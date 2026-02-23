// server.js
// ============================================================================
// WonderTalk — PRO server.js (Express + Socket.IO + WebRTC + AI + Telegram users)
// ----------------------------------------------------------------------------
// KEY FEATURES:
// - ENV-only secrets (NO hardcoded keys)
// - Helmet security headers + compression
// - CORS allowlist
// - HTTP rate-limit + Socket event token bucket
// - Room lifecycle + TTL cleanup
// - Admin HTTP API (token) + Admin snapshot
// - TURN/STUN config endpoint
// - AI Coach (Gemini) w/ timeout guards
// - ✅ Telegram integration:
//    * POST /telegram/webhook (secure secret header) -> store /start users
//    * Persist to data/tg_users.json
//    * Optional Telegram WebApp initData verification on socket register
//
// Required ENV:
//   ADMIN_TOKEN=supersecret
//   GEMINI_API_KEY=xxxxx        (optional if AI used)
//   TELEGRAM_BOT_TOKEN=123:abc  (recommended for initData verification)
//   TG_WEBHOOK_SECRET=something (required if using webhook endpoint)
//
// Optional ENV:
//   CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
//   TURN_URL=turn:... TURN_USER=... TURN_PASS=...
//   FORCE_RELAY=true
//   USERS_STORE_PATH=/var/data/tg_users.json
// ============================================================================

"use strict";

// Optional dotenv (only if you use .env locally). Safe even if package not installed.
try { require("dotenv").config(); } catch {}

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

/* ===================== ENV / Config ===================== */
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const PORT = Number(process.env.PORT || 3000);
const TRUST_PROXY = process.env.TRUST_PROXY || "1";
const STATIC_DIR = path.join(__dirname, "public");

// ✅ ENV-only secrets
const ADMIN_TOKEN = "132312wewqd"
const GEMINI_API_KEY = "AIzaSyBWJoLc1muSCPs1D8fX63Ihh5MYcbKDqXA"

// Telegram
// Persistent store for TG users
const USERS_STORE_PATH = (process.env.USERS_STORE_PATH || path.join(__dirname, "data", "tg_users.json")).trim();
const USERS_STORE_DIR = path.dirname(USERS_STORE_PATH);

// Gemini API
const GEMINI_BASE = process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// WebRTC ICE
const STUN = process.env.STUN_URL || "stun:stun.l.google.com:19302";
const TURN_URL = (process.env.TURN_URL || "").trim();
const TURN_USER = (process.env.TURN_USER || "").trim();
const TURN_PASS = (process.env.TURN_PASS || "").trim();
const FORCE_RELAY = String(process.env.FORCE_RELAY || "").toLowerCase() === "true";

// CORS allowlist
const CORS_ORIGINS_RAW = (process.env.CORS_ORIGINS || "").trim();
const CORS_ORIGINS = CORS_ORIGINS_RAW
  ? CORS_ORIGINS_RAW.split(",").map((s) => s.trim()).filter(Boolean)
  : ["*"]; // dev convenience

/* -------- Limits -------- */
const JSON_LIMIT = process.env.JSON_LIMIT || "1mb";
const MAX_NAME_LEN = Number(process.env.MAX_NAME_LEN || 40);
const MAX_MSG_LEN = Number(process.env.MAX_MSG_LEN || 2000);
const ROOM_HISTORY_LIMIT = Number(process.env.ROOM_HISTORY_LIMIT || 80);
const WAITING_LIMIT = Number(process.env.WAITING_LIMIT || 2000);

// Cleanup/TTL
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 1000 * 60 * 60);      // 1h
const WAITING_TTL_MS = Number(process.env.WAITING_TTL_MS || 1000 * 60 * 10);// 10m
const ROOM_IDLE_END_MS = Number(process.env.ROOM_IDLE_END_MS || 1000 * 60 * 12); // 12m

// Socket rate-limits (token bucket / 10s)
const SOCKET_EVENTS_PER_10S = Number(process.env.SOCKET_EVENTS_PER_10S || 140);
const SOCKET_MSGS_PER_10S = Number(process.env.SOCKET_MSGS_PER_10S || 45);
const SOCKET_BYTES_PER_10S = Number(process.env.SOCKET_BYTES_PER_10S || 60_000);

/* -------- Questions -------- */
const QUESTIONS = [
  "What is your hobby, and why do you enjoy it?",
  "Where do you live, and what do you like about that place?",
  "What’s a skill you want to learn this year?",
  "Tell me about a memorable day you had recently.",
  "What kind of music do you listen to, and when do you listen to it?",
  "If you could travel anywhere, where would you go and why?",
  "What do you usually do on weekends?",
  "What is your favorite movie or series, and what do you like about it?",
  "What’s a goal you’re working on right now?",
  "What makes a good friend, in your opinion?"
];

/* ===================== Utilities ===================== */
const now = () => Date.now();

function clamp(n, a, b) {
  n = Number(n) || 0;
  return Math.max(a, Math.min(b, n));
}

function safeStr(x, max = 80) {
  return String(x ?? "").trim().slice(0, max);
}

function normalizeName(name) {
  return safeStr(name, MAX_NAME_LEN).replace(/\s+/g, " ");
}

function uid(n = 16) {
  return crypto.randomBytes(n).toString("hex");
}

function hrTimeMs() {
  const t = process.hrtime.bigint();
  return Number(t / 1000000n);
}

function makeRoomId(a, b) {
  return `room_${[String(a), String(b)].sort().join("_")}_${now()}_${uid(4)}`;
}

function samePrefs(a, b) {
  const gOk = a.gender === "Any" || b.gender === "Any" || a.gender === b.gender;
  const lOk = a.level === "Any" || b.level === "Any" || a.level === b.level;
  return gOk && lOk;
}

function userPublic(u) {
  return {
    name: u.name,
    gender: u.gender,
    level: u.level,
    roomId: u.roomId || null,
    tg: u.tg ? { id: u.tg.id, username: u.tg.username || null } : null
  };
}

/* ===================== Logger (JSON) ===================== */
function log(level, msg, meta) {
  const base = { ts: new Date().toISOString(), level, msg, env: NODE_ENV };
  console.log(JSON.stringify(meta ? { ...base, ...meta } : base));
}
const info = (m, meta) => log("info", m, meta);
const warn = (m, meta) => log("warn", m, meta);
const error = (m, meta) => log("error", m, meta);

/* ===================== Telegram Store (persistent) ===================== */
const tgStore = {
  byId: new Map(), // id -> user
  dirty: false,
  saveTimer: null
};

function tgMakeName(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return normalizeName(full || u.username || `TG-${u.id}`);
}

async function tgEnsureDir() {
  try { await fsp.mkdir(USERS_STORE_DIR, { recursive: true }); } catch {}
}

async function tgLoadFromDisk() {
  await tgEnsureDir();
  try {
    const raw = await fsp.readFile(USERS_STORE_PATH, "utf8");
    const j = JSON.parse(raw);
    const arr = Array.isArray(j?.users) ? j.users : [];
    tgStore.byId.clear();
    for (const x of arr) {
      if (!x || !x.id) continue;
      tgStore.byId.set(Number(x.id), x);
    }
    info("tg_store_loaded", { count: tgStore.byId.size, path: USERS_STORE_PATH });
  } catch (e) {
    // first run: file may not exist
    info("tg_store_empty", { path: USERS_STORE_PATH });
  }
}

async function tgSaveNow() {
  if (!tgStore.dirty) return;
  tgStore.dirty = false;

  await tgEnsureDir();
  const users = Array.from(tgStore.byId.values())
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));

  const payload = JSON.stringify({ v: 1, savedAt: now(), users }, null, 2);
  const tmp = USERS_STORE_PATH + ".tmp";

  try {
    await fsp.writeFile(tmp, payload, "utf8");
    await fsp.rename(tmp, USERS_STORE_PATH);
  } catch (e) {
    tgStore.dirty = true; // retry later
    error("tg_store_save_fail", { err: String(e?.message || e) });
  }
}

function tgScheduleSave() {
  tgStore.dirty = true;
  if (tgStore.saveTimer) return;
  tgStore.saveTimer = setTimeout(async () => {
    tgStore.saveTimer = null;
    await tgSaveNow();
  }, 1200).unref();
}

function tgUpsertFromTelegramUser(u, source = "webhook", isStart = false) {
  if (!u || typeof u.id !== "number") return null;
  const id = Number(u.id);

  const prev = tgStore.byId.get(id);
  const name = tgMakeName(u);

  const next = prev || {
    id,
    name,
    username: u.username || null,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    language_code: u.language_code || null,
    firstSeenAt: now(),
    lastSeenAt: now(),
    starts: 0,
    messages: 0,
    source
  };

  next.name = name;
  next.username = u.username || next.username || null;
  next.first_name = u.first_name || next.first_name || null;
  next.last_name = u.last_name || next.last_name || null;
  next.language_code = u.language_code || next.language_code || null;
  next.lastSeenAt = now();
  next.source = source;

  next.messages = (next.messages || 0) + 1;
  if (isStart) next.starts = (next.starts || 0) + 1;

  tgStore.byId.set(id, next);
  tgScheduleSave();
  return next;
}

/* ===================== Telegram initData verification ===================== */
// Validate Telegram WebApp initData with bot token (recommended).
// If TELEGRAM_BOT_TOKEN not set, we don't verify.
function verifyTelegramInitData(initData, botToken, maxAgeSec = 24 * 60 * 60) {
  try {
    if (!initData || !botToken) return { ok: false, reason: "missing" };

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, reason: "no_hash" };

    const authDate = Number(params.get("auth_date") || "0");
    if (!authDate) return { ok: false, reason: "no_auth_date" };

    const age = Math.abs(Math.floor(Date.now() / 1000) - authDate);
    if (maxAgeSec && age > maxAgeSec) return { ok: false, reason: "expired" };

    // Build data_check_string: sort by key, exclude hash
    const kv = [];
    for (const [k, v] of params.entries()) {
      if (k === "hash") continue;
      kv.push([k, v]);
    }
    kv.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = kv.map(([k, v]) => `${k}=${v}`).join("\n");

    // secret_key = HMAC_SHA256("WebAppData", bot_token)
    const secretKey = crypto.createHmac("sha256", botToken).update("WebAppData").digest();
    const calcHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (calcHash !== hash) return { ok: false, reason: "bad_hash" };

    // user field is JSON string
    let user = null;
    const userRaw = params.get("user");
    if (userRaw) {
      try { user = JSON.parse(userRaw); } catch {}
    }

    return { ok: true, user, authDate };
  } catch (e) {
    return { ok: false, reason: "err" };
  }
}

/* ===================== App / Server ===================== */
const app = express();
app.set("trust proxy", TRUST_PROXY);
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: JSON_LIMIT }));

/* ---------- HTTP Rate limit ---------- */
app.use(rateLimit({
  windowMs: 10 * 1000,
  max: IS_PROD ? 250 : 1000,
  standardHeaders: true,
  legacyHeaders: false
}));

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (CORS_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token, X-TG-Secret");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- Static ---------- */
app.use(express.static(STATIC_DIR, {
  maxAge: IS_PROD ? "7d" : 0,
  etag: true
}));

/* ---------- Health ---------- */
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    uptime: process.uptime(),
    online: null,
    tgUsers: tgStore.byId.size
  });
});

/* ---------- ICE config ---------- */
app.get("/webrtc-config", (req, res) => {
  const iceServers = [{ urls: STUN }];
  if (TURN_URL && TURN_USER && TURN_PASS) {
    iceServers.push({ urls: TURN_URL, username: TURN_USER, credential: TURN_PASS });
  }
  res.json({ iceServers, forceRelay: FORCE_RELAY });
});

/* ---------- Diagnostics ---------- */
app.get("/diag", (req, res) => {
  res.json({
    env: NODE_ENV,
    stun: STUN,
    turnConfigured: !!(TURN_URL && TURN_USER && TURN_PASS),
    forceRelay: FORCE_RELAY,
    cors: CORS_ORIGINS,
    tgUsers: tgStore.byId.size
  });
});

/* ===================== Admin HTTP API (token) ===================== */
function adminHttpAuth(req, res) {
  const tok = String(req.headers["x-admin-token"] || "").trim();
  if (!ADMIN_TOKEN || tok !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

app.get("/admin/tg/users", (req, res) => {
  if (!adminHttpAuth(req, res)) return;
  const limit = clamp(Number(req.query?.limit || 200), 1, 5000);
  const users = Array.from(tgStore.byId.values())
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    .slice(0, limit);
  res.json({ ok: true, count: tgStore.byId.size, users });
});

/* ===================== Telegram Webhook (store /start users) ===================== */
// Telegram can send a header: x-telegram-bot-api-secret-token (if you set it on setWebhook).
function tgWebhookAuth(req) {
  if (!TG_WEBHOOK_SECRET) return false;
  const h1 = String(req.headers["x-telegram-bot-api-secret-token"] || "").trim();
  const h2 = String(req.headers["x-tg-secret"] || "").trim();
  return (h1 && h1 === TG_WEBHOOK_SECRET) || (h2 && h2 === TG_WEBHOOK_SECRET);
}

app.post("/telegram/webhook", async (req, res) => {
  if (!tgWebhookAuth(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const upd = req.body || {};
  // Common update shapes: message, edited_message, callback_query, etc.
  const msg = upd.message || upd.edited_message || upd.channel_post || upd.edited_channel_post;
  const from = msg?.from || upd.callback_query?.from || null;

  if (from && typeof from.id === "number") {
    const text = String(msg?.text || upd.callback_query?.data || "").trim();
    const isStart = text.startsWith("/start");
    tgUpsertFromTelegramUser(from, "webhook", isStart);
  }

  res.json({ ok: true });
});

/* ===================== Create server + Socket.IO ===================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS.includes("*") ? "*" : CORS_ORIGINS,
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  pingTimeout: 20000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6
});

/* ===================== In-memory State ===================== */
const state = {
  usersBySocket: new Map(),   // socketId -> user
  socketsByName: new Map(),   // name -> socketId
  socketsByTgId: new Map(),   // tgId -> socketId
  bannedNames: new Set(),

  waiting: [],                // {socketId, ts}
  rooms: new Map(),           // roomId -> room

  reportsByName: new Map(),
  ratingsByName: new Map(),
  totals: { visitors: 0, messages: 0, aiReplies: 0 },

  buckets: new Map(),
  metrics: {
    aiLatencyMsLast: 0,
    aiLatencyMsMax5m: 0,
    aiLatencyWindow: []
  }
};

function getOnlineCount() { return state.usersBySocket.size; }
function getRoomsCount() { return state.rooms.size; }
function getWaitingCount() { return state.waiting.length; }

function getReports() {
  const out = [];
  for (const [name, count] of state.reportsByName.entries()) out.push({ name, count });
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return out;
}

function getRatingsLeaderboard(limit = 50) {
  const rows = [];
  for (const [name, r] of state.ratingsByName.entries()) {
    const avg = r.count ? (r.sum / r.count) : 0;
    rows.push({ name, avg: Number(avg.toFixed(2)), count: r.count });
  }
  rows.sort((a, b) => b.avg - a.avg || b.count - a.count || a.name.localeCompare(b.name));
  return rows.slice(0, limit);
}

function emitGlobalStats() {
  io.emit("global:stats", {
    online: getOnlineCount(),
    waiting: getWaitingCount(),
    rooms: getRoomsCount(),
    totals: { ...state.totals },
    tgUsers: tgStore.byId.size
  });
}

function emitAdminSnapshot(toSocketId = null) {
  const payload = {
    online: getOnlineCount(),
    waiting: getWaitingCount(),
    rooms: getRoomsCount(),
    totals: { ...state.totals },
    reports: getReports(),
    banned: Array.from(state.bannedNames).sort((a, b) => a.localeCompare(b)),
    leaderboard: getRatingsLeaderboard(50),
    metrics: {
      aiLatencyMsLast: state.metrics.aiLatencyMsLast,
      aiLatencyMsMax5m: state.metrics.aiLatencyMsMax5m
    },
    tgUsers: tgStore.byId.size
  };
  if (toSocketId) io.to(toSocketId).emit("admin:snapshot", payload);
  else io.emit("admin:snapshot", payload);
}

/* ===================== Waiting / Room Helpers ===================== */
function removeFromWaiting(socketId) {
  if (!state.waiting.length) return;
  state.waiting = state.waiting.filter((w) => w.socketId !== socketId);
}

function roomOther(room, socketId) {
  return room.a === socketId ? room.b : room.a;
}

function safeLeaveRoomSocket(socketId, roomId) {
  try {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.leave(roomId);
  } catch {}
}

function endRoom(roomId, reason) {
  const room = state.rooms.get(roomId);
  if (!room) return;

  const ids = [room.a, room.b].filter(Boolean);
  for (const id of ids) {
    const u = state.usersBySocket.get(id);
    if (u) u.roomId = null;

    io.to(id).emit("room:ended", { reason: reason || "ended" });
    safeLeaveRoomSocket(id, roomId);
  }

  state.rooms.delete(roomId);
  emitGlobalStats();
  emitAdminSnapshot();
}

function leaveRoom(socketId, reason) {
  const u = state.usersBySocket.get(socketId);
  if (!u?.roomId) return;
  endRoom(u.roomId, reason || "left");
}

/* ===================== Abuse guards ===================== */
function bucketTake(socketId, kind = "event", bytes = 0) {
  const t = now();
  const b = state.buckets.get(socketId) || { ts: t, eventCount: 0, msgCount: 0, byteCount: 0 };

  if (t - b.ts > 10_000) {
    b.ts = t;
    b.eventCount = 0;
    b.msgCount = 0;
    b.byteCount = 0;
  }

  b.byteCount += Math.max(0, Number(bytes) || 0);
  if (b.byteCount > SOCKET_BYTES_PER_10S) { state.buckets.set(socketId, b); return false; }

  if (kind === "msg") {
    b.msgCount += 1;
    if (b.msgCount > SOCKET_MSGS_PER_10S) { state.buckets.set(socketId, b); return false; }
  } else {
    b.eventCount += 1;
    if (b.eventCount > SOCKET_EVENTS_PER_10S) { state.buckets.set(socketId, b); return false; }
  }

  state.buckets.set(socketId, b);
  return true;
}

/* ===================== Reports/Ratings/Bans ===================== */
function addReport(name) {
  const n = normalizeName(name);
  if (!n) return;
  state.reportsByName.set(n, (state.reportsByName.get(n) || 0) + 1);
}

function addRating(name, stars) {
  const n = normalizeName(name);
  if (!n) return;
  const s = Math.max(1, Math.min(5, Number(stars) || 0));
  if (!state.ratingsByName.has(n)) state.ratingsByName.set(n, { sum: 0, count: 0 });
  const r = state.ratingsByName.get(n);
  r.sum += s;
  r.count += 1;
}

function banName(name) {
  const n = normalizeName(name);
  if (!n) return;

  state.bannedNames.add(n);

  const sockId = state.socketsByName.get(n);
  if (sockId) {
    const u = state.usersBySocket.get(sockId);
    if (u?.roomId) leaveRoom(sockId, "banned");
    removeFromWaiting(sockId);

    io.to(sockId).emit("user:banned");
    try { io.sockets.sockets.get(sockId)?.disconnect(true); } catch {}
  }

  emitAdminSnapshot();
  emitGlobalStats();
}

function unbanName(name) {
  const n = normalizeName(name);
  if (!n) return;
  state.bannedNames.delete(n);
  emitAdminSnapshot();
}

/* ===================== AI (Gemini) ===================== */
async function geminiText({ system, user, maxOutputTokens = 320, temperature = 0.7, timeoutMs = 9000 }) {
  if (!GEMINI_API_KEY) return "AI is not configured. Ask admin to set GEMINI_API_KEY.";

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: `${system}\n\nUSER:\n${user}` }] }],
    generationConfig: { temperature, maxOutputTokens }
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return `AI error: ${resp.status} ${t}`.slice(0, 600);
    }

    const json = await resp.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ||
      "AI: (no response)";

    return String(text).trim().slice(0, 2500);
  } catch {
    return "AI error: timeout or network issue.";
  } finally {
    clearTimeout(timer);
  }
}

async function geminiJSON({ system, user, maxOutputTokens = 420, temperature = 0.35 }) {
  const raw = await geminiText({ system, user, maxOutputTokens, temperature });
  const t = String(raw || "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = t.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
  }
  return { error: "bad_json", raw: t.slice(0, 900) };
}

/* ===================== Maintenance Cleanups ===================== */
function cleanupWaiting() {
  const t = now();
  if (!state.waiting.length) return;

  state.waiting = state.waiting.filter((w) => (t - w.ts) <= WAITING_TTL_MS);
  if (state.waiting.length > WAITING_LIMIT) state.waiting = state.waiting.slice(0, WAITING_LIMIT);
}

function cleanupRooms() {
  const t = now();
  for (const [roomId, room] of state.rooms.entries()) {
    const createdAt = Number(room?.createdAt) || 0;
    const lastActivityAt = Number(room?.lastActivityAt) || createdAt;

    if (createdAt && (t - createdAt) > ROOM_TTL_MS) { endRoom(roomId, "timeout"); continue; }
    if (lastActivityAt && (t - lastActivityAt) > ROOM_IDLE_END_MS) endRoom(roomId, "idle_timeout");
  }
}

setInterval(() => {
  cleanupWaiting();
  cleanupRooms();

  const win = state.metrics.aiLatencyWindow;
  const cutoff = now() - 5 * 60 * 1000;
  while (win.length && win[0].ts < cutoff) win.shift();
  state.metrics.aiLatencyMsMax5m = win.reduce((m, x) => Math.max(m, x.ms), 0);

  // periodic save (in case)
  tgSaveNow().catch(() => {});
}, 20_000).unref();

/* ===================== Socket Middleware Guards ===================== */
io.use((socket, next) => {
  socket.data._registered = false;
  next();
});

/* ===================== Socket.IO ===================== */
io.on("connection", (socket) => {
  state.totals.visitors++;

  socket.emit("global:questions", { questions: QUESTIONS });
  emitGlobalStats();
  emitAdminSnapshot();

  function mustBeRegistered() {
    const u = state.usersBySocket.get(socket.id);
    return u || null;
  }

  function touchRoomActivity(roomId) {
    const r = state.rooms.get(roomId);
    if (r) r.lastActivityAt = now();
  }

  // ✅ REGISTER (supports tgInitData verification)
  socket.on("user:register", ({ name, tgInitData } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ name: name ?? "", tgInitData: tgInitData ? "[tg]" : "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    // If Telegram initData provided and bot token exists, verify and override name
    let tgUser = null;
    if (tgInitData && TELEGRAM_BOT_TOKEN) {
      const v = verifyTelegramInitData(String(tgInitData), TELEGRAM_BOT_TOKEN, 24 * 60 * 60);
      if (v.ok && v.user && typeof v.user.id === "number") {
        tgUser = v.user;
        name = tgMakeName(tgUser);
        // store tg user in persistent list (source: webapp)
        tgUpsertFromTelegramUser(tgUser, "webapp", false);
      }
    }

    const n = normalizeName(name);
    if (!n) return socket.emit("user:register:fail", { reason: "bad_name" });
    if (state.bannedNames.has(n)) return socket.emit("user:register:fail", { reason: "banned" });

    // If this socket already registered -> rename flow
    const existing = state.usersBySocket.get(socket.id);
    if (existing) {
      if (existing.roomId) endRoom(existing.roomId, "rename");
      removeFromWaiting(socket.id);

      if (state.socketsByName.get(existing.name) === socket.id) state.socketsByName.delete(existing.name);

      // remove old tg mapping if any
      if (existing.tg?.id && state.socketsByTgId.get(existing.tg.id) === socket.id) {
        state.socketsByTgId.delete(existing.tg.id);
      }

      // Kick same-name session
      const oldId = state.socketsByName.get(n);
      if (oldId && oldId !== socket.id) {
        const oldSock = io.sockets.sockets.get(oldId);
        if (oldSock) {
          try { oldSock.emit("user:kicked"); } catch {}
          try { oldSock.disconnect(true); } catch {}
        }
      }

      // Kick same Telegram ID session
      if (tgUser?.id) {
        const oldTgSockId = state.socketsByTgId.get(tgUser.id);
        if (oldTgSockId && oldTgSockId !== socket.id) {
          const oldSock = io.sockets.sockets.get(oldTgSockId);
          if (oldSock) {
            try { oldSock.emit("user:kicked"); } catch {}
            try { oldSock.disconnect(true); } catch {}
          }
        }
        state.socketsByTgId.set(tgUser.id, socket.id);
        existing.tg = { id: tgUser.id, username: tgUser.username || null };
      }

      state.socketsByName.set(n, socket.id);

      existing.name = n;
      existing.roomId = null;
      existing.searching = false;

      socket.data._registered = true;
      socket.emit("user:register:ok", { user: userPublic(existing), aiScore: existing.aiScore });
      emitGlobalStats();
      emitAdminSnapshot();
      return;
    }

    // Initial register: kick same-name older session
    const oldId = state.socketsByName.get(n);
    if (oldId && oldId !== socket.id) {
      const oldSock = io.sockets.sockets.get(oldId);
      if (oldSock) {
        try { oldSock.emit("user:kicked"); } catch {}
        try { oldSock.disconnect(true); } catch {}
      }
    }

    // Initial register: kick same TG id older session
    if (tgUser?.id) {
      const oldTgSockId = state.socketsByTgId.get(tgUser.id);
      if (oldTgSockId && oldTgSockId !== socket.id) {
        const oldSock = io.sockets.sockets.get(oldTgSockId);
        if (oldSock) {
          try { oldSock.emit("user:kicked"); } catch {}
          try { oldSock.disconnect(true); } catch {}
        }
      }
      state.socketsByTgId.set(tgUser.id, socket.id);
    }

    state.socketsByName.set(n, socket.id);

    const user = {
      socketId: socket.id,
      name: n,
      gender: "Any",
      level: "Any",
      roomId: null,
      searching: false,
      createdAt: now(),
      aiScore: null,
      tg: tgUser?.id ? { id: tgUser.id, username: tgUser.username || null } : null
    };

    state.usersBySocket.set(socket.id, user);
    socket.data._registered = true;

    socket.emit("user:register:ok", { user: userPublic(user), aiScore: user.aiScore });
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ---------- Match Start / Stop ---------- */
  socket.on("match:start", ({ gender, level } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ gender: gender ?? "", level: level ?? "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const u = mustBeRegistered();
    if (!u) return;
    if (state.bannedNames.has(u.name)) return socket.emit("user:banned");

    if (u.roomId) leaveRoom(socket.id, "restart_search");
    removeFromWaiting(socket.id);

    u.gender = safeStr(gender, 12) || "Any";
    u.level = safeStr(level, 16) || "Any";
    u.searching = true;

    // AI match
    if (u.gender === "AI") {
      const roomId = makeRoomId(socket.id, "AI");
      state.rooms.set(roomId, {
        id: roomId,
        a: socket.id,
        b: null,
        createdAt: now(),
        lastActivityAt: now(),
        qIndex: 0,
        ai: true,
        topic: null,
        history: []
      });

      u.roomId = roomId;
      u.searching = false;

      socket.join(roomId);
      socket.emit("match:found", { roomId, partnerName: "AI", aiScore: u.aiScore });
      socket.emit("icebreaker:set", { roomId, index: 0 });

      emitGlobalStats();
      emitAdminSnapshot();
      return;
    }

    // Human match
    cleanupWaiting();

    let foundIndex = -1;
    for (let i = 0; i < state.waiting.length; i++) {
      const w = state.waiting[i];
      const other = state.usersBySocket.get(w.socketId);
      if (!other) continue;
      if (other.roomId) continue;
      if (other.socketId === socket.id) continue;
      if (samePrefs(u, other)) { foundIndex = i; break; }
    }

    if (foundIndex >= 0) {
      const w = state.waiting[foundIndex];
      state.waiting.splice(foundIndex, 1);

      const other = state.usersBySocket.get(w.socketId);
      if (!other) return;

      const roomId = makeRoomId(socket.id, other.socketId);
      state.rooms.set(roomId, {
        id: roomId,
        a: socket.id,
        b: other.socketId,
        createdAt: now(),
        lastActivityAt: now(),
        qIndex: 0,
        ai: false,
        history: []
      });

      u.roomId = roomId;
      other.roomId = roomId;
      u.searching = false;
      other.searching = false;

      socket.join(roomId);
      io.sockets.sockets.get(other.socketId)?.join(roomId);

      io.to(socket.id).emit("match:found", { roomId, partnerName: other.name, aiScore: u.aiScore });
      io.to(other.socketId).emit("match:found", { roomId, partnerName: u.name, aiScore: other.aiScore });

      io.to(roomId).emit("icebreaker:set", { roomId, index: 0 });

      emitGlobalStats();
      emitAdminSnapshot();
    } else {
      if (state.waiting.length < WAITING_LIMIT) state.waiting.push({ socketId: socket.id, ts: now() });
      socket.emit("match:searching");
      emitGlobalStats();
      emitAdminSnapshot();
    }
  });

  socket.on("match:stop", () => {
    if (!bucketTake(socket.id, "event", 1)) return;
    const u = mustBeRegistered();
    if (!u) return;

    u.searching = false;
    removeFromWaiting(socket.id);

    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ---------- Icebreaker navigation ---------- */
  socket.on("icebreaker:nav", ({ roomId, dir } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", dir: dir ?? "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const u = mustBeRegistered();
    if (!u || !u.roomId || u.roomId !== roomId) return;

    const room = state.rooms.get(roomId);
    if (!room) return;

    let idx = Number(room.qIndex) || 0;
    if (dir === "next") idx++;
    else if (dir === "prev") idx--;
    else return;

    idx = clamp(idx, 0, QUESTIONS.length - 1);
    room.qIndex = idx;

    touchRoomActivity(roomId);
    io.to(roomId).emit("icebreaker:set", { roomId, index: idx });
  });

  /* ---------- Chat (Human & AI) ---------- */
  socket.on("chat:message", async ({ roomId, text } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", text: text ?? "" }));
    if (!bucketTake(socket.id, "msg", bytes)) return;

    const u = mustBeRegistered();
    if (!u || !u.roomId || u.roomId !== roomId) return;

    const room = state.rooms.get(roomId);
    if (!room) return;

    const msgText = String(text ?? "").slice(0, MAX_MSG_LEN);
    if (!msgText.trim()) return;

    state.totals.messages++;
    touchRoomActivity(roomId);

    const msg = { from: u.name, text: msgText, ts: now() };
    room.history.push(msg);
    if (room.history.length > ROOM_HISTORY_LIMIT) room.history.shift();

    if (room.ai) {
      socket.emit("chat:message", msg);

      if (!room.topic && msgText.trim().length >= 3) room.topic = msgText.trim();

      const sys =
        "You are an IELTS speaking coach in a voice practice app.\n" +
        "Every turn you MUST output exactly this structure:\n" +
        "Reply: <1-2 short sentences>\n" +
        "Fixes:\n" +
        "- <Wrong -> Correct>\n" +
        "- <Wrong -> Correct>\n" +
        "Tip: <one short advice>\n" +
        "Next question: <one follow-up question>\n" +
        "English only. Keep it short, friendly.";

      const t0 = hrTimeMs();
      const aiReply = await geminiText({
        system: sys,
        user: `Topic: ${room.topic || "general"}\nUser said: ${msgText}`,
        maxOutputTokens: 340,
        temperature: 0.65
      });
      const t1 = hrTimeMs();
      const dt = (t1 - t0);

      state.totals.aiReplies++;
      state.metrics.aiLatencyMsLast = dt;
      state.metrics.aiLatencyWindow.push({ ts: now(), ms: dt });

      const aiMsg = { from: "AI", text: aiReply, ts: now() };
      room.history.push(aiMsg);
      if (room.history.length > ROOM_HISTORY_LIMIT) room.history.shift();

      setTimeout(() => socket.emit("chat:message", aiMsg), 120);

      info("ai_reply", { ms: dt, roomId, user: u.name });
      emitGlobalStats();
      emitAdminSnapshot();
      return;
    }

    io.to(roomId).emit("chat:message", msg);
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ---------- Leave (AI: generate report & score) ---------- */
  socket.on("room:leave", async () => {
    if (!bucketTake(socket.id, "event", 2)) return;

    const u = mustBeRegistered();
    if (!u?.roomId) return;

    const roomId = u.roomId;
    const room = state.rooms.get(roomId);

    if (room && room.ai) {
      const myName = u.name;
      const myMsgs = (room.history || [])
        .filter((m) => m.from === myName)
        .map((m) => m.text)
        .join("\n");

      const sys =
        "You are an IELTS speaking examiner.\n" +
        "Return JSON only with this exact schema:\n" +
        "{\n" +
        '  "band": 0-9,\n' +
        '  "fluency": 0-9,\n' +
        '  "grammar": 0-9,\n' +
        '  "vocab": 0-9,\n' +
        '  "pronunciation": 0-9,\n' +
        '  "summary": "1-2 sentences",\n' +
        '  "fixes": ["Wrong -> Correct", "Wrong -> Correct", "Wrong -> Correct"],\n' +
        '  "next_steps": ["...", "...", "..."]\n' +
        "}\n" +
        "English only. Be strict.";

      const rep = await geminiJSON({
        system: sys,
        user: `User messages:\n${myMsgs || "(no messages)"}`,
        maxOutputTokens: 520,
        temperature: 0.25
      });

      const band = clamp(Number(rep.band) || 0, 0, 9);
      u.aiScore = {
        band,
        fluency: clamp(Number(rep.fluency) || 0, 0, 9),
        grammar: clamp(Number(rep.grammar) || 0, 0, 9),
        vocab: clamp(Number(rep.vocab) || 0, 0, 9),
        pronunciation: clamp(Number(rep.pronunciation) || 0, 0, 9)
      };

      io.to(socket.id).emit("coach:report", { report: rep, aiScore: u.aiScore });
    }

    removeFromWaiting(socket.id);
    leaveRoom(socket.id, "left");
  });

  /* ---------- Report / Rate (human only) ---------- */
  socket.on("report:partner", ({ roomId } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const u = mustBeRegistered();
    if (!u || !u.roomId || u.roomId !== roomId) return;

    const room = state.rooms.get(roomId);
    if (!room || room.ai) return;

    const otherId = roomOther(room, socket.id);
    const other = otherId ? state.usersBySocket.get(otherId) : null;
    if (!other) return;

    addReport(other.name);
    socket.emit("report:ok", { reported: other.name });
    emitAdminSnapshot();
  });

  socket.on("rate:partner", ({ roomId, stars } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", stars: stars ?? "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const u = mustBeRegistered();
    if (!u || !u.roomId || u.roomId !== roomId) return;

    const room = state.rooms.get(roomId);
    if (!room || room.ai) return;

    const otherId = roomOther(room, socket.id);
    const other = otherId ? state.usersBySocket.get(otherId) : null;
    if (!other) return;

    addRating(other.name, stars);
    socket.emit("rate:ok", { rated: other.name });
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ---------- WebRTC signaling (human only) ---------- */
  socket.on("webrtc:offer", ({ roomId, sdp } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", sdp: sdp ? "[sdp]" : "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const u = mustBeRegistered();
    if (!u || u.roomId !== roomId) return;

    const room = state.rooms.get(roomId);
    if (!room || room.ai) return;

    const otherId = roomOther(room, socket.id);
    if (!otherId) return;

    touchRoomActivity(roomId);
    io.to(otherId).emit("webrtc:offer", { sdp, from: u.name });
  });

  socket.on("webrtc:answer", ({ roomId, sdp } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", sdp: sdp ? "[sdp]" : "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const u = mustBeRegistered();
    if (!u || u.roomId !== roomId) return;

    const room = state.rooms.get(roomId);
    if (!room || room.ai) return;

    const otherId = roomOther(room, socket.id);
    if (!otherId) return;

    touchRoomActivity(roomId);
    io.to(otherId).emit("webrtc:answer", { sdp, from: u.name });
  });

  socket.on("webrtc:ice", ({ roomId, candidate } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", candidate: candidate ? "[ice]" : "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const u = mustBeRegistered();
    if (!u || u.roomId !== roomId) return;

    const room = state.rooms.get(roomId);
    if (!room || room.ai) return;

    const otherId = roomOther(room, socket.id);
    if (!otherId) return;

    touchRoomActivity(roomId);
    io.to(otherId).emit("webrtc:ice", { candidate, from: u.name });
  });

  /* ---------- Admin Socket Events (token protected) ---------- */
  function adminAuth(payload) {
    const tok = String(payload?.token || "").trim();
    return ADMIN_TOKEN && tok && tok === ADMIN_TOKEN;
  }

  socket.on("admin:get", (payload = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify(payload || {}));
    if (!bucketTake(socket.id, "event", bytes)) return;
    if (!adminAuth(payload)) return;
    emitAdminSnapshot(socket.id);
  });

  socket.on("admin:ban", (payload = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify(payload || {}));
    if (!bucketTake(socket.id, "event", bytes)) return;
    if (!adminAuth(payload)) return;
    banName(payload.name);
  });

  socket.on("admin:unban", (payload = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify(payload || {}));
    if (!bucketTake(socket.id, "event", bytes)) return;
    if (!adminAuth(payload)) return;
    unbanName(payload.name);
  });

  /* ---------- Disconnect ---------- */
  socket.on("disconnect", (reason) => {
    const u = state.usersBySocket.get(socket.id);

    removeFromWaiting(socket.id);
    if (u?.roomId) leaveRoom(socket.id, "disconnect");

    if (u) {
      state.usersBySocket.delete(socket.id);
      if (state.socketsByName.get(u.name) === socket.id) state.socketsByName.delete(u.name);
      if (u.tg?.id && state.socketsByTgId.get(u.tg.id) === socket.id) state.socketsByTgId.delete(u.tg.id);
    }

    state.buckets.delete(socket.id);

    emitGlobalStats();
    emitAdminSnapshot();

    info("disconnect", { reason, socketId: socket.id });
  });
});

/* ===================== Start ===================== */
(async function start() {
  await tgLoadFromDisk();

  server.listen(PORT, () => {
    info("server_start", {
      port: PORT,
      env: NODE_ENV,
      stun: STUN,
      turnConfigured: !!(TURN_URL && TURN_USER && TURN_PASS),
      forceRelay: FORCE_RELAY,
      cors: CORS_ORIGINS,
      tgUsers: tgStore.byId.size
    });

    if (!ADMIN_TOKEN) warn("ADMIN_TOKEN is missing — admin actions disabled.");
    if (!GEMINI_API_KEY) warn("GEMINI_API_KEY is missing — AI Coach will reply with config warning.");
  });
})();

/* ===================== Graceful shutdown ===================== */
function shutdown(signal) {
  warn("shutdown", { signal });
  try {
    io.close(() => {
      server.close(async () => {
        try { await tgSaveNow(); } catch {}
        process.exit(0);
      });
    });
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
