// ============================================================
//  WonderTalk — app.js
//  Fully matches index.html IDs & style.css classes
// ============================================================
"use strict";

/* ─────────────────────────────────────────────────────────
   SOCKET
───────────────────────────────────────────────────────── */
const socket = io();

/* ─────────────────────────────────────────────────────────
   DOM HELPERS
───────────────────────────────────────────────────────── */
const $   = id  => document.getElementById(id);
const qs  = sel => document.querySelector(sel);
const now = ()  => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, +v || 0));

/** Safely show/hide an element via display style */
function show(el, visible, as = "") {
  if (!el) return;
  el.style.display = visible ? (as || "") : "none";
}

/** HTML-escape a value */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Append a chat bubble to a message container.
 * kind: "me" | "sys" | "" (partner)
 */
function addMsg(boxId, from, text, kind = "") {
  const box = $(boxId);
  if (!box) return;
  const wrap = document.createElement("div");
  wrap.className = "msg-item" + (kind ? " " + kind : "");
  wrap.innerHTML =
    `<div class="msg-from">${esc(from)}</div>` +
    `<div class="msg-bubble">${esc(text)}</div>`;
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

/* ─────────────────────────────────────────────────────────
   LOCAL STORAGE KEYS
───────────────────────────────────────────────────────── */
const LS_NAME = "wt_name_v5";
const LS_PRAC = "wt_prac_v5";

/* ─────────────────────────────────────────────────────────
   APP STATE
───────────────────────────────────────────────────────── */
const S = {
  /* user */
  name: "",

  /* matching preferences */
  prefs: { gender: "Any", level: "Any" },

  /* human room */
  room: {
    id: null,
    partner: null,
    polite: false,   // perfect-negotiation role
  },

  /* ai room */
  ai: { id: null },

  /* questions from server */
  questions: [],
  qIdx: 0,

  /* WebRTC */
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  forceRelay: false,
  audioWarm:  false,
  pc:         null,
  stream:     null,      // local microphone stream
  voiceOn:    false,
  makingOffer:  false,
  ignoreOffer:  false,

  /* AI voice (SpeechRecognition + TTS) */
  aiListening:  false,
  aiSpeaking:   false,
  aiLastText:   "",
  aiRec:        null,
  aiAutoStop:   null,

  /* practice data */
  prac: { sessions: 0, minutes: 0, days: {} },
  cal:  { y: new Date().getFullYear(), m: new Date().getMonth() },

  /* session timing */
  humanTs: 0,
  aiTs:    0,

  /* send cooldown */
  lastHumanSend: 0,
  lastAiSend:    0,
  cdMs: 450,
};

/* ─────────────────────────────────────────────────────────
   SCREEN MANAGEMENT
   Three top-level screens: name / banned / main
───────────────────────────────────────────────────────── */
function showScreen(name) {
  $("sName").style.display   = name === "name"   ? "grid"  : "none";
  $("sBanned").style.display = name === "banned" ? "grid"  : "none";
  $("sMain").style.display   = name === "main"   ? "block" : "none";
}

/* ─────────────────────────────────────────────────────────
   TAB SYSTEM  (Home / Conversation / AI Coach)
───────────────────────────────────────────────────────── */
function setTab(tab) {
  /* stop AI mic when leaving AI tab */
  if (tab !== "ai" && S.aiListening) {
    stopAiMic();
    hintAi("Mic stopped (tab changed).");
  }

  $("tabHome").style.display = tab === "home" ? "block" : "none";
  $("tabConv").style.display = tab === "conv" ? "block" : "none";
  $("tabAi").style.display   = tab === "ai"   ? "block" : "none";

  ["navHome", "navConv", "navAi"].forEach(id => $(id)?.classList.remove("active"));
  const navMap = { home: "navHome", conv: "navConv", ai: "navAi" };
  $(navMap[tab])?.classList.add("active");
}

/* ─────────────────────────────────────────────────────────
   CONVERSATION SUB-STATES  (idle / prefs / chat)
───────────────────────────────────────────────────────── */
function convState(s) {
  $("convIdle").style.display  = s === "idle"  ? "block" : "none";
  $("convPrefs").style.display = s === "prefs" ? "block" : "none";
  $("convChat").style.display  = s === "chat"  ? "block" : "none";
}

/* ─────────────────────────────────────────────────────────
   HINT HELPERS
───────────────────────────────────────────────────────── */
function hintVoice(txt) {
  const el = $("voiceHint");
  if (!el) return;
  el.textContent    = txt || "";
  el.style.display  = txt ? "block" : "none";
}

function hintAi(html) {
  const el = $("aiHintBar");
  if (el) el.innerHTML = html || "";
}

function hintSearch(txt) {
  const el = $("searchInfo");
  if (el) el.textContent = txt || "";
}

/* ─────────────────────────────────────────────────────────
   NET BADGE
───────────────────────────────────────────────────────── */
function netBadge(txt) {
  const el = $("netBadge");
  if (!el) return;
  el.textContent   = txt || "";
  el.style.display = txt ? "inline-flex" : "none";
}

/* ─────────────────────────────────────────────────────────
   PRACTICE  (localStorage)
───────────────────────────────────────────────────────── */
function dKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadPrac() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_PRAC) || "{}");
    if (typeof j.sessions === "number") S.prac.sessions = j.sessions;
    if (typeof j.minutes  === "number") S.prac.minutes  = j.minutes;
    if (j.days && typeof j.days === "object") S.prac.days = j.days;
  } catch (_) {}
}

function savePrac() {
  try { localStorage.setItem(LS_PRAC, JSON.stringify(S.prac)); } catch (_) {}
}

function markPrac(mins = 0, sess = 0) {
  const k = dKey(new Date());
  if (!S.prac.days[k]) S.prac.days[k] = { minutes: 0, sessions: 0 };
  S.prac.days[k].minutes  += Math.max(0, mins);
  S.prac.days[k].sessions += Math.max(0, sess);
  S.prac.minutes  += Math.max(0, mins);
  S.prac.sessions += Math.max(0, sess);
  savePrac();
  renderStats();
  renderCal();
}

function pracDays()  { return Object.keys(S.prac.days || {}).length; }

function calcStreak() {
  const d = new Date();
  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    if (S.prac.days[dKey(d)]) streak++;
    else break;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function calcMissed7() {
  const d = new Date();
  let p = 0;
  for (let i = 0; i < 7; i++) {
    if (S.prac.days[dKey(d)]) p++;
    d.setDate(d.getDate() - 1);
  }
  return Math.max(0, 7 - p);
}

/* Session timing helpers */
function sessionStart(kind) {
  if (kind === "human") S.humanTs = now();
  if (kind === "ai")    S.aiTs    = now();
}

function sessionEnd(kind) {
  const end = now();
  if (kind === "human" && S.humanTs) {
    markPrac(Math.max(1, Math.round((end - S.humanTs) / 60000)), 1);
    S.humanTs = 0;
  }
  if (kind === "ai" && S.aiTs) {
    markPrac(Math.max(1, Math.round((end - S.aiTs) / 60000)), 1);
    S.aiTs = 0;
  }
}

/* ─────────────────────────────────────────────────────────
   RENDER: STATS
───────────────────────────────────────────────────────── */
function renderStats() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  set("hSessions", S.prac.sessions);
  set("hDays",     pracDays());
  set("hMinutes",  S.prac.minutes);
  set("hStreak",   calcStreak());
  set("hMissed",   calcMissed7());
}

/* ─────────────────────────────────────────────────────────
   RENDER: CALENDAR
───────────────────────────────────────────────────────── */
const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

function renderCal() {
  const grid  = $("calGrid");
  const title = $("calTitle");
  if (!grid || !title) return;

  const { y, m } = S.cal;
  title.textContent = `${MONTH_NAMES[m]} ${y}`;
  grid.innerHTML    = "";

  const firstDow    = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays    = new Date(y, m, 0).getDate();
  const todayKey    = dKey(new Date());

  for (let i = 0; i < 42; i++) {
    const cell = document.createElement("div");
    cell.className = "cal-cell";

    const n = i - firstDow + 1;
    let k   = null;

    if (n <= 0) {
      const pd = prevDays + n;
      cell.textContent = String(pd);
      cell.classList.add("dim");
      k = dKey(new Date(y, m - 1, pd));
    } else if (n > daysInMonth) {
      const nd = n - daysInMonth;
      cell.textContent = String(nd);
      cell.classList.add("dim");
      k = dKey(new Date(y, m + 1, nd));
    } else {
      cell.textContent = String(n);
      k = dKey(new Date(y, m, n));
    }

    if (k === todayKey)      cell.classList.add("today");
    if (S.prac.days[k])     cell.classList.add("done");

    cell.addEventListener("click", () => {
      if (k && S.prac.days[k]) {
        const d = S.prac.days[k];
        hintAi(`📅 ${k}: ${d.minutes} min, ${d.sessions} sessions`);
      }
    });

    grid.appendChild(cell);
  }
}

/* ─────────────────────────────────────────────────────────
   RENDER: AI SCORE BAR
───────────────────────────────────────────────────────── */
function renderScore(sc) {
  if (!sc) return;
  const bar = $("scoreBar");
  if (bar) bar.style.display = "grid";
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v ?? "—"); };
  set("myBand", sc.band);
  set("myFlu",  sc.fluency);
  set("myGra",  sc.grammar);
  set("myVoc",  sc.vocab);
  set("myPro",  sc.pronunciation);
}

/* ─────────────────────────────────────────────────────────
   RENDER: ONLINE USERS LIST
───────────────────────────────────────────────────────── */
function renderOnline(users) {
  const list = $("onlineList");
  const cnt  = $("onlineCount");
  if (!list) return;

  const all = Array.isArray(users) ? users : [];
  if (cnt) cnt.textContent = String(all.length);

  /* exclude self */
  const others = all.filter(u => u.name !== S.name);

  if (!others.length) {
    list.innerHTML = `<div class="empty-state">No one else online right now. Invite a friend!</div>`;
    return;
  }

  list.innerHTML = "";
  others.forEach(u => {
    const row = document.createElement("div");
    row.className = "ol-row";

    const ini  = (u.name || "?")[0].toUpperCase();
    const meta = [
      u.gender !== "Any" ? u.gender : null,
      u.level  !== "Any" ? u.level  : null,
    ].filter(Boolean).join(" · ");

    const statusHtml = u.roomId
      ? `<span class="ol-status" style="color:var(--dim);">In session</span>`
      : `<span class="ol-status" style="color:#86efac;">Available</span>`;

    row.innerHTML = `
      <div class="ol-avatar">${esc(ini)}</div>
      <div class="ol-name">${esc(u.name)}</div>
      <div class="ol-meta">${esc(meta)}</div>
      ${statusHtml}
      <div class="ol-dot"></div>
    `;
    list.appendChild(row);
  });
}

/* ─────────────────────────────────────────────────────────
   RENDER: ICEBREAKER QUESTION
───────────────────────────────────────────────────────── */
function renderQ() {
  const total = S.questions.length || 10;
  S.qIdx = clamp(S.qIdx, 0, total - 1);

  const qi = $("qIdx");  if (qi) qi.textContent = String(S.qIdx + 1);
  const qt = $("qText"); if (qt) qt.textContent = S.questions[S.qIdx] || "Loading questions…";

  const prev = $("qPrev");
  const next = $("qNext");
  if (prev) { prev.disabled = S.qIdx === 0;          prev.style.opacity = prev.disabled ? ".3" : "1"; }
  if (next) { next.disabled = S.qIdx === total - 1;  next.style.opacity = next.disabled ? ".3" : "1"; }
}

/* ─────────────────────────────────────────────────────────
   RENDER: LEADERBOARD
───────────────────────────────────────────────────────── */
function renderLb(rows) {
  const el = $("leaderboard");
  if (!el) return;

  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) {
    el.innerHTML = `<div class="empty-state">No ratings yet.</div>`;
    return;
  }

  el.innerHTML = "";
  arr.slice(0, 20).forEach((x, i) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    const rankClass = i === 0 ? "lb-rank g1" : i === 1 ? "lb-rank g2" : i === 2 ? "lb-rank g3" : "lb-rank";
    row.innerHTML = `
      <div class="${rankClass}">${i + 1}</div>
      <div class="lb-name">${esc(x.name)}</div>
      <div class="lb-badge">⭐ ${esc(String(x.avg))} <span style="opacity:.6;">(${esc(String(x.count))})</span></div>
    `;
    el.appendChild(row);
  });
}

/* ─────────────────────────────────────────────────────────
   CHIPS  (gender / level selection)
───────────────────────────────────────────────────────── */
function syncChips(groupId, activeVal) {
  const g = $(groupId);
  if (!g) return;
  g.querySelectorAll(".chip").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.val === activeVal);
  });
}

/* ─────────────────────────────────────────────────────────
   RESET HELPERS
───────────────────────────────────────────────────────── */
function resetConv() {
  const msgs = $("messages"); if (msgs) msgs.innerHTML = "";
  const mi   = $("msgInput"); if (mi)   mi.value       = "";

  S.room  = { id: null, partner: null, polite: false };
  S.qIdx  = 0;
  S.humanTs = 0;

  renderQ();
  hintVoice("");
  hintSearch("");
  stopVoice().catch(() => {});
  convState("idle");
}

function resetAi() {
  const am = $("aiMessages"); if (am) am.innerHTML = "";
  const ai = $("aiInput");    if (ai) ai.value     = "";
  const ar = $("aiReport");   if (ar) ar.style.display = "none";

  S.ai   = { id: null };
  S.aiTs = 0;

  stopAiMic();
  setAiVoiceBtn();
  hintAi("Press <strong>Start AI</strong> below to begin your session.");
}

/* ─────────────────────────────────────────────────────────
   RTC CONFIG  (fetch /webrtc-config)
───────────────────────────────────────────────────────── */
async function loadRtcCfg() {
  try {
    const r = await fetch("/webrtc-config");
    const j = await r.json();
    if (Array.isArray(j?.iceServers) && j.iceServers.length) S.iceServers = j.iceServers;
    S.forceRelay = !!j?.forceRelay;
  } catch (_) {}
}

/* ─────────────────────────────────────────────────────────
   AUDIO WARM-UP  (unlock autoplay on mobile)
───────────────────────────────────────────────────────── */
async function warmAudio() {
  if (S.audioWarm) return;
  S.audioWarm = true;
  const a = $("remoteAudio");
  if (!a) return;
  try { a.muted = true; await a.play().catch(() => {}); a.muted = false; } catch (_) {}
}

/* ─────────────────────────────────────────────────────────
   WebRTC  ——  ONE-WAY VOICE READY

   Core idea:
     • When partner presses "Voice On" they emit webrtc:offer.
     • We ALWAYS answer that offer even if WE haven't pressed
       Voice On yet — this lets us HEAR them immediately.
     • If WE then press Voice On, we add our tracks and
       renegotiation happens automatically.
     • Result: one-way audio works instantly for the listener.
───────────────────────────────────────────────────────── */
function buildPeer() {
  destroyPeer();

  S.pc = new RTCPeerConnection({
    iceServers:         S.iceServers,
    iceTransportPolicy: S.forceRelay ? "relay" : "all",
  });

  /* Remote audio → <audio> element */
  S.pc.ontrack = ev => {
    const [st] = ev.streams;
    const a    = $("remoteAudio");
    if (st && a) { a.srcObject = st; a.play().catch(() => {}); }
  };

  /* ICE candidates → server */
  S.pc.onicecandidate = ev => {
    if (ev.candidate && S.room.id)
      socket.emit("webrtc:ice", { roomId: S.room.id, candidate: ev.candidate });
  };

  /* Connection state feedback */
  S.pc.onconnectionstatechange = () => {
    if (!S.pc) return;
    const cs = S.pc.connectionState;
    if (cs === "connected")    hintVoice("Voice connected ✅");
    if (cs === "failed")       hintVoice("Voice failed ❌  (check network / TURN required)");
    if (cs === "disconnected") hintVoice("Voice disconnected.");
  };

  /* Renegotiation needed → create offer */
  S.pc.onnegotiationneeded = async () => {
    try {
      S.makingOffer = true;
      const offer = await S.pc.createOffer({ offerToReceiveAudio: true });
      if (!S.pc || S.pc.signalingState !== "stable") return;
      await S.pc.setLocalDescription(offer);
      socket.emit("webrtc:offer", { roomId: S.room.id, sdp: S.pc.localDescription });
    } catch (_) {
      hintVoice("Offer error.");
    } finally {
      S.makingOffer = false;
    }
  };
}

function destroyPeer() {
  if (!S.pc) return;
  try { S.pc.ontrack = null; S.pc.onicecandidate = null; S.pc.onnegotiationneeded = null; } catch (_) {}
  try { S.pc.close(); } catch (_) {}
  S.pc = null;
}

/**
 * Handle incoming offer from partner.
 * Always answers, even before local Voice On → one-way audio.
 */
async function handleOffer(sdp, from) {
  if (!S.room.id) return;

  /* Build peer if not yet created (listener receives before pressing Voice On) */
  if (!S.pc) buildPeer();

  const collision   = S.makingOffer || S.pc.signalingState !== "stable";
  S.ignoreOffer     = !S.room.polite && collision;
  if (S.ignoreOffer) return;

  try {
    await S.pc.setRemoteDescription(new RTCSessionDescription(sdp));

    if (sdp.type === "offer") {
      /* If we already have local stream (Voice On active), add tracks */
      if (S.stream && S.voiceOn) {
        const senders = S.pc.getSenders();
        S.stream.getTracks().forEach(t => {
          if (!senders.some(s => s.track === t)) S.pc.addTrack(t, S.stream);
        });
      }

      const ans = await S.pc.createAnswer();
      await S.pc.setLocalDescription(ans);
      socket.emit("webrtc:answer", { roomId: S.room.id, sdp: S.pc.localDescription });

      /* Inform listener they can now hear partner */
      hintVoice(`${esc(from)} turned on voice — you can hear them now. Press Voice On to also speak.`);
    }
  } catch (_) {
    hintVoice("Voice connection error.");
  }
}

async function startVoice() {
  if (!S.room.id)  { hintVoice("Join a room first."); return; }
  if (S.voiceOn)   return;

  hintVoice("Requesting microphone…");

  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        channelCount:     1,
        sampleRate:       48000,
      },
      video: false,
    });
  } catch (_) {
    hintVoice("Microphone access denied. Allow mic in your browser settings.");
    return;
  }

  S.voiceOn = true;
  const btn = $("btnVoice");
  if (btn) btn.innerHTML = "🔴 Voice Off";

  /* Build peer if listener hadn't built it yet */
  if (!S.pc) buildPeer();

  /* Add microphone tracks → triggers onnegotiationneeded → offer */
  const senders = S.pc.getSenders();
  S.stream.getTracks().forEach(t => {
    if (!senders.some(s => s.track === t)) S.pc.addTrack(t, S.stream);
  });

  hintVoice("Mic on ✅  Connecting voice to partner…");
}

async function stopVoice() {
  S.voiceOn = false;

  const btn = $("btnVoice");
  if (btn) btn.innerHTML = "🎙️ Voice On";
  hintVoice("");

  if (S.stream) {
    S.stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    S.stream = null;
  }

  destroyPeer();

  const a = $("remoteAudio");
  if (a) a.srcObject = null;
}

/* ─────────────────────────────────────────────────────────
   AI VOICE  (SpeechRecognition + TTS)
───────────────────────────────────────────────────────── */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const aiOk = () => !!SR && !!window.speechSynthesis;

function setAiVoiceBtn() {
  const btn = $("btnAiVoice");
  if (!btn) return;
  if (S.aiListening) {
    btn.textContent = "🛑 Voice Off";
    btn.classList.add("on");
  } else {
    btn.textContent = "🎙️ Voice On";
    btn.classList.remove("on");
  }
}

async function aiSpeak(text) {
  return new Promise(resolve => {
    if (!window.speechSynthesis) { resolve(); return; }
    try {
      window.speechSynthesis.cancel();
      const utt    = new SpeechSynthesisUtterance(String(text || ""));
      utt.lang     = "en-US";
      utt.rate     = 1;
      utt.pitch    = 1;
      S.aiSpeaking = true;
      hintAi("AI speaking… 🔊");

      utt.onend  = () => { S.aiSpeaking = false; hintAi("Your turn → Voice On → speak → Voice Off 🎙️"); resolve(); };
      utt.onerror= () => { S.aiSpeaking = false; hintAi("TTS error. Check browser TTS support."); resolve(); };

      window.speechSynthesis.speak(utt);
    } catch (_) {
      S.aiSpeaking = false;
      resolve();
    }
  });
}

function stopAiMic() {
  clearTimeout(S.aiAutoStop);
  S.aiAutoStop  = null;
  S.aiListening = false;
  setAiVoiceBtn();

  const rec = S.aiRec;
  S.aiRec = null;
  try { rec && rec.stop(); } catch (_) {}
}

function startAiMic() {
  if (!S.ai.id) { hintAi("Press <strong>Start AI</strong> first."); return; }

  if (!aiOk()) {
    hintAi("Voice requires Chrome with SpeechRecognition support.");
    return;
  }
  if (S.aiSpeaking) {
    hintAi("Wait — AI is still speaking…");
    return;
  }
  if (S.aiListening) return;

  const rec = new SR();
  S.aiRec        = rec;
  rec.lang         = "en-US";
  rec.interimResults = true;
  rec.continuous   = true;

  S.aiLastText   = "";
  S.aiListening  = true;
  setAiVoiceBtn();
  hintAi("Listening… speak now 🎙️  Press <strong>Voice Off</strong> when done.");

  rec.onresult = e => {
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += (final ? " " : "") + (r[0]?.transcript || "").trim();
    }
    if (final) S.aiLastText = (S.aiLastText + " " + final).trim();

    /* Auto-stop after 2.2s silence */
    clearTimeout(S.aiAutoStop);
    S.aiAutoStop = setTimeout(() => {
      if (S.aiListening) stopAiMicAndSend();
    }, 2200);
  };

  rec.onerror = () => { hintAi("Mic error."); stopAiMic(); };
  rec.onend   = () => { if (S.aiListening) { try { rec.start(); } catch (_) {} } };

  try { rec.start(); } catch (_) {}
}

async function stopAiMicAndSend() {
  if (!S.aiListening) return;
  stopAiMic();

  const txt = (S.aiLastText || "").trim();
  if (!txt) { hintAi("No speech detected. Try again."); return; }

  addMsg("aiMessages", S.name, txt, "me");
  socket.emit("chat:message", { roomId: S.ai.id, text: txt });
  markPrac(1, 0);
  hintAi("Sent ✅  Waiting for AI Coach…");
}

/* ─────────────────────────────────────────────────────────
   SEND MESSAGE HELPERS
───────────────────────────────────────────────────────── */
function sendHuman() {
  if (now() - S.lastHumanSend < S.cdMs) { hintVoice("Slow down a bit…"); return; }
  S.lastHumanSend = now();

  const mi = $("msgInput");
  const txt = (mi?.value || "").trim();
  if (!txt || !S.room.id) return;
  if (mi) mi.value = "";
  socket.emit("chat:message", { roomId: S.room.id, text: txt });
}

function sendAi() {
  if (now() - S.lastAiSend < S.cdMs) { hintAi("Slow down a bit…"); return; }
  S.lastAiSend = now();

  const ai = $("aiInput");
  const txt = (ai?.value || "").trim();
  if (!txt || !S.ai.id) return;
  if (ai) ai.value = "";

  addMsg("aiMessages", S.name, txt, "me");
  socket.emit("chat:message", { roomId: S.ai.id, text: txt });
  markPrac(1, 0);
  hintAi("Sent ✅  Waiting for AI Coach…");
}

/* ─────────────────────────────────────────────────────────
   WIRE: UI EVENTS
───────────────────────────────────────────────────────── */
function wireUI() {

  /* ── Name screen ──────────────────────────────────── */
  const doJoin = () => {
    const ne  = $("nameErr");
    const val = ($("nameInput")?.value || "").trim();
    if (!val) { if (ne) ne.textContent = "Please enter a name."; return; }
    if (ne) ne.textContent = "";
    socket.emit("user:register", { name: val });
  };
  $("btnJoin")?.addEventListener("click", doJoin);
  $("nameInput")?.addEventListener("keydown", e => { if (e.key === "Enter") doJoin(); });

  /* ── Logout ───────────────────────────────────────── */
  $("btnLogout")?.addEventListener("click", () => {
    localStorage.removeItem(LS_NAME);
    location.reload();
  });

  /* ── Bottom nav ───────────────────────────────────── */
  $("navHome")?.addEventListener("click", () => setTab("home"));
  $("navConv")?.addEventListener("click", () => setTab("conv"));
  $("navAi")?.addEventListener("click",   () => setTab("ai"));

  /* ── Home tab ─────────────────────────────────────── */
  $("btnResetStats")?.addEventListener("click", () => {
    S.prac = { sessions: 0, minutes: 0, days: {} };
    savePrac(); renderStats(); renderCal();
  });

  $("calPrev")?.addEventListener("click", () => {
    S.cal.m--;
    if (S.cal.m < 0) { S.cal.m = 11; S.cal.y--; }
    renderCal();
  });

  $("calNext")?.addEventListener("click", () => {
    S.cal.m++;
    if (S.cal.m > 11) { S.cal.m = 0; S.cal.y++; }
    renderCal();
  });

  $("btnLb")?.addEventListener("click", () => socket.emit("admin:get"));

  /* ── Conv: Start Conversation button ─────────────── */
  $("btnStartConv")?.addEventListener("click", () => convState("prefs"));

  /* ── Conv: Back ───────────────────────────────────── */
  $("btnBackIdle")?.addEventListener("click", () => convState("idle"));

  /* ── Conv: Gender chips ───────────────────────────── */
  $("genderChips")?.addEventListener("click", e => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    S.prefs.gender = btn.dataset.val;
    syncChips("genderChips", S.prefs.gender);
  });

  /* ── Conv: Level chips ────────────────────────────── */
  $("levelChips")?.addEventListener("click", e => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    S.prefs.level = btn.dataset.val;
    syncChips("levelChips", S.prefs.level);
  });

  /* ── Conv: Find match ─────────────────────────────── */
  $("btnFind")?.addEventListener("click", () => {
    /* AI selected → go straight to AI tab */
    if (S.prefs.gender === "AI") {
      socket.emit("match:start", { gender: "AI", level: "Any" });
      hintAi("Connecting to AI Coach…");
      setTab("ai");
      return;
    }
    hintSearch("Searching for a partner…");
    socket.emit("match:start", { gender: S.prefs.gender, level: S.prefs.level });
  });

  $("btnStop")?.addEventListener("click", () => {
    socket.emit("match:stop");
    hintSearch("");
  });

  /* ── Conv: Leave room ─────────────────────────────── */
  $("btnLeave")?.addEventListener("click", () => {
    if (S.room.id || S.ai.id) socket.emit("room:leave");
  });

  /* ── Conv: Report partner ─────────────────────────── */
  $("btnReport")?.addEventListener("click", () => {
    if (!S.room.id) return;
    socket.emit("report:partner", { roomId: S.room.id });
  });

  /* ── Conv: Human send ─────────────────────────────── */
  $("btnSend")?.addEventListener("click", sendHuman);
  $("msgInput")?.addEventListener("keydown", e => { if (e.key === "Enter") sendHuman(); });

  /* ── Conv: Rating stars ───────────────────────────── */
  document.querySelectorAll(".rate-star").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!S.room.id) return;
      const stars = clamp(Number(btn.dataset.r), 1, 5);
      document.querySelectorAll(".rate-star")
        .forEach(b => b.classList.toggle("picked", Number(b.dataset.r) === stars));
      socket.emit("rate:partner", { roomId: S.room.id, stars });
    });
  });

  /* ── Conv: Icebreaker navigation ──────────────────── */
  $("qPrev")?.addEventListener("click", () => {
    if (S.room.id) socket.emit("icebreaker:nav", { roomId: S.room.id, dir: "prev" });
  });
  $("qNext")?.addEventListener("click", () => {
    if (S.room.id) socket.emit("icebreaker:nav", { roomId: S.room.id, dir: "next" });
  });

  /* ── Conv: Voice On/Off ───────────────────────────── */
  $("btnVoice")?.addEventListener("click", async () => {
    if (!S.room.id) { hintVoice("Join a room first."); return; }
    await warmAudio();
    if (!S.voiceOn) await startVoice();
    else            await stopVoice();
  });

  /* ── AI tab: Start AI ─────────────────────────────── */
  $("btnAiStart")?.addEventListener("click", () => {
    if (S.ai.id) {
      hintAi("AI session already active.");
      return;
    }
    socket.emit("match:start", { gender: "AI", level: "Any" });
    hintAi("Connecting to AI Coach…");
  });

  /* ── AI tab: Voice On/Off ─────────────────────────── */
  $("btnAiVoice")?.addEventListener("click", async () => {
    if (!S.ai.id) { hintAi("Press <strong>Start AI</strong> first."); return; }
    if (!S.aiListening) startAiMic();
    else                await stopAiMicAndSend();
    setAiVoiceBtn();
  });

  /* ── AI tab: Finish session ───────────────────────── */
  $("btnAiLeave")?.addEventListener("click", () => {
    if (!S.ai.id) { resetAi(); return; }
    stopAiMic();
    socket.emit("room:leave");
  });

  /* ── AI tab: Typed message ────────────────────────── */
  $("btnAiSend")?.addEventListener("click", sendAi);
  $("aiInput")?.addEventListener("keydown", e => { if (e.key === "Enter") sendAi(); });
}

/* ─────────────────────────────────────────────────────────
   WIRE: SOCKET EVENTS
───────────────────────────────────────────────────────── */
function wireSocket() {

  /* ── Questions from server ────────────────────────── */
  socket.on("global:questions", ({ questions }) => {
    S.questions = Array.isArray(questions) ? questions.slice(0, 10) : [];
    while (S.questions.length < 10) S.questions.push("Tell me something interesting about you.");
    renderQ();
  });

  /* ── Live stats ───────────────────────────────────── */
  socket.on("global:stats", ({ online, waiting, rooms }) => {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v ?? 0); };
    set("statOnline",  online);
    set("statWaiting", waiting);
    set("statRooms",   rooms);

    /* Also update online count in Conversation tab */
    const oc = $("onlineCount");
    if (oc) oc.textContent = String(online ?? 0);
  });

  /* ── Admin snapshot (leaderboard + optional user list) */
  socket.on("admin:snapshot", snap => {
    if (snap?.leaderboard)  renderLb(snap.leaderboard);
    if (Array.isArray(snap?.onlineUsers)) renderOnline(snap.onlineUsers);
  });

  /* ── Register success ─────────────────────────────── */
  socket.on("user:register:ok", ({ user, aiScore }) => {
    S.name = user.name;
    localStorage.setItem(LS_NAME, user.name);

    const mn = $("meName"); if (mn) mn.textContent = user.name;
    if (aiScore) renderScore(aiScore);

    showScreen("main");
    resetConv();
    resetAi();
    renderStats();
    renderCal();
    syncChips("genderChips", S.prefs.gender);
    syncChips("levelChips",  S.prefs.level);

    /* Always open on Conversation tab */
    setTab("conv");
    convState("idle");
  });

  /* ── Register fail ────────────────────────────────── */
  socket.on("user:register:fail", ({ reason }) => {
    if (reason === "banned") { showScreen("banned"); return; }

    const ne = $("nameErr");
    if (!ne) return;

    if (reason === "name_taken") {
      ne.textContent = "This name is already in use by someone else. Choose a different name.";
    } else {
      ne.textContent = "Invalid name. Please try something else.";
    }
  });

  /* ── Kicked (same name logged in elsewhere) ───────── */
  socket.on("user:kicked", () => {
    localStorage.removeItem(LS_NAME);
    location.reload();
  });

  /* ── Banned mid-session ───────────────────────────── */
  socket.on("user:banned", () => showScreen("banned"));

  /* ── Searching ────────────────────────────────────── */
  socket.on("match:searching", () => hintSearch("Searching for a partner…"));

  /* ── Match found ──────────────────────────────────── */
  socket.on("match:found", async ({ roomId, partnerName, aiScore }) => {
    if (aiScore) renderScore(aiScore);

    /* ── AI room ─────────────────────────────────── */
    if (partnerName === "AI") {
      S.ai.id = roomId;
      sessionStart("ai");

      const am = $("aiMessages"); if (am) am.innerHTML = "";
      const ar = $("aiReport");   if (ar) ar.style.display = "none";

      addMsg("aiMessages", "System", "Connected to AI Coach. Ask anything or use voice.", "sys");
      hintAi("AI ready ✅  Voice On → speak → Voice Off → AI replies by voice.");
      setAiVoiceBtn();
      setTab("ai");
      return;
    }

    /* ── Human room ──────────────────────────────── */
    S.room.id     = roomId;
    S.room.partner= partnerName;
    S.room.polite = (S.name || "").localeCompare(partnerName || "") < 0;
    sessionStart("human");

    const pn = $("partnerName"); if (pn) pn.textContent  = partnerName;
    const pa = $("pAvatar");     if (pa) pa.textContent   = (partnerName || "?")[0].toUpperCase();
    const msgs = $("messages");  if (msgs) msgs.innerHTML = "";

    hintSearch("");
    convState("chat");
    setTab("conv");

    addMsg("messages", "System", `Connected with ${partnerName}. Say hello!`, "sys");
    hintVoice("Press Voice On to speak. Your partner will hear you immediately.");

    /* Pre-build peer NOW → ready to receive their audio one-way */
    if (!S.pc) buildPeer();
    await warmAudio();
  });

  /* ── Icebreaker index change ──────────────────────── */
  socket.on("icebreaker:set", ({ index }) => {
    S.qIdx = Number(index) || 0;
    renderQ();
  });

  /* ── Chat message ─────────────────────────────────── */
  socket.on("chat:message", async msg => {
    if (!msg?.from) return;

    /* AI room message */
    if (S.ai.id && msg.from === "AI") {
      addMsg("aiMessages", "AI Coach", msg.text);
      await aiSpeak(msg.text);
      return;
    }

    /* Human room message */
    if (S.room.id && msg.from !== "AI") {
      const isMe = msg.from === S.name;
      addMsg("messages", msg.from, msg.text, isMe ? "me" : "");
    }
  });

  /* ── Report / Rate acknowledgments ───────────────── */
  socket.on("report:ok", ({ reported }) =>
    addMsg("messages", "System", `Reported: ${reported || "ok"}`, "sys"));

  socket.on("rate:ok", ({ rated }) =>
    addMsg("messages", "System", `Rated: ${rated || "ok"}`, "sys"));

  /* ── Room ended ───────────────────────────────────── */
  socket.on("room:ended", ({ reason }) => {
    if (S.room.id) {
      sessionEnd("human");
      addMsg("messages", "System", `Conversation ended${reason ? " (" + reason + ")" : ""}.`, "sys");
      setTimeout(() => resetConv(), 1800);
    }
    if (S.ai.id) {
      sessionEnd("ai");
      addMsg("aiMessages", "System", "AI session ended.", "sys");
      S.ai.id = null;
      stopAiMic();
      setAiVoiceBtn();
      hintAi("Session ended. Press <strong>Start AI</strong> to begin a new session.");
    }
  });

  /* ── AI Coach report ──────────────────────────────── */
  socket.on("coach:report", ({ report, aiScore }) => {
    if (aiScore) renderScore(aiScore);

    /* Show report card */
    const rc = $("aiReport"); if (rc) rc.style.display = "block";

    /* Summary */
    const rs = $("rSummary"); if (rs) rs.textContent = report?.summary || "Report received.";

    /* Scores */
    const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v ?? "—"); };
    set("rBand", report?.band);
    set("rFlu",  report?.fluency);
    set("rGra",  report?.grammar);
    set("rVoc",  report?.vocab);
    set("rPro",  report?.pronunciation);

    /* Fixes */
    const fl = $("rFixes");
    if (fl) {
      fl.innerHTML = "";
      (Array.isArray(report?.fixes) ? report.fixes : []).forEach(x => {
        const li = document.createElement("li");
        li.textContent = x;
        fl.appendChild(li);
      });
    }

    /* Next steps */
    const sl = $("rSteps");
    if (sl) {
      sl.innerHTML = "";
      (Array.isArray(report?.next_steps) ? report.next_steps : []).forEach(x => {
        const li = document.createElement("li");
        li.textContent = x;
        sl.appendChild(li);
      });
    }

    sessionEnd("ai");
    S.ai.id = null;
    stopAiMic();
    setAiVoiceBtn();
    hintAi("✅ Session finished! Your report is below.");

    /* Scroll to report */
    const ar = $("aiReport");
    if (ar) setTimeout(() => ar.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  });

  /* ── WebRTC signaling ─────────────────────────────── */
  socket.on("webrtc:offer", async ({ sdp, from }) => handleOffer(sdp, from));

  socket.on("webrtc:answer", async ({ sdp }) => {
    if (!S.pc) return;
    try { await S.pc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch (_) {}
  });

  socket.on("webrtc:ice", async ({ candidate }) => {
    if (!S.pc) return;
    try { await S.pc.addIceCandidate(candidate); } catch (_) {}
  });

  /* ── Connection status ────────────────────────────── */
  socket.on("connect",    () => netBadge(""));
  socket.on("disconnect", () => {
    netBadge("Offline… reconnecting");
    if (S.aiListening) stopAiMic();
  });
  socket.io?.on?.("reconnect_attempt", () => netBadge("Reconnecting…"));
  socket.io?.on?.("reconnect",         () => netBadge(""));
}

/* ─────────────────────────────────────────────────────────
   GLOBAL EVENTS
───────────────────────────────────────────────────────── */

/* Escape → stop AI mic */
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && S.aiListening) stopAiMic();
});

/* Tab hidden → stop AI mic */
document.addEventListener("visibilitychange", () => {
  if (document.hidden && S.aiListening) {
    stopAiMic();
    hintAi("Mic stopped (tab hidden).");
  }
});

/* Browser online/offline */
window.addEventListener("offline", () => netBadge("Offline"));
window.addEventListener("online",  () => netBadge(""));

/* ─────────────────────────────────────────────────────────
   BOOT
───────────────────────────────────────────────────────── */
(async function boot() {

  /* 1. Load saved practice data */
  loadPrac();

  /* 2. Fetch RTC config from server */
  await loadRtcCfg();

  /* 3. Wire all UI + socket events */
  wireUI();
  wireSocket();

  /* 4. Render initial local data */
  renderStats();
  renderCal();
  renderQ();

  /* 5. Sync chips to default prefs */
  syncChips("genderChips", S.prefs.gender);
  syncChips("levelChips",  S.prefs.level);

  /* 6. Show Name screen, hide rest */
  showScreen("name");
  convState("idle");

  /* 7. Auto-login if name was saved */
  const stored = (localStorage.getItem(LS_NAME) || "").trim();
  if (stored) {
    const ni = $("nameInput");
    if (ni) ni.value = stored;
    socket.emit("user:register", { name: stored });
  }

})();
