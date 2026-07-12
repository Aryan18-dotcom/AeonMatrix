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

/* ---------- setup ---------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 5000;
const runningCronThreads = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

/* ---------- MongoDB Connection Setup ---------- */

const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error('❌ Fatal Environment Constraint: MONGO_URI is missing.');
  process.exit(1);
}

const mongoClient = new MongoClient(mongoURI);
let db, jobsCollection, configCollection;

async function connectDatabase() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('AeonMatrix'); 
    jobsCollection = db.collection('jobs');
    configCollection = db.collection('config');
    console.log('📦 Connected cleanly to free MongoDB MongoDB Atlas cluster layer.');

    await bootstrapSchedules();
    bootTelegramBotEngine();
  } catch (err) {
    console.error('❌ MongoDB Connection Failure:', err.message);
  }
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
  timeout: 30000,   
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
  if (isBotBooting) return;
  isBotBooting = true;

  if (telegramBot) {
    try {
      await telegramBot.stopPolling();
      telegramBot = null;
    } catch (e) {
      console.error('❌ Error stopping bot polling gracefully:', e.message);
    }
  }

  const cfg = await getSystemConfig();
  const rawToken = cfg.encryptedTelegramBotToken ? decrypt(cfg.encryptedTelegramBotToken) : '';

  if (rawToken && rawToken.trim() !== "") {
    try {
      telegramBot = new TelegramBot(rawToken, { polling: { autoStart: false } });
      await telegramBot.deleteWebhook(); 
      await telegramBot.startPolling();
      
      console.log('📡 Telegram Bot Matrix Link Connected and Active.');

      telegramBot.setMyCommands([
        { command: 'start', description: 'Initialize the Hermes connection node' },
        { command: 'help', description: 'Show comprehensive command operational guide' },
        { command: 'status', description: 'Fetch system matrix current metrics' },
        { command: 'resume', description: 'Preview active stored CV profile text' }
      ]).catch(err => console.error('⚠️ Failed to register command list UI hints:', err.message));

      telegramBot.onText(/\/start/, msg => {
        telegramBot.sendMessage(msg.chat.id, '🛡️ *AeonMatrix Active Node Linked.*\n\nUse `/prompt <command>` to inject continuous automation maps dynamically, or type anything casually to chat with the engine.', { parse_mode: 'Markdown' });
      });

      telegramBot.onText(/\/help/, msg => {
        const helpMessage = `📖 *AeonMatrix Operator Guide*\n\n🤖 *Core Execution Engines:*\n• \`/prompt <instruction>\` — Compiles a natural language request into a 6-field cron thread array loop.\n• _Plain Text_ — Chat directly with the cognitive brain node.\n\n🛠️ *System Status Arrays:*\n• \`/status\` — Reviews active background orchestration pools.\n• \`/resume\` — Inspects the currently cached vector layout file content.`;
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

      telegramBot.on('message', async (msg) => {
        const text = msg.text || '';
        if (text.startsWith('/start') || text.startsWith('/help') || text.startsWith('/status') || text.startsWith('/resume')) return;

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

            const requestsMutation = /\b(change|update|modify|alter|edit|pause|stop|resume|start|delete|purge)\b/i.test(text) && 
                                    /\b(cron|time|schedule|loop|job|pipeline|pool)\b/i.test(text);

            if (requestsMutation) {
const mutationSystemInstruction = `You are the core database mutation parser of AeonMatrix.
Current Baseline Reference Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' })}.

Your job is to read the user's update request, cross-reference it against the [ACTIVE JOBS POOL], and return a strict JSON action output map matching this scheme perfectly:
{
  "action": "update_schedule" | "pause_job" | "resume_job" | "delete_job" | "none",
  "targetJobId": "string_of_matched_job_id",
  "newCronSchedule": "6-field cron string or null if action doesn't require schedule change",
  "reason": "Clear explanation of what change you are processing"
}

CRITICAL RULES FOR SCHEDULE MODIFICATION:
1. COMPLETE OVERWRITE RULE: When changing a schedule from a range (e.g., '30-40') to a specific single time point (e.g., '9:20am'), you MUST completely clear out the range and replace the field with the single absolute number target (e.g., '0 20 9 13 7 *'). Never preserve old hyphens or interval tokens.

[ACTIVE JOBS POOL]:
${JSON.stringify(compactJobsMatrix, null, 2)}`;

              const mutationCall = await naraClient.chat.completions.create({
                model: 'mistral-large',
                response_format: { type: 'json_object' },
                temperature: 0,
                messages: [{ role: 'system', content: mutationSystemInstruction }, { role: 'user', content: text }]
              });

              const mutationResult = JSON.parse(mutationCall.choices?.[0]?.message?.content || '{}');

if (mutationResult.action && mutationResult.action !== 'none' && mutationResult.targetJobId) {
                const targetJob = await jobsCollection.findOne({ id: mutationResult.targetJobId });
                if (targetJob) {
                  if (mutationResult.action === 'update_schedule' && mutationResult.newCronSchedule) {
                    await jobsCollection.updateOne({ id: targetJob.id }, { $set: { schedule: mutationResult.newCronSchedule } });
                    const updated = await jobsCollection.findOne({ id: targetJob.id });
                    activateCronForJob(updated);
                    
                    const updateConfirmation = `⚙️ *AeonMatrix Database Sync Matrix Complete*\n\n• *Pipeline:* ${escapeMarkdown(targetJob.name)}\n• *Update Action:* Schedule Shifted\n• *New Target Cron Map:* \`${mutationResult.newCronSchedule}\`\n• *Status:* Dynamic Loop Recalibrated Live.`;
                    
                    try {
                      return await telegramBot.sendMessage(msg.chat.id, updateConfirmation, { parse_mode: 'Markdown' });
                    } catch {
                      return await telegramBot.sendMessage(msg.chat.id, updateConfirmation.replace(/[\*\_`#\-]/g, ''));
                    }
                  } 
                  else if (mutationResult.action === 'pause_job') {
                    await jobsCollection.updateOne({ id: targetJob.id }, { $set: { status: 'paused' } });
                    stopCronForJob(targetJob.id);
                    
                    const pauseConfirmation = `⏸ *Pipeline Block Paused Successfully*\n\n• *Thread Name:* ${escapeMarkdown(targetJob.name)}\n• *State:* Halted in Thread PoolRegistry.`;
                    
                    try {
                      return await telegramBot.sendMessage(msg.chat.id, pauseConfirmation, { parse_mode: 'Markdown' });
                    } catch {
                      return await telegramBot.sendMessage(msg.chat.id, pauseConfirmation.replace(/[\*\_`#\-]/g, ''));
                    }
                  } 
                  else if (mutationResult.action === 'resume_job') {
                    await jobsCollection.updateOne({ id: targetJob.id }, { $set: { status: 'active' } });
                    const updated = await jobsCollection.findOne({ id: targetJob.id });
                    activateCronForJob(updated);
                    
                    const resumeConfirmation = `▶ *Pipeline Vector Re-Activated*\n\n• *Thread Name:* ${escapeMarkdown(targetJob.name)}\n• *State:* Active standard looping thread synced.`;
                    
                    try {
                      return await telegramBot.sendMessage(msg.chat.id, resumeConfirmation, { parse_mode: 'Markdown' });
                    } catch {
                      return await telegramBot.sendMessage(msg.chat.id, resumeConfirmation.replace(/[\*\_`#\-]/g, ''));
                    }
                  }
                  else if (mutationResult.action === 'delete_job') {
                    stopCronForJob(targetJob.id);
                    await jobsCollection.deleteOne({ id: targetJob.id });
                    
                    const deleteConfirmation = `🗑 *Thread Purged Cleanly*\n\n• *Wiped Pipeline:* ${escapeMarkdown(targetJob.name)}\n• *Database State:* Document records removed.`;
                    
                    try {
                      return await telegramBot.sendMessage(msg.chat.id, deleteConfirmation, { parse_mode: 'Markdown' });
                    } catch {
                      return await telegramBot.sendMessage(msg.chat.id, deleteConfirmation.replace(/[\*\_`#\-]/g, ''));
                    }
                  }
                }
              }
            }

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
    } catch (err) {
      console.error('⚠️ Telegram initialization exception caught:', err.message);
    } finally {
      isBotBooting = false;
    }
  } else {
    console.warn('⚠️ No Bot Token configured inside App UI Storage Setup.');
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
    owner: job.owner || 'admin'
  };
}

function isValidCron(expr) { return typeof expr === 'string' && expr.trim() !== '' && cron.validate(expr); }
function stopCronForJob(jobId) {
  const active = runningCronThreads.get(jobId);
  active?.stop?.();
  active?.destroy?.();
  runningCronThreads.delete(jobId);
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
  
  const temporalContext = {
    current_time: now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', timeStyle: 'short' }),
    current_date: now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }),
    day_of_week: now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }),
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

CRITICAL TEMPORAL CONTEXT MATRIX:
${JSON.stringify(temporalContext, null, 2)}

CRITICAL CONTEXT RULES:
1. DATE MATH ENFORCEMENT: Use the temporal parameters above to calculate exact target offsets. For example, if current_date is "Jul 12, 2026" and the user asks for "tomorrow at 9:30am", the schedule parameter MUST resolve to the 13th day of the 7th month: "0 30 9 13 7 *".
2. NO YEAR FIELDS: Yield a standard 5 or 6 field standard cron syntax string. Do not append a 7th year segment under any circumstances.
3. ONETIME EVENT RESOLUTION: For relative targets ("after 5 mins", "tomorrow morning"), compute the absolute future date markers relative to the baseline date block and map them cleanly to standard structural cron fields.`;

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
  const payloadText = `🤖 [Hermes Matrix Execution Report]\n\nPipeline Run: ${job.name}\n\nOutput Log:\n${logText}`;

  try {
    if (medium === 'telegram') {
      if (telegramBot) {
        const plainOwnerId = cfg.encryptedTelegramOwnerId ? decrypt(cfg.encryptedTelegramOwnerId) : '';
        const targetChatId = job.deliveryTargetTelegramChatId || plainOwnerId;

        if (targetChatId) {
          try {
            await telegramBot.sendMessage(targetChatId, payloadText, { parse_mode: 'Markdown' });
          } catch {
            await telegramBot.sendMessage(targetChatId, payloadText.replace(/[\*\_`#\-]/g, ''));
          }
        }
      }
    }

    if (medium === 'email' && mailer) {
      const toAddress = job.deliveryTargetEmail || cfg.email;
      if (toAddress) {
        await mailer.sendMail({ from: SMTP_USER, to: toAddress, subject: `Hermes AI Alert: ${job.name}`, text: payloadText });
      }
    }
  } catch (err) {
    console.error('❌ System notification pipeline failure:', err.message);
  }
}

async function executeAIResearchBrain(job) {
  try {
    const contextEvaluator = job.task.toLowerCase();
    
    const isSimpleReminder = job.name.toLowerCase().includes('reminder') || 
                             job.name.toLowerCase().includes('pipeline loop') ||
                             /\b(timer|remind|alert|wake me up|meeting tomorrow|appointment|meating)\b/.test(contextEvaluator);

    if (isSimpleReminder) {
      const cleanTaskText = job.task.replace(/^(after \d+\s*\w+\s*|reminder\s*|tomorrow\s*)/i, '');
      const reminderOutput = `⏰ **AeonMatrix Task Alert Engine**\n\n• **Notification:** ${cleanTaskText}\n• **Status:** Active schedule execution successful.`;
      await appendExecutionLog(job.id, reminderOutput);
      await sendChannelNotification(job, reminderOutput);
      return;
    }

    let analysisContext = "";
    const demandsWebAccess = ['search', 'find', 'jobs', 'latest', 'top 10', 'market', 'food', 'place', 'company', 'website', 'near', 'list', 'facts'].some(k => contextEvaluator.includes(k));

    if (demandsWebAccess && tvly) {
      await appendExecutionLog(job.id, "🔍 Initiating live Tavily API high-precision web search...");
      try {
        const searchResults = await tvly.search(job.task, { searchDepth: "advanced", maxResults: 6 });
        analysisContext = JSON.stringify(searchResults.results);
      } catch (err) { 
        await appendExecutionLog(job.id, "⚠️ Web Crawler search engine encountered a timeout exception."); 
      }
    }

    await appendExecutionLog(job.id, "🧠 Synthesizing crawled parameters inside cognitive layer...");

    const systemInstruction = `You are a precise data synthesis engine of the AeonMatrix cloud framework.
Current Reference Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}.

STRICT INSTRUCTION PROTOCOLS:
1. OUTPUT DYNAMICS: Create a highly polished layout using clear markdown headings, bold accents, spaced lines, and descriptive emojis.
2. ANCHORED GROUNDING: Stick strictly to the literal facts provided in the live internet search context below. Do not guess links, numbers, or company structures. If a website or place coordinates link isn't verified in the data, print "Website/Link: Not verified in current live records".
3. MAP LINK STANDARD: Never output hallucinated map links. Use this syntax: https://www.google.com/maps/search/?api=1&query=urlencoded_query_string

[LIVE CRAWLED DATA ENVIRONMENT]:
${analysisContext || "No background internet data chunk provided. Rely completely on literal structural parameters."}`;

    const modelCall = await naraClient.chat.completions.create({
      model: 'mistral-large',
      temperature: 0.1, 
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: `${job.task} (Compile the complete, well-structured response report matching the task directives).` }
      ]
    });

    const report = modelCall.choices?.[0]?.message?.content || "Loop executed safely.";
    await appendExecutionLog(job.id, report);
    await sendChannelNotification(job, report);
  } catch (err) {
    console.error('❌ Thread runtime execution processing error:', err.message);
    const errorReport = `❌ Runtime Error: ${err.message}`;
    await appendExecutionLog(job.id, errorReport);
    await sendChannelNotification(job, errorReport);
  }
}

function activateCronForJob(job) {
  stopCronForJob(job.id);
  if (job.status === 'paused' || !isValidCron(job.schedule)) return;

  const task = cron.schedule(job.schedule, async () => {
    executeAIResearchBrain(job).catch(err => {
      console.error(`❌ Non-blocking execution catch on node [${job.id}]:`, err.message);
    });

    if (job.isOneOff) {
      setTimeout(async () => {
        try {
          await jobsCollection.deleteOne({ id: job.id });
          stopCronForJob(job.id);
        } catch (e) {
          console.error('❌ Failed to clear transient entry:', e.message);
        }
      }, 5000);
    }
  });
  runningCronThreads.set(job.id, task);
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