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
      telegramOwnerId: '',
      telegramAllowedIds: [],
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

/* ---------- Telegram bot setup (Encrypted Init) ---------- */

let telegramBot = null;

function bootTelegramBotEngine() {
  if (telegramBot) {
    try { telegramBot.stopPolling(); } catch { }
  }

  const cfg = readConfig();
  const rawToken = cfg.encryptedTelegramBotToken ? decrypt(cfg.encryptedTelegramBotToken) : process.env.TELEGRAM_BOT_TOKEN;

  if (rawToken && rawToken.trim() !== "") {
    try {
      telegramBot = new TelegramBot(rawToken, { polling: true });
      console.log('📡 Telegram Bot Matrix Link Connected and Active.');

      telegramBot.onText(/\/start/, msg => {
        telegramBot.sendMessage(msg.chat.id, '🛡️ Hermes Matrix Node Linked. Use `/prompt <command>` to inject continuous automation maps dynamically.');
      });

      telegramBot.on('message', async (msg) => {
        const text = msg.text || '';
        if (text.startsWith('/prompt ')) {
          const promptPayload = text.replace('/prompt ', '').trim();
          telegramBot.sendMessage(msg.chat.id, '🧠 Intercepting structural prompt... Compiling Automation Pipeline matrix... Layout compiling via NaraRouter.');

          try {
            const jobObject = await parsePrompt(promptPayload);
            jobObject.owner = "admin"; // Telegram direct inputs default to Admin parameters

            const jobs = readJobsFromFile();
            jobs.push(jobObject);
            writeJobsToFile(jobs);
            activateCronForJob(jobObject);

            telegramBot.sendMessage(msg.chat.id, `✅ Loop Registered Successfully!\nPipeline Name: ${jobObject.name}\nSchedule Target: ${jobObject.schedule}`);
          } catch (err) {
            telegramBot.sendMessage(msg.chat.id, `❌ Failed to map incoming prompt payload: ${err.message}`);
          }
        }
      });
    } catch (err) {
      console.error('⚠️ Telegram initialization exception caught:', err.message);
    }
  } else {
    console.warn('⚠️ No Bot Token configured. Telegram command listener suspended.');
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
function stopCronForJob(jobId) { const active = runningCronThreads.get(jobId); active?.stop?.(); active?.destroy?.(); runningCronThreads.delete(jobId); }
function toCron6(date) { return `${date.getSeconds()} ${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`; }

function fallbackParsePrompt(prompt) {
  const text = String(prompt || '').toLowerCase();
  const now = new Date();
  const timer = text.match(/\b(?:timer|set timer|remind me)\s*(\d+)\s*(second|minute|hour)s?\b/);
  if (timer) {
    const n = parseInt(timer[1], 10);
    let target = new Date(now);
    if (timer[2].startsWith('sec')) target = new Date(now.getTime() + n * 1000);
    if (timer[2].startsWith('min')) target = new Date(now.getTime() + n * 60 * 1000);
    if (timer[2].startsWith('hou')) target = new Date(now.getTime() + n * 60 * 60 * 1000);
    return { schedule: toCron6(target), isOneOff: true };
  }
  return { schedule: "0 */5 * * * *", isOneOff: false };
}

async function naraParsePrompt(prompt) {
  if (!naraKey) throw new Error('NARA_API_KEY not configured');
  const now = new Date().toISOString();
  const system = `You are a scheduling parser. Return raw JSON matching this structure exactly:\n{\n  "name": "string",\n  "description": "string",\n  "schedule": "6-field cron",\n  "isOneOff": boolean,\n  "deliveryMedium": "telegram"|"email"|"site",\n  "task": "string"\n}\nBaseline Context: ${now}`;

  const completion = await naraClient.chat.completions.create({
    model: 'mistral-large', response_format: { type: 'json_object' }, temperature: 0,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
  });
  return JSON.parse(completion.choices?.[0]?.message?.content || '{}');
}

async function parsePrompt(prompt) {
  let parsed;
  try { parsed = await naraParsePrompt(prompt); } catch { parsed = fallbackParsePrompt(prompt); }
  const cfg = readConfig();
  return {
    id: String(Date.now()),
    name: String(parsed.name || 'AI Pipeline Loop').slice(0, 60),
    description: String(parsed.description || prompt).slice(0, 200),
    schedule: isValidCron(parsed.schedule) ? parsed.schedule : "0 */2 * * * *",
    isOneOff: !!parsed.isOneOff,
    task: String(parsed.task || prompt),
    status: 'active', logs: [], channelOverride: null,
    deliveryMedium: parsed.deliveryMedium || cfg.defaultMedium || 'site',
    deliveryTargetTelegramChatId: cfg.telegramOwnerId || null,
    deliveryTargetEmail: cfg.email || null,
    owner: "admin"
  };
}

function appendExecutionLog(jobId, logText) {
  const jobs = readJobsFromFile();
  const index = jobs.findIndex(j => j.id === jobId);
  if (index === -1) return;
  if (!jobs[index].logs) jobs[index].logs = [];
  jobs[index].logs.unshift({ timestamp: new Date().toLocaleString(), message: logText });
  if (jobs[index].logs.length > 10) jobs[index].logs.pop();
  writeJobsToFile(jobs);
}

async function sendChannelNotification(job, logText) {
  const cfg = readConfig();
  const medium = job.deliveryMedium || cfg.defaultMedium || 'site';
  const payloadText = `🤖 [Hermes Matrix Execution Report]\n\nPipeline Run: ${job.name}\n\nOutput Log:\n${logText}`;
  try {
    if (medium === 'telegram' && telegramBot) {
      const targetChatId = job.deliveryTargetTelegramChatId || cfg.telegramOwnerId;
      if (!targetChatId) return;
      const MAX_LENGTH = 4000;
      if (payloadText.length > MAX_LENGTH) {
        for (let i = 0; i < payloadText.length; i += MAX_LENGTH) {
          await telegramBot.sendMessage(targetChatId, payloadText.substring(i, i + MAX_LENGTH));
          await new Promise(r => setTimeout(r, 500));
        }
      } else {
        await telegramBot.sendMessage(targetChatId, payloadText);
      }
    } else if (medium === 'email' && mailer) {
      const toAddress = job.deliveryTargetEmail || cfg.email;
      if (!toAddress) return;
      await mailer.sendMail({ from: SMTP_USER, to: toAddress, subject: `Hermes AI Alert: ${job.name}`, text: payloadText });
    }
  } catch (err) { console.error('❌ Notification channel drop:', err.message); }
}

async function executeAIResearchBrain(job) {
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

    appendExecutionLog(job.id, "🧠 Synthesizing parameters inside LLM phase...");

    const systemInstruction = `You are the primary cognitive routing and execution node of the Hermes Automation Matrix.
Current Reference Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}.

Your absolute directive is to dynamically adapt your behavioral mode based entirely on the user's task intent:

1. MESSAGE & REMINDER MODE (Simple Greetings, Commands, or Static Reminders):
   - IF the task is a simple statement, greeting, or basic text alert (e.g., "hii", "remind me to drink water", "send an alert test"), you MUST act as a pass-through node.
   - Output ONLY the user's literal intended message or reminder text word-for-word. 
   - Strict rule: Do NOT add headers, markdown templates, formatting wrappers, or meta-commentary.

2. RESEARCH & JOB MATCHING MODE (Complex data aggregation, web lookups, or profiles):
   - IF the task involves analytical processing, tracking live web statuses, or career lookups (e.g., "get top job openings", "search market status"), synthesize an ultra-impactful, executive summary report.
   - Strict length control: Keep the total report clean and UNDER 1500 characters. Get straight to the value points.
   - Strict link accuracy rule: You MUST extract the exact literal "url" fields present within the provided Web Data below and attach them explicitly inline alongside every single listing as clickable anchors (e.g., "[Apply Here](URL)"). Never truncate, modify, or hallucinate a hyperlink.
   - Formatting: Use precise, compact markdown bullet points (\`**Bold Title**\`, \`-\`, \`*\`). Avoid broken line breaks or nested indentation spaces.

----------------------------------------
PROVIDED MATRIX DATA CONTEXT:
----------------------------------------
[LIVE CRAWLED WEB CONTEXT]:
${analysisContext}

[USER RESUME PROFILE DATA]:
${cfg.userResume || 'No user resume profile uploaded to config databases.'}
`;

    const modelCall = await naraClient.chat.completions.create({
      model: 'mistral-large', temperature: 0.3,
      messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: job.task }]
    });

    const report = modelCall.choices?.[0]?.message?.content || "Loop executed safely.";
    appendExecutionLog(job.id, report);
    await sendChannelNotification(job, report);
  } catch (err) { appendExecutionLog(job.id, `❌ Runtime Error: ${err.message}`); }
}

function activateCronForJob(job) {
  stopCronForJob(job.id);
  if (job.status === 'paused' || !isValidCron(job.schedule)) return;

  const task = cron.schedule(job.schedule, async () => {
    await executeAIResearchBrain(job);
    if (job.isOneOff) {
      let jobs = readJobsFromFile();
      writeJobsToFile(jobs.filter(j => j.id !== job.id));
      stopCronForJob(job.id);
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
  // Never pass raw encrypted strings to client ui
  const responseConfig = { ...cfg, telegramBotToken: cfg.encryptedTelegramBotToken ? '••••••••••••••••••••••••' : '' };
  delete responseConfig.encryptedTelegramBotToken;
  res.json(responseConfig);
});

app.post('/api/config', (req, res) => {
  try {
    const { defaultMedium = 'site', email = '', telegramOwnerId = '', userResume = '', telegramBotToken = '' } = req.body;
    const cfg = readConfig();

    cfg.defaultMedium = defaultMedium;
    cfg.email = email.trim();
    cfg.telegramOwnerId = telegramOwnerId.trim();
    cfg.userResume = userResume.trim();

    if (telegramBotToken && telegramBotToken !== '••••••••••••••••••••••••') {
      cfg.encryptedTelegramBotToken = encrypt(telegramBotToken.trim());
    }

    writeConfig(cfg);
    bootTelegramBotEngine(); // Hot reload loop connections
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
        return res.status(422).json({ error: `🚨 Rule Cap Breach: Trial profiles are strictly rate-limited to a maximum of ${targetUser.maxJobs} active parameters simultaneously.` });
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