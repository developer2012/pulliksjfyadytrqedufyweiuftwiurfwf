// public/admin.js — WonderTalk Admin PRO (server-auth)
const socket = io();

// ⚠️ Endi bu token FRONTENDda “haqiqiy himoya” emas.
// Haqiqiy himoya serverda: process.env.ADMIN_TOKEN
// Bu yerda faqat UI uchun.
const ADMIN_TOKEN_PLACEHOLDER = "CHANGE_ME_ADMIN_TOKEN"; // UI hint only

const el = {
  liveDot: document.getElementById("liveDot"),
  connDot: document.getElementById("connDot"),
  connText: document.getElementById("connText"),
  clock: document.getElementById("clock"),

  kpiOnline: document.getElementById("kpiOnline"),
  kpiWaiting: document.getElementById("kpiWaiting"),
  kpiRooms: document.getElementById("kpiRooms"),
  kpiMessages: document.getElementById("kpiMessages"),

  viewSeg: document.getElementById("viewSeg"),
  viewReports: document.getElementById("viewReports"),
  viewLeaderboard: document.getElementById("viewLeaderboard"),
  viewBans: document.getElementById("viewBans"),

  reportsRows: document.getElementById("reportsRows"),
  reportsEmpty: document.getElementById("reportsEmpty"),

  lbRows: document.getElementById("lbRows"),
  lbEmpty: document.getElementById("lbEmpty"),

  banRows: document.getElementById("banRows"),
  banEmpty: document.getElementById("banEmpty"),

  banName: document.getElementById("banName"),
  unbanName: document.getElementById("unbanName"),
  btnBan: document.getElementById("btnBan"),
  btnUnban: document.getElementById("btnUnban"),

  btnRefresh: document.getElementById("btnRefresh"),
  btnPull: document.getElementById("btnPull"),
  btnLive: document.getElementById("btnLive"),
  btnLogoutAdmin: document.getElementById("btnLogoutAdmin"),

  authOverlay: document.getElementById("authOverlay"),
  adminToken: document.getElementById("adminToken"),
  btnAuth: document.getElementById("btnAuth"),
  authErr: document.getElementById("authErr"),

  sessionKey: document.getElementById("sessionKey"),
  toasts: document.getElementById("toasts")
};

const LS_ADMIN = "wt_admin_token_v1";
const LS_LIVE = "wt_admin_live_v1";
let live = (localStorage.getItem(LS_LIVE) || "1") === "1";

function p2(n){ return String(n).padStart(2,"0"); }
function nowStr() {
  const d = new Date();
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
setInterval(() => { el.clock.textContent = nowStr(); }, 1000);
el.clock.textContent = nowStr();

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(title, sub = "") {
  const node = document.createElement("div");
  node.className = "toast";
  node.innerHTML = `<div class="tt">${escapeHtml(title)}</div><div class="ts">${escapeHtml(sub)}</div>`;
  el.toasts.appendChild(node);
  setTimeout(() => { try { node.style.opacity = "0"; node.style.transform = "translateY(6px)"; } catch {} }, 2400);
  setTimeout(() => node.remove(), 3200);
}

function setConn(ok) {
  el.connDot.classList.toggle("danger", !ok);
  el.connText.textContent = ok ? "Connected" : "Disconnected";
}

function setLive(on) {
  live = !!on;
  localStorage.setItem(LS_LIVE, live ? "1" : "0");
  el.liveDot.classList.toggle("danger", !live);
  el.btnLive.textContent = live ? "Live: ON" : "Live: OFF";
}

function setView(view) {
  const map = { reports: el.viewReports, leaderboard: el.viewLeaderboard, bans: el.viewBans };
  Object.entries(map).forEach(([k, node]) => { node.style.display = (k === view) ? "" : "none"; });
  el.viewSeg.querySelectorAll(".chip").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
}

function mask(t) {
  if (!t) return "—";
  if (t.length <= 6) return "••••";
  return t.slice(0, 2) + "••••" + t.slice(-2);
}

function getToken() {
  return (localStorage.getItem(LS_ADMIN) || "").trim();
}

function tokenOkUI() {
  // UI-only check (server is real check)
  const t = getToken();
  return t && t !== ADMIN_TOKEN_PLACEHOLDER;
}

function requireAuthUI() {
  const t = getToken();
  el.sessionKey.textContent = t ? mask(t) : "—";
  el.authOverlay.style.display = tokenOkUI() ? "none" : "";
}

function pullSnapshot() {
  if (!tokenOkUI()) return toast("Admin locked", "Enter token");
  socket.emit("admin:get", { token: getToken() }); // ✅ server-auth
}

function renderKPIs(snap) {
  el.kpiOnline.textContent = String(snap.online ?? 0);
  el.kpiWaiting.textContent = String(snap.waiting ?? 0);
  el.kpiRooms.textContent = String(snap.rooms ?? 0);
  el.kpiMessages.textContent = String(snap.totals?.messages ?? 0);
}

function renderReports(reports) {
  const rows = Array.isArray(reports) ? reports : [];
  el.reportsRows.innerHTML = "";
  el.reportsEmpty.style.display = rows.length ? "none" : "";

  rows.forEach((r) => {
    const row = document.createElement("div");
    row.className = "trow";
    row.innerHTML = `
      <div><span class="mono">${escapeHtml(r.name)}</span></div>
      <div><span class="badge2"><span class="dot ${r.count >= 5 ? "danger" : r.count >= 3 ? "warn" : ""}"></span>${escapeHtml(r.count)}</span></div>
      <div class="actions">
        <button class="btn sm" data-ban="${escapeHtml(r.name)}">Ban</button>
      </div>
    `;
    el.reportsRows.appendChild(row);
  });

  el.reportsRows.querySelectorAll("[data-ban]").forEach((b) => {
    b.addEventListener("click", () => {
      const name = (b.dataset.ban || "").trim();
      if (!name) return;
      socket.emit("admin:ban", { token: getToken(), name }); // ✅ server-auth
      toast("Ban sent", name);
    });
  });
}

function renderLeaderboard(rows) {
  const r = Array.isArray(rows) ? rows : [];
  el.lbRows.innerHTML = "";
  el.lbEmpty.style.display = r.length ? "none" : "";

  r.slice(0, 50).forEach((x, idx) => {
    const row = document.createElement("div");
    row.className = "trow";
    row.innerHTML = `
      <div><b>${idx + 1}.</b> <span class="mono">${escapeHtml(x.name)}</span></div>
      <div><span class="badge2">⭐ ${escapeHtml(x.avg)}</span></div>
      <div style="text-align:right;"><span class="badge2">${escapeHtml(x.count)}</span></div>
    `;
    el.lbRows.appendChild(row);
  });
}

function renderBans(list) {
  const bans = Array.isArray(list) ? list : [];
  el.banRows.innerHTML = "";
  el.banEmpty.style.display = bans.length ? "none" : "";

  bans.forEach((name) => {
    const row = document.createElement("div");
    row.className = "trow";
    row.style.gridTemplateColumns = "1.6fr .8fr";
    row.innerHTML = `
      <div><span class="mono">${escapeHtml(name)}</span></div>
      <div class="actions">
        <button class="btn sm" data-unban="${escapeHtml(name)}">Unban</button>
      </div>
    `;
    el.banRows.appendChild(row);
  });

  el.banRows.querySelectorAll("[data-unban]").forEach((b) => {
    b.addEventListener("click", () => {
      const name = (b.dataset.unban || "").trim();
      if (!name) return;
      socket.emit("admin:unban", { token: getToken(), name }); // ✅ server-auth
      toast("Unban sent", name);
    });
  });
}

function renderAll(snap) {
  renderKPIs(snap);
  renderReports(snap.reports || []);
  renderLeaderboard(snap.leaderboard || []);
  renderBans(snap.banned || []);
}

el.viewSeg.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

el.btnRefresh.addEventListener("click", pullSnapshot);
el.btnPull.addEventListener("click", pullSnapshot);
el.btnLive.addEventListener("click", () => { setLive(!live); toast("Live mode", live ? "Enabled" : "Disabled"); });

el.btnBan.addEventListener("click", () => {
  if (!tokenOkUI()) return toast("Admin locked", "Enter token");
  const name = (el.banName.value || "").trim();
  if (!name) return;
  socket.emit("admin:ban", { token: getToken(), name });
  toast("Ban sent", name);
});
el.btnUnban.addEventListener("click", () => {
  if (!tokenOkUI()) return toast("Admin locked", "Enter token");
  const name = (el.unbanName.value || "").trim();
  if (!name) return;
  socket.emit("admin:unban", { token: getToken(), name });
  toast("Unban sent", name);
});

el.btnLogoutAdmin.addEventListener("click", () => {
  localStorage.removeItem(LS_ADMIN);
  requireAuthUI();
  toast("Logged out", "Admin token removed");
});

el.btnAuth.addEventListener("click", () => {
  const token = (el.adminToken.value || "").trim();
  if (!token) { el.authErr.textContent = "Token required"; return; }
  localStorage.setItem(LS_ADMIN, token);
  el.adminToken.value = "";
  el.authErr.textContent = "";
  requireAuthUI();
  toast("Saved", "Token stored locally");
  pullSnapshot();
});

el.adminToken.addEventListener("keydown", (e) => { if (e.key === "Enter") el.btnAuth.click(); });

socket.on("connect", () => {
  setConn(true);
  requireAuthUI();
  if (tokenOkUI()) pullSnapshot();
});

socket.on("disconnect", () => {
  setConn(false);
  toast("Disconnected", "Reconnecting…");
});

socket.on("admin:snapshot", (snap) => {
  requireAuthUI();
  if (!tokenOkUI()) return;
  renderAll(snap);
});

socket.on("global:stats", (stats) => {
  if (!live) return;
  if (!tokenOkUI()) return;
  renderKPIs({
    online: stats.online,
    waiting: stats.waiting,
    rooms: stats.rooms,
    totals: stats.totals
  });
});

(function boot(){
  setView("reports");
  setLive(live);
  requireAuthUI();
})();
