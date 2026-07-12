import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import cron from 'node-cron';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import TelegramBot from 'node-telegram-bot-api';
import nodemailer from 'nodemailer';
import { tavily } from '@tavily/core';

/* ---------- setup ---------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 5000;

const DATA_DIR = path.join(__dirname, '../storage');
const DB_FILE = path.join(DATA_DIR, 'jobs.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const runningCronThreads = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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
  apiKey: naraKey,
  baseURL: 'https://router.bynara.id/v1'
});

/* ---------- Tavily Client ---------- */
const tavilyKey = process.env.TAVILY_API_KEY;
let tvly = null;
if (tavilyKey) {
  tvly = tavily({ apiKey: tavilyKey });
}

/* ---------- storage helpers ---------- */

function initializeStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf8');
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig = {
      defaultMedium: 'site',
      email: '',
      encryptedTelegramOwnerId: '',
      encryptedTelegramAllowedIds: [],
      whatsappBotNumber: '',
      userResume: '',
      encryptedTelegramBotToken: ''
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf8');
  }
}

function readJobsFromFile() {
  initializeStorage();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { return []; }
}

function writeJobsToFile(jobs) {
  initializeStorage();
  fs.writeFileSync(DB_FILE, JSON.stringify(jobs, null, 2), 'utf8');
}

function readConfig() {
  initializeStorage();
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { return {}; }
}

function writeConfig(cfg) {
  initializeStorage();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

/* ---------- Telegram bot setup ---------- */

let telegramBot = null;

function bootTelegramBotEngine() {
  if (telegramBot) {
    try {
      telegramBot.stopPolling();
    } catch (e) {
      console.error('❌ Error stopping bot polling:', e.message);
    }
  }

  const cfg = readConfig();
  const rawToken = cfg.encryptedTelegramBotToken ? decrypt(cfg.encryptedTelegramBotToken) : '';

  if (rawToken && rawToken.trim() !== "") {
    try {
      telegramBot = new TelegramBot(rawToken, { polling: true });
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

      telegramBot.onText(/\/status/, msg => {
        try {
          const jobs = readJobsFromFile();
          const totalJobs = jobs.length;
          const activeJobs = jobs.filter(j => j.status === 'active').length;
          const statusMessage = `📟 *AeonMatrix Runtime Health Profile*\n\n• *Platform Node:* Live (Optimal)\n• *Orchestration Threads:* \`${totalJobs}\` total registered loops.\n• *Active State:* \`${activeJobs}\` operational.\n• *Local Core Baseline Time:* \`${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}\``;
          telegramBot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'Markdown' });
        } catch (err) {
          telegramBot.sendMessage(msg.chat.id, `❌ Error extracting health array: ${err.message}`);
        }
      });

      telegramBot.onText(/\/resume/, msg => {
        const profileContent = cfg.userResume
          ? `📋 *Current Stored Profile Context:* \n\n\`\`\`text\n${cfg.userResume.slice(0, 1000)}${cfg.userResume.length > 1000 ? '... [Truncated]' : ''}\n\`\`\``
          : `⚠️ *No Profile Data Bound.*`;

        telegramBot.sendMessage(msg.chat.id, profileContent, { parse_mode: 'Markdown' });
      });

      telegramBot.on('message', async (msg) => {
        const text = msg.text || '';
        if (text.startsWith('/start') || text.startsWith('/help') || text.startsWith('/status') || text.startsWith('/resume')) return;

        if (text.startsWith('/prompt ')) {
          const promptPayload = text.replace('/prompt ', '').trim();
          await telegramBot.sendMessage(msg.chat.id, '🧠 Intercepting structural prompt... Compiling Automation Pipeline matrix... Layout compiling via NaraRouter.');

          try {
            const jobObject = await parsePrompt(promptPayload);
            jobObject.owner = "admin";

            const jobs = readJobsFromFile();
            jobs.push(jobObject);
            writeJobsToFile(jobs);
            activateCronForJob(jobObject);

            telegramBot.sendMessage(msg.chat.id, `✅ *Loop Registered Successfully!*\n\n• *Pipeline:* ${jobObject.name}\n• *Schedule Mapping:* \`${jobObject.schedule}\``, { parse_mode: 'Markdown' });
          } catch (err) {
            telegramBot.sendMessage(msg.chat.id, `❌ *Failed to compile prompt pipeline:* ${err.message}`);
          }
        } else {
          telegramBot.sendChatAction(msg.chat.id, 'typing');
          try {
            const systemInstruction = `You are the primary cognitive routing and execution node of the Hermes Automation Matrix (AeonMatrix).
Current Reference Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}.

CRITICAL ENGAGEMENT PROTOCOLS (PRODUCTION-GRADE CONCISENESS):
1. STAGE-BASED RESPONDING: Never dump a massive wall of feature sets or bullet points all at once. Keep casual conversational turns under 3-4 lines maximum. 
2. INFORMATIVE YET COMPACT: When answering "what can you do," summarize your utility in 2 clear, punchy sentences instead of listing everything out. Let the user guide the deep dives.
3. CONTEXTUAL AWARENESS: You have access to the user's resume below. Use it as a quiet reference graph. Address him as Aryan. Never parrot back his full project titles or full stack lists out of nowhere unless he explicitly asks for a technical audit on them.

[USER RESUME PROFILE DATA]:
${cfg.userResume || 'No user resume profile uploaded.'}`;

            const responseCall = await naraClient.chat.completions.create({
              model: 'mistral-large',
              temperature: 0.5,
              messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: text }]
            });

            let replyMessage = responseCall.choices?.[0]?.message?.content || "Empty content payload.";

            // Clean pass protection for markdown formats
            replyMessage = replyMessage.replace(/^```markdown\n?/i, '').replace(/```$/, '');

            try {
              await telegramBot.sendMessage(msg.chat.id, replyMessage, { parse_mode: 'Markdown' });
            } catch (mdError) {
              console.warn("⚠️ Telegram Markdown parsing failed, shifting to plain text delivery:", mdError.message);
              const cleanPlainText = replyMessage.replace(/[\*\_`#\-]/g, '');
              await telegramBot.sendMessage(msg.chat.id, cleanPlainText);
            }
          } catch (err) {
            console.error('❌ Conversational routing error:', err.message);
            telegramBot.sendMessage(msg.chat.id, `⚠️ Cognitive node exception: ${err.message}`);
          }
        }
      });
    } catch (err) {
      console.error('⚠️ Telegram initialization exception caught:', err.message);
    }
  } else {
    console.warn('⚠️ No Bot Token configured inside App UI Storage Setup.');
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

  // Hardened regex: handles spaces, no spaces, full words, and single characters (s, m, h, min, sec, hr)
  const timer = text.match(/\b(?:timer|set timer|remind me|after|in)\s*(\d+)\s*(second|minute|hour|min|sec|hr|h|m|s)s?\b/)
    || text.match(/\bafter\s*(\d+)\s*(second|minute|hour|min|sec|hr|h|m|s)s?\b/)
    || text.match(/\b(\d+)\s*(s|m|h)\b/); // Catches "40s", "10m" cleanly

  const nowStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  let target = new Date(nowStr);
  let isOneOff = true; // Default custom timers explicitly to true for safety

  if (timer) {
    // Determine which capture group holds the number and unit based on regex match indices
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

  // Expose precise local reference parameters so the LLM understands standard Indian Standard time loops
  const localContextTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });

  const system = `You are a scheduling parser. Return raw JSON matching this structure exactly:\n{\n  "name": "string",\n  "description": "string",\n  "schedule": "6-field cron",\n  "isOneOff": boolean,\n  "deliveryMedium": "telegram"|"email"|"site",\n  "task": "string"\n}\n\nCRITICAL CONTEXT RULES:\n1. Baseline Reference Time: ${localContextTime}.\n2. CRON REQUIREMENT: You MUST yield a strict 5 or 6-field standard cron string. NEVER include a 7th field for the year (e.g., Do NOT attach '2026').\n3. FOR ONE-OFF TIMER REQUESTS (e.g. 'after 1 min'): Calculate the exact absolute target minute and generate a static one-off run specification field string like: '0 MM HH DD M *'. Never return intervals like '*/1' for specific delayed reminder notifications.`;

  const completion = await naraClient.chat.completions.create({
    model: 'mistral-large', response_format: { type: 'json_object' }, temperature: 0,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
  });
  return JSON.parse(completion.choices?.[0]?.message?.content || '{}');
}

async function parsePrompt(prompt) {
  let parsed;
  const textCheck = String(prompt).toLowerCase();
  let localFallbackForced = false;

  // INTERCEPT: If it is a clear basic timer/reminder string command statement, use local absolute calculation parameters directly
  if (/\b(after|in|timer|remind)\b/.test(textCheck) && !/\b(every|each|search|find|jobs)\b/.test(textCheck)) {
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

  const cfg = readConfig();
  const plainOwnerId = cfg.encryptedTelegramOwnerId ? decrypt(cfg.encryptedTelegramOwnerId) : '';

  // DYNAMIC SMART ROUTING: If prompt manually overrides target distribution arrays, force assignment properties
  let finalMedium = parsed.deliveryMedium || cfg.defaultMedium || 'site';
  if (/\b(telegram|tg|bot)\b/.test(textCheck)) finalMedium = 'telegram';
  if (/\b(email|mail)\b/.test(textCheck)) finalMedium = 'email';

  // Fix 7-field or corrupted year string patterns returned by models out of bounds
  let safeSchedule = parsed.schedule || "0 * * * * *";
  if (safeSchedule.split(' ').length > 6) {
    console.warn(`⚠️ [DEBUG LOG] Detected broken 7-field cron structure: "${safeSchedule}". Correcting mapping parameters...`);
    const parts = safeSchedule.split(' ');
    safeSchedule = `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]} ${parts[4]} *`;
  }
  if (safeSchedule.startsWith('*/1 ')) {
    console.warn(`⚠️ [DEBUG LOG] Detected broken '*/1' runtime instruction. Standardizing layout to single match step ticks.`);
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

function appendExecutionLog(jobId, logText) {
  const jobs = readJobsFromFile();
  const index = jobs.findIndex(j => j.id === jobId);
  if (index === -1) return;
  if (!jobs[index].logs) jobs[index].logs = [];
  jobs[index].logs.unshift({ timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }), message: logText });
  if (jobs[index].logs.length > 10) jobs[index].logs.pop();
  writeJobsToFile(jobs);
}

async function sendChannelNotification(job, logText) {
  const cfg = readConfig();
  const medium = job.deliveryMedium || cfg.defaultMedium || 'site';
  const payloadText = `🤖 [Hermes Matrix Execution Report]\n\nPipeline Run: ${job.name}\n\nOutput Log:\n${logText}`;

  try {
    if (medium === 'telegram') {
      if (telegramBot) {
        const plainOwnerId = cfg.encryptedTelegramOwnerId ? decrypt(cfg.encryptedTelegramOwnerId) : '';
        const targetChatId = job.deliveryTargetTelegramChatId || plainOwnerId;

        if (targetChatId) {
          await telegramBot.sendMessage(targetChatId, payloadText);
        } else {
          console.warn('⚠️ Telegram dispatch skipped: Missing target structural chat registration details.');
        }
      } else {
        console.warn('⚠️ Bot process engine not running.');
      }
    }

    if (medium === 'email' && mailer) {
      const toAddress = job.deliveryTargetEmail || cfg.email;
      if (toAddress) {
        await mailer.sendMail({ from: SMTP_USER, to: toAddress, subject: `Hermes AI Alert: ${job.name}`, text: payloadText });
        console.log(`✅ Outbound SMTP mail alert fired to: ${toAddress}`);
      }
    }
  } catch (err) {
    console.error('❌ System notification pipeline failure:', err.message);
  }
}

async function executeAIResearchBrain(job) {
  console.log(`⚡ [DEBUG LOG] CRON TRIGGER FIRED: Processing Job Core ID "${job.id}" (${job.name})`);
  try {
    const cfg = readConfig();
    let analysisContext = "";
    const contextEvaluator = job.task.toLowerCase();
    const demandsWebAccess = ['search', 'find', 'jobs', 'latest', 'top 10', 'market'].some(k => contextEvaluator.includes(k));

    if (demandsWebAccess && tvly) {
      appendExecutionLog(job.id, "🔍 Initiating live Tavily API web search automation routine...");
      try {
        const searchResults = await tvly.search(job.task, { searchDepth: "advanced", maxResults: 5 });
        analysisContext = JSON.stringify(searchResults.results);
      } catch { appendExecutionLog(job.id, "⚠️ Web Crawler search engine timed out."); }
    }

    appendExecutionLog(job.id, "🧠 Processing parameters inside LLM phase...");

    const systemInstruction = `You are the primary cognitive routing and execution node of the Hermes Automation Matrix.\nCurrent Reference Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}.\n\nIF the task is a simple statement, command, or reminder, you MUST act as a pass-through node. Output ONLY the user's literal intended message text word-for-word without any extra markdown titles or templates.`;

    const modelCall = await naraClient.chat.completions.create({
      model: 'mistral-large', temperature: 0.3,
      messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: job.task }]
    });

    const report = modelCall.choices?.[0]?.message?.content || "Loop executed safely.";
    appendExecutionLog(job.id, report);
    await sendChannelNotification(job, report);
  } catch (err) {
    console.error('❌ Thread runtime execution processing error:', err.message);
    appendExecutionLog(job.id, `❌ Runtime Error: ${err.message}`);
  }
}

function activateCronForJob(job) {
  stopCronForJob(job.id);
  if (job.status === 'paused' || !isValidCron(job.schedule)) return;

  const task = cron.schedule(job.schedule, async () => {
    await executeAIResearchBrain(job);

    if (job.isOneOff) {
      setTimeout(() => {
        let jobs = readJobsFromFile();
        writeJobsToFile(jobs.filter(j => j.id !== job.id));
        stopCronForJob(job.id);
      }, 5000);
    }
  });
  runningCronThreads.set(job.id, task);
}

function bootstrapSchedules() {
  readJobsFromFile().map(normalizeJob).forEach(job => activateCronForJob(job));
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

app.get('/api/config', (req, res) => {
  const cfg = readConfig();
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
  delete responseConfig.encryptedTelegramBotToken;
  delete responseConfig.encryptedTelegramOwnerId;
  delete responseConfig.encryptedTelegramAllowedIds;
  res.json(responseConfig);
});

app.post('/api/config', (req, res) => {
  try {
    const { defaultMedium = 'site', email = '', telegramOwnerId = '', userResume = '', telegramBotToken = '', telegramAllowedIds = '' } = req.body;
    const cfg = readConfig();

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

    writeConfig(cfg);
    bootTelegramBotEngine();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs', (req, res) => {
  const { user } = req.query;
  const jobs = readJobsFromFile();
  if (user === 'trial') return res.json(jobs.filter(j => j.owner === 'trial'));
  res.json(jobs);
});

app.post('/api/jobs', async (req, res) => {
  try {
    const { prompt, user } = req.body;
    const targetUser = USER_DATABASE[String(user || '').toLowerCase()];
    if (!targetUser) return res.status(403).json({ error: "Unauthorized scope." });

    const currentJobs = readJobsFromFile();
    if (targetUser.role === 'trial') {
      const activeTrialJobsCount = currentJobs.filter(j => j.owner === 'trial').length;
      if (activeTrialJobsCount >= targetUser.maxJobs) {
        return res.status(422).json({ error: `🚨 Rule Cap Breach: Max ${targetUser.maxJobs} allowed.` });
      }
    }

    const job = await parsePrompt(prompt);
    job.owner = targetUser.role;

    currentJobs.push(job);
    writeJobsToFile(currentJobs);
    activateCronForJob(job);

    res.json({ success: true, job });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/toggle-pause', (req, res) => {
  const { id } = req.body;
  const jobs = readJobsFromFile();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return res.status(404).json({ error: "Pipeline not found." });

  jobs[idx].status = (jobs[idx].status || 'active') === 'active' ? 'paused' : 'active';
  writeJobsToFile(jobs);
  activateCronForJob(jobs[idx]);
  res.json({ success: true });
});

app.delete('/api/jobs', (req, res) => {
  const { id } = req.query;
  stopCronForJob(id);
  writeJobsToFile(readJobsFromFile().filter(j => j.id !== id));
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 System active on target: http://localhost:${PORT}`);
  initializeStorage();
  bootstrapSchedules();
  bootTelegramBotEngine();
});