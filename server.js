// server.js
// ============================================================================
// WonderTalk — PRO server.js (Express + Socket.IO + WebRTC + AI)
// ----------------------------------------------------------------------------
// - ✅ "ENVsiz": hammasi kod ichida (Replit uchun qulay)
// - ✅ Open CORS (reflect Origin / allow all)
// - ✅ Helmet + compression + HTTP rate-limit
// - ✅ Socket token bucket (events/messages/bytes)
// - ✅ Room lifecycle + TTL cleanup
// - ✅ Admin HTTP API (token) + Admin snapshot socket events
// - ✅ TURN/STUN config endpoint
// - ✅ AI Coach (Groq / xAI / Gemini) + timeout guards + metrics
//
// ⚠️ NOTE: Secrets (ADMIN_TOKEN, API keys) kod ichida bo‘ladi.
//           GitHub’ga qo‘ymang. Keylarni ehtiyot qiling.
//
// Replit:
// - Run: node server.js
// - Port: Replit avtomatik process.env.PORT beradi (biz ham qo‘llab-quvvatlaymiz)
//
// ============================================================================

"use strict";

const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

/* ===================== Config (ENVsiz) ===================== */
const NODE_ENV = (process.env.NODE_ENV || "development").trim();
const IS_PROD = NODE_ENV === "production";

const PORT = Number(process.env.PORT || 3000); // Replit ko‘pincha PORT beradi
const TRUST_PROXY = (process.env.TRUST_PROXY || "1").trim();
const STATIC_DIR = path.join(__dirname, "public");

// ✅ ADMIN TOKEN (ENVsiz) — O'ZINGIZ QO'YING
const ADMIN_TOKEN = "shoxruxjonxonbek";

// AI provider selection (ENVsiz)
const AI_PROVIDER = "groq"; // "groq" | "xai" | "gemini"

// Groq (OpenAI-compatible)
const GROQ_API_KEY = "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";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// xAI Grok (OpenAI-compatible style endpoints on api.x.ai)
const XAI_API_KEY = "PASTE_YOUR_XAI_API_KEY_HERE";
const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_MODEL = "grok-4-fast-reasoning";

// Gemini
const GEMINI_API_KEY = "AIzaSyDKAtmJHMtPC6Ui56tFt7Ij0cPoP9gn8qs";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL = "gemini-2.5-flash";

// WebRTC ICE
const STUN = "stun:stun.l.google.com:19302";
const TURN_URL = "";  // masalan: "turn:your.turn.server:3478"
const TURN_USER = "";
const TURN_PASS = "";
const FORCE_RELAY = false;

// Limits
const JSON_LIMIT = "1mb";
const MAX_NAME_LEN = 40;
const MAX_MSG_LEN = 2000;
const ROOM_HISTORY_LIMIT = 80;
const WAITING_LIMIT = 2000;

// Cleanup/TTL
const ROOM_TTL_MS = 1000 * 60 * 60;       // 1h
const WAITING_TTL_MS = 1000 * 60 * 10;    // 10m
const ROOM_IDLE_END_MS = 1000 * 60 * 12;  // 12m

// Socket token bucket (per 10s)
const SOCKET_EVENTS_PER_10S = 140;
const SOCKET_MSGS_PER_10S = 45;
const SOCKET_BYTES_PER_10S = 60_000;

// HTTP AI timeout
const AI_TIMEOUT_MS = 9000;

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
    roomId: u.roomId || null
  };
}

function textFromOpenAICompatChoice(json) {
  const c = json?.choices?.[0];
  const content = c?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

/* ===================== Logger ===================== */
function log(level, msg, meta) {
  const base = { ts: new Date().toISOString(), level, msg, env: NODE_ENV };
  console.log(JSON.stringify(meta ? { ...base, ...meta } : base));
}
const info = (m, meta) => log("info", m, meta);
const warn = (m, meta) => log("warn", m, meta);
const error = (m, meta) => log("error", m, meta);

/* ===================== App / Server ===================== */
const app = express();
app.set("trust proxy", TRUST_PROXY);
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: JSON_LIMIT }));

/* ---------- Open CORS (domainlarsiz) ---------- */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- HTTP Rate limit ---------- */
app.use(rateLimit({
  windowMs: 10 * 1000,
  max: IS_PROD ? 250 : 2000,
  standardHeaders: true,
  legacyHeaders: false
}));

/* ---------- Static ---------- */
app.use(express.static(STATIC_DIR, {
  maxAge: IS_PROD ? "7d" : 0,
  etag: true
}));

/* ===================== In-memory State ===================== */
const state = {
  usersBySocket: new Map(), // socketId -> user
  socketsByName: new Map(), // name -> socketId
  bannedNames: new Set(),

  waiting: [],              // { socketId, ts }
  rooms: new Map(),         // roomId -> room

  reportsByName: new Map(),
  ratingsByName: new Map(),
  totals: { visitors: 0, messages: 0, aiReplies: 0 },

  buckets: new Map(),
  metrics: {
    aiProvider: AI_PROVIDER,
    aiLatencyMsLast: 0,
    aiLatencyMsMax5m: 0,
    aiLatencyWindow: [],
    aiErrors: 0
  }
};

/* ---------- Health ---------- */
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    uptime: process.uptime(),
    online: state.usersBySocket.size
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
    aiProvider: AI_PROVIDER,
    stun: STUN,
    turnConfigured: !!(TURN_URL && TURN_USER && TURN_PASS),
    forceRelay: FORCE_RELAY,
    aiConfigured: getAiConfigured()
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

app.get("/admin/stats", (req, res) => {
  if (!adminHttpAuth(req, res)) return;
  res.json({
    ok: true,
    online: state.usersBySocket.size,
    waiting: state.waiting.length,
    rooms: state.rooms.size,
    totals: { ...state.totals },
    metrics: {
      aiProvider: state.metrics.aiProvider,
      aiLatencyMsLast: state.metrics.aiLatencyMsLast,
      aiLatencyMsMax5m: state.metrics.aiLatencyMsMax5m,
      aiErrors: state.metrics.aiErrors
    }
  });
});

/* ===================== Create server + Socket.IO ===================== */
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] }, // open
  transports: ["websocket", "polling"],
  pingTimeout: 20000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6
});

/* ===================== Helpers: stats ===================== */
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
    totals: { ...state.totals }
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
      aiProvider: state.metrics.aiProvider,
      aiLatencyMsLast: state.metrics.aiLatencyMsLast,
      aiLatencyMsMax5m: state.metrics.aiLatencyMsMax5m,
      aiErrors: state.metrics.aiErrors
    }
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
  try { io.sockets.sockets.get(socketId)?.leave(roomId); } catch {}
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

/* ===================== HTTP client (fetchsiz) ===================== */
function httpRequestWithTimeout(urlStr, opts = {}, timeoutMs = AI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;

    const method = (opts.method || "GET").toUpperCase();
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body != null ? String(opts.body) : null;

    if (body != null && !headers["content-length"] && !headers["Content-Length"]) {
      headers["content-length"] = Buffer.byteLength(body);
    }

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        if (timedOut) return;
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 0,
          text,
          json
        });
      });
    });

    req.on("error", (err) => {
      if (timedOut) return;
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      try { req.destroy(new Error("timeout")); } catch {}
      reject(new Error("timeout"));
    });

    if (body != null) req.write(body);
    req.end();
  });
}

/* ===================== AI Provider Layer ===================== */
function getAiConfigured() {
  if (AI_PROVIDER === "groq") return !!GROQ_API_KEY && !String(GROQ_API_KEY).includes("PASTE_YOUR");
  if (AI_PROVIDER === "xai") return !!XAI_API_KEY && !String(XAI_API_KEY).includes("PASTE_YOUR");
  if (AI_PROVIDER === "gemini") return !!GEMINI_API_KEY && !String(GEMINI_API_KEY).includes("PASTE_YOUR");
  return false;
}

async function openAICompatChat({
  baseURL,
  apiKey,
  model,
  system,
  user,
  maxOutputTokens = 320,
  temperature = 0.7,
  timeoutMs = AI_TIMEOUT_MS
}) {
  if (!apiKey || String(apiKey).includes("PASTE_YOUR")) return "AI is not configured. Missing API key.";

  const url = `${String(baseURL).replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: "system", content: String(system || "") },
      { role: "user", content: String(user || "") }
    ],
    temperature,
    max_tokens: maxOutputTokens
  };

  try {
    const { ok, status, text, json } = await httpRequestWithTimeout(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    }, timeoutMs);

    if (!ok) return `AI error: ${status} ${(text || "").slice(0, 500)}`;

    const msg = textFromOpenAICompatChoice(json);
    return String(msg || "AI: (no response)").trim().slice(0, 2500);
  } catch (e) {
    return `AI error: ${String(e?.message || "timeout or network issue")}`;
  }
}

async function groqText({ system, user, maxOutputTokens = 320, temperature = 0.7, timeoutMs = AI_TIMEOUT_MS }) {
  return openAICompatChat({
    baseURL: GROQ_BASE_URL,
    apiKey: GROQ_API_KEY,
    model: GROQ_MODEL,
    system,
    user,
    maxOutputTokens,
    temperature,
    timeoutMs
  });
}

async function xaiText({ system, user, maxOutputTokens = 320, temperature = 0.7, timeoutMs = AI_TIMEOUT_MS }) {
  return openAICompatChat({
    baseURL: XAI_BASE_URL,
    apiKey: XAI_API_KEY,
    model: XAI_MODEL,
    system,
    user,
    maxOutputTokens,
    temperature,
    timeoutMs
  });
}

async function geminiText({ system, user, maxOutputTokens = 320, temperature = 0.7, timeoutMs = AI_TIMEOUT_MS }) {
  if (!GEMINI_API_KEY || String(GEMINI_API_KEY).includes("PASTE_YOUR")) return "AI is not configured. Missing GEMINI_API_KEY.";

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: `${system}\n\nUSER:\n${user}` }] }],
    generationConfig: { temperature, maxOutputTokens }
  };

  try {
    const { ok, status, text, json } = await httpRequestWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }, timeoutMs);

    if (!ok) return `AI error: ${status} ${(text || "").slice(0, 500)}`;

    const out =
      json?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").filter(Boolean).join("") ||
      "AI: (no response)";

    return String(out).trim().slice(0, 2500);
  } catch (e) {
    return `AI error: ${String(e?.message || "timeout or network issue")}`;
  }
}

async function aiText(opts) {
  if (AI_PROVIDER === "groq") return groqText(opts);
  if (AI_PROVIDER === "xai") return xaiText(opts);
  if (AI_PROVIDER === "gemini") return geminiText(opts);
  return `AI error: unsupported AI_PROVIDER "${AI_PROVIDER}"`;
}

async function aiJSON({ system, user, maxOutputTokens = 420, temperature = 0.35, timeoutMs = AI_TIMEOUT_MS }) {
  const raw = await aiText({ system, user, maxOutputTokens, temperature, timeoutMs });
  const t = String(raw || "").trim();

  try { return JSON.parse(t); } catch {}

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
}, 20_000).unref();

/* ===================== Socket.IO ===================== */
io.on("connection", (socket) => {
  state.totals.visitors++;

  socket.emit("global:questions", { questions: QUESTIONS });
  emitGlobalStats();
  emitAdminSnapshot();

  function mustBeRegistered() {
    return state.usersBySocket.get(socket.id) || null;
  }

  function touchRoomActivity(roomId) {
    const r = state.rooms.get(roomId);
    if (r) r.lastActivityAt = now();
  }

  /* ---------- Register ---------- */
  socket.on("user:register", ({ name } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ name: name ?? "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const n = normalizeName(name);
    if (!n) return socket.emit("user:register:fail", { reason: "bad_name" });
    if (state.bannedNames.has(n)) return socket.emit("user:register:fail", { reason: "banned" });

    // Kick same-name old session
    const oldId = state.socketsByName.get(n);
    if (oldId && oldId !== socket.id) {
      const oldSock = io.sockets.sockets.get(oldId);
      if (oldSock) {
        try { oldSock.emit("user:kicked"); } catch {}
        try { oldSock.disconnect(true); } catch {}
      }
    }

    // Rename flow
    const existing = state.usersBySocket.get(socket.id);
    if (existing) {
      if (existing.roomId) endRoom(existing.roomId, "rename");
      removeFromWaiting(socket.id);

      if (state.socketsByName.get(existing.name) === socket.id) {
        state.socketsByName.delete(existing.name);
      }

      state.socketsByName.set(n, socket.id);
      existing.name = n;
      existing.roomId = null;
      existing.searching = false;

      socket.emit("user:register:ok", { user: userPublic(existing), aiScore: existing.aiScore });
      emitGlobalStats();
      emitAdminSnapshot();
      return;
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
      aiScore: null
    };

    state.usersBySocket.set(socket.id, user);
    socket.emit("user:register:ok", { user: userPublic(user), aiScore: user.aiScore });
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ---------- Match start ---------- */
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

    // AI match if user selects AI
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
      if (state.waiting.length < WAITING_LIMIT) {
        state.waiting.push({ socketId: socket.id, ts: now() });
      }
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

  /* ---------- Icebreaker nav ---------- */
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

  /* ---------- Chat (human + AI) ---------- */
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

    // AI room
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
      const aiReply = await aiText({
        system: sys,
        user: `Topic: ${room.topic || "general"}\nUser said: ${msgText}`,
        maxOutputTokens: 340,
        temperature: 0.65,
        timeoutMs: AI_TIMEOUT_MS
      });
      const dt = hrTimeMs() - t0;

      if (String(aiReply).startsWith("AI error:")) state.metrics.aiErrors++;
      state.totals.aiReplies++;
      state.metrics.aiLatencyMsLast = dt;
      state.metrics.aiLatencyWindow.push({ ts: now(), ms: dt });

      const aiMsg = { from: "AI", text: String(aiReply).slice(0, 2500), ts: now() };
      room.history.push(aiMsg);
      if (room.history.length > ROOM_HISTORY_LIMIT) room.history.shift();

      setTimeout(() => socket.emit("chat:message", aiMsg), 120);

      emitGlobalStats();
      emitAdminSnapshot();
      return;
    }

    // Human room
    io.to(roomId).emit("chat:message", msg);
    emitGlobalStats();
    emitAdminSnapshot();
  });

  /* ---------- Leave room (AI report on exit) ---------- */
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

      const rep = await aiJSON({
        system: sys,
        user: `User messages:\n${myMsgs || "(no messages)"}`,
        maxOutputTokens: 520,
        temperature: 0.25,
        timeoutMs: AI_TIMEOUT_MS
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
      if (state.socketsByName.get(u.name) === socket.id) {
        state.socketsByName.delete(u.name);
      }
    }

    state.buckets.delete(socket.id);

    emitGlobalStats();
    emitAdminSnapshot();

    info("disconnect", { reason, socketId: socket.id });
  });
});

/* ===================== Start ===================== */
server.listen(PORT, "0.0.0.0", () => {
  info("server_start", {
    port: PORT,
    env: NODE_ENV,
    aiProvider: AI_PROVIDER,
    stun: STUN,
    turnConfigured: !!(TURN_URL && TURN_USER && TURN_PASS),
    forceRelay: FORCE_RELAY,
    aiConfigured: getAiConfigured()
  });

  if (!ADMIN_TOKEN || String(ADMIN_TOKEN).includes("PASTE_YOUR")) warn("ADMIN_TOKEN is missing — admin actions disabled.");
  if (AI_PROVIDER === "groq" && (!GROQ_API_KEY || String(GROQ_API_KEY).includes("PASTE_YOUR"))) warn("GROQ_API_KEY missing — AI replies will show config warning.");
  if (AI_PROVIDER === "xai" && (!XAI_API_KEY || String(XAI_API_KEY).includes("PASTE_YOUR"))) warn("XAI_API_KEY missing — AI replies will show config warning.");
  if (AI_PROVIDER === "gemini" && (!GEMINI_API_KEY || String(GEMINI_API_KEY).includes("PASTE_YOUR"))) warn("GEMINI_API_KEY missing — AI replies will show config warning.");
});

/* ===================== Graceful shutdown ===================== */
function shutdown(signal) {
  warn("shutdown", { signal });
  try {
    io.close(() => {
      server.close(() => process.exit(0));
    });
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
