// server.js — WonderTalk PRO
// ============================================================================
// KEY FIXES:
//   ✅ myGender/myLevel  = user's OWN gender & level  (set at register)
//   ✅ wantGender/wantLevel = partner preference       (set at match:start)
//   ✅ samePrefs() cross-check: male→female ↔ female→male
//   ✅ match:found includes partnerGender + partnerLevel
//   ✅ global:users event — online list for all clients
//   ✅ admin:snapshot includes full user list
//   ✅ admin:kick event added
// ============================================================================
"use strict";

try { require("dotenv").config(); } catch {}

const path   = require("path");
const http   = require("http");
const crypto = require("crypto");

const express     = require("express");
const helmet      = require("helmet");
const compression = require("compression");
const rateLimit   = require("express-rate-limit");
const { Server }  = require("socket.io");

/* ===================== ENV / Config ===================== */
const NODE_ENV    = (process.env.NODE_ENV || "development").trim();
const IS_PROD     = NODE_ENV === "production";
const PORT        = Number(process.env.PORT || 3000);
const TRUST_PROXY = (process.env.TRUST_PROXY || "1").trim();
const STATIC_DIR  = path.join(__dirname, "public");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "salom123";

// AI
const AI_PROVIDER  = (process.env.AI_PROVIDER || "groq").trim().toLowerCase();
const GROQ_API_KEY = "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";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_MODEL   = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const XAI_API_KEY  = (process.env.XAI_API_KEY  || "").trim();
const XAI_BASE_URL = (process.env.XAI_BASE_URL || "https://api.x.ai/v1").trim();
const XAI_MODEL    = (process.env.XAI_MODEL    || "grok-4-fast-reasoning").trim();

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_BASE    = (process.env.GEMINI_BASE    || "https://generativelanguage.googleapis.com/v1beta").trim();
const GEMINI_MODEL   = (process.env.GEMINI_MODEL   || "gemini-2.5-flash").trim();

// WebRTC
const TURN_USER   = "b4a729fa2f17923032be306e";
const TURN_PASS   = "E9ZqX0aTVZm9qhcF";
const FORCE_RELAY = String(process.env.FORCE_RELAY || "").toLowerCase() === "true";

// Limits
const JSON_LIMIT         = (process.env.JSON_LIMIT || "1mb").trim();
const MAX_NAME_LEN       = Number(process.env.MAX_NAME_LEN       || 40);
const MAX_MSG_LEN        = Number(process.env.MAX_MSG_LEN        || 2000);
const ROOM_HISTORY_LIMIT = Number(process.env.ROOM_HISTORY_LIMIT || 80);
const WAITING_LIMIT      = Number(process.env.WAITING_LIMIT      || 2000);
const ROOM_TTL_MS        = Number(process.env.ROOM_TTL_MS        || 1000 * 60 * 60);
const WAITING_TTL_MS     = Number(process.env.WAITING_TTL_MS     || 1000 * 60 * 10);
const ROOM_IDLE_END_MS   = Number(process.env.ROOM_IDLE_END_MS   || 1000 * 60 * 12);

// Socket token bucket (per 10 s)
const SOCKET_EVENTS_PER_10S = Number(process.env.SOCKET_EVENTS_PER_10S || 140);
const SOCKET_MSGS_PER_10S   = Number(process.env.SOCKET_MSGS_PER_10S   || 45);
const SOCKET_BYTES_PER_10S  = Number(process.env.SOCKET_BYTES_PER_10S  || 60_000);
const AI_TIMEOUT_MS         = Number(process.env.AI_TIMEOUT_MS         || 9000);

/* -------- Valid enums -------- */
const VALID_OWN_GENDERS  = new Set(["Male", "Female"]);
const VALID_WANT_GENDERS = new Set(["Any", "Male", "Female", "AI"]);
const VALID_LEVELS       = new Set([
  "Any", "Beginner", "Elementary",
  "Intermediate", "Upper_intermediate", "Advanced"
]);

/* -------- Questions -------- */
const QUESTIONS = [
  "What is your hobby, and why do you enjoy it?",
  "Where do you live, and what do you like about that place?",
  "What's a skill you want to learn this year?",
  "Tell me about a memorable day you had recently.",
  "What kind of music do you listen to, and when do you listen to it?",
  "If you could travel anywhere, where would you go and why?",
  "What do you usually do on weekends?",
  "What is your favorite movie or series, and what do you like about it?",
  "What's a goal you're working on right now?",
  "What makes a good friend, in your opinion?",
  "If you could live in any era, past or future, which would it be and why?",
  "What is a talent or skill you admire in others?",
  "Do you like animals? If yes, which one is your favorite and why?",
  "What’s your favorite subject in school or area of learning, and why?",
  "Have you ever faced a challenge that taught you something important? What happened?",
  "What’s your favorite way to relax after a long day?",
  "If you could meet any famous person, living or dead, who would it be and why?",
  "Do you prefer the beach or the mountains, and why?",
  "What’s your favorite game, and what do you enjoy most about it?",
  "Is there a language you want to learn, and why?",
  "What’s one memory that always makes you smile?",
];

/* ===================== Utilities ===================== */
const now   = () => Date.now();
const clamp = (n, a, b) => Math.max(a, Math.min(b, +n || 0));

function safeStr(x, max = 80) { return String(x ?? "").trim().slice(0, max); }
function normalizeName(name)   { return safeStr(name, MAX_NAME_LEN).replace(/\s+/g, " "); }
function uid(n = 16)           { return crypto.randomBytes(n).toString("hex"); }
function hrTimeMs()            { return Number(process.hrtime.bigint() / 1000000n); }
function makeRoomId(a, b)      { return `room_${[String(a),String(b)].sort().join("_")}_${now()}_${uid(4)}`; }

function sanitizeOwnGender(v) {
  const s = safeStr(v, 20);
  return VALID_OWN_GENDERS.has(s) ? s : "Male"; // default Male if not set
}
function sanitizeWantGender(v) {
  const s = safeStr(v, 20);
  return VALID_WANT_GENDERS.has(s) ? s : "Any";
}
function sanitizeLevel(v) {
  const s = safeStr(v, 25);
  return VALID_LEVELS.has(s) ? s : "Any";
}

// ── FIXED: proper bidirectional gender+level matching ─────────────────────
// A.myGender   = A's own gender  ("Male"|"Female")
// A.wantGender = what gender partner A wants ("Any"|"Male"|"Female")
// Match if: A's gender OK for B's want  AND  B's gender OK for A's want
//           A's level  OK for B's want  AND  B's level  OK for A's want
function samePrefs(a, b) {
  const aGenderOkForB = b.wantGender === "Any" || b.wantGender === a.myGender;
  const bGenderOkForA = a.wantGender === "Any" || a.wantGender === b.myGender;
  const aLevelOkForB  = b.wantLevel  === "Any" || b.wantLevel  === a.myLevel;
  const bLevelOkForA  = a.wantLevel  === "Any" || a.wantLevel  === b.myLevel;
  return aGenderOkForB && bGenderOkForA && aLevelOkForB && bLevelOkForA;
}

function userPublic(u) {
  return {
    name      : u.name,
    myGender  : u.myGender,
    myLevel   : u.myLevel,
    wantGender: u.wantGender,
    wantLevel : u.wantLevel,
    roomId    : u.roomId    || null,
    searching : u.searching || false
  };
}

function textFromOpenAICompatChoice(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map(p => (typeof p === "string" ? p : p?.text || "")).filter(Boolean).join("");
  return "";
}

/* ===================== Logger ===================== */
const log  = (lvl, msg, meta) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, env: NODE_ENV, ...meta }));
const info = (m, meta) => log("info",  m, meta);
const warn = (m, meta) => log("warn",  m, meta);

/* ===================== Express app ===================== */
const app = express();
app.set("trust proxy", TRUST_PROXY);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: JSON_LIMIT }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(rateLimit({ windowMs: 10_000, max: IS_PROD ? 250 : 2000, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(STATIC_DIR, { maxAge: IS_PROD ? "7d" : 0, etag: true }));

/* ===================== In-memory State ===================== */
const state = {
  usersBySocket : new Map(),
  socketsByName : new Map(),
  bannedNames   : new Set(),
  waiting       : [],
  rooms         : new Map(),
  reportsByName : new Map(),
  ratingsByName : new Map(),
  totals        : { visitors: 0, messages: 0, aiReplies: 0 },
  buckets       : new Map(),
  metrics: {
    aiProvider      : AI_PROVIDER,
    aiLatencyMsLast : 0,
    aiLatencyMsMax5m: 0,
    aiLatencyWindow : [],
    aiErrors        : 0
  }
};

/* ===================== HTTP routes ===================== */
app.get("/healthz", (req, res) => res.json({ ok: true, env: NODE_ENV, uptime: process.uptime(), online: state.usersBySocket.size }));

app.get("/webrtc-config", (req, res) => res.json({
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "turn:global.relay.metered.ca:80",                 username: TURN_USER, credential: TURN_PASS },
    { urls: "turn:global.relay.metered.ca:80?transport=tcp",   username: TURN_USER, credential: TURN_PASS },
    { urls: "turn:global.relay.metered.ca:443",                username: TURN_USER, credential: TURN_PASS },
    { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: TURN_USER, credential: TURN_PASS }
  ],
  forceRelay: FORCE_RELAY
}));

app.get("/diag", (req, res) => res.json({ env: NODE_ENV, aiProvider: AI_PROVIDER, turnConfigured: !!(TURN_USER && TURN_PASS), forceRelay: FORCE_RELAY, aiConfigured: getAiConfigured() }));

function adminHttpAuth(req, res) {
  const tok = String(req.headers["x-admin-token"] || "").trim();
  if (!ADMIN_TOKEN || tok !== ADMIN_TOKEN) { res.status(401).json({ ok: false, error: "unauthorized" }); return false; }
  return true;
}

app.get("/admin/stats", (req, res) => {
  if (!adminHttpAuth(req, res)) return;
  res.json({ ok: true, online: state.usersBySocket.size, waiting: state.waiting.length, rooms: state.rooms.size, totals: { ...state.totals }, metrics: { ...state.metrics, aiLatencyWindow: undefined } });
});

/* ===================== Server + Socket.IO ===================== */
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  pingTimeout : 20000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6
});

/* ===================== Helpers ===================== */
function getOnlineUsers() {
  return Array.from(state.usersBySocket.values()).map(u => ({
    name      : u.name,
    myGender  : u.myGender,
    myLevel   : u.myLevel,
    wantGender: u.wantGender,
    wantLevel : u.wantLevel,
    roomId    : u.roomId    || null,
    searching : u.searching || false,
    createdAt : u.createdAt
  }));
}

function getReports() {
  return Array.from(state.reportsByName.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function getRatingsLeaderboard(limit = 50) {
  return Array.from(state.ratingsByName.entries())
    .map(([name, r]) => ({ name, avg: +(r.count ? r.sum / r.count : 0).toFixed(2), count: r.count }))
    .sort((a, b) => b.avg - a.avg || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function emitGlobalStats() {
  io.emit("global:stats", { online: state.usersBySocket.size, waiting: state.waiting.length, rooms: state.rooms.size, totals: { ...state.totals } });
  io.emit("global:users", { users: getOnlineUsers() });   // ← online user list
}

function emitAdminSnapshot(toSocketId = null) {
  const payload = {
    online     : state.usersBySocket.size,
    waiting    : state.waiting.length,
    rooms      : state.rooms.size,
    totals     : { ...state.totals },
    users      : getOnlineUsers(),          // ← full list with gender/level
    reports    : getReports(),
    banned     : Array.from(state.bannedNames).sort((a, b) => a.localeCompare(b)),
    leaderboard: getRatingsLeaderboard(50),
    metrics    : { aiProvider: state.metrics.aiProvider, aiLatencyMsLast: state.metrics.aiLatencyMsLast, aiLatencyMsMax5m: state.metrics.aiLatencyMsMax5m, aiErrors: state.metrics.aiErrors }
  };
  if (toSocketId) io.to(toSocketId).emit("admin:snapshot", payload);
  else            io.emit("admin:snapshot", payload);
}

/* ===================== Room helpers ===================== */
function removeFromWaiting(socketId) {
  state.waiting = state.waiting.filter(w => w.socketId !== socketId);
}

function roomOther(room, socketId) { return room.a === socketId ? room.b : room.a; }

function endRoom(roomId, reason) {
  const room = state.rooms.get(roomId);
  if (!room) return;
  for (const id of [room.a, room.b].filter(Boolean)) {
    const u = state.usersBySocket.get(id);
    if (u) { u.roomId = null; u.searching = false; }
    io.to(id).emit("room:ended", { reason: reason || "ended" });
    try { io.sockets.sockets.get(id)?.leave(roomId); } catch {}
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

/* ===================== Token bucket ===================== */
function bucketTake(socketId, kind = "event", bytes = 0) {
  const t = now();
  const b = state.buckets.get(socketId) || { ts: t, eventCount: 0, msgCount: 0, byteCount: 0 };
  if (t - b.ts > 10_000) { b.ts = t; b.eventCount = 0; b.msgCount = 0; b.byteCount = 0; }
  b.byteCount += Math.max(0, +bytes || 0);
  if (b.byteCount > SOCKET_BYTES_PER_10S)                         { state.buckets.set(socketId, b); return false; }
  if (kind === "msg") { b.msgCount++;   if (b.msgCount   > SOCKET_MSGS_PER_10S)   { state.buckets.set(socketId, b); return false; } }
  else                { b.eventCount++; if (b.eventCount > SOCKET_EVENTS_PER_10S) { state.buckets.set(socketId, b); return false; } }
  state.buckets.set(socketId, b);
  return true;
}

/* ===================== Reports / Ratings / Bans ===================== */
function addReport(name) {
  const n = normalizeName(name); if (!n) return;
  state.reportsByName.set(n, (state.reportsByName.get(n) || 0) + 1);
}
function addRating(name, stars) {
  const n = normalizeName(name); if (!n) return;
  const s = clamp(+stars, 1, 5);
  if (!state.ratingsByName.has(n)) state.ratingsByName.set(n, { sum: 0, count: 0 });
  const r = state.ratingsByName.get(n); r.sum += s; r.count++;
}
function banName(name) {
  const n = normalizeName(name); if (!n) return;
  state.bannedNames.add(n);
  const sockId = state.socketsByName.get(n);
  if (sockId) {
    const u = state.usersBySocket.get(sockId);
    if (u?.roomId) leaveRoom(sockId, "banned");
    removeFromWaiting(sockId);
    io.to(sockId).emit("user:banned");
    try { io.sockets.sockets.get(sockId)?.disconnect(true); } catch {}
  }
  emitAdminSnapshot(); emitGlobalStats();
}
function unbanName(name) {
  const n = normalizeName(name); if (!n) return;
  state.bannedNames.delete(n);
  emitAdminSnapshot();
}
function kickName(name) {
  const n = normalizeName(name); if (!n) return;
  const sockId = state.socketsByName.get(n);
  if (!sockId) return;
  const u = state.usersBySocket.get(sockId);
  if (u?.roomId) leaveRoom(sockId, "kicked");
  removeFromWaiting(sockId);
  io.to(sockId).emit("user:kicked");
  try { io.sockets.sockets.get(sockId)?.disconnect(true); } catch {}
  emitAdminSnapshot(); emitGlobalStats();
}

/* ===================== AI Layer ===================== */
function getAiConfigured() {
  if (AI_PROVIDER === "groq")   return !!GROQ_API_KEY;
  if (AI_PROVIDER === "xai")    return !!XAI_API_KEY;
  if (AI_PROVIDER === "gemini") return !!GEMINI_API_KEY;
  return false;
}

async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = AI_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: ac.signal });
    const text = await resp.text().catch(() => "");
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: resp.ok, status: resp.status, text, json };
  } finally { clearTimeout(timer); }
}

async function openAICompatChat({ baseURL, apiKey, model, system, user, maxOutputTokens = 320, temperature = 0.7, timeoutMs = AI_TIMEOUT_MS }) {
  if (!apiKey) return "AI is not configured. Missing API key.";
  const url  = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const body = { model, messages: [{ role: "system", content: String(system || "") }, { role: "user", content: String(user || "") }], temperature, max_tokens: maxOutputTokens };
  try {
    const { ok, status, text, json } = await fetchJsonWithTimeout(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) }, timeoutMs);
    if (!ok) return `AI error: ${status} ${(text || "").slice(0, 500)}`;
    return String(textFromOpenAICompatChoice(json) || "AI: (no response)").trim().slice(0, 2500);
  } catch (e) { return `AI error: ${String(e?.message || "timeout")}`; }
}

const groqText = opts => openAICompatChat({ baseURL: GROQ_BASE_URL, apiKey: GROQ_API_KEY, model: GROQ_MODEL, ...opts });
const xaiText  = opts => openAICompatChat({ baseURL: XAI_BASE_URL,  apiKey: XAI_API_KEY,  model: XAI_MODEL,  ...opts });

async function geminiText({ system, user, maxOutputTokens = 320, temperature = 0.7, timeoutMs = AI_TIMEOUT_MS }) {
  if (!GEMINI_API_KEY) return "AI is not configured. Missing GEMINI_API_KEY.";
  const url  = `${GEMINI_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = { contents: [{ role: "user", parts: [{ text: `${system}\n\nUSER:\n${user}` }] }], generationConfig: { temperature, maxOutputTokens } };
  try {
    const { ok, status, text, json } = await fetchJsonWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
    if (!ok) return `AI error: ${status} ${(text || "").slice(0, 500)}`;
    return String(json?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").filter(Boolean).join("") || "AI: (no response)").trim().slice(0, 2500);
  } catch (e) { return `AI error: ${String(e?.message || "timeout")}`; }
}

async function aiText(opts) {
  if (AI_PROVIDER === "groq")   return groqText(opts);
  if (AI_PROVIDER === "xai")    return xaiText(opts);
  if (AI_PROVIDER === "gemini") return geminiText(opts);
  return `AI error: unsupported provider "${AI_PROVIDER}"`;
}

async function aiJSON(opts) {
  const raw  = await aiText(opts);
  const t    = String(raw || "").trim();
  try { return JSON.parse(t); } catch {}
  const f = t.indexOf("{"), l = t.lastIndexOf("}");
  if (f >= 0 && l > f) { try { return JSON.parse(t.slice(f, l + 1)); } catch {} }
  return { error: "bad_json", raw: t.slice(0, 900) };
}

/* ===================== Cleanup intervals ===================== */
function cleanupWaiting() {
  const t = now();
  state.waiting = state.waiting.filter(w => (t - w.ts) <= WAITING_TTL_MS);
  if (state.waiting.length > WAITING_LIMIT) state.waiting = state.waiting.slice(0, WAITING_LIMIT);
}
function cleanupRooms() {
  const t = now();
  for (const [roomId, room] of state.rooms.entries()) {
    const ca = Number(room?.createdAt) || 0;
    const la = Number(room?.lastActivityAt) || ca;
    if (ca && (t - ca) > ROOM_TTL_MS)           { endRoom(roomId, "timeout");      continue; }
    if (la && (t - la) > ROOM_IDLE_END_MS)         endRoom(roomId, "idle_timeout");
  }
}
setInterval(() => {
  cleanupWaiting(); cleanupRooms();
  const win = state.metrics.aiLatencyWindow, cutoff = now() - 5 * 60_000;
  while (win.length && win[0].ts < cutoff) win.shift();
  state.metrics.aiLatencyMsMax5m = win.reduce((m, x) => Math.max(m, x.ms), 0);
}, 20_000).unref();

/* ===================== Socket.IO ===================== */
io.on("connection", socket => {
  state.totals.visitors++;
  socket.emit("global:questions", { questions: QUESTIONS });
  emitGlobalStats();
  emitAdminSnapshot();

  const mustBeRegistered = () => state.usersBySocket.get(socket.id) || null;
  const touchRoom = roomId => { const r = state.rooms.get(roomId); if (r) r.lastActivityAt = now(); };

  /* ── Register ──────────────────────────────────────────────────── */
  // Payload: { name, myGender: "Male"|"Female", myLevel: "Any"|"Beginner"|... }
  socket.on("user:register", ({ name, myGender, myLevel } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ name: name ?? "", myGender: myGender ?? "", myLevel: myLevel ?? "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const n = normalizeName(name);
    if (!n)                           return socket.emit("user:register:fail", { reason: "bad_name" });
    if (state.bannedNames.has(n))     return socket.emit("user:register:fail", { reason: "banned"   });

    // Kick existing session with same name
    const oldId = state.socketsByName.get(n);
    if (oldId && oldId !== socket.id) {
      const old = io.sockets.sockets.get(oldId);
      try { old?.emit("user:kicked"); } catch {}
      try { old?.disconnect(true);    } catch {}
    }

    const gVal = VALID_OWN_GENDERS.has(safeStr(myGender, 20)) ? safeStr(myGender, 20) : "Male";
    const lVal = sanitizeLevel(myLevel);

    const existing = state.usersBySocket.get(socket.id);
    if (existing) {
      if (existing.roomId) endRoom(existing.roomId, "rename");
      removeFromWaiting(socket.id);
      if (state.socketsByName.get(existing.name) === socket.id) state.socketsByName.delete(existing.name);
      state.socketsByName.set(n, socket.id);
      Object.assign(existing, { name: n, myGender: gVal, myLevel: lVal, roomId: null, searching: false });
      socket.emit("user:register:ok", { user: userPublic(existing), aiScore: existing.aiScore });
      emitGlobalStats(); emitAdminSnapshot();
      return;
    }

    state.socketsByName.set(n, socket.id);
    const user = {
      socketId  : socket.id,
      name      : n,
      myGender  : gVal,   // ← USER's OWN gender
      myLevel   : lVal,   // ← USER's OWN level
      wantGender: "Any",  // ← set later at match:start
      wantLevel : "Any",
      roomId    : null,
      searching : false,
      createdAt : now(),
      aiScore   : null
    };
    state.usersBySocket.set(socket.id, user);
    socket.emit("user:register:ok", { user: userPublic(user), aiScore: user.aiScore });
    emitGlobalStats(); emitAdminSnapshot();
  });

  /* ── Match start ────────────────────────────────────────────────── */
  // Payload: { wantGender: "Any"|"Male"|"Female"|"AI", wantLevel: "Any"|... }
  socket.on("match:start", ({ wantGender, wantLevel } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ wantGender: wantGender ?? "", wantLevel: wantLevel ?? "" }));
    if (!bucketTake(socket.id, "event", bytes)) return;

    const u = mustBeRegistered();
    if (!u) return;
    if (state.bannedNames.has(u.name)) return socket.emit("user:banned");

    if (u.roomId) leaveRoom(socket.id, "restart_search");
    removeFromWaiting(socket.id);

    u.wantGender = sanitizeWantGender(wantGender);
    u.wantLevel  = sanitizeLevel(wantLevel);
    u.searching  = true;

    // ── AI room ──────────────────────────────────────────────────
    if (u.wantGender === "AI") {
      const roomId = makeRoomId(socket.id, "AI");
      state.rooms.set(roomId, { id: roomId, a: socket.id, b: null, createdAt: now(), lastActivityAt: now(), qIndex: 0, ai: true, topic: null, history: [] });
      u.roomId = roomId; u.searching = false;
      socket.join(roomId);
      socket.emit("match:found", { roomId, partnerName: "AI", partnerGender: "AI", partnerLevel: "AI", aiScore: u.aiScore });
      socket.emit("icebreaker:set", { roomId, index: 0 });
      emitGlobalStats(); emitAdminSnapshot();
      return;
    }

    cleanupWaiting();

    // ── Find matching partner ──────────────────────────────────────
    let foundIndex = -1;
    for (let i = 0; i < state.waiting.length; i++) {
      const w     = state.waiting[i];
      const other = state.usersBySocket.get(w.socketId);
      if (!other || other.roomId || other.socketId === socket.id) continue;
      if (samePrefs(u, other)) { foundIndex = i; break; }
    }

    if (foundIndex >= 0) {
      const [w] = state.waiting.splice(foundIndex, 1);
      const other = state.usersBySocket.get(w.socketId);
      if (!other) return;

      const roomId = makeRoomId(socket.id, other.socketId);
      state.rooms.set(roomId, { id: roomId, a: socket.id, b: other.socketId, createdAt: now(), lastActivityAt: now(), qIndex: 0, ai: false, history: [] });
      u.roomId = roomId;      u.searching = false;
      other.roomId = roomId;  other.searching = false;

      socket.join(roomId);
      io.sockets.sockets.get(other.socketId)?.join(roomId);

      // ← send partner's real gender & level to each side
      io.to(socket.id).emit("match:found", {
        roomId,
        partnerName  : other.name,
        partnerGender: other.myGender,
        partnerLevel : other.myLevel,
        aiScore      : u.aiScore
      });
      io.to(other.socketId).emit("match:found", {
        roomId,
        partnerName  : u.name,
        partnerGender: u.myGender,
        partnerLevel : u.myLevel,
        aiScore      : other.aiScore
      });
      io.to(roomId).emit("icebreaker:set", { roomId, index: 0 });

    } else {
      if (state.waiting.length < WAITING_LIMIT) state.waiting.push({ socketId: socket.id, ts: now() });
      socket.emit("match:searching");
    }

    emitGlobalStats(); emitAdminSnapshot();
  });

  socket.on("match:stop", () => {
    if (!bucketTake(socket.id, "event", 1)) return;
    const u = mustBeRegistered(); if (!u) return;
    u.searching = false;
    removeFromWaiting(socket.id);
    emitGlobalStats(); emitAdminSnapshot();
  });

  /* ── Icebreaker nav ─────────────────────────────────────────────── */
  socket.on("icebreaker:nav", ({ roomId, dir } = {}) => {
    if (!bucketTake(socket.id, "event", 5)) return;
    const u = mustBeRegistered();
    if (!u || u.roomId !== roomId) return;
    const room = state.rooms.get(roomId); if (!room) return;
    let idx = Number(room.qIndex) || 0;
    if (dir === "next") idx++; else if (dir === "prev") idx--; else return;
    room.qIndex = clamp(idx, 0, QUESTIONS.length - 1);
    touchRoom(roomId);
    io.to(roomId).emit("icebreaker:set", { roomId, index: room.qIndex });
  });

  /* ── Chat (human + AI) ─────────────────────────────────────────── */
  socket.on("chat:message", async ({ roomId, text } = {}) => {
    const bytes = Buffer.byteLength(JSON.stringify({ roomId: roomId ?? "", text: text ?? "" }));
    if (!bucketTake(socket.id, "msg", bytes)) return;
    const u = mustBeRegistered();
    if (!u || u.roomId !== roomId) return;
    const room = state.rooms.get(roomId); if (!room) return;
    const msgText = String(text ?? "").slice(0, MAX_MSG_LEN);
    if (!msgText.trim()) return;

    state.totals.messages++;
    touchRoom(roomId);
    const msg = { from: u.name, text: msgText, ts: now() };
    room.history.push(msg);
    if (room.history.length > ROOM_HISTORY_LIMIT) room.history.shift();

    if (room.ai) {
      socket.emit("chat:message", msg);
      if (!room.topic && msgText.trim().length >= 3) room.topic = msgText.trim();
      const sys = "You are an IELTS speaking coach in a voice practice app.\nEvery turn you MUST output exactly this structure:\nReply: <1-2 short sentences>\nFixes:\n- <Wrong -> Correct>\n- <Wrong -> Correct>\nTip: <one short advice>\nNext question: <one follow-up question>\nEnglish only. Keep it short, friendly.";
      const t0 = hrTimeMs();
      const aiReply = await aiText({ system: sys, user: `Topic: ${room.topic || "general"}\nUser said: ${msgText}`, maxOutputTokens: 340, temperature: 0.65, timeoutMs: AI_TIMEOUT_MS });
      const dt = hrTimeMs() - t0;
      if (String(aiReply).startsWith("AI error:")) state.metrics.aiErrors++;
      state.totals.aiReplies++;
      state.metrics.aiLatencyMsLast = dt;
      state.metrics.aiLatencyWindow.push({ ts: now(), ms: dt });
      const aiMsg = { from: "AI", text: String(aiReply).slice(0, 2500), ts: now() };
      room.history.push(aiMsg);
      if (room.history.length > ROOM_HISTORY_LIMIT) room.history.shift();
      setTimeout(() => socket.emit("chat:message", aiMsg), 120);
      emitGlobalStats(); emitAdminSnapshot();
      return;
    }

    io.to(roomId).emit("chat:message", msg);
    emitGlobalStats(); emitAdminSnapshot();
  });

  /* ── Leave room ──────────────────────────────────────────────────── */
  socket.on("room:leave", async () => {
    if (!bucketTake(socket.id, "event", 2)) return;
    const u = mustBeRegistered(); if (!u?.roomId) return;
    const roomId = u.roomId;
    const room   = state.rooms.get(roomId);

    if (room?.ai) {
      const myMsgs = (room.history || []).filter(m => m.from === u.name).map(m => m.text).join("\n");
      const sys    = "You are an IELTS speaking examiner.\nReturn JSON only:\n{ \"band\":0-9, \"fluency\":0-9, \"grammar\":0-9, \"vocab\":0-9, \"pronunciation\":0-9, \"summary\":\"1-2 sentences\", \"fixes\":[\"Wrong -> Correct\",\"...\",\"...\"], \"next_steps\":[\"...\",\"...\",\"...\"] }\nEnglish only. Be strict.";
      const rep    = await aiJSON({ system: sys, user: `User messages:\n${myMsgs || "(no messages)"}`, maxOutputTokens: 520, temperature: 0.25, timeoutMs: AI_TIMEOUT_MS });
      u.aiScore = { band: clamp(+rep.band || 0, 0, 9), fluency: clamp(+rep.fluency || 0, 0, 9), grammar: clamp(+rep.grammar || 0, 0, 9), vocab: clamp(+rep.vocab || 0, 0, 9), pronunciation: clamp(+rep.pronunciation || 0, 0, 9) };
      io.to(socket.id).emit("coach:report", { report: rep, aiScore: u.aiScore });
    }

    removeFromWaiting(socket.id);
    leaveRoom(socket.id, "left");
  });

  /* ── Report / Rate ──────────────────────────────────────────────── */
  socket.on("report:partner", ({ roomId } = {}) => {
    if (!bucketTake(socket.id, "event", 5)) return;
    const u = mustBeRegistered();
    if (!u || u.roomId !== roomId) return;
    const room = state.rooms.get(roomId); if (!room || room.ai) return;
    const otherId = roomOther(room, socket.id);
    const other   = otherId ? state.usersBySocket.get(otherId) : null; if (!other) return;
    addReport(other.name);
    socket.emit("report:ok", { reported: other.name });
    emitAdminSnapshot();
  });

  socket.on("rate:partner", ({ roomId, stars } = {}) => {
    if (!bucketTake(socket.id, "event", 5)) return;
    const u = mustBeRegistered();
    if (!u || u.roomId !== roomId) return;
    const room = state.rooms.get(roomId); if (!room || room.ai) return;
    const otherId = roomOther(room, socket.id);
    const other   = otherId ? state.usersBySocket.get(otherId) : null; if (!other) return;
    addRating(other.name, stars);
    socket.emit("rate:ok", { rated: other.name });
    emitGlobalStats(); emitAdminSnapshot();
  });

  /* ── WebRTC signaling ───────────────────────────────────────────── */
  const relay = (ev, { roomId, ...payload } = {}) => {
    if (!bucketTake(socket.id, "event", 5)) return;
    const u = mustBeRegistered(); if (!u || u.roomId !== roomId) return;
    const room = state.rooms.get(roomId); if (!room || room.ai) return;
    const otherId = roomOther(room, socket.id); if (!otherId) return;
    touchRoom(roomId);
    io.to(otherId).emit(ev, { ...payload, from: u.name });
  };
  socket.on("webrtc:offer",  p => relay("webrtc:offer",  p));
  socket.on("webrtc:answer", p => relay("webrtc:answer", p));
  socket.on("webrtc:ice",    p => relay("webrtc:ice",    p));

  /* ── Admin socket events ──────────────────────────────────────── */
  const adminAuth = payload => {
    const tok = String(payload?.token || "").trim();
    return !!(ADMIN_TOKEN && tok && tok === ADMIN_TOKEN);
  };
  socket.on("admin:get",   p => { if (!bucketTake(socket.id, "event", 5) || !adminAuth(p)) return; emitAdminSnapshot(socket.id); });
  socket.on("admin:ban",   p => { if (!bucketTake(socket.id, "event", 5) || !adminAuth(p)) return; banName(p.name); });
  socket.on("admin:unban", p => { if (!bucketTake(socket.id, "event", 5) || !adminAuth(p)) return; unbanName(p.name); });
  socket.on("admin:kick",  p => { if (!bucketTake(socket.id, "event", 5) || !adminAuth(p)) return; kickName(p.name); });

  /* ── Disconnect ────────────────────────────────────────────────── */
  socket.on("disconnect", reason => {
    const u = state.usersBySocket.get(socket.id);
    removeFromWaiting(socket.id);
    if (u?.roomId) leaveRoom(socket.id, "disconnect");
    if (u) {
      state.usersBySocket.delete(socket.id);
      if (state.socketsByName.get(u.name) === socket.id) state.socketsByName.delete(u.name);
    }
    state.buckets.delete(socket.id);
    emitGlobalStats(); emitAdminSnapshot();
    info("disconnect", { reason, socketId: socket.id });
  });
});

/* ===================== Start ===================== */
server.listen(PORT, "0.0.0.0", () => {
  info("server_start", { port: PORT, env: NODE_ENV, aiProvider: AI_PROVIDER, turnConfigured: !!(TURN_USER && TURN_PASS), forceRelay: FORCE_RELAY, aiConfigured: getAiConfigured() });
  if (!ADMIN_TOKEN)                               warn("ADMIN_TOKEN is missing — admin actions disabled.");
  if (AI_PROVIDER === "groq"   && !GROQ_API_KEY)  warn("GROQ_API_KEY missing.");
  if (AI_PROVIDER === "xai"    && !XAI_API_KEY)   warn("XAI_API_KEY missing.");
  if (AI_PROVIDER === "gemini" && !GEMINI_API_KEY) warn("GEMINI_API_KEY missing.");
});

/* ===================== Graceful shutdown ===================== */
const shutdown = sig => {
  warn("shutdown", { signal: sig });
  try { io.close(() => server.close(() => process.exit(0))); } catch { process.exit(0); }
  setTimeout(() => process.exit(1), 8000).unref();
};
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
