/* ============================================================
   Revora backend
   ------------------------------------------------------------
   Two responsibilities:
     1. /api/ai            — securely proxy AI chat calls to Groq
                             so the API key lives on the server,
                             never in the browser.
     2. /api/storage/*     — persistent, per-user key/value store
                             (replaces the browser-only localStorage
                             / artifact storage the frontend used).
   Plus it serves index.html so the whole app runs from one origin.

   Where do API keys go?  ->  the .env file next to this file.
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- tiny .env loader (no extra dependency) ---------- */
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip surrounding quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// Vision-capable model, used only for reading text out of uploaded photos.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/* ============================================================
   PERSISTENT KEY/VALUE STORE
   Single JSON file loaded into memory, written back atomically
   on every change. Fine for this app's scale, zero native deps.
============================================================ */
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let store = {};
try {
  if (fs.existsSync(STORE_FILE)) store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) || {};
} catch (e) {
  console.error('Could not read store.json, starting empty:', e.message);
  store = {};
}

let saveQueued = false;
function persistStore() {
  // debounce: collapse bursts of writes into one flush
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    try {
      const tmp = STORE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, STORE_FILE); // atomic swap
    } catch (e) {
      console.error('Failed to persist store:', e.message);
    }
  });
}

/* ============================================================
   APP
============================================================ */
const app = express();
app.use(express.json({ limit: '5mb' }));

/* ---------- Storage API ---------- */
app.get('/api/storage/get', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'key required' });
  const has = Object.prototype.hasOwnProperty.call(store, key);
  res.json({ value: has ? store[key] : null });
});

app.post('/api/storage/set', (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  store[key] = value;
  persistStore();
  res.json({ ok: true });
});

app.get('/api/storage/list', (req, res) => {
  const prefix = req.query.prefix || '';
  const keys = Object.keys(store).filter(k => k.startsWith(prefix));
  res.json({ keys });
});

app.post('/api/storage/delete', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  delete store[key];
  persistStore();
  res.json({ ok: true });
});

/* ---------- AI proxy ---------- */
app.post('/api/ai', async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({
      error: 'AI is not configured. Add GROQ_API_KEY to your .env file and restart the server.'
    });
  }
  const { messages, systemPrompt } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const groqMessages = [];
  if (systemPrompt) groqMessages.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    groqMessages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? '')
    });
  }

  try {
    const upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages: groqMessages, max_tokens: 1000 })
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error('Groq error', upstream.status, detail);
      return res.status(502).json({ error: 'AI was not able to respond.' });
    }

    const data = await upstream.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    res.json({ text });
  } catch (e) {
    console.error('AI proxy failed:', e.message);
    res.status(502).json({ error: 'AI was not able to respond.' });
  }
});

/* ============================================================
   FILE UPLOAD → TEXT EXTRACTION
   Lets Notes / Flashcards be generated from an uploaded photo,
   PDF, or text file instead of pasted text.
     - .txt              -> read directly
     - .pdf               -> pdf-parse
     - images (jpg/png/…) -> Groq vision model transcribes/describes it
============================================================ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

async function extractTextFromImage(buffer, mimetype) {
  if (!GROQ_API_KEY) {
    throw new Error('AI is not configured. Add GROQ_API_KEY to your .env file and restart the server.');
  }
  const base64 = buffer.toString('base64');
  const upstream = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + GROQ_API_KEY
    },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcribe all readable text from this image exactly as written, preserving structure (headings, lists). If it is a diagram, chart, or has no text, describe its content and structure in detail instead. Output plain text only — no commentary, no markdown fences.'
          },
          { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64}` } }
        ]
      }],
      max_tokens: 2000
    })
  });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('Groq vision error', upstream.status, detail);
    throw new Error('Could not read that image. Try a clearer photo or a different file.');
  }
  const data = await upstream.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

app.post('/api/extract-file', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded.' });

  try {
    let text = '';
    if (file.mimetype === 'application/pdf') {
      const parsed = await pdfParse(file.buffer);
      text = (parsed.text || '').trim();
    } else if (file.mimetype.startsWith('image/')) {
      text = await extractTextFromImage(file.buffer, file.mimetype);
    } else if (file.mimetype.startsWith('text/') || file.mimetype === 'application/octet-stream') {
      text = file.buffer.toString('utf8').trim();
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Upload a photo, PDF, or text file.' });
    }

    if (!text) {
      return res.status(422).json({ error: 'Could not find any readable content in that file.' });
    }
    res.json({ text });
  } catch (e) {
    console.error('File extraction failed:', e.message);
    res.status(502).json({ error: e.message || 'Could not read that file.' });
  }
});

/* ---------- health check ---------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ai: GROQ_API_KEY ? 'configured' : 'missing', model: GROQ_MODEL });
});

/* ---------- static app ---------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname, { index: 'index.html' }));

/* ---------- JSON error handler (catches multer errors, e.g. file too large) ---------- */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 15MB).' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`\n  Revora running →  http://localhost:${PORT}\n`);
  if (!GROQ_API_KEY) {
    console.log('  ⚠  No GROQ_API_KEY found. AI features are disabled until you');
    console.log('     add it to the .env file and restart.\n');
  } else {
    console.log(`  ✓  AI configured (model: ${GROQ_MODEL})\n`);
  }
});
