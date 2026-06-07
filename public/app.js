/* ═══════════════════════════════════════════════════════════════
   Speaking Zone Bot — app.js
   Features:
   • Socket.io connection management
   • Human-to-human WebRTC voice with dual mute controls
     - Mic mute   : disables your outgoing audio track
     - Remote mute: silences the other person's audio locally
   • AI (SpeakBot) chat with inline AQ score parsing
   • IELTS report on session end
   • Glassmorphism UI interactions
═══════════════════════════════════════════════════════════════ */
"use strict";

/* ── DOM helpers ─────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

/* ── State ───────────────────────────────────────────────── */
const S = {
  socket        : null,
  name          : "",
  myGender      : "Male",
  myLevel       : "Intermediate",
  aiScore       : null,
  roomId        : null,
  isAiRoom      : false,
  partnerName   : "",
  questions     : [],
  qIndex        : 0,
  // WebRTC
  pc            : null,
  localStream   : null,
  micMuted      : false,
  remoteMuted   : false,
  partnerMuted  : false,  // partner's self-mute state (from socket)
  voiceActive   : false,
  // Rating
  pendingRoomId : null,
  pendingStars  : 0,
};

/* ═══════════════════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════════════════ */
function toast(msg, type = "", duration = 3500) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("toast-container").appendChild(el);
  setTimeout(() => el.remove(), duration);
}

/* ═══════════════════════════════════════════════════════════
   SCREEN SWITCH
═══════════════════════════════════════════════════════════ */
function showScreen(id) {
  $$(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
}

/* ═══════════════════════════════════════════════════════════
   TAB NAVIGATION
═══════════════════════════════════════════════════════════ */
$$(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".nav-btn").forEach(b => b.classList.remove("active"));
    $$(".tab-content").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

/* ═══════════════════════════════════════════════════════════
   ENTRY SCREEN
═══════════════════════════════════════════════════════════ */
$("btn-enter").addEventListener("click", () => {
  const name = $("inp-name").value.trim();
  if (!name) { toast("Please enter your name", "error"); return; }
  S.name     = name;
  S.myGender = $("inp-gender").value;
  S.myLevel  = $("inp-level").value;
  initSocket();
});
$("inp-name").addEventListener("keydown", e => { if (e.key === "Enter") $("btn-enter").click(); });

/* ═══════════════════════════════════════════════════════════
   SOCKET.IO
═══════════════════════════════════════════════════════════ */
function initSocket() {
  $("btn-enter").disabled = true;
  $("btn-enter").textContent = "Connecting…";

  S.socket = io({ transports: ["websocket","polling"], reconnectionAttempts: 8, reconnectionDelay: 1500 });

  S.socket.on("connect", () => {
    S.socket.emit("user:register", { name: S.name, myGender: S.myGender, myLevel: S.myLevel });
  });

  S.socket.on("user:register:ok", ({ user, aiScore }) => {
    S.name     = user.name;
    S.myGender = user.myGender;
    S.myLevel  = user.myLevel;
    S.aiScore  = aiScore;
    updateScoreUI();
    updateHeaderUser();
    showScreen("screen-main");
    toast(`Welcome, ${S.name}! 🎙️`, "success");
  });

  S.socket.on("user:register:fail", ({ reason }) => {
    $("btn-enter").disabled = false;
    $("btn-enter").textContent = "Start Speaking →";
    toast(reason === "banned" ? "You are banned." : "Invalid name. Try again.", "error");
  });

  S.socket.on("global:stats", ({ online, rooms, totals }) => {
    $("hdr-online").textContent = online;
    $("hdr-rooms").textContent  = rooms;
    $("st-online").textContent  = online;
    $("st-rooms").textContent   = rooms;
    $("st-msgs").textContent    = totals?.messages || 0;
  });

  S.socket.on("global:users", ({ users }) => renderUserList(users));
  S.socket.on("global:questions", ({ questions }) => { S.questions = questions || []; });

  S.socket.on("match:searching", () => {
    $("match-controls").classList.add("hidden");
    $("searching-ui").classList.remove("hidden");
  });

  S.socket.on("match:found", ({ roomId, partnerName, partnerGender, partnerLevel, aiScore }) => {
    S.roomId      = roomId;
    S.isAiRoom    = partnerName === "SpeakBot";
    S.partnerName = partnerName;
    S.aiScore     = aiScore;

    // Show room
    $("match-controls").classList.add("hidden");
    $("searching-ui").classList.add("hidden");
    $("room-panel").classList.add("visible");
    $("session-report").classList.add("hidden");

    // Partner card
    $("partner-name").textContent = partnerName;
    $("partner-meta").textContent = `${partnerLevel || "AI"} • ${partnerGender || "AI"}`;
    $("partner-avatar").textContent = S.isAiRoom ? "🤖" : partnerName.charAt(0).toUpperCase();
    if (S.isAiRoom) {
      $("partner-avatar").classList.add("ai-avatar");
      $("partner-badge").textContent = "AI";
      $("partner-badge").className = "badge badge-ai";
      $("voice-controls-wrap").classList.add("hidden");
    } else {
      $("partner-avatar").classList.remove("ai-avatar");
      $("partner-badge").textContent = "HUMAN";
      $("partner-badge").className = "badge badge-human";
      $("voice-controls-wrap").classList.remove("hidden");
    }

    clearMessages("talk-messages");
    updateScoreUI();

    // Switch to talk tab
    $$(".nav-btn").forEach(b => b.classList.remove("active"));
    $$(".tab-content").forEach(t => t.classList.remove("active"));
    document.querySelector('.nav-btn[data-tab="talk"]').classList.add("active");
    $("tab-talk").classList.add("active");

    toast(`Connected with ${partnerName}! 🎉`, "success");
  });

  S.socket.on("icebreaker:set", ({ index }) => {
    S.qIndex = index;
    updateIcebreaker();
  });

  S.socket.on("chat:message", msg => handleChatMessage(msg, "talk"));
  S.socket.on("room:ended", ({ reason }) => handleRoomEnded(reason));
  S.socket.on("coach:report", ({ report, aiScore }) => {
    S.aiScore = aiScore;
    updateScoreUI();
    showReport(report, "talk");
  });

  /* WebRTC signals */
  S.socket.on("webrtc:offer",  ({ sdp, from }) => handleOffer(sdp, from));
  S.socket.on("webrtc:answer", ({ sdp })        => handleAnswer(sdp));
  S.socket.on("webrtc:ice",    ({ candidate })  => handleIce(candidate));

  /* Partner mute notification */
  S.socket.on("webrtc:mute", ({ muted }) => {
    S.partnerMuted = !!muted;
    $("partner-muted-badge").classList.toggle("hidden", !muted);
    toast(muted ? `${S.partnerName} muted their mic` : `${S.partnerName} unmuted`, "", 2000);
  });

  S.socket.on("user:banned", () => { toast("You have been banned.", "error"); location.reload(); });
  S.socket.on("user:kicked", () => { toast("You were kicked.", "error"); location.reload(); });

  S.socket.on("disconnect", () => toast("Connection lost. Reconnecting…", "error"));
  S.socket.on("reconnect",  () => { S.socket.emit("user:register", { name: S.name, myGender: S.myGender, myLevel: S.myLevel }); });
}

/* ═══════════════════════════════════════════════════════════
   HEADER
═══════════════════════════════════════════════════════════ */
function updateHeaderUser() {
  $("hdr-name").textContent   = S.name;
  $("hdr-avatar").textContent = S.name.charAt(0).toUpperCase();
}

/* ═══════════════════════════════════════════════════════════
   SCORE UI
═══════════════════════════════════════════════════════════ */
function updateScoreUI() {
  const sc = S.aiScore;
  if (!sc) return;
  const aq = sc.aq || 0;

  // AQ circle
  const circ = 2 * Math.PI * 54.9;
  const offset = circ - (aq / 100) * circ;
  const arc = $("aq-arc");
  if (arc) { arc.style.strokeDasharray = circ; arc.style.strokeDashoffset = offset; }
  $("aq-num").textContent = aq;
  $("aq-hint") && ($("aq-hint").classList.add("hidden"));

  const setBar = (barId, valId, val, max) => {
    const pct = max > 0 ? (val / max) * 100 : 0;
    $(barId) && ($(barId).style.width = pct + "%");
    $(valId) && ($(valId).textContent = val);
  };
  setBar("bar-fluency",      "val-fluency",      sc.fluency      || 0, 9);
  setBar("bar-grammar",      "val-grammar",       sc.grammar      || 0, 9);
  setBar("bar-vocab",        "val-vocab",         sc.vocab        || 0, 9);
  setBar("bar-pronunciation","val-pronunciation", sc.pronunciation|| 0, 9);
}

/* ═══════════════════════════════════════════════════════════
   USER LIST
═══════════════════════════════════════════════════════════ */
function renderUserList(users) {
  const list = $("users-list");
  if (!users || !users.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:12px;">No users online</div>'; return; }
  list.innerHTML = users.slice(0, 30).map(u => `
    <div class="user-item">
      <div class="user-item-avatar">${u.name.charAt(0).toUpperCase()}</div>
      <span class="user-item-name">${esc(u.name)}</span>
      ${u.roomId ? '<span style="font-size:.7rem;color:var(--primary);">💬</span>' : u.searching ? '<span style="font-size:.7rem;color:var(--blue);">🔍</span>' : ''}
      <span class="user-item-level">${u.myLevel||''}</span>
    </div>
  `).join("");
}

/* ═══════════════════════════════════════════════════════════
   ICEBREAKER
═══════════════════════════════════════════════════════════ */
function updateIcebreaker() {
  const q = S.questions[S.qIndex];
  if (q) $("ib-text").textContent = q;
}
$("ib-prev").addEventListener("click", () => { if (!S.roomId) return; S.socket.emit("icebreaker:nav", { roomId: S.roomId, dir: "prev" }); });
$("ib-next").addEventListener("click", () => { if (!S.roomId) return; S.socket.emit("icebreaker:nav", { roomId: S.roomId, dir: "next" }); });

/* ═══════════════════════════════════════════════════════════
   MATCH CONTROLS
═══════════════════════════════════════════════════════════ */
$("btn-find-human").addEventListener("click", () => {
  if (!S.socket) return;
  const wantGender = $("pref-gender").value;
  const wantLevel  = $("pref-level").value;
  S.socket.emit("match:start", { wantGender, wantLevel });
});

$("btn-stop-search").addEventListener("click", () => {
  S.socket?.emit("match:stop");
  $("searching-ui").classList.add("hidden");
  $("match-controls").classList.remove("hidden");
});

/* ═══════════════════════════════════════════════════════════
   CHAT — TALK TAB (human + AI messages shared channel)
═══════════════════════════════════════════════════════════ */
$("talk-send").addEventListener("click", () => sendTalkMsg());
$("talk-input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) sendTalkMsg(); });

function sendTalkMsg() {
  const txt = $("talk-input").value.trim();
  if (!txt || !S.roomId) return;
  S.socket.emit("chat:message", { roomId: S.roomId, text: txt });
  $("talk-input").value = "";
}

function handleChatMessage(msg, channel) {
  const isMe = msg.from === S.name;
  const isAI = !!msg.isAI;
  const container = channel === "bot" ? $("bot-messages") : $("talk-messages");
  const typing    = channel === "bot" ? $("bot-typing")   : $("talk-typing");

  typing.classList.remove("visible");

  const wrapper = document.createElement("div");
  wrapper.className = `msg ${isMe ? "msg-mine" : "msg-theirs"}`;
  if (!S.isAiRoom && !isAI) wrapper.classList.add("human-chat");
  if (isAI) wrapper.classList.add("ai-msg");

  if (!isMe) {
    const from = document.createElement("div");
    from.className = "msg-from";
    from.textContent = msg.from;
    wrapper.appendChild(from);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (isAI) {
    // Parse ---REPLY--- ... ---SCORE--- ... ---END--- format
    const parsed = parseAIMsg(msg.text);
    const replyEl = document.createElement("div");
    replyEl.className = "ai-reply-text";
    replyEl.textContent = parsed.reply;
    bubble.appendChild(replyEl);

    if (parsed.scores) {
      const scRow = document.createElement("div");
      scRow.className = "ai-score-inline";
      if (parsed.scores.fluency)     scRow.innerHTML += `<span class="score-chip">Fluency ${parsed.scores.fluency}</span>`;
      if (parsed.scores.grammar)     scRow.innerHTML += `<span class="score-chip">Grammar ${parsed.scores.grammar}</span>`;
      if (parsed.scores.vocabulary)  scRow.innerHTML += `<span class="score-chip">Vocab ${parsed.scores.vocabulary}</span>`;
      if (parsed.scores.aq)          scRow.innerHTML += `<span class="score-chip aq-chip">AQ ${parsed.scores.aq}</span>`;
      bubble.appendChild(scRow);

      // Update live score panel
      updateLiveScores(parsed.scores);
    }
  } else {
    bubble.textContent = msg.text;
  }

  const timeEl = document.createElement("div");
  timeEl.className = "msg-time";
  timeEl.textContent = formatTime(msg.ts);
  bubble.appendChild(timeEl);

  wrapper.appendChild(bubble);
  container.insertBefore(wrapper, typing);
  container.scrollTop = container.scrollHeight;
}

/* Parse AI response format:
   ---REPLY---\n<text>\n---SCORE---\n...\n---END--- */
function parseAIMsg(raw) {
  const txt = String(raw || "");

  const replyMatch = txt.match(/---REPLY---\s*([\s\S]*?)(?=---SCORE---|---END---|$)/i);
  const scoreMatch = txt.match(/---SCORE---\s*([\s\S]*?)(?=---END---|$)/i);

  let reply = txt;
  let scores = null;

  if (replyMatch) {
    reply = replyMatch[1].trim();
  }

  if (scoreMatch) {
    const scoreText = scoreMatch[1].trim();
    scores = {};
    const extract = (label) => {
      const m = scoreText.match(new RegExp(`${label}[:\\s]*(\\d+)`, "i"));
      return m ? parseInt(m[1], 10) : null;
    };
    scores.fluency     = extract("fluency");
    scores.grammar     = extract("grammar");
    scores.vocabulary  = extract("vocabulary") || extract("vocab");
    scores.pronunciation = extract("pronunciation");
    scores.aq          = extract("aq") || extract("overall");
  }

  // Fallback: if no markers found, return whole text as reply
  if (!replyMatch && !scoreMatch) {
    reply = txt.replace(/Score:[\s\S]*$/i, "").trim();
    const sc = {};
    sc.fluency      = extractNum(txt, "fluency");
    sc.grammar      = extractNum(txt, "grammar");
    sc.vocabulary   = extractNum(txt, "vocabulary") || extractNum(txt, "vocab");
    sc.pronunciation= extractNum(txt, "pronunciation");
    sc.aq           = extractNum(txt, "aq") || extractNum(txt, "overall");
    if (sc.fluency || sc.grammar || sc.aq) scores = sc;
  }

  return { reply, scores };
}

function extractNum(txt, label) {
  const m = txt.match(new RegExp(`${label}[:\\s]*(\\d+)`, "i"));
  return m ? parseInt(m[1], 10) : null;
}

function updateLiveScores(scores) {
  if (!scores) return;
  const set = (id, barId, val, max) => {
    if (val == null) return;
    $(id) && ($(id).textContent = val);
    $(barId) && ($(barId).style.width = `${(val/max)*100}%`);
  };
  set("ls-fluency",  "lsb-fluency",  scores.fluency,      9);
  set("ls-grammar",  "lsb-grammar",  scores.grammar,      9);
  set("ls-vocab",    "lsb-vocab",    scores.vocabulary,   9);
  set("ls-aq",       "lsb-aq",       scores.aq,           100);

  // Also update home tab scores for latest
  if (scores.fluency)  { $("bar-fluency").style.width = `${(scores.fluency/9)*100}%`; $("val-fluency").textContent = scores.fluency; }
  if (scores.grammar)  { $("bar-grammar").style.width = `${(scores.grammar/9)*100}%`; $("val-grammar").textContent = scores.grammar; }
  if (scores.vocabulary){ $("bar-vocab").style.width = `${(scores.vocabulary/9)*100}%`; $("val-vocab").textContent = scores.vocabulary; }
  if (scores.aq) {
    $("aq-num").textContent = scores.aq;
    const circ = 2 * Math.PI * 54.9;
    $("aq-arc").style.strokeDasharray  = circ;
    $("aq-arc").style.strokeDashoffset = circ - (scores.aq / 100) * circ;
    $("aq-hint") && $("aq-hint").classList.add("hidden");
  }
}

function clearMessages(id) {
  const c = $(id);
  // Keep typing indicator
  const typing = c.querySelector(".typing-indicator");
  c.innerHTML = "";
  if (typing) c.appendChild(typing);
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function esc(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/* ═══════════════════════════════════════════════════════════
   ROOM ENDED
═══════════════════════════════════════════════════════════ */
function handleRoomEnded(reason) {
  stopVoice();
  S.roomId   = null;
  S.isAiRoom = false;
  $("room-panel").classList.remove("visible");
  $("match-controls").classList.remove("hidden");
  $("partner-muted-badge").classList.add("hidden");

  if (reason !== "left" && reason !== "restart_search") {
    toast(`Session ended: ${reason || "partner left"}`, "", 3000);
    // show rating modal for human rooms
    if (!S.isAiRoom && S.partnerName) openRateModal();
  }
}

/* ═══════════════════════════════════════════════════════════
   LEAVE / REPORT
═══════════════════════════════════════════════════════════ */
$("btn-leave").addEventListener("click", () => {
  if (!S.roomId) return;
  const wasAI = S.isAiRoom;
  S.socket.emit("room:leave");
  stopVoice();
  if (!wasAI) openRateModal();
});

$("btn-report").addEventListener("click", () => {
  if (!S.roomId || S.isAiRoom) return;
  S.socket.emit("report:partner", { roomId: S.roomId });
  toast("Partner reported.", "", 2500);
});

/* ── End report display ─ */
function showReport(report, channel) {
  if (channel === "talk") {
    $("room-panel").classList.remove("visible");
    $("session-report").classList.remove("hidden");
    $("rep-band").textContent    = report.band ?? "—";
    $("rep-summary").textContent = report.summary || "";
    renderList($("rep-fixes"),  report.fixes  || [], "fix-item");
    renderList($("rep-steps"),  report.next_steps || [], "step-item");
    $("match-controls").classList.add("hidden");
  } else {
    $("bot-room-wrap").classList.add("hidden");
    $("bot-report").classList.remove("hidden");
    $("bot-rep-band").textContent    = report.band ?? "—";
    $("bot-rep-summary").textContent = report.summary || "";
    renderList($("bot-rep-fixes"),  report.fixes  || [], "fix-item");
    renderList($("bot-rep-steps"),  report.next_steps || [], "step-item");
  }
}
$("rep-close").addEventListener("click", () => {
  $("session-report").classList.add("hidden");
  $("match-controls").classList.remove("hidden");
});
$("bot-rep-close").addEventListener("click", () => {
  $("bot-report").classList.add("hidden");
  $("bot-start-wrap").classList.remove("hidden");
  clearMessages("bot-messages");
  clearLiveScores();
});

function renderList(container, items, cls) {
  container.innerHTML = items.slice(0, 5).map(i => `<div class="${cls}">${esc(String(i))}</div>`).join("");
}
function clearLiveScores() {
  ["ls-fluency","ls-grammar","ls-vocab","ls-aq"].forEach(id => $(id) && ($(id).textContent = "—"));
  ["lsb-fluency","lsb-grammar","lsb-vocab","lsb-aq"].forEach(id => $(id) && ($(id).style.width = "0%"));
}

/* ═══════════════════════════════════════════════════════════
   BOT TAB
═══════════════════════════════════════════════════════════ */
$("btn-start-bot").addEventListener("click", () => {
  if (!S.socket) return;
  $("bot-start-wrap").classList.add("hidden");
  $("bot-room-wrap").classList.remove("hidden");
  $("bot-report").classList.add("hidden");
  clearMessages("bot-messages");
  clearLiveScores();

  // Use match:start with AI
  S.socket.emit("match:start", { wantGender: "AI", wantLevel: "Any" });
  S.socket.off("match:found.bot");
  S.socket.on("match:found", onBotMatchFound);
});

function onBotMatchFound({ roomId, partnerName }) {
  if (partnerName !== "SpeakBot") return; // Only handle AI matches here
  S.socket.off("match:found", onBotMatchFound);

  // Sync S.roomId for bot chat
  S.roomId   = roomId;
  S.isAiRoom = true;

  // Send initial greeting
  setTimeout(() => {
    const greetings = [
      "Hey! How's your day going? 😊",
      "Hi there! What's on your mind today?",
      "Hello! Ready for a great conversation? ✨",
    ];
    S.socket.emit("chat:message", { roomId: S.roomId, text: greetings[Math.floor(Math.random() * greetings.length)] });
  }, 600);

  $("bot-typing").classList.add("visible");
});

// Override the global chat:message for bot channel
const _origHandleChat = handleChatMessage;
// Route bot messages to bot channel based on room
function routeMessage(msg) {
  if (S.isAiRoom && S.roomId) {
    handleChatMessage(msg, "bot");
  } else {
    handleChatMessage(msg, "talk");
  }
}

// Re-subscribe so bot messages go to bot panel
// (Socket listener already set in initSocket; we patch routing):
// We already have:  socket.on("chat:message", msg => handleChatMessage(msg, "talk"))
// So we'll update initSocket's chat:message to call routeMessage instead.
// Patch after socket is created — see patchSocket() below.

function patchSocket() {
  S.socket.off("chat:message");
  S.socket.on("chat:message", msg => {
    // Route: if we're in an AI room (bot tab), send to bot panel
    if (S.isAiRoom) {
      $("bot-typing").classList.remove("visible");
      handleChatMessage(msg, "bot");
    } else {
      handleChatMessage(msg, "talk");
    }
  });
}

$("btn-end-bot").addEventListener("click", () => {
  if (!S.roomId) return;
  S.socket.emit("room:leave");
  S.socket.once("coach:report", ({ report, aiScore }) => {
    S.aiScore = aiScore;
    updateScoreUI();
    showReport(report, "bot");
  });
});

$("bot-send").addEventListener("click", () => sendBotMsg());
$("bot-input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) sendBotMsg(); });

function sendBotMsg() {
  const txt = $("bot-input").value.trim();
  if (!txt || !S.roomId) return;
  S.socket.emit("chat:message", { roomId: S.roomId, text: txt });
  $("bot-input").value = "";
  $("bot-typing").classList.add("visible");
}

/* ═══════════════════════════════════════════════════════════
   WEBRTC — VOICE
═══════════════════════════════════════════════════════════ */
$("btn-start-voice").addEventListener("click", startVoice);

async function startVoice() {
  if (S.voiceActive) return;
  if (!S.roomId || S.isAiRoom) return;

  try {
    S.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    S.voiceActive = true;
    S.micMuted    = false;

    $("btn-start-voice").classList.add("hidden");
    $("btn-mute-mic").classList.remove("hidden");
    $("btn-mute-remote").classList.remove("hidden");
    updateMuteUI();

    const config = await fetchIceConfig();
    await createPeerConn(config);
    S.localStream.getTracks().forEach(t => S.pc.addTrack(t, S.localStream));

    const offer = await S.pc.createOffer({ offerToReceiveAudio: true });
    await S.pc.setLocalDescription(offer);
    S.socket.emit("webrtc:offer", { roomId: S.roomId, sdp: offer });
    toast("Voice connected 🎙️", "success");
  } catch (err) {
    toast("Mic access denied: " + err.message, "error");
  }
}

async function handleOffer(sdp, from) {
  if (!S.roomId || S.isAiRoom) return;
  try {
    S.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    S.voiceActive = true;
    S.micMuted    = false;

    $("btn-start-voice").classList.add("hidden");
    $("btn-mute-mic").classList.remove("hidden");
    $("btn-mute-remote").classList.remove("hidden");
    updateMuteUI();

    const config = await fetchIceConfig();
    await createPeerConn(config);
    S.localStream.getTracks().forEach(t => S.pc.addTrack(t, S.localStream));

    await S.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await S.pc.createAnswer();
    await S.pc.setLocalDescription(answer);
    S.socket.emit("webrtc:answer", { roomId: S.roomId, sdp: answer });
  } catch (err) {
    toast("Voice setup error: " + err.message, "error");
  }
}

async function handleAnswer(sdp) {
  if (!S.pc) return;
  try { await S.pc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch {}
}

async function handleIce(candidate) {
  if (!S.pc || !candidate) return;
  try { await S.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
}

async function createPeerConn(config) {
  S.pc = new RTCPeerConnection(config);
  S.pc.onicecandidate = ({ candidate }) => {
    if (candidate) S.socket.emit("webrtc:ice", { roomId: S.roomId, candidate });
  };
  S.pc.ontrack = ({ streams }) => {
    const audio = $("remote-audio");
    if (audio && streams[0]) {
      audio.srcObject = streams[0];
      audio.muted = S.remoteMuted;
    }
  };
  S.pc.onconnectionstatechange = () => {
    if (["failed","disconnected","closed"].includes(S.pc.connectionState)) {
      toast("Voice connection lost.", "error");
      resetVoiceUI();
    }
  };
}

async function fetchIceConfig() {
  try {
    const r = await fetch("/webrtc-config");
    return await r.json();
  } catch {
    return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  }
}

/* ── Mic mute (your own audio) ─────────────────────────── */
$("btn-mute-mic").addEventListener("click", toggleMicMute);

function toggleMicMute() {
  S.micMuted = !S.micMuted;
  if (S.localStream) {
    S.localStream.getAudioTracks().forEach(t => { t.enabled = !S.micMuted; });
  }
  // Notify partner
  S.socket.emit("webrtc:mute", { roomId: S.roomId, muted: S.micMuted });
  updateMuteUI();
  toast(S.micMuted ? "Your mic muted 🔇" : "Mic unmuted 🎤", "", 2000);
}

/* ── Remote mute (their audio for you) ─────────────────── */
$("btn-mute-remote").addEventListener("click", toggleRemoteMute);

function toggleRemoteMute() {
  S.remoteMuted = !S.remoteMuted;
  const audio = $("remote-audio");
  if (audio) audio.muted = S.remoteMuted;
  updateMuteUI();
  toast(S.remoteMuted ? `${S.partnerName}'s voice muted 🔇` : `${S.partnerName}'s voice on 🔊`, "", 2000);
}

function updateMuteUI() {
  // Mic button
  const micBtn = $("btn-mute-mic");
  if (S.micMuted) {
    micBtn.classList.add("muted");
    micBtn.querySelector("span:not(.vc-icon)") && (micBtn.querySelectorAll("span")[1].textContent = "Unmute Mic");
    micBtn.querySelector(".vc-icon").textContent = "🔇";
  } else {
    micBtn.classList.remove("muted");
    micBtn.querySelectorAll("span")[1] && (micBtn.querySelectorAll("span")[1].textContent = "Mute Mic");
    micBtn.querySelector(".vc-icon").textContent = "🎤";
  }
  // Remote button
  const remBtn = $("btn-mute-remote");
  if (S.remoteMuted) {
    remBtn.classList.add("muted");
    remBtn.querySelectorAll("span")[1] && (remBtn.querySelectorAll("span")[1].textContent = "Unmute Them");
    remBtn.querySelector(".vc-icon").textContent = "🔕";
  } else {
    remBtn.classList.remove("muted");
    remBtn.querySelectorAll("span")[1] && (remBtn.querySelectorAll("span")[1].textContent = "Mute Them");
    remBtn.querySelector(".vc-icon").textContent = "🔊";
  }
}

function stopVoice() {
  if (S.localStream) { S.localStream.getTracks().forEach(t => t.stop()); S.localStream = null; }
  if (S.pc)          { try { S.pc.close(); } catch {} S.pc = null; }
  const audio = $("remote-audio");
  if (audio) { audio.srcObject = null; audio.muted = false; }
  S.voiceActive = false;
  S.micMuted    = false;
  S.remoteMuted = false;
  resetVoiceUI();
}

function resetVoiceUI() {
  $("btn-start-voice").classList.remove("hidden");
  $("btn-mute-mic").classList.add("hidden");
  $("btn-mute-remote").classList.add("hidden");
}

/* ═══════════════════════════════════════════════════════════
   RATING MODAL
═══════════════════════════════════════════════════════════ */
function openRateModal() {
  S.pendingRoomId = S.roomId;
  S.pendingStars  = 0;
  $$(".star-btn").forEach(b => b.classList.remove("lit"));
  $("rate-modal").classList.add("open");
}
$$(".star-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const n = parseInt(btn.dataset.stars, 10);
    S.pendingStars = n;
    $$(".star-btn").forEach(b => b.classList.toggle("lit", parseInt(b.dataset.stars, 10) <= n));
  });
});
$("rate-skip").addEventListener("click",   () => $("rate-modal").classList.remove("open"));
$("rate-submit").addEventListener("click", () => {
  if (S.pendingStars > 0 && S.pendingRoomId)
    S.socket.emit("rate:partner", { roomId: S.pendingRoomId, stars: S.pendingStars });
  $("rate-modal").classList.remove("open");
  toast("Rating submitted ⭐", "success");
});

/* ═══════════════════════════════════════════════════════════
   BOOT — patch socket routing after connect
═══════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  // Patch after socket is initialised (called inside initSocket)
  const origInit = initSocket;
  window.initSocket = function() {
    origInit();
    // After a tick, patch the chat routing
    setTimeout(patchSocket, 200);
  };
});

// Also patch after any reconnect
function patchAfterConnect() {
  if (S.socket) patchSocket();
}
