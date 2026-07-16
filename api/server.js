import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import cron from 'node-cron';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import TelegramBot from 'node-telegram-bot-api';
import nodemailer from 'nodemailer';
import { tavily } from '@tavily/core';
import { MongoClient } from 'mongodb';
import fs from 'fs';

/* ---------- setup ---------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 5000;
const runningCronThreads = new Map();
const interactiveSessionStatesPool = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

/* ---------- Hybrid Database Layer Engine ---------- */

const isProd = process.env.ISPRODUCTION === 'production';
const LOCAL_DB_PATH = path.resolve(__dirname, '../storage/db.json');

if (!isProd) {
  const storageDir = path.dirname(LOCAL_DB_PATH);
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify({ jobs: [], config: [] }, null, 2));
  }
}

let mongoClient = null;
let jobsCollection = null;
let configCollection = null;

const localJsonDriver = {
  read: () => JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8')),
  write: (data) => fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2)),

  createCollection: (collectionName) => ({
    find: (query = {}) => ({
      toArray: async () => {
        const dbData = localJsonDriver.read();
        let items = dbData[collectionName] || [];
        return items.filter(item => Object.keys(query).every(key => String(item[key]) === String(query[key])));
      }
    }),
    findOne: async (query = {}) => {
      const dbData = localJsonDriver.read();
      let items = dbData[collectionName] || [];
      return items.find(item => Object.keys(query).every(key => String(item[key]) === String(query[key]))) || null;
    },
    insertOne: async (doc) => {
      const dbData = localJsonDriver.read();
      if (!dbData[collectionName]) dbData[collectionName] = [];
      dbData[collectionName].push(doc);
      localJsonDriver.write(dbData);
      return { insertedId: doc.id || doc._id };
    },
    updateOne: async (query, update) => {
      const dbData = localJsonDriver.read();
      let items = dbData[collectionName] || [];
      const index = items.findIndex(item => Object.keys(query).every(key => String(item[key]) === String(query[key])));
      if (index !== -1) {
        if (update.$set) {
          items[index] = { ...items[index], ...update.$set };
        } else {
          items[index] = { ...items[index], ...update };
        }
        dbData[collectionName] = items;
        localJsonDriver.write(dbData);
      }
      return { modifiedCount: index !== -1 ? 1 : 0 };
    },
    deleteOne: async (query) => {
      const dbData = localJsonDriver.read();
      let items = dbData[collectionName] || [];
      const initialLength = items.length;
      items = items.filter(item => !Object.keys(query).every(key => String(item[key]) === String(query[key])));
      dbData[collectionName] = items;
      localJsonDriver.write(dbData);
      return { deletedCount: initialLength - items.length };
    }
  })
};

async function connectDatabase() {
  if (isProd) {
    const mongoURI = process.env.MONGO_URI;
    if (!mongoURI) {
      console.error('❌ Fatal Environment Constraint: MONGO_URI is missing in production scope.');
      process.exit(1);
    }
    try {
      mongoClient = new MongoClient(mongoURI);
      await mongoClient.connect();
      const db = mongoClient.db('AeonMatrix');
      jobsCollection = db.collection('jobs');
      configCollection = db.collection('config');
      console.log('📦 Connected cleanly to free MongoDB MongoDB Atlas cluster layer.');
    } catch (err) {
      console.error('❌ MongoDB Connection Failure:', err.message);
      process.exit(1);
    }
  } else {
    jobsCollection = localJsonDriver.createCollection('jobs');
    configCollection = localJsonDriver.createCollection('config');
    console.log('📝 Development Environment Detected. Persistent Layer Bound to storage/db.json');
  }

  await bootstrapSchedules();
  bootTelegramBotEngine();
}

/* ---------- Crypto Helpers (AES-256-GCM) ---------- */

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? crypto.createHash('sha256').update(String(process.env.ENCRYPTION_KEY)).digest()
  : crypto.createHash('sha256').update('HermesMatrixCryptoKeyFallbackSignature2026').digest();

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText) {
  if (!encryptedText || !encryptedText.includes(':')) return '';
  try {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('❌ Token Decryption Failure. Returning empty string:', err.message);
    return '';
  }
}

/* ---------- Static Multi-Tenant Auth Profiles ---------- */

const USER_DATABASE = {
  "admin": { password: "Pass123", role: "admin", maxJobs: Infinity },
  "trial": { password: "Trial@pass", role: "trial", maxJobs: 3 }
};

/* ---------- NaraRouter client ---------- */

const naraKey = process.env.NARA_API_KEY;
if (!naraKey) {
  console.error('❌ NARA_API_KEY is not set in .env');
}

const naraClient = new OpenAI({
  apiKey: naraKey && naraKey.trim() !== "" ? naraKey : "MISSING_ENV_KEY_FALLBACK",
  baseURL: 'https://router.bynara.id/v1',
  timeout: 60000,
  maxRetries: 2
});

/* ---------- Tavily Client ---------- */
const tavilyKey = process.env.TAVILY_API_KEY;
let tvly = null;
if (tavilyKey) {
  tvly = tavily({ apiKey: tavilyKey });
}

/* ---------- storage helpers ---------- */

async function getSystemConfig() {
  try {
    let cfg = await configCollection.findOne({ type: 'system_settings' });
    if (!cfg) {
      cfg = {
        type: 'system_settings',
        defaultMedium: 'site',
        email: '',
        encryptedTelegramOwnerId: '',
        encryptedTelegramAllowedIds: [],
        whatsappBotNumber: '',
        userResume: '',
        encryptedTelegramBotToken: ''
      };
      await configCollection.insertOne(cfg);
    }
    return cfg;
  } catch (err) {
    console.error('❌ Failed to read system settings profile map:', err.message);
    return {};
  }
}

/* ---------- Telegram Markdown Safety Encoder ---------- */

function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

/* ---------- Telegram bot setup ---------- */

let telegramBot = null;
let isBotBooting = false;

async function bootTelegramBotEngine() {
  if (isBotBooting || telegramBot) return;
  isBotBooting = true;

  try {
    const cfg = await getSystemConfig();
    const rawToken = cfg.encryptedTelegramBotToken ? decrypt(cfg.encryptedTelegramBotToken) : '';

    if (rawToken && rawToken.trim() !== "") {
      telegramBot = new TelegramBot(rawToken, {
        polling: { autoStart: false },
        params: { timeout: 30 },
        retryTimeout: 10000
      });

      await telegramBot.deleteWebhook();

      try {
        // 🚀 CRITICAL UPDATE: Suppression constraint completely removed for Dev and Prod alignment
        await telegramBot.startPolling();
        console.log('📡 Telegram Bot Matrix Link Connected and Active.');

        await telegramBot.setMyCommands([
          { command: 'start', description: 'Initialize the Hermes connection node' },
          { command: 'help', description: 'Show comprehensive command operational guide' },
          { command: 'status', description: 'Fetch system matrix current metrics' },
          { command: 'update', description: 'Modify active loops via interactive selection panels' },
          { command: 'resume', description: 'Preview active stored CV profile text' }
        ]);
        console.log('📋 Telegram UI command menu hints injected successfully.');
      } catch (netErr) {
        console.warn('⚠️ Telegram Handshake Suppressed:', netErr.message);
      }

      telegramBot.onText(/\/start/, msg => {
        telegramBot.sendMessage(msg.chat.id, '🛡️ *AeonMatrix Active Node Linked.*\n\nUse `/prompt <command>` to inject continuous automation maps dynamically, or use `/update` to manage your active jobs pool via interactive menus.', { parse_mode: 'Markdown' });
      });

      telegramBot.onText(/\/help/, msg => {
        const helpMessage = `📖 *AeonMatrix Operator Guide*\n\n🤖 *Core Execution Engines:*\n• \`/prompt <instruction>\` — Compiles a natural language request into a cron thread.\n• \`/update\` — Opens a secure inline structural UI button configuration map.\n• _Plain Text_ — Chat directly with the cognitive brain node.\n\n🛠️ *System Status Arrays:*\n• \`/status\` — Reviews active background orchestration pools.\n• \`/resume\` — Inspects the currently cached vector profile content.`;
        telegramBot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
      });

      telegramBot.onText(/\/status/, async (msg) => {
        try {
          const jobs = await jobsCollection.find({}).toArray();
          const totalJobs = jobs.length;
          const activeJobs = jobs.filter(j => j.status === 'active').length;
          const statusMessage = `📟 *AeonMatrix Runtime Health Profile*\n\n• *Platform Node:* Live (Optimal)\n• *Orchestration Threads:* \`${totalJobs}\` total registered loops.\n• *Active State:* \`${activeJobs}\` operational.\n• *Local Core Baseline Time:* \`${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}\``;
          telegramBot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'Markdown' });
        } catch (err) {
          telegramBot.sendMessage(msg.chat.id, `❌ Error extracting health array: ${err.message}`);
        }
      });

      telegramBot.onText(/\/resume/, async (msg) => {
        const currentCfg = await getSystemConfig();
        const profileContent = currentCfg.userResume
          ? `📋 *Current Stored Profile Context:* \n\n\`\`\`text\n${currentCfg.userResume.slice(0, 1000)}${currentCfg.userResume.length > 1000 ? '... [Truncated]' : ''}\n\`\`\``
          : `⚠️ *No Profile Data Bound.*`;
        telegramBot.sendMessage(msg.chat.id, profileContent, { parse_mode: 'Markdown' });
      });

      telegramBot.onText(/\/update/, async (msg) => {
        try {
          interactiveSessionStatesPool.delete(msg.chat.id);

          const rawJobs = await jobsCollection.find({ owner: "admin" }).toArray();
          if (rawJobs.length === 0) {
            return telegramBot.sendMessage(msg.chat.id, '📟 *AeonMatrix Control Plane:* No running orchestration pools found in MongoDB Atlas storage layers.', { parse_mode: 'Markdown' });
          }

          const inlineKeyboardButtons = rawJobs.map(job => [{
            text: `⚙️ ${job.name.slice(0, 32)} [${job.status.toUpperCase()}]`,
            callback_data: `select_job:${job.id}`
          }]);

          await telegramBot.sendMessage(msg.chat.id, '📟 *Select Target Pipeline Thread to Calibrate:*', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboardButtons }
          });
        } catch (err) {
          telegramBot.sendMessage(msg.chat.id, `❌ Menu deployment failure: ${err.message}`);
        }
      });

      telegramBot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        const payloadData = callbackQuery.data;

        await telegramBot.answerCallbackQuery(callbackQuery.id);

        try {
          if (payloadData.startsWith('select_job:')) {
            const jobId = payloadData.split(':')[1];
            const targetJob = await jobsCollection.findOne({ id: jobId });

            if (!targetJob) {
              return telegramBot.sendMessage(chatId, '❌ *Database Exception:* Target tracking artifact has vanished.');
            }

            const toggleLabel = targetJob.status === 'active' ? '⏸ Pause Execution' : '▶ Re-Activate Thread';

            const interactiveControlMenu = {
              inline_keyboard: [
                [
                  { text: '⏱ Shifts Schedule Mapping', callback_data: `mod_time:${jobId}` },
                  { text: toggleLabel, callback_data: `mod_state:${jobId}` }
                ],
                [
                  { text: '🗑 Purge Thread from Cluster', callback_data: `mod_purge:${jobId}` }
                ],
                [
                  { text: '◀ Return to Main Panel', callback_data: 'nav_back_main' }
                ]
              ]
            };

            await telegramBot.editMessageText(`🛠 *Calibrating Target Vector:*\n\n• *Name:* \`${escapeMarkdown(targetJob.name)}\`\n• *Task:* \`${escapeMarkdown(targetJob.task)}\`\n• *Active Schedule:* \`${targetJob.schedule}\`\n• *Metrics State:* \`${targetJob.status.toUpperCase()}\``, {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: interactiveControlMenu
            });
          }

          else if (payloadData.startsWith('mod_state:')) {
            const jobId = payloadData.split(':')[1];
            const targetJob = await jobsCollection.findOne({ id: jobId });

            if (targetJob) {
              const adjustedStatus = targetJob.status === 'active' ? 'paused' : 'active';
              await jobsCollection.updateOne({ id: jobId }, { $set: { status: adjustedStatus } });

              const freshJobState = await jobsCollection.findOne({ id: jobId });
              if (adjustedStatus === 'paused') {
                stopCronForJob(jobId);
              } else {
                activateCronForJob(freshJobState);
              }

              await telegramBot.deleteMessage(chatId, messageId).catch(() => { });
              await telegramBot.sendMessage(chatId, `⚙️ *AeonMatrix Database Sync Matrix Complete*\n\n• *Pipeline:* ${escapeMarkdown(targetJob.name)}\n• *Update Action:* Status Mutated\n• *New State:* \`${adjustedStatus.toUpperCase()}\``, { parse_mode: 'Markdown' });
            }
          }

          else if (payloadData.startsWith('mod_purge:')) {
            const jobId = payloadData.split(':')[1];
            const targetJob = await jobsCollection.findOne({ id: jobId });

            if (targetJob) {
              stopCronForJob(jobId);
              await jobsCollection.deleteOne({ id: jobId });

              await telegramBot.deleteMessage(chatId, messageId).catch(() => { });
              await telegramBot.sendMessage(chatId, `🗑 *Thread Purged Cleanly*\n\n• *Wiped Pipeline:* ${escapeMarkdown(targetJob.name)}\n• *Database State:* Document records removed.`, { parse_mode: 'Markdown' });
            }
          }

          else if (payloadData.startsWith('mod_time:')) {
            const jobId = payloadData.split(':')[1];
            interactiveSessionStatesPool.set(chatId, { step: 'AWAITING_CRON_STRING', targetJobId: jobId });

            await telegramBot.deleteMessage(chatId, messageId).catch(() => { });
            await telegramBot.sendMessage(chatId, '⏱ *Provide New Precise Schedule Configuration Vector:*\n\nSend your new raw timing or relative parameters string layout as a direct text reply (e.g. `every 10 minutes`, `0 30 9 * * *`, `remind me in 2 hours`).', { parse_mode: 'Markdown' });
          }

          else if (payloadData === 'nav_back_main') {
            await telegramBot.deleteMessage(chatId, messageId).catch(() => { });
            const rawJobs = await jobsCollection.find({ owner: "admin" }).toArray();
            const inlineKeyboardButtons = rawJobs.map(job => [{
              text: `⚙️ ${job.name.slice(0, 32)} [${job.status.toUpperCase()}]`,
              callback_data: `select_job:${job.id}`
            }]);
            await telegramBot.sendMessage(chatId, '📟 *Select Target Pipeline Thread to Calibrate:*', {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: inlineKeyboardButtons }
            });
          }
        } catch (err) {
          console.error('❌ Callback Query Processing Error:', err.message);
        }
      });

      telegramBot.on('message', async (msg) => {
        const text = msg.text || '';
        const chatId = msg.chat.id;

        console.log(`📨 Telegram Message Received from Chat ID ${chatId}:`, text);

        if (text.startsWith('/start') || text.startsWith('/help') || text.startsWith('/status') || text.startsWith('/resume') || text.startsWith('/update')) return;

        if (interactiveSessionStatesPool.has(chatId)) {
          const contextState = interactiveSessionStatesPool.get(chatId);

          if (contextState.step === 'AWAITING_CRON_STRING') {
            interactiveSessionStatesPool.delete(chatId);

            await telegramBot.sendMessage(chatId, '🧠 Intercepting custom input vectors... Parsing update tokens via NaraRouter engine layers...');

            try {
              const targetJob = await jobsCollection.findOne({ id: contextState.targetJobId });
              if (!targetJob) throw new Error("Target pipeline context was deleted mid-transaction.");

              const temporaryMockJob = await parsePrompt(text);

              await jobsCollection.updateOne(
                { id: targetJob.id },
                { $set: { schedule: temporaryMockJob.schedule, isOneOff: temporaryMockJob.isOneOff } }
              );

              const fullyUpdatedJob = await jobsCollection.findOne({ id: targetJob.id });
              activateCronForJob(fullyUpdatedJob);

              const successMessage = `⚙️ *AeonMatrix Calibration Matrix Complete*\n\n• *Pipeline:* ${escapeMarkdown(targetJob.name)}\n• *Update Action:* Schedule Shifted\n• *New Target Cron Map:* \`${fullyUpdatedJob.schedule}\`\n• *Status:* Background processing loop recalibrated live.`;
              return await telegramBot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });

            } catch (err) {
              console.error('❌ Stateful calibration intercept failure:', err.message);
              return await telegramBot.sendMessage(chatId, `⚠️ *Hermes Core Rejection:* Failed to process schedule change input format. Reason: ${escapeMarkdown(err.message)}`, { parse_mode: 'Markdown' });
            }
          }
        }

        const currentCfg = await getSystemConfig();

        if (text.startsWith('/prompt ')) {
          const promptPayload = text.replace('/prompt ', '').trim();

          if (!promptPayload) {
            return telegramBot.sendMessage(msg.chat.id, '⚠️ *Operator Intercept:* Prompt payload cannot be blank. Provide a valid natural language instruction.', { parse_mode: 'Markdown' });
          }

          const looksConversational = /^(tell me|write|explain|who is|what is|give me information)/i.test(promptPayload) &&
            !/\b(every|each|at|cron|minute|hour|day|timer|after|in|pm|am)\b/i.test(promptPayload);

          if (looksConversational) {
            const warningMsg = `⚠️ *Hermes Parameter Rejection*\n\n*Reason:* Input detected as a direct conversational statement rather than a scheduling rule mapping.\n\n💡 _Tip: Remove the \`/prompt\` prefix to chat directly with the node._`;
            return telegramBot.sendMessage(msg.chat.id, warningMsg, { parse_mode: 'Markdown' });
          }

          await telegramBot.sendMessage(msg.chat.id, '🧠 Intercepting structural prompt... Compiling Automation Pipeline matrix... Layout compiling via NaraRouter.');

          try {
            const jobObject = await parsePrompt(promptPayload);
            jobObject.owner = "admin";

            await jobsCollection.insertOne({ ...jobObject });
            activateCronForJob(jobObject);

            const confirmationMsg = `✅ *Loop Registered Successfully!*\n\n• *Pipeline:* ${escapeMarkdown(jobObject.name)}\n• *Schedule Mapping:* \`${jobObject.schedule}\`\n• *Task Bound:* ${escapeMarkdown(jobObject.task)}`;
            await telegramBot.sendMessage(msg.chat.id, confirmationMsg, { parse_mode: 'Markdown' });

          } catch (err) {
            console.error('❌ Intercepted invalid prompt mapping safely:', err.message);
            const warningMsg = `⚠️ *Hermes Parameter Rejection Warning*\n\n*Reason:* ${escapeMarkdown(err.message)}`;
            await telegramBot.sendMessage(msg.chat.id, warningMsg, { parse_mode: 'Markdown' });
          }
        } else {
          telegramBot.sendChatAction(msg.chat.id, 'typing');
          try {
            const rawJobs = await jobsCollection.find({ owner: "admin" }).toArray();
            const compactJobsMatrix = rawJobs.map(j => ({
              id: j.id,
              name: j.name,
              schedule: j.schedule,
              status: j.status,
              medium: j.deliveryMedium,
              task: j.task
            }));

            const systemInstruction = `You are the primary cognitive routing and execution node of the Hermes Automation Matrix (AeonMatrix).
Current Reference Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}.

CRITICAL ENGAGEMENT PROTOCOLS:
1. STAGE-BASED RESPONDING: Keep casual conversational answers short, punchy, and under 3-4 lines maximum.
2. ORCHESTRATION RESTRAINT: You have complete read-only visibility over the user's automated threads listed below. Use this matrix to precisely answer status updates.
3. IDENTITY CONSTRAINTS: Address the user as Aryan naturally. Do not dump his technical resume text word-for-word unless he explicitly asks to review his CV profile.

[ACTIVE SYSTEM THREAD POOL MATRIX]:
${compactJobsMatrix.length > 0 ? JSON.stringify(compactJobsMatrix.map(j => ({ name: j.name, schedule: j.schedule, status: j.status })), null, 2) : "No active background orchestration threads registered."}

[USER RESUME PROFILE DATA]:
${currentCfg.userResume || 'No user resume profile uploaded.'}`;

            const responseCall = await naraClient.chat.completions.create({
              model: 'mistral-large',
              temperature: 0.4,
              messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: text }]
            });

            let replyMessage = responseCall.choices?.[0]?.message?.content || "Empty content payload.";
            replyMessage = replyMessage.replace(/^```markdown\n?/i, '').replace(/```$/, '');

            try {
              await telegramBot.sendMessage(msg.chat.id, replyMessage, { parse_mode: 'Markdown' });
            } catch (mdError) {
              console.warn("⚠️ Chat markdown broken, shifting to plain text delivery pass:", mdError.message);
              await telegramBot.sendMessage(msg.chat.id, replyMessage.replace(/[\*\_`#\-]/g, ''));
            }
          } catch (err) {
            console.error('❌ Conversational routing error:', err.message);
            telegramBot.sendMessage(msg.chat.id, `⚠️ Cognitive node exception: ${err.message}`);
          }
        }
      });
    }
  } catch (err) {
    console.error('⚠️ Telegram initialization exception caught:', err.message);
  } finally {
    isBotBooting = false;
  }
}

/* ---------- Email setup ---------- */

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
let mailer = null;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

/* ---------- Job Helpers & Scheduling Logic ---------- */

function normalizeJob(job) {
  return {
    id: String(job.id || Date.now()),
    name: job.name || 'Untitled Job',
    description: job.description || '',
    task: job.task || '',
    schedule: job.schedule || '',
    isOneOff: !!job.isOneOff,
    status: job.status === 'paused' ? 'paused' : 'active',
    logs: Array.isArray(job.logs) ? job.logs : [],
    channelOverride: job.channelOverride || null,
    deliveryMedium: job.deliveryMedium || 'site',
    deliveryTargetTelegramChatId: job.deliveryTargetTelegramChatId || null,
    deliveryTargetEmail: job.deliveryTargetEmail || null,
    owner: job.owner || 'admin',
    cachedResponse: job.cachedResponse || null
  };
}

function isValidCron(expr) { return typeof expr === 'string' && expr.trim() !== '' && cron.validate(expr); }
function stopCronForJob(jobId) {
  const active = runningCronThreads.get(jobId);
  if (active) {
    if (active.preflight) { active.preflight.stop?.(); active.preflight.destroy?.(); }
    if (active.trigger) { active.trigger.stop?.(); active.trigger.destroy?.(); }
    runningCronThreads.delete(jobId);
  }
}

function fallbackParsePrompt(prompt) {
  const text = String(prompt || '').toLowerCase();
  const timer = text.match(/\b(timer|set timer|remind me|after|in)\s*(\d+)\s*(second|minute|hour|min|sec|hr|h|m|s)s?\b/)
    || text.match(/\bafter\s*(\d+)\s*(second|minute|hour|min|sec|hr|h|m|s)s?\b/)
    || text.match(/\b(\d+)\s*(s|m|h)\b/);

  const nowStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  let target = new Date(nowStr);
  let isOneOff = true;

  if (timer) {
    const n = parseInt(timer[1], 10);
    const unit = timer[2];

    if (unit.startsWith('sec') || unit === 's') {
      target = new Date(target.getTime() + n * 1000);
    } else if (unit.startsWith('min') || unit === 'm') {
      target = new Date(target.getTime() + n * 60 * 1000);
    } else if (unit.startsWith('hou') || unit.startsWith('hr') || unit === 'h') {
      target = new Date(target.getTime() + n * 60 * 60 * 1000);
    }
  } else {
    target = new Date(target.getTime() + 60 * 1000);
  }

  const schedule = `${target.getSeconds()} ${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`;
  return { schedule, isOneOff };
}

async function naraParsePrompt(prompt) {
  if (!naraKey) throw new Error('NARA_API_KEY not configured');

  const now = new Date();

  // 🚀 FIXED: Hardened explicit clock parameters to prevent calculation offset bugs
  const temporalContext = {
    current_time_24h: now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }),
    current_time_12h: now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: true }),
    current_date_indian: now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }), // DD/MM/YYYY format layout
    day_of_week: now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }),
    current_year: now.getFullYear(),
    iso_timestamp: now.toISOString()
  };

  const system = `You are a strict technical scheduling parser. Return raw JSON matching this structure exactly:
{
  "name": "string",
  "description": "string",
  "schedule": "6-field cron",
  "isOneOff": boolean,
  "deliveryMedium": "telegram"|"email"|"site",
  "task": "string"
}

CRITICAL TEMPORAL CONTEXT MATRIX (STRICT BASELINE TIME):
${JSON.stringify(temporalContext, null, 2)}

CRITICAL CONTEXT RULES:
1. DATE MATH ENFORCEMENT: Use the current clock markers above to calculate exact target parameters. For example, if current_time_24h is "15:45:00" and the user asks for "till 3:50PM today", the schedule parameter MUST resolve precisely to minute 50 of hour 15: "0 50 15 16 7 *".
2. ABSOLUTE DETERMINISM: Carefully read whether the user specifies a specific time limit boundary. Do not make random guesses or generate early offsets. 
3. NO YEAR FIELDS: Yield a standard 5 or 6 field standard cron syntax string. Do not append a 7th year segment under any circumstances.`;

  const completion = await naraClient.chat.completions.create({
    model: 'mistral-large',
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
  });

  return JSON.parse(completion.choices?.[0]?.message?.content || '{}');
}

async function parsePrompt(prompt) {
  let parsed;
  const textCheck = String(prompt).toLowerCase();
  let localFallbackForced = false;
  if (/\b(after|in|timer|remind)\b/.test(textCheck) && !/\b(every|each|search|find|jobs|food|place|company|tomorrow)\b/.test(textCheck)) {
    parsed = fallbackParsePrompt(prompt);
    localFallbackForced = true;
  }
  if (!localFallbackForced) {
    try {
      parsed = await naraParsePrompt(prompt);
    } catch (error) {
      console.error('❌ NARA parse crash, defaulting to fallback processing engine:', error.message);
      parsed = fallbackParsePrompt(prompt);
    }
  }

  const cfg = await getSystemConfig();
  const plainOwnerId = cfg.encryptedTelegramOwnerId ? decrypt(cfg.encryptedTelegramOwnerId) : '';

  let finalMedium = parsed.deliveryMedium || cfg.defaultMedium || 'site';
  if (/\b(telegram|tg|bot)\b/.test(textCheck)) finalMedium = 'telegram';
  if (/\b(email|mail)\b/.test(textCheck)) finalMedium = 'email';

  let safeSchedule = parsed.schedule || "0 * * * * *";
  if (safeSchedule.split(' ').length > 6) {
    const parts = safeSchedule.split(' ');
    safeSchedule = `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]} ${parts[4]} *`;
  }
  if (safeSchedule.startsWith('*/1 ')) {
    safeSchedule = safeSchedule.replace('*/1 ', '0 ');
  }

  return {
    id: String(Date.now()),
    name: String(parsed.name || 'AI Pipeline Loop').slice(0, 60),
    description: String(parsed.description || prompt).slice(0, 200),
    schedule: isValidCron(safeSchedule) ? safeSchedule : "0 * * * * *",
    isOneOff: parsed.isOneOff !== undefined ? !!parsed.isOneOff : true,
    task: String(parsed.task || prompt),
    status: 'active', logs: [], channelOverride: null,
    deliveryMedium: finalMedium,
    deliveryTargetTelegramChatId: plainOwnerId || null,
    deliveryTargetEmail: cfg.email || null,
    owner: "admin"
  };
}

async function appendExecutionLog(jobId, logText) {
  try {
    const job = await jobsCollection.findOne({ id: jobId });
    if (!job) return;

    let logs = Array.isArray(job.logs) ? job.logs : [];
    logs.unshift({ timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }), message: logText });
    if (logs.length > 10) logs.pop();

    await jobsCollection.updateOne({ id: jobId }, { $set: { logs: logs } });
  } catch (err) {
    console.error('❌ Failed to write execution log to MongoDB Atlas:', err.message);
  }
}

async function sendChannelNotification(job, logText) {
  const cfg = await getSystemConfig();
  const medium = job.deliveryMedium || cfg.defaultMedium || 'site';
  const fullPayloadText = `🤖 [Hermes Matrix Execution Report]\n\nPipeline Run: ${job.name}\n\nOutput Log:\n${logText}`;

  try {
    if (medium === 'telegram') {
      if (telegramBot) {
        const plainOwnerId = cfg.encryptedTelegramOwnerId ? decrypt(cfg.encryptedTelegramOwnerId) : '';
        const targetChatId = job.deliveryTargetTelegramChatId || plainOwnerId;

        if (targetChatId) {
          const SEGMENT_THRESHOLD_CAP = 3800;

          if (fullPayloadText.length > SEGMENT_THRESHOLD_CAP) {
            console.log(`📦 Large chunk string discovered (${fullPayloadText.length} characters). Slicing array tokens...`);
            let chunkBuffer = fullPayloadText;

            while (chunkBuffer.length > 0) {
              const segment = chunkBuffer.slice(0, SEGMENT_THRESHOLD_CAP);
              chunkBuffer = chunkBuffer.slice(SEGMENT_THRESHOLD_CAP);

              try {
                await telegramBot.sendMessage(targetChatId, segment, { parse_mode: 'Markdown' });
              } catch {
                await telegramBot.sendMessage(targetChatId, segment.replace(/[\*\_`#\-]/g, ''));
              }
            }
          } else {
            try {
              await telegramBot.sendMessage(targetChatId, fullPayloadText, { parse_mode: 'Markdown' });
            } catch {
              await telegramBot.sendMessage(targetChatId, fullPayloadText.replace(/[\*\_`#\-]/g, ''));
            }
          }
        }
      }
    }

    if (medium === 'email' && mailer) {
      const toAddress = job.deliveryTargetEmail || cfg.email;
      if (toAddress) {
        await mailer.sendMail({ from: SMTP_USER, to: toAddress, subject: `Hermes AI Alert: ${job.name}`, text: fullPayloadText });
      }
    }
  } catch (err) {
    console.error('❌ System notification pipeline failure:', err.message);
  }
}

async function executeAIResearchBrain(job, preCacheOnly = false) {
  try {
    const contextEvaluator = job.task.toLowerCase();

    const demandsWebAccess = ['search', 'find', 'jobs', 'latest', 'top 10', 'market', 'food', 'place', 'company', 'website', 'near', 'list', 'facts', 'price', 'photo', 'breed'].some(k => contextEvaluator.includes(k));

    const isSimpleReminder = !demandsWebAccess && (
      job.name.toLowerCase().includes('reminder') ||
      job.name.toLowerCase().includes('pipeline loop') ||
      /\b(timer|remind|alert|wake me up|meeting tomorrow|appointment|meating)\b/.test(contextEvaluator)
    );

    if (isSimpleReminder) {
      const cleanTaskText = job.task.replace(/^(after \d+\s*\w+\s*|reminder\s*|tomorrow\s*)/i, '');
      const reminderOutput = `⏰ **AeonMatrix Task Alert Engine**\n\n• **Notification:** ${cleanTaskText}\n• **Status:** Active schedule execution successful.`;

      await jobsCollection.updateOne({ id: job.id }, { $set: { cachedResponse: reminderOutput } });
      if (!preCacheOnly) {
        await appendExecutionLog(job.id, reminderOutput);
        await sendChannelNotification(job, reminderOutput);
      }
      return;
    }

    let analysisContext = "";

    if (demandsWebAccess && tvly) {
      let optimizedSearchQuery = job.task;
      if (contextEvaluator.includes('chowk') || contextEvaluator.includes('ghatlodiya') || contextEvaluator.includes('near')) {
        optimizedSearchQuery = `${job.task} Ahmedabad Gujarat India`;
      }

      if (!preCacheOnly) {
        await appendExecutionLog(job.id, `🔍 Initiating localized live Tavily web search for: "${optimizedSearchQuery}"...`);
      }

      try {
        const tavilySearchPromise = tvly.search(optimizedSearchQuery, { searchDepth: "advanced", maxResults: 5 });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Tavily search endpoint timeout")), 25000));

        const searchResults = await Promise.race([tavilySearchPromise, timeoutPromise]);
        analysisContext = JSON.stringify(searchResults.results);
      } catch (err) {
        console.warn("⚠️ Tavily research timed out or failed:", err.message);
      }
    }

    if (!preCacheOnly) {
      await appendExecutionLog(job.id, "🧠 Synthesizing parameters inside cognitive layer...");
    }

    // 🚀 NEW: Dynamic Length Context Engine
    const isMusicOrQuickPrompt = ['song', 'music', 'listen', 'track', 'playlist', 'quick', 'short'].some(k => contextEvaluator.includes(k));

    const operationalConstraintInstruction = isMusicOrQuickPrompt
      ? `STRICT LENGTH ENFORCEMENT PROTOCOL:
1. OUTPUT CAP: Keep the entire response ultra-short, crisp, punchy, and strictly under 15-20 lines total.
2. DYNAMICS: Do not write giant walls of text, massive tables, or overly wordy scientific justifications. Deliver straight point-to-point facts.
3. DATA RETENTION: State the suggestion instantly, give 2-3 quick bullet points explaining why, and include verified map or media URLs immediately without fluff.`
      : `STANDARD LAYOUT PROTOCOL:
1. OUTPUT DYNAMICS: Create a polished layout using clear markdown headings, bold accents, spaced lines, and descriptive emojis.
2. ANCHORED GROUNDING: Stick strictly to the literal facts provided in the live internet search context below. Do not guess parameters.`;

    const systemInstruction = `You are a precise data synthesis engine of the AeonMatrix cloud framework.
Current Reference Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}.

STRICT INSTRUCTION PROTOCOLS:
${operationalConstraintInstruction}

MAP LINK STANDARD:
Never output hallucinated map links. Use this exact format: https://www.google.com/maps/search/?api=1&query=urlencoded_query_string

[LIVE CRAWLED DATA ENVIRONMENT]:
${analysisContext || "No background internet data chunk provided. Rely completely on literal internal parametric metrics."}`;

    const modelCall = await naraClient.chat.completions.create({
      model: 'mistral-large',
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: `${job.task} (Compile the complete response report matching the task directives).` }
      ]
    });

    const report = modelCall.choices?.[0]?.message?.content || "Loop executed safely.";

    await jobsCollection.updateOne({ id: job.id }, { $set: { cachedResponse: report } });

    if (!preCacheOnly) {
      await appendExecutionLog(job.id, report);
      await sendChannelNotification(job, report);
    }
  } catch (err) {
    console.error('❌ Thread runtime execution processing error:', err.message);
    if (!preCacheOnly) {
      const errorReport = `❌ Runtime Error: ${err.message}`;
      await appendExecutionLog(job.id, errorReport);
      await sendChannelNotification(job, errorReport);
    }
  }
}

function calculatePreFlightCron(cronString) {
  const parts = cronString.trim().split(/\s+/);
  if (parts.length < 5) return null;

  const hasSeconds = parts.length === 6;
  const minIndex = hasSeconds ? 1 : 0;
  const hourIndex = hasSeconds ? 2 : 1;

  let currentMin = parseInt(parts[minIndex], 10);
  let currentHour = parseInt(parts[hourIndex], 10);

  if (isNaN(currentMin) || isNaN(currentHour)) return null;

  currentMin -= 2;
  if (currentMin < 0) {
    currentMin += 60;
    currentHour -= 1;
    if (currentHour < 0) {
      currentHour = 23;
    }
  }

  parts[minIndex] = String(currentMin);
  parts[hourIndex] = String(currentHour);

  if (hasSeconds) parts[0] = "0";

  return parts.join(' ');
}

function isNaN(val) { return Number.isNaN(val); }

function activateCronForJob(job) {
  stopCronForJob(job.id);
  if (job.status === 'paused') {
    return;
  }

  const textCheck = String(job.task).toLowerCase();
  const threadsContainer = { preflight: null, trigger: null };

  const isShortTimer = job.isOneOff && (
    /\b(\d+)\s*(s|sec|second|m|min|minute)s?\b/.test(textCheck) ||
    /\bin\s+\d+/.test(textCheck) ||
    /\bseconds\s+from\s+now\b/.test(textCheck)
  );

  if (isShortTimer) {
    const match = textCheck.match(/\b(\d+)\s*(s|sec|second|m|min|minute)s?\b/);
    let delayMs = 20000;

    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      delayMs = unit.startsWith('m') ? value * 60 * 1000 : value * 1000;
    }

    console.log(`🧠 [PRE-CACHE CONTROL] Short dynamic timer caught. Initializing immediate pre-compilation layer...`);
    executeAIResearchBrain(job, true).catch(() => { });

    const shortTask = setTimeout(async () => {
      try {
        const exactJob = await jobsCollection.findOne({ id: job.id });
        if (telegramBot && exactJob?.deliveryMedium === 'telegram' && exactJob?.deliveryTargetTelegramChatId) {
          telegramBot.sendChatAction(exactJob.deliveryTargetTelegramChatId, 'typing').catch(() => { });
          await new Promise(res => setTimeout(res, 5000));
        }

        const freshJob = await jobsCollection.findOne({ id: job.id });
        if (freshJob && freshJob.cachedResponse) {
          await appendExecutionLog(freshJob.id, freshJob.cachedResponse);
          await sendChannelNotification(freshJob, freshJob.cachedResponse);
        } else {
          await executeAIResearchBrain(job, false);
        }
        await jobsCollection.deleteOne({ id: job.id });
      } catch (err) {
        console.error(`[❌ CRON DEBUGLOG ERROR] Isolated memory timer catch on Job [${job.id}]:`, err.message);
      }
    }, delayMs);

    threadsContainer.trigger = { stop: () => clearTimeout(shortTask), destroy: () => clearTimeout(shortTask) };
    runningCronThreads.set(job.id, threadsContainer);
    return;
  }

  if (!isValidCron(job.schedule)) {
    return;
  }

  try {
    const preFlightSchedule = calculatePreFlightCron(job.schedule);

    // 🚀 FIXED: Dynamic verification map to catch if target falls within current offset limit window
    const now = new Date();
    const parts = job.schedule.trim().split(/\s+/);
    const hasSeconds = parts.length === 6;
    const targetMin = parseInt(parts[hasSeconds ? 1 : 0], 10);
    const targetHour = parseInt(parts[hasSeconds ? 2 : 1], 10);

    let isUnderTwoMinutes = false;
    if (!isNaN(targetMin) && !isNaN(targetHour)) {
      const targetDate = new Date(now.getTime());
      targetDate.setHours(targetHour, targetMin, 0, 0);

      const timeDifferenceMinutes = (targetDate.getTime() - now.getTime()) / (1000 * 60);
      if (timeDifferenceMinutes > 0 && timeDifferenceMinutes <= 2) {
        isUnderTwoMinutes = true;
      }
    }

    if (isUnderTwoMinutes) {
      // If prompt target parameters match under 2 minutes, bypass delay schedule and compute immediately
      console.log(`⏱ [PRE-CACHE MATRIX] Time window <= 2 mins remaining. Injecting crawl workers instantly...`, now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      executeAIResearchBrain(job, true).catch(() => { });
    } else if (preFlightSchedule) {
      // If time window allows, securely schedule standard preflight task 2 minutes prior
      threadsContainer.preflight = cron.schedule(preFlightSchedule, async () => {
        try {
          const checkState = await jobsCollection.findOne({ id: job.id });
          if (checkState && checkState.status === 'active') {
            console.log(`🧠 [PRE-CACHE MATRIX] Running predictive live pre-compile crawl sequence for Job [${job.id}]`, now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            await executeAIResearchBrain(checkState, true);
          }
        } catch (preErr) {
          console.error("⚠️ Pre-flight compilation step failure:", preErr.message);
        }
      });
      console.log(`⏱ Mounted Pre-Flight target cycle loop for [${job.id}] at expression: [${preFlightSchedule}]`, new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    }

    // Actual Delivery Target Trigger Loop Engine
    threadsContainer.trigger = cron.schedule(job.schedule, async () => {
      try {
        const exactJob = await jobsCollection.findOne({ id: job.id });

        if (exactJob && exactJob.status === 'active') {
          console.log(`🎯 [🎯 FAST EXECUTION TRIGGER] Dispatched pre-compiled matrix array block safely for Job [${job.id}]`, new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

          if (telegramBot && exactJob.deliveryMedium === 'telegram' && exactJob.deliveryTargetTelegramChatId) {
            telegramBot.sendChatAction(exactJob.deliveryTargetTelegramChatId, 'typing').catch(() => { });
            await new Promise(res => setTimeout(res, 5000));
          }

          const freshJobState = await jobsCollection.findOne({ id: job.id });
          if (freshJobState && freshJobState.cachedResponse) {
            await appendExecutionLog(freshJobState.id, freshJobState.cachedResponse);
            await sendChannelNotification(freshJobState, freshJobState.cachedResponse);

            await jobsCollection.updateOne({ id: freshJobState.id }, { $set: { cachedResponse: null } });
          } else {
            console.warn(`⚠️ [CACHE FAULT] Pre-cache was empty at dispatch time for node [${job.id}]. Generating on-the-fly...`);
            await executeAIResearchBrain(exactJob, false);
          }
        }

        if (job.isOneOff) {
          setTimeout(async () => {
            try {
              await jobsCollection.deleteOne({ id: job.id });
              stopCronForJob(job.id);
            } catch (e) {
              console.error(`[❌ CRON DEBUGLOG ERROR] Failed to clean up one-off database artifact [${job.id}]:`, e.message);
            }
          }, 5000);
        }
      } catch (loopErr) {
        console.error("❌ Recurrent execution loop failure:", loopErr.message);
      }
    });

    runningCronThreads.set(job.id, threadsContainer);
    console.log(`[🎯 CRON DEBUGLOG] Job [${job.id}] successfully mounted to scheduler stack. Current thread pool size: ${runningCronThreads.size}`, new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  } catch (schedErr) {
    console.error(`[❌ CRON DEBUGLOG CRITICAL ERROR] Failed to inject job configuration into node-cron core framework for job [${job.id}]:`, schedErr.message);
  }
}

async function bootstrapSchedules() {
  try {
    const jobs = await jobsCollection.find({}).toArray();
    jobs.map(normalizeJob).forEach(job => activateCronForJob(job));
  } catch (err) {
    console.error('❌ Failed to extract sync profiles from database cluster storage maps:', err.message);
  }
}

/* ---------- Security Gateway & Routes ---------- */

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing login details." });

  const user = USER_DATABASE[username.toLowerCase()];
  if (user && user.password === password) {
    return res.json({ success: true, username: username.toLowerCase(), role: user.role });
  }
  res.status(401).json({ error: "Invalid systemic security authorization parameters." });
});

app.get('/api/config', async (req, res) => {
  const cfg = await getSystemConfig();
  const plainOwnerId = cfg.encryptedTelegramOwnerId ? decrypt(cfg.encryptedTelegramOwnerId) : '';
  const plainAllowedIds = Array.isArray(cfg.encryptedTelegramAllowedIds)
    ? cfg.encryptedTelegramAllowedIds.map(id => decrypt(id)).join(', ')
    : '';

  const responseConfig = {
    ...cfg,
    telegramBotToken: cfg.encryptedTelegramBotToken ? '••••••••••••••••••••••••' : '',
    telegramOwnerId: plainOwnerId,
    telegramAllowedIds: plainAllowedIds
  };
  delete responseConfig._id;
  delete responseConfig.encryptedTelegramBotToken;
  delete responseConfig.encryptedTelegramOwnerId;
  delete responseConfig.encryptedTelegramAllowedIds;
  res.json(responseConfig);
});

app.post('/api/config', async (req, res) => {
  try {
    const { defaultMedium = 'site', email = '', telegramOwnerId = '', userResume = '', telegramBotToken = '', telegramAllowedIds = '' } = req.body;
    const cfg = await getSystemConfig();

    cfg.defaultMedium = defaultMedium;
    cfg.email = email.trim();
    cfg.userResume = userResume.trim();

    if (telegramBotToken && telegramBotToken !== '••••••••••••••••••••••••') {
      cfg.encryptedTelegramBotToken = encrypt(telegramBotToken.trim());
    }
    if (telegramOwnerId) {
      cfg.encryptedTelegramOwnerId = encrypt(String(telegramOwnerId).trim());
    }
    if (telegramAllowedIds) {
      const parsedIds = String(telegramAllowedIds).split(',').map(id => id.trim()).filter(Boolean);
      cfg.encryptedTelegramAllowedIds = parsedIds.map(id => encrypt(id));
    } else {
      cfg.encryptedTelegramAllowedIds = [];
    }

    await configCollection.updateOne({ type: 'system_settings' }, { $set: cfg });
    bootTelegramBotEngine();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const { user } = req.query;
    const jobs = await jobsCollection.find({}).toArray();
    if (user === 'trial') return res.json(jobs.filter(j => j.owner === 'trial'));
    res.json(jobs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs', async (req, res) => {
  try {
    const { prompt, user } = req.body;
    const targetUser = USER_DATABASE[String(user || '').toLowerCase()];
    if (!targetUser) return res.status(403).json({ error: "Unauthorized scope." });

    const currentJobs = await jobsCollection.find({}).toArray();
    if (targetUser.role === 'trial') {
      const activeTrialJobsCount = currentJobs.filter(j => j.owner === 'trial').length;
      if (activeTrialJobsCount >= targetUser.maxJobs) {
        return res.status(422).json({ error: `🚨 Rule Cap Breach: Max ${targetUser.maxJobs} allowed.` });
      }
    }

    const job = await parsePrompt(prompt);
    job.owner = targetUser.role;

    await jobsCollection.insertOne({ ...job });
    activateCronForJob(job);

    res.json({ success: true, job });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/toggle-pause', async (req, res) => {
  try {
    const { id } = req.body;
    const job = await jobsCollection.findOne({ id });
    if (!job) return res.status(404).json({ error: "Pipeline not found." });

    const newStatus = (job.status || 'active') === 'active' ? 'paused' : 'active';
    await jobsCollection.updateOne({ id }, { $set: { status: newStatus } });

    const updatedJob = await jobsCollection.findOne({ id });
    activateCronForJob(updatedJob);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/jobs', async (req, res) => {
  try {
    const { id } = req.query;
    stopCronForJob(id);
    await jobsCollection.deleteOne({ id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- Start Server Lifecycle ---------- */
app.listen(PORT, () => {
  console.log(`🚀 System active on target: http://localhost:${PORT}`);
  connectDatabase();
});