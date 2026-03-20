// ============================================================
//  WonderTalk — server.js
//  Express + Socket.IO + WebRTC signaling + AI Coach (Groq)
// ============================================================
//
//  Required ENV:
//    ADMIN_TOKEN=...           admin socket/HTTP auth
//
//  AI (pick one provider):
//    AI_PROVIDER=groq|xai|gemini        (default: groq)
//
//    GROQ_API_KEY=...
//    GROQ_MODEL=llama-3.3-70b-versatile  (default)
//    GROQ_BASE_URL=https://api.groq.com/openai/v1
//
//    XAI_API_KEY=...
//    XAI_MODEL=grok-3-fast
//    XAI_BASE_URL=https://api.x.ai/v1
//
//    GEMINI_API_KEY=...
//    GEMINI_MODEL=gemini-2.5-flash
//    GEMINI_BASE=https://generativelanguage.googleapis.com/v1beta
//
//  WebRTC:
//    STUN_URL=stun:stun.l.google.com:19302
//    TURN_URL=turn:...  TURN_USER=...  TURN_PASS=...
//    FORCE_RELAY=true
//
//  Optional:
//    PORT=3000
//    NODE_ENV=production
//    TRUST_PROXY=1
//    JSON_LIMIT=1mb
//    MAX_NAME_LEN=40
//    MAX_MSG_LEN=2000
//    ROOM_HISTORY=80
//    ROOM_TTL_MS=3600000        (1h)
//    ROOM_IDLE_MS=720000        (12m)
//    WAITING_TTL_MS=600000      (10m)
//    WAITING_LIMIT=2000
//    SOCKET_EVENTS_PER_10S=140
//    SOCKET_MSGS_PER_10S=45
//    SOCKET_BYTES_PER_10S=60000
//    AI_TIMEOUT_MS=9000
// ============================================================

"use strict";

try { require("dotenv").config(); } catch (_) {}

const path   = require("path");
const http   = require("http");
const crypto = require("crypto");

const express     = require("express");
const helmet      = require("helmet");
const compression = require("compression");
const rateLimit   = require("express-rate-limit");
const { Server }  = require("socket.io");

/* ──────────────────────────────────────────────────────────
   ENV
────────────────────────────────────────────────────────── */
const NODE_ENV   = (process.env.NODE_ENV   || "development").trim();
const IS_PROD    = NODE_ENV === "production";
const PORT       = Number(process.env.PORT || 3000);
const TRUST_PROXY= (process.env.TRUST_PROXY || "1").trim();
const STATIC_DIR = path.join(__dirname, "public");
const JSON_LIMIT = process.env.JSON_LIMIT || "1mb";

/* Admin */
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

/* AI */
const AI_PROVIDER    = (process.env.AI_PROVIDER   || "groq").trim().toLowerCase();
const AI_TIMEOUT_MS  = Number(process.env.AI_TIMEOUT_MS || 9000);

const GROQ_API_KEY   = "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"
const GROQ_BASE_URL  =  "https://api.groq.com/openai/v1"
const GROQ_MODEL     = "llama-3.3-70b-versatile"

const XAI_API_KEY    = (process.env.XAI_API_KEY    || "").trim();
const XAI_BASE_URL   = (process.env.XAI_BASE_URL   || "https://api.x.ai/v1").trim();
const XAI_MODEL      = (process.env.XAI_MODEL      || "grok-3-fast").trim();

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_BASE    = (process.env.GEMINI_BASE    || "https://generativelanguage.googleapis.com/v1beta").trim();
const GEMINI_MODEL   = (process.env.GEMINI_MODEL   || "gemini-2.5-flash").trim();

/* WebRTC */
const STUN       = (process.env.STUN_URL  || "stun:stun.l.google.com:19302").trim();
const TURN_URL   = (process.env.TURN_URL  || "").trim();
const TURN_USER  = (process.env.TURN_USER || "").trim();
const TURN_PASS  = (process.env.TURN_PASS || "").trim();
const FORCE_RELAY= String(process.env.FORCE_RELAY || "").toLowerCase() === "true";

/* Limits */
const MAX_NAME_LEN = Number(process.env.MAX_NAME_LEN || 40);
const MAX_MSG_LEN  = Number(process.env.MAX_MSG_LEN  || 2000);
const ROOM_HISTORY = Number(process.env.ROOM_HISTORY || 80);
const WAITING_LIMIT= Number(process.env.WAITING_LIMIT|| 2000);

/* TTLs */
const ROOM_TTL_MS   = Number(process.env.ROOM_TTL_MS   || 60 * 60 * 1000);   // 1 h
const ROOM_IDLE_MS  = Number(process.env.ROOM_IDLE_MS  || 12 * 60 * 1000);   // 12 m
const WAITING_TTL_MS= Number(process.env.WAITING_TTL_MS|| 10 * 60 * 1000);   // 10 m

/* Socket token bucket per 10 s */
const SOCK_EV_PER_10S  = Number(process.env.SOCKET_EVENTS_PER_10S || 140);
const SOCK_MSG_PER_10S = Number(process.env.SOCKET_MSGS_PER_10S   || 45);
const SOCK_BY_PER_10S  = Number(process.env.SOCKET_BYTES_PER_10S  || 60_000);

/* ──────────────────────────────────────────────────────────
   ICEBREAKER QUESTIONS
────────────────────────────────────────────────────────── */
const QUESTIONS = [
  "What is your hobby, and why do you enjoy it?",
  "Where do you live, and what do you like about that place?",
  "What's a skill you want to learn this year?",
  "Tell me about a memorable day you had recently.",
  "What kind of music do you listen to, and when?",
  "If you could travel anywhere, where would you go and why?",
  "What do you usually do on weekends?",
  "What is your favorite movie or series, and why?",
  "What's a goal you're working on right now?",
  "What makes a good friend, in your opinion?",
];

/* ──────────────────────────────────────────────────────────
   UTILITIES
────────────────────────────────────────────────────────── */
const ts  = () => Date.now();
const uid = (n = 16) => crypto.randomBytes(n).toString("hex");
const hrMs= () => Number(process.hrtime.bigint() / 1_000_000n);

function safeStr(x, max = 80) {
  return String(x ?? "").trim().slice(0, max);
}

function normName(name) {
  return safeStr(name, MAX_NAME_LEN).replace(/\s+/g, " ");
}

function clamp(n, a, b) {
  n = Number(n) || 0;
  return Math.max(a, Math.min(b, n));
}

function makeRoomId(a, b) {
  return `room_${[String(a), String(b)].sort().join("_")}_${ts()}_${uid(4)}`;
}

/* Match preferences: Any matches anything */
function prefsMatch(a, b) {
  const gOk = a.gender === "Any" || b.gender === "Any" || a.gender === b.gender;
  const lOk = a.level  === "Any" || b.level  === "Any" || a.level  === b.level;
  return gOk && lOk;
}

function publicUser(u) {
  return { name: u.name, gender: u.gender, level: u.level, roomId: u.roomId || null };
}

/* ──────────────────────────────────────────────────────────
   LOGGER  (structured JSON)
────────────────────────────────────────────────────────── */
function log(level, msg, meta) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, env: NODE_ENV, ...meta }));
}
const info = (m, x) => log("info",  m, x);
const warn = (m, x) => log("warn",  m, x);
const err  = (m, x) => log("error", m, x);

/* ──────────────────────────────────────────────────────────
   EXPRESS + SERVER
────────────────────────────────────────────────────────── */
const app = express();
app.set("trust proxy", TRUST_PROXY);
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: JSON_LIMIT }));

/* Open CORS */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin",  origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Admin-Token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* HTTP rate limit */
app.use(rateLimit({
  windowMs: 10_000,
  max: IS_PROD ? 250 : 2000,
  standardHeaders: true,
  legacyHeaders: false,
}));

/* Static files */
app.use(express.static(STATIC_DIR, { maxAge: IS_PROD ? "7d" : 0, etag: true }));

/* ──────────────────────────────────────────────────────────
   IN-MEMORY STATE
────────────────────────────────────────────────────────── */
const STATE = {
  /* socketId → user object */
  bySocket: new Map(),
  /* name → socketId  (one name = one active session) */
  byName:   new Map(),
  /* banned names */
  banned:   new Set(),

  /* waiting queue: [{ socketId, ts }] */
  waiting:  [],

  /* roomId → room object */
  rooms:    new Map(),

  /* name → report count */
  reports:  new Map(),
  /* name → { sum, count } */
  ratings:  new Map(),

  /* socket token buckets */
  buckets:  new Map(),

  totals: { visitors: 0, messages: 0, aiReplies: 0 },

  metrics: {
    aiProvider:      AI_PROVIDER,
    aiLatencyLast:   0,
    aiLatencyMax5m:  0,
    aiLatencyWindow: [],  // [{ ts, ms }]
    aiErrors:        0,
  },
};

/* ──────────────────────────────────────────────────────────
   HTTP ENDPOINTS
────────────────────────────────────────────────────────── */

/* Health */
app.get("/healthz", (_, res) =>
  res.json({ ok: true, env: NODE_ENV, uptime: process.uptime(), online: STATE.bySocket.size }));

/* WebRTC ICE config */
app.get("/webrtc-config", (_, res) => {
  const iceServers = [{ urls: STUN }];
  if (TURN_URL && TURN_USER && TURN_PASS)
    iceServers.push({ urls: TURN_URL, username: TURN_USER, credential: TURN_PASS });
  res.json({ iceServers, forceRelay: FORCE_RELAY });
});

/* Diagnostics */
app.get("/diag", (_, res) =>
  res.json({
    env: NODE_ENV, aiProvider: AI_PROVIDER, stun: STUN,
    turnConfigured: !!(TURN_URL && TURN_USER && TURN_PASS),
    forceRelay: FORCE_RELAY, aiConfigured: aiConfigured(),
  }));

/* ── Admin HTTP API ─────────────────────────────────── */
function adminHttpOk(req, res) {
  const tok = String(req.headers["x-admin-token"] || "").trim();
  if (!ADMIN_TOKEN || tok !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

app.get("/admin/stats", (req, res) => {
  if (!adminHttpOk(req, res)) return;
  res.json({
    ok: true,
    online:  STATE.bySocket.size,
    waiting: STATE.waiting.length,
    rooms:   STATE.rooms.size,
    totals:  { ...STATE.totals },
    metrics: {
      aiProvider:    STATE.metrics.aiProvider,
      aiLatencyLast: STATE.metrics.aiLatencyLast,
      aiErrors:      STATE.metrics.aiErrors,
    },
  });
});

/* ──────────────────────────────────────────────────────────
   SOCKET.IO
────────────────────────────────────────────────────────── */
const server = http.createServer(app);

const io = new Server(server, {
  cors:               { origin: true, methods: ["GET", "POST"] },
  transports:         ["websocket", "polling"],
  pingTimeout:        20_000,
  pingInterval:       25_000,
  maxHttpBufferSize:  1_000_000,
});

/* ──────────────────────────────────────────────────────────
   STAT / SNAPSHOT HELPERS
────────────────────────────────────────────────────────── */
function onlineUsers() {
  const out = [];
  for (const [, u] of STATE.bySocket) out.push(publicUser(u));
  return out;
}

function getReports() {
  return [...STATE.reports.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function getLeaderboard(limit = 50) {
  return [...STATE.ratings.entries()]
    .map(([name, r]) => ({ name, avg: r.count ? +(r.sum / r.count).toFixed(2) : 0, count: r.count }))
    .sort((a, b) => b.avg - a.avg || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function emitGlobalStats() {
  io.emit("global:stats", {
    online:  STATE.bySocket.size,
    waiting: STATE.waiting.length,
    rooms:   STATE.rooms.size,
    totals:  { ...STATE.totals },
  });
}

function emitAdminSnapshot(toId = null) {
  const payload = {
    online:      STATE.bySocket.size,
    waiting:     STATE.waiting.length,
    rooms:       STATE.rooms.size,
    totals:      { ...STATE.totals },
    reports:     getReports(),
    banned:      [...STATE.banned].sort(),
    leaderboard: getLeaderboard(50),
    onlineUsers: onlineUsers(),        // ← client renders online list from this
    metrics:     {
      aiProvider:    STATE.metrics.aiProvider,
      aiLatencyLast: STATE.metrics.aiLatencyLast,
      aiErrors:      STATE.metrics.aiErrors,
    },
  };
  if (toId) io.to(toId).emit("admin:snapshot", payload);
  else       io.emit("admin:snapshot", payload);
}

/* ──────────────────────────────────────────────────────────
   ROOM / WAITING HELPERS
────────────────────────────────────────────────────────── */
function removeWaiting(socketId) {
  STATE.waiting = STATE.waiting.filter(w => w.socketId !== socketId);
}

function touchRoom(roomId) {
  const r = STATE.rooms.get(roomId);
  if (r) r.lastActivityAt = ts();
}

function endRoom(roomId, reason) {
  const room = STATE.rooms.get(roomId);
  if (!room) return;

  [room.a, room.b].filter(Boolean).forEach(sid => {
    const u = STATE.bySocket.get(sid);
    if (u) u.roomId = null;
    io.to(sid).emit("room:ended", { reason: reason || "ended" });
    try { io.sockets.sockets.get(sid)?.leave(roomId); } catch (_) {}
  });

  STATE.rooms.delete(roomId);
  emitGlobalStats();
  emitAdminSnapshot();
}

function leaveRoom(socketId, reason) {
  const u = STATE.bySocket.get(socketId);
  if (u?.roomId) endRoom(u.roomId, reason || "left");
}

function otherInRoom(room, socketId) {
  return room.a === socketId ? room.b : room.a;
}

/* ──────────────────────────────────────────────────────────
   TOKEN BUCKET  (per-socket rate limiting)
────────────────────────────────────────────────────────── */
function bucketOk(socketId, kind = "event", bytes = 0) {
  const now = ts();
  let b = STATE.buckets.get(socketId) || { ts: now, ev: 0, msg: 0, by: 0 };

  if (now - b.ts > 10_000) { b = { ts: now, ev: 0, msg: 0, by: 0 }; }

  b.by += Math.max(0, Number(bytes) || 0);
  if (b.by > SOCK_BY_PER_10S) { STATE.buckets.set(socketId, b); return false; }

  if (kind === "msg") {
    b.msg++;
    if (b.msg > SOCK_MSG_PER_10S) { STATE.buckets.set(socketId, b); return false; }
  } else {
    b.ev++;
    if (b.ev > SOCK_EV_PER_10S) { STATE.buckets.set(socketId, b); return false; }
  }

  STATE.buckets.set(socketId, b);
  return true;
}

/* ──────────────────────────────────────────────────────────
   REPORTS / RATINGS / BANS
────────────────────────────────────────────────────────── */
function addReport(name) {
  const n = normName(name); if (!n) return;
  STATE.reports.set(n, (STATE.reports.get(n) || 0) + 1);
}

function addRating(name, stars) {
  const n = normName(name); if (!n) return;
  const s = clamp(Number(stars), 1, 5);
  if (!STATE.ratings.has(n)) STATE.ratings.set(n, { sum: 0, count: 0 });
  const r = STATE.ratings.get(n);
  r.sum += s; r.count++;
}

function banUser(name) {
  const n = normName(name); if (!n) return;
  STATE.banned.add(n);

  const sid = STATE.byName.get(n);
  if (sid) {
    const u = STATE.bySocket.get(sid);
    if (u?.roomId) leaveRoom(sid, "banned");
    removeWaiting(sid);
    io.to(sid).emit("user:banned");
    try { io.sockets.sockets.get(sid)?.disconnect(true); } catch (_) {}
  }

  emitAdminSnapshot();
  emitGlobalStats();
}

function unbanUser(name) {
  STATE.banned.delete(normName(name));
  emitAdminSnapshot();
}

/* ──────────────────────────────────────────────────────────
   AI PROVIDER LAYER
────────────────────────────────────────────────────────── */
function aiConfigured() {
  if (AI_PROVIDER === "groq")   return !!GROQ_API_KEY;
  if (AI_PROVIDER === "xai")    return !!XAI_API_KEY;
  if (AI_PROVIDER === "gemini") return !!GEMINI_API_KEY;
  return false;
}

async function fetchWithTimeout(url, opts = {}, ms = AI_TIMEOUT_MS) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res  = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text().catch(() => "");
    let json   = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function extractOpenAIText(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map(p => (typeof p === "string" ? p : p?.text || "")).filter(Boolean).join("");
  return "";
}

async function callOpenAICompat({ baseURL, apiKey, model, system, user, maxTokens = 320, temperature = 0.7 }) {
  if (!apiKey) return "AI is not configured. Missing API key.";
  const url  = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: "system", content: String(system || "") },
      { role: "user",   content: String(user   || "") },
    ],
    temperature,
    max_tokens: maxTokens,
  };
  try {
    const { ok, status, text, json } = await fetchWithTimeout(url, {
      method:  "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${apiKey}` },
      body:    JSON.stringify(body),
    });
    if (!ok) return `AI error: ${status} ${(text || "").slice(0, 400)}`;
    return String(extractOpenAIText(json) || "AI: (no response)").trim().slice(0, 2500);
  } catch (e) {
    return `AI error: ${String(e?.message || "timeout or network issue")}`;
  }
}

async function callGemini({ system, user, maxTokens = 320, temperature = 0.7 }) {
  if (!GEMINI_API_KEY) return "AI is not configured. Missing GEMINI_API_KEY.";
  const url  = `${GEMINI_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: `${system}\n\nUSER:\n${user}` }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  try {
    const { ok, status, text, json } = await fetchWithTimeout(url, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
    if (!ok) return `AI error: ${status} ${(text || "").slice(0, 400)}`;
    const out = json?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").filter(Boolean).join("") || "AI: (no response)";
    return String(out).trim().slice(0, 2500);
  } catch (e) {
    return `AI error: ${String(e?.message || "timeout or network issue")}`;
  }
}

async function aiText({ system, user, maxTokens = 320, temperature = 0.7 }) {
  if (AI_PROVIDER === "xai")
    return callOpenAICompat({ baseURL: XAI_BASE_URL, apiKey: XAI_API_KEY, model: XAI_MODEL, system, user, maxTokens, temperature });
  if (AI_PROVIDER === "gemini")
    return callGemini({ system, user, maxTokens, temperature });
  /* default: groq */
  return callOpenAICompat({ baseURL: GROQ_BASE_URL, apiKey: GROQ_API_KEY, model: GROQ_MODEL, system, user, maxTokens, temperature });
}

async function aiJSON(opts) {
  const raw = await aiText(opts);
  const t   = String(raw || "").trim();
  try { return JSON.parse(t); } catch (_) {}
  const fi = t.indexOf("{"); const li = t.lastIndexOf("}");
  if (fi >= 0 && li > fi) {
    try { return JSON.parse(t.slice(fi, li + 1)); } catch (_) {}
  }
  return { error: "bad_json", raw: t.slice(0, 900) };
}

/* ──────────────────────────────────────────────────────────
   AI PROMPTS
────────────────────────────────────────────────────────── */
const COACH_SYSTEM = `\
You are an IELTS speaking coach in a voice practice app.
Every turn output EXACTLY this structure (no extra text):

Reply: <1-2 short sentences responding to the user>
Fixes:
- <Wrong phrase → Corrected phrase>
- <Wrong phrase → Corrected phrase>
Tip: <one short practical advice>
Next question: <one follow-up question to keep the conversation going>

English only. Keep it friendly and concise.`;

const REPORT_SYSTEM = `\
You are a strict IELTS speaking examiner.
Return ONLY valid JSON with this exact schema (no markdown, no extra keys):
{
  "band": 0-9,
  "fluency": 0-9,
  "grammar": 0-9,
  "vocab": 0-9,
  "pronunciation": 0-9,
  "summary": "1-2 sentences",
  "fixes": ["Wrong → Correct", "Wrong → Correct", "Wrong → Correct"],
  "next_steps": ["...", "...", "..."]
}
English only. Be strict and accurate.`;

/* ──────────────────────────────────────────────────────────
   MAINTENANCE CLEANUP  (runs every 20 s)
────────────────────────────────────────────────────────── */
setInterval(() => {
  const now = ts();

  /* Clean expired waiting slots */
  STATE.waiting = STATE.waiting.filter(w => now - w.ts <= WAITING_TTL_MS);
  if (STATE.waiting.length > WAITING_LIMIT) STATE.waiting = STATE.waiting.slice(0, WAITING_LIMIT);

  /* Clean expired / idle rooms */
  for (const [roomId, room] of STATE.rooms) {
    const created = room.createdAt || 0;
    const active  = room.lastActivityAt || created;
    if (created && now - created > ROOM_TTL_MS)  { endRoom(roomId, "timeout");      continue; }
    if (active  && now - active  > ROOM_IDLE_MS) { endRoom(roomId, "idle_timeout"); continue; }
  }

  /* Trim AI latency window (keep last 5 min) */
  const win    = STATE.metrics.aiLatencyWindow;
  const cutoff = now - 5 * 60 * 1000;
  while (win.length && win[0].ts < cutoff) win.shift();
  STATE.metrics.aiLatencyMax5m = win.reduce((m, x) => Math.max(m, x.ms), 0);

}, 20_000).unref();

/* ──────────────────────────────────────────────────────────
   SOCKET.IO — CONNECTION
────────────────────────────────────────────────────────── */
io.on("connection", socket => {
  STATE.totals.visitors++;

  /* Send questions immediately */
  socket.emit("global:questions", { questions: QUESTIONS });
  emitGlobalStats();
  emitAdminSnapshot();

  /* Helper: get user or null */
  const me = () => STATE.bySocket.get(socket.id) || null;

  /* ── user:register ────────────────────────────────── */
  socket.on("user:register", ({ name } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ name: name ?? "" }));
    if (!bucketOk(socket.id, "event", bytes)) return;

    const n = normName(name);
    if (!n) return socket.emit("user:register:fail", { reason: "bad_name" });
    if (STATE.banned.has(n)) return socket.emit("user:register:fail", { reason: "banned" });

    /* Enforce one-session-per-name: kick old session */
    const oldSid = STATE.byName.get(n);
    if (oldSid && oldSid !== socket.id) {
      /* The old session gets kicked — new session takes the name */
      const oldSock = io.sockets.sockets.get(oldSid);
      if (oldSock) {
        try { oldSock.emit("user:kicked"); } catch (_) {}
        try { oldSock.disconnect(true);   } catch (_) {}
      }
      /* Clean up old user from state */
      const oldUser = STATE.bySocket.get(oldSid);
      if (oldUser) {
        if (oldUser.roomId) endRoom(oldUser.roomId, "rename");
        removeWaiting(oldSid);
        STATE.bySocket.delete(oldSid);
        STATE.buckets.delete(oldSid);
      }
      STATE.byName.delete(n);
    }

    /* Rename: same socket already registered */
    const existing = STATE.bySocket.get(socket.id);
    if (existing) {
      if (existing.name !== n) {
        if (existing.roomId) endRoom(existing.roomId, "rename");
        removeWaiting(socket.id);
        if (STATE.byName.get(existing.name) === socket.id) STATE.byName.delete(existing.name);
      }
      existing.name    = n;
      existing.roomId  = null;
      existing.searching = false;
      STATE.byName.set(n, socket.id);
      socket.emit("user:register:ok", { user: publicUser(existing), aiScore: existing.aiScore });
      emitGlobalStats();
      emitAdminSnapshot();
      return;
    }

    /* Fresh registration */
    const user = {
      socketId:   socket.id,
      name:       n,
      gender:     "Any",
      level:      "Any",
      roomId:     null,
      searching:  false,
      createdAt:  ts(),
      aiScore:    null,
    };
    STATE.bySocket.set(socket.id, user);
    STATE.byName.set(n, socket.id);

    socket.emit("user:register:ok", { user: publicUser(user), aiScore: null });
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ── match:start ──────────────────────────────────── */
  socket.on("match:start", ({ gender, level } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ gender: gender ?? "", level: level ?? "" }));
    if (!bucketOk(socket.id, "event", bytes)) return;

    const u = me(); if (!u) return;
    if (STATE.banned.has(u.name)) return socket.emit("user:banned");

    /* Leave current room if in one */
    if (u.roomId) leaveRoom(socket.id, "restart_search");
    removeWaiting(socket.id);

    u.gender    = safeStr(gender, 12) || "Any";
    u.level     = safeStr(level,  16) || "Any";
    u.searching = true;

    /* ── AI match ─────────────────────────────────── */
    if (u.gender === "AI") {
      const roomId = makeRoomId(socket.id, "AI");
      STATE.rooms.set(roomId, {
        id: roomId, a: socket.id, b: null,
        ai: true, topic: null,
        createdAt: ts(), lastActivityAt: ts(),
        qIndex: 0, history: [],
      });
      u.roomId    = roomId;
      u.searching = false;
      socket.join(roomId);
      socket.emit("match:found",     { roomId, partnerName: "AI", aiScore: u.aiScore });
      socket.emit("icebreaker:set",  { roomId, index: 0 });
      emitGlobalStats();
      emitAdminSnapshot();
      return;
    }

    /* ── Human match ──────────────────────────────── */
    /* Clean up stale waiting entries first */
    STATE.waiting = STATE.waiting.filter(w => {
      if (ts() - w.ts > WAITING_TTL_MS) return false;
      const other = STATE.bySocket.get(w.socketId);
      return other && !other.roomId;
    });

    /* Find compatible partner */
    let foundIdx = -1;
    for (let i = 0; i < STATE.waiting.length; i++) {
      const w     = STATE.waiting[i];
      const other = STATE.bySocket.get(w.socketId);
      if (!other || other.roomId || w.socketId === socket.id) continue;
      if (prefsMatch(u, other)) { foundIdx = i; break; }
    }

    if (foundIdx >= 0) {
      const w     = STATE.waiting.splice(foundIdx, 1)[0];
      const other = STATE.bySocket.get(w.socketId);
      if (!other) return;

      const roomId = makeRoomId(socket.id, other.socketId);
      STATE.rooms.set(roomId, {
        id: roomId, a: socket.id, b: other.socketId,
        ai: false, createdAt: ts(), lastActivityAt: ts(),
        qIndex: 0, history: [],
      });

      u.roomId     = roomId; u.searching     = false;
      other.roomId = roomId; other.searching = false;

      socket.join(roomId);
      io.sockets.sockets.get(other.socketId)?.join(roomId);

      io.to(socket.id).emit("match:found",    { roomId, partnerName: other.name, aiScore: u.aiScore });
      io.to(other.socketId).emit("match:found",{ roomId, partnerName: u.name,    aiScore: other.aiScore });
      io.to(roomId).emit("icebreaker:set",    { roomId, index: 0 });
    } else {
      if (STATE.waiting.length < WAITING_LIMIT)
        STATE.waiting.push({ socketId: socket.id, ts: ts() });
      socket.emit("match:searching");
    }

    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ── match:stop ───────────────────────────────────── */
  socket.on("match:stop", () => {
    if (!bucketOk(socket.id, "event", 1)) return;
    const u = me(); if (!u) return;
    u.searching = false;
    removeWaiting(socket.id);
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ── icebreaker:nav ───────────────────────────────── */
  socket.on("icebreaker:nav", ({ roomId, dir } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", dir: dir ?? "" }));
    if (!bucketOk(socket.id, "event", bytes)) return;

    const u = me(); if (!u || u.roomId !== roomId) return;
    const room = STATE.rooms.get(roomId); if (!room) return;

    let idx = Number(room.qIndex) || 0;
    if (dir === "next") idx++;
    else if (dir === "prev") idx--;
    else return;

    room.qIndex = clamp(idx, 0, QUESTIONS.length - 1);
    touchRoom(roomId);
    io.to(roomId).emit("icebreaker:set", { roomId, index: room.qIndex });
  });

  /* ── chat:message ─────────────────────────────────── */
  socket.on("chat:message", async ({ roomId, text } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", text: text ?? "" }));
    if (!bucketOk(socket.id, "msg", bytes)) return;

    const u = me(); if (!u || u.roomId !== roomId) return;
    const room = STATE.rooms.get(roomId); if (!room) return;

    const msgText = String(text ?? "").slice(0, MAX_MSG_LEN).trim();
    if (!msgText) return;

    STATE.totals.messages++;
    touchRoom(roomId);

    const msg = { from: u.name, text: msgText, ts: ts() };
    room.history.push(msg);
    if (room.history.length > ROOM_HISTORY) room.history.shift();

    /* ── AI room ────────────────────────────────── */
    if (room.ai) {
      socket.emit("chat:message", msg);
      if (!room.topic && msgText.length >= 3) room.topic = msgText;

      const t0      = hrMs();
      const aiReply = await aiText({
        system:      COACH_SYSTEM,
        user:        `Topic: ${room.topic || "general"}\nUser said: ${msgText}`,
        maxTokens:   340,
        temperature: 0.65,
      });
      const dt = hrMs() - t0;

      if (String(aiReply).startsWith("AI error:")) STATE.metrics.aiErrors++;
      STATE.totals.aiReplies++;
      STATE.metrics.aiLatencyLast = dt;
      STATE.metrics.aiLatencyWindow.push({ ts: ts(), ms: dt });

      const aiMsg = { from: "AI", text: String(aiReply).slice(0, 2500), ts: ts() };
      room.history.push(aiMsg);
      if (room.history.length > ROOM_HISTORY) room.history.shift();

      setTimeout(() => socket.emit("chat:message", aiMsg), 120);
      emitGlobalStats();
      emitAdminSnapshot();
      return;
    }

    /* ── Human room ─────────────────────────────── */
    io.to(roomId).emit("chat:message", msg);
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ── room:leave  (+ generate AI report) ──────────── */
  socket.on("room:leave", async () => {
    if (!bucketOk(socket.id, "event", 2)) return;

    const u = me(); if (!u?.roomId) return;
    const roomId = u.roomId;
    const room   = STATE.rooms.get(roomId);

    /* Generate AI report if it was an AI session */
    if (room?.ai) {
      const myMsgs = (room.history || [])
        .filter(m => m.from === u.name)
        .map(m => m.text)
        .join("\n");

      const rep = await aiJSON({
        system:      REPORT_SYSTEM,
        user:        `User messages:\n${myMsgs || "(no messages)"}`,
        maxTokens:   520,
        temperature: 0.25,
      });

      const score = {
        band:         clamp(Number(rep.band)          || 0, 0, 9),
        fluency:      clamp(Number(rep.fluency)        || 0, 0, 9),
        grammar:      clamp(Number(rep.grammar)        || 0, 0, 9),
        vocab:        clamp(Number(rep.vocab)          || 0, 0, 9),
        pronunciation:clamp(Number(rep.pronunciation)  || 0, 0, 9),
      };
      u.aiScore = score;

      io.to(socket.id).emit("coach:report", { report: rep, aiScore: score });
    }

    removeWaiting(socket.id);
    leaveRoom(socket.id, "left");
  });

  /* ── report:partner ───────────────────────────────── */
  socket.on("report:partner", ({ roomId } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "" }));
    if (!bucketOk(socket.id, "event", bytes)) return;

    const u = me(); if (!u || u.roomId !== roomId) return;
    const room = STATE.rooms.get(roomId); if (!room || room.ai) return;

    const otherId = otherInRoom(room, socket.id);
    const other   = otherId ? STATE.bySocket.get(otherId) : null;
    if (!other) return;

    addReport(other.name);
    socket.emit("report:ok", { reported: other.name });
    emitAdminSnapshot();
  });

  /* ── rate:partner ─────────────────────────────────── */
  socket.on("rate:partner", ({ roomId, stars } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", stars: stars ?? 0 }));
    if (!bucketOk(socket.id, "event", bytes)) return;

    const u = me(); if (!u || u.roomId !== roomId) return;
    const room = STATE.rooms.get(roomId); if (!room || room.ai) return;

    const otherId = otherInRoom(room, socket.id);
    const other   = otherId ? STATE.bySocket.get(otherId) : null;
    if (!other) return;

    addRating(other.name, stars);
    socket.emit("rate:ok", { rated: other.name });
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ── WebRTC signaling ─────────────────────────────── */
  socket.on("webrtc:offer", ({ roomId, sdp } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", sdp: "[sdp]" }));
    if (!bucketOk(socket.id, "event", bytes)) return;

    const u = me(); if (!u || u.roomId !== roomId) return;
    const room = STATE.rooms.get(roomId); if (!room || room.ai) return;

    const otherId = otherInRoom(room, socket.id);
    if (!otherId) return;

    touchRoom(roomId);
    io.to(otherId).emit("webrtc:offer", { sdp, from: u.name });
  });

  socket.on("webrtc:answer", ({ roomId, sdp } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", sdp: "[sdp]" }));
    if (!bucketOk(socket.id, "event", bytes)) return;

    const u = me(); if (!u || u.roomId !== roomId) return;
    const room = STATE.rooms.get(roomId); if (!room || room.ai) return;

    const otherId = otherInRoom(room, socket.id);
    if (!otherId) return;

    touchRoom(roomId);
    io.to(otherId).emit("webrtc:answer", { sdp, from: u.name });
  });

  socket.on("webrtc:ice", ({ roomId, candidate } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", candidate: "[ice]" }));
    if (!bucketOk(socket.id, "event", bytes)) return;

    const u = me(); if (!u || u.roomId !== roomId) return;
    const room = STATE.rooms.get(roomId); if (!room || room.ai) return;

    const otherId = otherInRoom(room, socket.id);
    if (!otherId) return;

    touchRoom(roomId);
    io.to(otherId).emit("webrtc:ice", { candidate, from: u.name });
  });

  /* ── Admin socket API ─────────────────────────────── */
  const adminOk = (payload) => {
    const tok = String(payload?.token || "").trim();
    return ADMIN_TOKEN && tok === ADMIN_TOKEN;
  };

  socket.on("admin:get", (payload = {}) => {
    if (!bucketOk(socket.id, "event", 4)) return;
    if (!adminOk(payload)) return;
    emitAdminSnapshot(socket.id);
  });

  socket.on("admin:ban", (payload = {}) => {
    if (!bucketOk(socket.id, "event", 4)) return;
    if (!adminOk(payload)) return;
    banUser(payload.name);
  });

  socket.on("admin:unban", (payload = {}) => {
    if (!bucketOk(socket.id, "event", 4)) return;
    if (!adminOk(payload)) return;
    unbanUser(payload.name);
  });

  /* ── disconnect ───────────────────────────────────── */
  socket.on("disconnect", reason => {
    const u = STATE.bySocket.get(socket.id);

    removeWaiting(socket.id);
    if (u?.roomId) leaveRoom(socket.id, "disconnect");

    if (u) {
      STATE.bySocket.delete(socket.id);
      if (STATE.byName.get(u.name) === socket.id) STATE.byName.delete(u.name);
    }

    STATE.buckets.delete(socket.id);
    emitGlobalStats();
    emitAdminSnapshot();

    info("disconnect", { reason, socketId: socket.id });
  });
});

/* ──────────────────────────────────────────────────────────
   START
────────────────────────────────────────────────────────── */
server.listen(PORT, "0.0.0.0", () => {
  info("server_start", {
    port: PORT, env: NODE_ENV,
    aiProvider: AI_PROVIDER, aiConfigured: aiConfigured(),
    stun: STUN,
    turnConfigured: !!(TURN_URL && TURN_USER && TURN_PASS),
    forceRelay: FORCE_RELAY,
  });

  if (!ADMIN_TOKEN)    warn("ADMIN_TOKEN not set — admin actions disabled.");
  if (!aiConfigured()) warn(`AI_PROVIDER="${AI_PROVIDER}" API key missing — AI replies will show error.`);
});

/* ──────────────────────────────────────────────────────────
   GRACEFUL SHUTDOWN
────────────────────────────────────────────────────────── */
function shutdown(signal) {
  warn("shutdown", { signal });
  try {
    io.close(() => server.close(() => process.exit(0)));
  } catch (_) {
    process.exit(0);
  }
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
