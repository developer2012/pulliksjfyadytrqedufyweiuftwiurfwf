// public/app.js
// ============================================================
// WonderTalk — app.js (Senior, full, no-shortcuts style)
// Tabs:
//   - Home: practice stats + calendar (local)
//   - Leaderboard: ratings
//   - Conversation: matching (Male/Female/Any + AI) + level + Human voice + AI Coach voice
//
// Notes about VOICE with real friends (far networks):
//   - STUN works only in many cases. Some networks require TURN (relay).
//   - If you see "Voice failed ❌ (TURN required...)" — set TURN_* env on server.
// ============================================================

"use strict";

/* ===================== Socket ===================== */
const socket = io();

/* ===================== DOM helpers ===================== */
const $ = (id) => document.getElementById(id);
const show = (node, yes) => { if (!node) return; node.style.display = yes ? "" : "none"; };
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function appendMsg(container, from, text) {
  if (!container) return;
  const box = document.createElement("div");
  box.className = "msg";
  box.innerHTML = `
    <div class="from">${escapeHtml(from)}</div>
    <div class="bubble">${escapeHtml(text)}</div>
  `;
  container.appendChild(box);
  container.scrollTop = container.scrollHeight;
}

/* ===================== Elements ===================== */
const el = {
  // screens
  screenName: $("screenName"),
  screenMain: $("screenMain"),
  bannedScreen: $("bannedScreen"),

  // register
  nameInput: $("nameInput"),
  btnJoin: $("btnJoin"),
  btnLogout: $("btnLogout"),
  nameErr: $("nameErr"),

  // header
  meName: $("meName"),
  statOnline: $("statOnline"),
  statWaiting: $("statWaiting"),
  statRooms: $("statRooms"),

  // AI score bar
  scoreBar: $("scoreBar"),
  myBand: $("myBand"),
  myFlu: $("myFlu"),
  myGra: $("myGra"),
  myVoc: $("myVoc"),
  myPro: $("myPro"),

  // tabs
  tabHome: $("tabHome"),
  tabLb: $("tabLb"),
  tabAi: $("tabAi"),

  navHome: $("navHome"),
  navLb: $("navLb"),
  navAi: $("navAi"),

  // Home (stats+calendar) — these ids must exist in your updated index.html
  // If you haven't added them yet, add placeholders:
  //   <div id="homeSessions"></div> etc...
  homeSessions: $("homeSessions"),
  homePracticeDays: $("homePracticeDays"),
  homeMinutes: $("homeMinutes"),
  homeStreak: $("homeStreak"),
  homeMissed: $("homeMissed"),

  calTitle: $("calTitle"),
  calPrev: $("calPrev"),
  calNext: $("calNext"),
  calGrid: $("calGrid"),

  // Leaderboard
  btnLb: $("btnLb"),
  leaderboard: $("leaderboard"),

  // Conversation / Matching (Human + AI option)
  prefsPanel: $("prefsPanel"),
  searchInfo: $("searchInfo"),
  btnFind: $("btnFind"),
  btnStop: $("btnStop"),

  // chips (query selectors)
  chipsGender: "[data-gender]",
  chipsLevel: "[data-level]",

  // Human chat
  chatPanel: $("chatPanel"),
  partnerName: $("partnerName"),
  btnLeave: $("btnLeave"),
  btnReport: $("btnReport"),
  voiceHint: $("voiceHint"),
  btnVoice: $("btnVoice"),
  remoteAudio: $("remoteAudio"),

  qText: $("qText"),
  qIndex: $("qIndex"),
  qPrev: $("qPrev"),
  qNext: $("qNext"),

  messages: $("messages"),
  msgInput: $("msgInput"),
  btnSend: $("btnSend"),

  // rating buttons have .rateBtn
  rateBtns: document.querySelectorAll(".rateBtn"),

  // AI Coach (Conversation AI)
  btnStartAi: $("btnStartAi"),
  btnAiVoice: $("btnAiVoice"),
  btnAiLeave: $("btnAiLeave"),
  aiHint: $("aiHint"),
  aiMessages: $("aiMessages"),
  aiInput: $("aiInput"),
  btnAiSend: $("btnAiSend"),

  aiReportCard: $("aiReportCard"),
  aiReportSummary: $("aiReportSummary"),
  aiReportList: $("aiReportList"),

  // ADDED (optional UI) — agar index.html da bo‘lmasa ham ishlashda xalaqit bermaydi
  netBadge: $("netBadge"),
};

/* ===================== Local Storage Keys ===================== */
const LS_NAME = "wt_name_v4";
const LS_PRACTICE = "wt_practice_v4"; // local stats + days
// Practice schema:
// {
//   sessions: number,
//   minutes: number,
//   practicedDays: { "YYYY-MM-DD": { minutes: number, sessions: number } }
// }

/* ===================== State ===================== */
const state = {
  me: { name: null },
  prefs: { gender: "Any", level: "Any" },

  // current human room
  current: {
    roomId: null,
    partner: null,
    polite: false,
    connectedAt: 0,
  },

  // ai room
  ai: {
    roomId: null,
    startedAt: 0,
  },

  // questions
  QUESTIONS: [],
  qIdx: 0,

  // rtc
  rtcIceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  forceRelay: false,

  // audio warmup
  audioWarm: false,

  // human voice
  pc: null,
  localStream: null,
  voiceOn: false,
  makingOffer: false,
  ignoreOffer: false,

  // AI voice turn-taking (SpeechRecognition + TTS)
  aiMode: {
    listening: false,
    speaking: false,
    lastUserText: "",
    autoStopTimer: null,
    recognition: null,
  },

  // practice local
  practice: {
    sessions: 0,
    minutes: 0,
    practicedDays: {},
  },

  // calendar view month
  cal: {
    viewYear: new Date().getFullYear(),
    viewMonth: new Date().getMonth(), // 0..11
  },

  // ADDED: client rate-limit + session tracker
  ux: {
    lastSendAt: 0,
    sendCooldownMs: 450,
    lastAiSendAt: 0,
    aiCooldownMs: 450,
  },

  session: {
    humanStartedAt: 0,
    aiStartedAt: 0,
  }
};

/* ===================== Senior UX helpers (ADDED) ===================== */
function setNetBadge(text) {
  if (!el.netBadge) return;
  el.netBadge.textContent = text || "";
  el.netBadge.style.display = text ? "" : "none";
}

function nowMs() { return Date.now(); }

function minutesBetween(startMs, endMs) {
  const ms = Math.max(0, (endMs || 0) - (startMs || 0));
  // 최소 1 daqiqa: 20s gap ham session hisoblanadi
  return Math.max(1, Math.round(ms / 60000));
}

function sessionStart(kind) {
  if (kind === "human") state.session.humanStartedAt = nowMs();
  if (kind === "ai") state.session.aiStartedAt = nowMs();
}

function sessionFinish(kind) {
  const end = nowMs();
  if (kind === "human") {
    if (!state.session.humanStartedAt) return;
    const mins = minutesBetween(state.session.humanStartedAt, end);
    state.session.humanStartedAt = 0;
    markPracticeNow(mins, 1);
  }
  if (kind === "ai") {
    if (!state.session.aiStartedAt) return;
    const mins = minutesBetween(state.session.aiStartedAt, end);
    state.session.aiStartedAt = 0;
    markPracticeNow(mins, 1);
  }
}

/* ===================== Tab system ===================== */
function setTab(name) {
  // ADDED: AI listening backgroundda qolmasin
  if (name !== "ai" && state.aiMode.listening) {
    stopAiListeningOnly();
    hintAI("AI mic stopped (tab changed).");
  }

  show(el.tabHome, name === "home");
  show(el.tabLb, name === "lb");
  show(el.tabAi, name === "ai");

  [el.navHome, el.navLb, el.navAi].forEach((b) => b && b.classList.remove("active"));
  if (name === "home" && el.navHome) el.navHome.classList.add("active");
  if (name === "lb" && el.navLb) el.navLb.classList.add("active");
  if (name === "ai" && el.navAi) el.navAi.classList.add("active");
}

/* ===================== Practice (local) ===================== */
function yyyyMmDd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadPractice() {
  try {
    const raw = localStorage.getItem(LS_PRACTICE);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (typeof j.sessions === "number") state.practice.sessions = j.sessions;
    if (typeof j.minutes === "number") state.practice.minutes = j.minutes;
    if (j.practicedDays && typeof j.practicedDays === "object") state.practice.practicedDays = j.practicedDays;
  } catch {}
}

function savePractice() {
  try {
    localStorage.setItem(LS_PRACTICE, JSON.stringify(state.practice));
  } catch {}
}

function markPracticeNow(minutesAdd = 1, sessionsAdd = 0) {
  const key = yyyyMmDd(new Date());
  if (!state.practice.practicedDays[key]) state.practice.practicedDays[key] = { minutes: 0, sessions: 0 };
  state.practice.practicedDays[key].minutes += Math.max(0, Number(minutesAdd) || 0);
  state.practice.practicedDays[key].sessions += Math.max(0, Number(sessionsAdd) || 0);

  state.practice.minutes += Math.max(0, Number(minutesAdd) || 0);
  state.practice.sessions += Math.max(0, Number(sessionsAdd) || 0);

  savePractice();
  renderHomeStats();
  renderCalendar();
}

function calcPracticeDaysCount() {
  return Object.keys(state.practice.practicedDays || {}).length;
}

function calcStreak() {
  // streak = consecutive days practiced up to today
  const days = state.practice.practicedDays || {};
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 3650; i++) {
    const k = yyyyMmDd(d);
    if (days[k]) streak++;
    else break;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function calcMissedLast7() {
  // missed days in last 7 (including today): 7 - practicedDaysCountInWindow
  const days = state.practice.practicedDays || {};
  let practiced = 0;
  const d = new Date();
  for (let i = 0; i < 7; i++) {
    const k = yyyyMmDd(d);
    if (days[k]) practiced++;
    d.setDate(d.getDate() - 1);
  }
  return Math.max(0, 7 - practiced);
}

function renderHomeStats() {
  // if elements not present, just skip
  const sessions = state.practice.sessions || 0;
  const minutes = state.practice.minutes || 0;
  const practiceDays = calcPracticeDaysCount();
  const streak = calcStreak();
  const missed = calcMissedLast7();

  if (el.homeSessions) el.homeSessions.textContent = String(sessions);
  if (el.homePracticeDays) el.homePracticeDays.textContent = String(practiceDays);
  if (el.homeMinutes) el.homeMinutes.textContent = String(minutes);
  if (el.homeStreak) el.homeStreak.textContent = String(streak);
  if (el.homeMissed) el.homeMissed.textContent = String(missed);
}

/* ===================== Calendar ===================== */
const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];
const DOW = ["S","M","T","W","T","F","S"];

function renderCalendar() {
  if (!el.calGrid || !el.calTitle) return;

  const year = state.cal.viewYear;
  const month = state.cal.viewMonth;

  el.calTitle.textContent = `${MONTHS[month]} ${year}`;

  // clear
  el.calGrid.innerHTML = "";

  const first = new Date(year, month, 1);
  const firstDow = first.getDay(); // 0..6
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // previous month days to fill
  const prevDays = new Date(year, month, 0).getDate();

  const todayKey = yyyyMmDd(new Date());
  const practicedDays = state.practice.practicedDays || {};

  // we render 6 rows (42 cells) stable layout
  const totalCells = 42;
  for (let idx = 0; idx < totalCells; idx++) {
    const cell = document.createElement("div");
    cell.className = "calCell";

    const dayNum = idx - firstDow + 1;

    let dKey = null;

    if (dayNum <= 0) {
      // prev month
      const d = prevDays + dayNum;
      cell.textContent = String(d);
      cell.classList.add("mutedDay");
      const prevDate = new Date(year, month - 1, d);
      dKey = yyyyMmDd(prevDate);
    } else if (dayNum > daysInMonth) {
      // next month
      const d = dayNum - daysInMonth;
      cell.textContent = String(d);
      cell.classList.add("mutedDay");
      const nextDate = new Date(year, month + 1, d);
      dKey = yyyyMmDd(nextDate);
    } else {
      // current month
      cell.textContent = String(dayNum);
      const curDate = new Date(year, month, dayNum);
      dKey = yyyyMmDd(curDate);
    }

    // today highlight
    if (dKey === todayKey) cell.classList.add("today");
    // practiced highlight
    if (practicedDays[dKey]) cell.classList.add("practiced");

    // click -> show mini info (optional)
    cell.addEventListener("click", () => {
      if (!dKey) return;
      const info = practicedDays[dKey];
      if (info) {
        // show in hint area (reuse AI hint if exists)
        if (el.aiHint) el.aiHint.textContent = `Practice on ${dKey}: ${info.minutes} min, ${info.sessions} sessions.`;
      }
    });

    el.calGrid.appendChild(cell);
  }
}

/* ===================== Score UI ===================== */
function updateScore(aiScore) {
  if (!aiScore) return;
  if (el.scoreBar) el.scoreBar.style.display = "";
  if (el.myBand) el.myBand.textContent = String(aiScore.band ?? "—");
  if (el.myFlu) el.myFlu.textContent = String(aiScore.fluency ?? "—");
  if (el.myGra) el.myGra.textContent = String(aiScore.grammar ?? "—");
  if (el.myVoc) el.myVoc.textContent = String(aiScore.vocab ?? "—");
  if (el.myPro) el.myPro.textContent = String(aiScore.pronunciation ?? "—");
}

/* ===================== Questions ===================== */
function renderQuestion() {
  const total = state.QUESTIONS.length || 10;
  state.qIdx = clamp(state.qIdx, 0, total - 1);

  if (el.qIndex) el.qIndex.textContent = String(state.qIdx + 1);
  if (el.qText) el.qText.textContent = state.QUESTIONS[state.qIdx] || "Loading questions...";

  if (el.qPrev) {
    el.qPrev.disabled = state.qIdx === 0;
    el.qPrev.style.opacity = el.qPrev.disabled ? ".45" : "1";
  }
  if (el.qNext) {
    el.qNext.disabled = state.qIdx === total - 1;
    el.qNext.style.opacity = el.qNext.disabled ? ".45" : "1";
  }
}

/* ===================== UI resets ===================== */
function hintHuman(text) {
  if (!el.voiceHint) return;
  el.voiceHint.style.display = text ? "" : "none";
  el.voiceHint.textContent = text || "";
}

function hintAI(text) {
  if (!el.aiHint) return;
  el.aiHint.textContent = text || "";
}

function resetHumanUI() {
  if (el.searchInfo) el.searchInfo.textContent = "";
  if (el.messages) el.messages.innerHTML = "";
  if (el.msgInput) el.msgInput.value = "";
  if (el.partnerName) el.partnerName.textContent = "—";

  state.current.roomId = null;
  state.current.partner = null;
  state.current.connectedAt = 0;

  state.qIdx = 0;
  renderQuestion();

  show(el.chatPanel, false);
  show(el.prefsPanel, true);

  hintHuman("");

  stopVoice().catch(() => {});
}

function resetAIUI() {
  state.ai.roomId = null;
  state.ai.startedAt = 0;

  if (el.aiMessages) el.aiMessages.innerHTML = "";
  if (el.aiInput) el.aiInput.value = "";
  if (el.aiReportCard) el.aiReportCard.style.display = "none";

  stopAiListeningOnly();
  setAiVoiceBtn();
  hintAI("Press Start AI to begin.");
}

/* ===================== Chips ===================== */
function setChipGroup(selector, key) {
  document.querySelectorAll(selector).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset[key] === state.prefs[key]);
  });
}

function wireChips() {
  document.querySelectorAll(el.chipsGender).forEach((btn) => {
    btn.addEventListener("click", () => {
      state.prefs.gender = btn.dataset.gender;
      setChipGroup(el.chipsGender, "gender");
    });
  });

  document.querySelectorAll(el.chipsLevel).forEach((btn) => {
    btn.addEventListener("click", () => {
      state.prefs.level = btn.dataset.level;
      setChipGroup(el.chipsLevel, "level");
    });
  });

  setChipGroup(el.chipsGender, "gender");
  setChipGroup(el.chipsLevel, "level");
}

/* ===================== WebRTC config ===================== */
async function loadRtcConfig() {
  try {
    const r = await fetch("/webrtc-config");
    const j = await r.json();
    if (j?.iceServers?.length) state.rtcIceServers = j.iceServers;
    state.forceRelay = !!j?.forceRelay;
  } catch {
    // keep default stun
  }
}

/* ===================== Audio warmup ===================== */
async function warmupAudioOnce() {
  if (state.audioWarm) return;
  state.audioWarm = true;

  if (!el.remoteAudio) return;

  try {
    el.remoteAudio.muted = true;
    await el.remoteAudio.play().catch(() => {});
    el.remoteAudio.muted = false;
  } catch {}
}

/* ===================== Register/Login ===================== */
function register(name) {
  if (el.nameErr) el.nameErr.textContent = "";
  socket.emit("user:register", { name });
}

/* ===================== Conversation actions (match) ===================== */
function matchStart() {
  warmupAudioOnce().catch(() => {});
  if (el.searchInfo) el.searchInfo.textContent = "Searching…";
  socket.emit("match:start", { gender: state.prefs.gender, level: state.prefs.level });
}

function matchStop() {
  socket.emit("match:stop");
  if (el.searchInfo) el.searchInfo.textContent = "";
}

/* ===================== Human messaging ===================== */
function sendHumanMsg() {
  const t = nowMs();
  if (t - state.ux.lastSendAt < state.ux.sendCooldownMs) {
    hintHuman("Too fast… slow down 🙂");
    return;
  }
  state.ux.lastSendAt = t;

  const text = (el.msgInput?.value || "").trim();
  if (!text || !state.current.roomId) return;
  el.msgInput.value = "";
  socket.emit("chat:message", { roomId: state.current.roomId, text });
  markPracticeNow(0, 0);
}

/* ===================== AI messaging (typed) ===================== */
function sendAiText() {
  const t = nowMs();
  if (t - state.ux.lastAiSendAt < state.ux.aiCooldownMs) {
    hintAI("Too fast… wait 🙂");
    return;
  }
  state.ux.lastAiSendAt = t;

  const text = (el.aiInput?.value || "").trim();
  if (!text || !state.ai.roomId) return;
  el.aiInput.value = "";
  appendMsg(el.aiMessages, state.me.name, text);
  socket.emit("chat:message", { roomId: state.ai.roomId, text });
  markPracticeNow(1, 0);
  hintAI("Sent ✅ Waiting AI…");
}

/* ===================== Rating & Report ===================== */
function setActiveRate(stars) {
  const s = clamp(Number(stars) || 0, 1, 5);
  el.rateBtns?.forEach((b) => b.classList.toggle("active", Number(b.dataset.rate) === s));
}

function ratePartner(stars) {
  if (!state.current.roomId) return;
  setActiveRate(stars);
  socket.emit("rate:partner", { roomId: state.current.roomId, stars });
}

function reportPartner() {
  if (!state.current.roomId) return;
  socket.emit("report:partner", { roomId: state.current.roomId });
}

/* ===================== Icebreaker navigation ===================== */
function iceNav(dir) {
  if (!state.current.roomId) return;
  socket.emit("icebreaker:nav", { roomId: state.current.roomId, dir });
}

/* ===================== Human Voice (WebRTC) ===================== */
function buildPeer() {
  state.pc = new RTCPeerConnection({
    iceServers: state.rtcIceServers,
    iceTransportPolicy: state.forceRelay ? "relay" : "all",
  });

  // remote track
  state.pc.ontrack = (ev) => {
    const [stream] = ev.streams;
    if (stream && el.remoteAudio) {
      el.remoteAudio.srcObject = stream;
      const p = el.remoteAudio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  };

  // ice -> server
  state.pc.onicecandidate = (ev) => {
    if (ev.candidate && state.current.roomId) {
      socket.emit("webrtc:ice", { roomId: state.current.roomId, candidate: ev.candidate });
    }
  };

  // connection status
  state.pc.onconnectionstatechange = () => {
    if (!state.pc) return;
    if (state.pc.connectionState === "connected") {
      hintHuman("Voice connected ✅");
    }
    if (state.pc.connectionState === "failed") {
      hintHuman("Voice failed ❌ (TURN required for far networks)");
    }
    if (state.pc.connectionState === "disconnected") {
      hintHuman("Voice disconnected.");
    }
  };

  // negotiation (perfect negotiation base)
  state.pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      const offer = await state.pc.createOffer({ offerToReceiveAudio: true });
      if (!state.pc || state.pc.signalingState !== "stable") return;
      await state.pc.setLocalDescription(offer);
      socket.emit("webrtc:offer", { roomId: state.current.roomId, sdp: state.pc.localDescription });
    } catch (e) {
      hintHuman("Negotiation error.");
    } finally {
      state.makingOffer = false;
    }
  };
}

async function startVoice() {
  if (!state.current.roomId) { hintHuman("Join a room first."); return; }
  if (state.voiceOn) return;
  state.voiceOn = true;
  if (el.btnVoice) el.btnVoice.textContent = "Voice Off";
  hintHuman("Requesting microphone…");

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
      },
      video: false,
    });
  } catch {
    state.voiceOn = false;
    if (el.btnVoice) el.btnVoice.textContent = "Voice On";
    hintHuman("Microphone blocked. Allow mic permission.");
    return;
  }

  if (!state.pc) buildPeer();

  // add tracks
  state.localStream.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));

  hintHuman("Mic enabled ✅ Connecting…");
}

async function stopVoice() {
  state.voiceOn = false;
  if (el.btnVoice) el.btnVoice.textContent = "Voice On";
  hintHuman("Voice off.");

  if (state.pc) {
    try {
      state.pc.ontrack = null;
      state.pc.onicecandidate = null;
      state.pc.onnegotiationneeded = null;
    } catch {}
    try { state.pc.close(); } catch {}
    state.pc = null;
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    state.localStream = null;
  }

  if (el.remoteAudio) el.remoteAudio.srcObject = null;
}

/* ===================== AI Voice (SpeechRecognition + TTS) ===================== */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function aiSupported() {
  return !!SR && !!window.speechSynthesis;
}

function stopAutoStop() {
  if (state.aiMode.autoStopTimer) clearTimeout(state.aiMode.autoStopTimer);
  state.aiMode.autoStopTimer = null;
}

function setAiVoiceBtn() {
  if (!el.btnAiVoice) return;
  el.btnAiVoice.textContent = state.aiMode.listening ? "Voice Off" : "Voice On";
}

function aiSpeak(text) {
  return new Promise((resolve) => {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text || ""));
      u.lang = "en-US";
      u.rate = 1;

      state.aiMode.speaking = true;
      hintAI("AI speaking… 🔊");

      u.onend = () => {
        state.aiMode.speaking = false;
        hintAI("Your turn: press Voice On and speak 🎙️");
        resolve();
      };
      u.onerror = () => {
        state.aiMode.speaking = false;
        hintAI("AI voice error.");
        resolve();
      };

      window.speechSynthesis.speak(u);
    } catch {
      state.aiMode.speaking = false;
      resolve();
    }
  });
}

function aiStartListening() {
  if (!state.ai.roomId) { hintAI("Start AI first."); return; }
  if (!aiSupported()) { hintAI("Use Chrome (SpeechRecognition + TTS required)."); return; }
  if (state.aiMode.speaking) { hintAI("Wait… AI is speaking."); return; }
  if (state.aiMode.listening) return;

  const rec = new SR();
  state.aiMode.recognition = rec;

  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = true;

  state.aiMode.lastUserText = "";
  state.aiMode.listening = true;
  setAiVoiceBtn();
  hintAI("Listening… speak now 🎙️ (press Voice Off when finished)");

  rec.onresult = (e) => {
    let finalText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t = (r[0]?.transcript || "").trim();
      if (!t) continue;
      if (r.isFinal) finalText += (finalText ? " " : "") + t;
    }

    if (finalText) {
      state.aiMode.lastUserText = (state.aiMode.lastUserText + " " + finalText).trim();
    }

    stopAutoStop();
    state.aiMode.autoStopTimer = setTimeout(() => {
      if (state.aiMode.listening) aiStopListeningAndSend();
    }, 2200);
  };

  rec.onerror = () => {
    hintAI("Mic error. Allow microphone permission.");
    stopAiListeningOnly();
  };

  rec.onend = () => {
    // keep alive while in listening mode
    if (state.aiMode.listening) {
      try { rec.start(); } catch {}
    }
  };

  try { rec.start(); } catch {}
}

function stopAiListeningOnly() {
  stopAutoStop();
  state.aiMode.listening = false;
  setAiVoiceBtn();

  const rec = state.aiMode.recognition;
  state.aiMode.recognition = null;

  try { rec && rec.stop(); } catch {}
}

async function aiStopListeningAndSend() {
  if (!state.aiMode.listening) return;
  stopAiListeningOnly();

  const text = (state.aiMode.lastUserText || "").trim();
  if (!text) { hintAI("No speech detected. Try again."); return; }

  appendMsg(el.aiMessages, state.me.name, text);
  socket.emit("chat:message", { roomId: state.ai.roomId, text });

  markPracticeNow(1, 0);

  hintAI("Sent ✅ Waiting AI…");
}

/* ===================== Leaderboard ===================== */
function renderLeaderboard(rows) {
  const r = Array.isArray(rows) ? rows : [];
  if (!el.leaderboard) return;

  el.leaderboard.innerHTML = "";

  if (!r.length) {
    const node = document.createElement("div");
    node.className = "item";
    node.innerHTML = `<div>No ratings yet.</div><div class="badge">—</div>`;
    el.leaderboard.appendChild(node);
    return;
  }

  r.slice(0, 20).forEach((x, idx) => {
    const node = document.createElement("div");
    node.className = "item";
    node.innerHTML = `
      <div><b>${idx + 1}.</b> ${escapeHtml(x.name)}</div>
      <div class="badge">⭐ ${escapeHtml(x.avg)} (${escapeHtml(x.count)})</div>
    `;
    el.leaderboard.appendChild(node);
  });
}

/* ===================== Wiring events ===================== */
function wireUi() {
  // register
  el.btnJoin?.addEventListener("click", () => register((el.nameInput?.value || "").trim()));
  el.nameInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") el.btnJoin?.click(); });

  el.btnLogout?.addEventListener("click", () => {
    localStorage.removeItem(LS_NAME);
    location.reload();
  });

  // tabs
  el.navHome?.addEventListener("click", () => setTab("home"));
  el.navLb?.addEventListener("click", () => setTab("lb"));
  el.navAi?.addEventListener("click", () => setTab("ai"));

  // leaderboard refresh (we reuse admin snapshot, ok)
  el.btnLb?.addEventListener("click", () => socket.emit("admin:get"));

  // conversation match buttons
  el.btnFind?.addEventListener("click", () => matchStart());
  el.btnStop?.addEventListener("click", () => matchStop());

  // human send
  el.btnSend?.addEventListener("click", sendHumanMsg);
  el.msgInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") sendHumanMsg(); });

  // leave/report
  el.btnLeave?.addEventListener("click", () => {
    if (!state.current.roomId && !state.ai.roomId) return;
    socket.emit("room:leave");
  });

  el.btnReport?.addEventListener("click", () => reportPartner());

  // rating
  el.rateBtns?.forEach((b) => {
    b.addEventListener("click", () => ratePartner(b.dataset.rate));
  });

  // ice nav
  el.qPrev?.addEventListener("click", () => iceNav("prev"));
  el.qNext?.addEventListener("click", () => iceNav("next"));

  // human voice toggle
  el.btnVoice?.addEventListener("click", async () => {
    if (!state.current.roomId) { hintHuman("Join a room first."); return; }
    await warmupAudioOnce();
    if (!state.voiceOn) await startVoice();
    else await stopVoice();
  });

  // AI start
  el.btnStartAi?.addEventListener("click", () => {
    socket.emit("match:start", { gender: "AI", level: "Any" });
    hintAI("Connecting AI…");
    setTab("ai");
  });

  // AI typed
  el.btnAiSend?.addEventListener("click", sendAiText);
  el.aiInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") sendAiText(); });

  // AI voice toggle
  el.btnAiVoice?.addEventListener("click", async () => {
    if (!state.ai.roomId) { hintAI("Start AI first."); return; }
    if (!state.aiMode.listening) aiStartListening();
    else await aiStopListeningAndSend();
    setAiVoiceBtn();
  });

  // AI finish
  el.btnAiLeave?.addEventListener("click", () => {
    if (!state.ai.roomId) return;
    if (state.aiMode.listening) stopAiListeningOnly();
    socket.emit("room:leave");
  });

  // calendar
  el.calPrev?.addEventListener("click", () => {
    state.cal.viewMonth--;
    if (state.cal.viewMonth < 0) { state.cal.viewMonth = 11; state.cal.viewYear--; }
    renderCalendar();
  });

  el.calNext?.addEventListener("click", () => {
    state.cal.viewMonth++;
    if (state.cal.viewMonth > 11) { state.cal.viewMonth = 0; state.cal.viewYear++; }
    renderCalendar();
  });
}

/* ===================== Socket events ===================== */
function wireSocket() {
  socket.on("global:questions", ({ questions }) => {
    state.QUESTIONS = Array.isArray(questions) ? questions.slice(0, 10) : [];
    while (state.QUESTIONS.length < 10) state.QUESTIONS.push("Tell me something interesting about you.");
    renderQuestion();
  });

  socket.on("global:stats", ({ online, waiting, rooms }) => {
    if (el.statOnline) el.statOnline.textContent = String(online ?? 0);
    if (el.statWaiting) el.statWaiting.textContent = String(waiting ?? 0);
    if (el.statRooms) el.statRooms.textContent = String(rooms ?? 0);
  });

  socket.on("user:register:ok", ({ user, aiScore }) => {
    state.me.name = user.name;
    localStorage.setItem(LS_NAME, state.me.name);

    if (el.meName) el.meName.textContent = state.me.name;

    show(el.screenName, false);
    show(el.screenMain, true);
    show(el.bannedScreen, false);

    if (aiScore) updateScore(aiScore);

    setTab("home");

    resetHumanUI();
    resetAIUI();

    renderHomeStats();
    renderCalendar();

    setChipGroup(el.chipsGender, "gender");
    setChipGroup(el.chipsLevel, "level");
  });

  socket.on("user:register:fail", ({ reason }) => {
    if (reason === "banned") {
      show(el.screenName, false);
      show(el.screenMain, false);
      show(el.bannedScreen, true);
      return;
    }
    if (el.nameErr) el.nameErr.textContent = "Invalid name";
  });

  socket.on("user:kicked", () => {
    localStorage.removeItem(LS_NAME);
    location.reload();
  });

  socket.on("match:searching", () => {
    if (el.searchInfo) el.searchInfo.textContent = "Searching…";
  });

  // match found
  socket.on("match:found", async ({ roomId, partnerName, aiScore }) => {
    if (aiScore) updateScore(aiScore);

    // AI room
    if (partnerName === "AI") {
      state.ai.roomId = roomId;
      state.ai.startedAt = Date.now();

      if (el.aiMessages) el.aiMessages.innerHTML = "";
      if (el.aiReportCard) el.aiReportCard.style.display = "none";

      hintAI("AI ready ✅ Voice On → speak → Voice Off. AI replies by voice.");
      setAiVoiceBtn();
      setTab("ai");
      appendMsg(el.aiMessages, "System", "Connected to AI.");

      sessionStart("ai");
      return;
    }

    // Human room
    state.current.roomId = roomId;
    state.current.partner = partnerName;
    state.current.connectedAt = Date.now();
    state.current.polite = (state.me.name || "").localeCompare(partnerName || "") < 0;

    if (el.partnerName) el.partnerName.textContent = partnerName;

    if (el.searchInfo) el.searchInfo.textContent = "";
    if (el.messages) el.messages.innerHTML = "";

    show(el.prefsPanel, false);
    show(el.chatPanel, true);

    hintHuman("Both users press Voice On for calls.");
    appendMsg(el.messages, "System", "Connected.");

    await warmupAudioOnce();

    sessionStart("human");
  });

  socket.on("icebreaker:set", ({ index }) => {
    state.qIdx = Number(index) || 0;
    renderQuestion();
  });

  // chat messages:
  socket.on("chat:message", async (m) => {
    if (!m || !m.from) return;

    // AI messages go to AI panel (and TTS)
    if (state.ai.roomId && m.from === "AI") {
      appendMsg(el.aiMessages, "AI", m.text);
      markPracticeNow(0, 0);
      await aiSpeak(m.text);
      return;
    }

    // Human messages go to human panel only
    if (state.current.roomId && state.current.partner && m.from !== "AI") {
      appendMsg(el.messages, m.from, m.text);
      markPracticeNow(0, 0);
    }
  });

  socket.on("report:ok", ({ reported }) => {
    appendMsg(el.messages, "System", "Reported: " + (reported || "ok"));
  });

  socket.on("rate:ok", ({ rated }) => {
    appendMsg(el.messages, "System", "Rated: " + (rated || "ok"));
  });

  socket.on("room:ended", ({ reason }) => {
    // ADDED: session finish by time
    if (state.current.roomId) {
      sessionFinish("human");
      appendMsg(el.messages, "System", "Disconnected.");
      resetHumanUI();
    }
    if (state.ai.roomId) {
      sessionFinish("ai");
      appendMsg(el.aiMessages, "System", "AI session ended.");
      state.ai.roomId = null;
      stopAiListeningOnly();
      setAiVoiceBtn();
    }
    hintHuman(reason ? `Room ended: ${reason}` : "");
  });

  socket.on("coach:report", ({ report, aiScore }) => {
    if (aiScore) updateScore(aiScore);

    if (el.aiReportCard) el.aiReportCard.style.display = "";
    if (el.aiReportSummary) el.aiReportSummary.textContent = report?.summary || "Report received.";

    if (el.aiReportList) {
      el.aiReportList.innerHTML = "";

      const fixes = Array.isArray(report?.fixes) ? report.fixes : [];
      const steps = Array.isArray(report?.next_steps) ? report.next_steps : [];

      const node1 = document.createElement("div");
      node1.className = "item";
      node1.innerHTML = `<div><b>Band:</b> ${escapeHtml(report?.band)}</div><div class="badge">AI Score</div>`;
      el.aiReportList.appendChild(node1);

      const node2 = document.createElement("div");
      node2.className = "item";
      node2.innerHTML = `<div><b>Breakdown:</b> F ${escapeHtml(report?.fluency)} • G ${escapeHtml(report?.grammar)} • V ${escapeHtml(report?.vocab)} • P ${escapeHtml(report?.pronunciation)}</div><div class="badge">Details</div>`;
      el.aiReportList.appendChild(node2);

      if (fixes.length) {
        const box = document.createElement("div");
        box.className = "item";
        box.innerHTML = `<div><b>Fixes:</b><br>${fixes.map(x => "• " + escapeHtml(x)).join("<br>")}</div><div class="badge">Grammar</div>`;
        el.aiReportList.appendChild(box);
      }

      if (steps.length) {
        const box = document.createElement("div");
        box.className = "item";
        box.innerHTML = `<div><b>Next steps:</b><br>${steps.map(x => "• " + escapeHtml(x)).join("<br>")}</div><div class="badge">Plan</div>`;
        el.aiReportList.appendChild(box);
      }
    }

    // AI session ended
    sessionFinish("ai");
    state.ai.roomId = null;
    stopAiListeningOnly();
    setAiVoiceBtn();
    hintAI("Session finished ✅ Your report is below.");
  });

  // admin snapshot -> leaderboard
  socket.on("admin:snapshot", (snap) => {
    if (snap?.leaderboard) renderLeaderboard(snap.leaderboard);
  });

  // WebRTC signaling
  socket.on("webrtc:offer", async ({ sdp, from }) => {
    if (!state.current.roomId) return;

    // if user hasn't pressed Voice On, they don't have pc/stream yet
    if (!state.pc || !state.localStream) {
      hintHuman(`${from || "Partner"} started voice. Press Voice On to join.`);
      return;
    }

    const offerCollision = state.makingOffer || state.pc.signalingState !== "stable";
    state.ignoreOffer = !state.current.polite && offerCollision;
    if (state.ignoreOffer) return;

    try {
      await state.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      if (sdp.type === "offer") {
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        socket.emit("webrtc:answer", { roomId: state.current.roomId, sdp: state.pc.localDescription });
      }
    } catch {
      hintHuman("Offer handling error.");
    }
  });

  socket.on("webrtc:answer", async ({ sdp }) => {
    if (!state.pc) return;
    try {
      await state.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch {
      hintHuman("Answer handling error.");
    }
  });

  socket.on("webrtc:ice", async ({ candidate }) => {
    if (!state.pc) return;
    try {
      await state.pc.addIceCandidate(candidate);
    } catch {
      // ignore
    }
  });

  // ADDED: socket connection UX
  socket.on("connect", () => {
    setNetBadge("");
  });

  socket.on("disconnect", () => {
    setNetBadge("Offline… reconnecting");
    // AI micni backgroundda qoldirmaymiz
    if (state.aiMode.listening) stopAiListeningOnly();
  });

  socket.io?.on?.("reconnect_attempt", () => {
    setNetBadge("Reconnecting…");
  });

  socket.io?.on?.("reconnect", () => {
    setNetBadge("");
  });
}

/* ===================== Boot ===================== */
(async function boot() {
  // base data
  loadPractice();
  await loadRtcConfig();

  // wire UI + socket
  wireUi();
  wireChips();
  wireSocket();

  // calendar render initial
  renderHomeStats();
  renderCalendar();

  // questions default
  renderQuestion();

  // auto login
  const stored = (localStorage.getItem(LS_NAME) || "").trim();
  if (stored) {
    if (el.nameInput) el.nameInput.value = stored;
    register(stored);
  } else {
    show(el.screenName, true);
    show(el.screenMain, false);
  }

  // safe initial hints
  hintHuman("");
  hintAI("Press Start AI to begin.");

  // show prefs panel by default (Conversation tab will use it)
  show(el.prefsPanel, true);
  show(el.chatPanel, false);

  // default prefs
  state.prefs.gender = "Any";
  state.prefs.level = "Any";
  setChipGroup(el.chipsGender, "gender");
  setChipGroup(el.chipsLevel, "level");

  // default tab
  setTab("home");
})();

/* ============================================================
   Extra: small UX improvements (optional but senior-feel)
   ============================================================ */

// prevent accidental enter submitting in empty
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    // quick stop AI listening
    if (state.aiMode.listening) stopAiListeningOnly();
  }
});

// ADDED: visibility change safety
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.aiMode.listening) {
      stopAiListeningOnly();
      hintAI("AI mic stopped (tab hidden).");
    }
  }
});

// ADDED: online/offline badge
window.addEventListener("offline", () => setNetBadge("Offline"));
window.addEventListener("online", () => setNetBadge(""));

