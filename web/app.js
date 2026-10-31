const LANES = [
  { key: "reply", name: "Needs your reply", note: "Someone is blocked on a sentence from you." },
  { key: "deadline", name: "On the clock", note: "Exact deadlines, read out of the message body." },
  { key: "opportunity", name: "Opportunities", note: "Upside if you act, nothing breaks if you don't." },
  { key: "explore", name: "Worth exploring", note: "No ask attached — parked in a reading block." }
];
const TABS = [{ key: "brief", name: "Brief" }, { key: "triage", name: "Triage" }, { key: "dump", name: "Dump" }, { key: "sessions", name: "Sessions" }];
const FILTERS = ["all", "new", "reply", "deadline", "opportunity", "explore"];
const DUMP_ACTIONS = ["all", "do", "read", "watch", "listen", "buy", "reply", "reference"];
const ACTION_LABEL = { do: "To do", read: "To read", watch: "To watch", listen: "To listen", buy: "To buy", reply: "To reply", reference: "Reference" };
const KIND_MARK = { link: "↗", note: "✎", image: "▣", video: "▶", audio: "♪", file: "❐" };

const S = {
  screen: "brief", data: null, source: "all", filter: "all", query: "",
  detailId: null, dragId: null, dropOver: false, undo: null, pairOpen: false, toast: null,
  draft: "", dumpFilter: "all", showDone: false, recording: false
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  return res.json();
}

async function apiRaw(path, body, type) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": type }, body });
  return res.json();
}

function toast(msg) {
  S.toast = msg;
  render();
  setTimeout(() => { if (S.toast === msg) { S.toast = null; render(); } }, 4500);
}

// The phone view only needs its own slice, and shows the last one it had at once on open.
const phoneView = () => typeof mobileUI === "function" && mobileUI();
async function refresh() {
  if (phoneView()) {
    // the phone says which Wi-Fi it's on: that's how Unibox learns when you're at work
    let ctx = "";
    try { if (window.UniboxNative?.context) ctx = "?ctx=" + encodeURIComponent(window.UniboxNative.context()); } catch {}
    const data = await api("/api/mobile" + ctx);
    if (!data || !data.mobile) return;
    // nothing new (most 30 s polls): no redraw at all
    const sig = JSON.stringify(data, (k, v) => (k === "generatedAt" ? undefined : v));
    const same = sig === S.sig && !S.fromCache;
    S.data = data;
    S.fromCache = false;
    if (same) return;
    S.sig = sig;
    try { localStorage.setItem("unibox_mobile_cache", JSON.stringify(data)); } catch {}
  } else {
    S.data = await api("/api/state");
  }
  render();
}

function renderCached() {
  if (!phoneView()) return;
  try {
    const cached = JSON.parse(localStorage.getItem("unibox_mobile_cache") || "null");
    if (cached && cached.mobile) { S.data = cached; S.fromCache = true; render(); }
  } catch {}
}

window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(location.search);
  const scr = params.get("screen");
  if (scr && TABS.some(t => t.key === scr)) S.screen = scr;
  renderCached();
  refresh();
  setInterval(refresh, 30000);
  registerSw();
  if (params.has("shared")) {
    const n = params.get("shared");
    toast(n && n !== "0" ? `Shared ${n} item${n === "1" ? "" : "s"}` : "Share received");
    history.replaceState(null, "", location.pathname);
  }
});

// A new version is ready: load it, but never under your fingers. If the page is on screen,
// wait until it's left (you open an app); the next time it shows, it's the new one.
function reloadWhenAway() {
  if (document.visibilityState === "hidden") { location.reload(); return; }
  if (window.__reloadPending) return;
  window.__reloadPending = true;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") location.reload(); });
}

let swReg = null;
async function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  // a new deploy took over: reload once so the page and its scripts match it
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) reloadWhenAway(); });
  try {
    swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {}
}

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  if (S.screen === "dump") render();
});

async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  render();
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePhoneAlerts() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toast("This browser can't do push notifications");
    return;
  }
  if (!window.isSecureContext) {
    toast("Push needs https:// — add Tailscale or a certificate (see README)");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    toast("Notifications were blocked");
    return;
  }
  try {
    const reg = swReg || (await navigator.serviceWorker.ready);
    const info = await api("/api/push/key");
    if (!info.enabled || !info.key) {
      toast("Push isn't configured on the server");
      return;
    }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(info.key),
    });
    await api("/api/push/subscribe", { subscription: sub });
    toast("Phone alerts on");
  } catch {
    toast("Couldn't turn on alerts");
  }
}

function pick(tab) { S.screen = tab; S.detailId = null; render(); }
function pickSource(k) { S.source = k; render(); }
function onQuery(e) { S.query = e.target.value; render(); }
function onFilter(e) { S.filter = e.target.value; render(); }
function openDetail(id) { S.detailId = id; S.screen = "triage"; render(); }
function closeDetail() { S.detailId = null; render(); }
function stop(e) { e.stopPropagation(); }

async function doDismiss(id) {
  const title = (S.data.items.find(i => i.id === id) || {}).title;
  await api("/api/action", { type: "dismiss", id });
  S.undo = { type: "dismiss", id, title };
  await refresh();
}
async function doSchedule(id, time) {
  const title = (S.data.items.find(i => i.id === id) || {}).title;
  await api("/api/action", { type: "schedule", id, time });
  S.undo = { type: "schedule", id, title };
  await refresh();
}
async function doUndo() {
  if (!S.undo) return;
  await api("/api/action", { type: S.undo.type === "dismiss" ? "undo-dismiss" : "undo-schedule", id: S.undo.id });
  S.undo = null;
  await refresh();
}
async function doRedigest(btn) {
  btn.disabled = true;
  btn.textContent = "Digesting…";
  await api("/api/redigest", {});
  S.undo = null;
  await refresh();
}
async function doResetDay() {
  await api("/api/action", { type: "resetDay" });
  await refresh();
}

function setDumpFilter(k) { S.dumpFilter = k; render(); }
function toggleDone() { S.showDone = !S.showDone; render(); }

async function dumpSubmit() {
  const ta = document.getElementById("dump-text");
  const text = (ta ? ta.value : S.draft).trim();
  if (!text) { toast("Nothing to dump"); return; }
  const btn = document.getElementById("dump-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Dumping…"; }
  const res = await api("/api/capture", { text });
  S.draft = "";
  toast(`Dumped ${res.added} item${res.added === 1 ? "" : "s"} — classifying`);
  await refresh();
}

async function uploadDumpFiles(input) {
  const files = [...(input.files || [])];
  if (!files.length) return;
  toast(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  for (const f of files) {
    const buf = await f.arrayBuffer();
    await fetch("/api/capture/file?name=" + encodeURIComponent(f.name), {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: buf
    });
  }
  input.value = "";
  toast(`${files.length} file${files.length === 1 ? "" : "s"} dumped`);
  await refresh();
}

// Paste a screenshot or photo anywhere in the app and it's captured like an upload.
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const stamp = Date.now();
  const named = files.map((f, i) => new File([f], `pegado-${stamp}-${i}.${(f.type.split("/")[1] || "bin").replace("jpeg", "jpg")}`, { type: f.type }));
  if (document.body.classList.contains("m")) mUpload({ files: named });
  else uploadDumpFiles({ files: named });
});

async function dumpItem(id, type, minutes) {
  await api("/api/item", { id, type, minutes });
  await refresh();
}

async function toggleAvailable() {
  const on = !S.data.dump.nudge.available;
  await api("/api/available", { available: on });
  toast(on ? "Available — nudges resume" : "Focus mode — nudges paused");
  await refresh();
}

async function nudgeNow() {
  const r = await api("/api/nudge", { force: true });
  toast(r.sent ? "Nudged · " + String(r.text || "").split("\n")[0] : "Nothing to nudge");
  await refresh();
}

let recorder = null;
let recChunks = [];
async function toggleRecord() {
  if (S.recording) { recorder && recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    recChunks = [];
    recorder.ondataavailable = (e) => recChunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      S.recording = false;
      render();
      const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
      await fetch("/api/capture/file?name=" + `voice-${Date.now()}.webm`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: blob
      });
      toast("Voice note dumped — will transcribe");
      await refresh();
    };
    recorder.start();
    S.recording = true;
    render();
  } catch {
    toast("Microphone unavailable");
  }
}

let pairTimer = null;
async function togglePair() {
  const wa = S.data.connections.find(c => c.key === "whatsapp");
  if (wa && wa.state === "connected") {
    await api("/api/wa/stop", {});
    await refresh();
    return;
  }
  S.pairOpen = true;
  render();
  await api("/api/wa/start", {});
  if (!pairTimer) pairTimer = setInterval(pairPoll, 2000);
}
async function pairPoll() {
  try {
    const st = await api("/api/wa/status");
    const img = document.getElementById("pair-qr");
    const msg = document.getElementById("pair-msg");
    if (st.state === "connected") { closePair(); return; }
    if (img && st.qr && img.dataset.qr !== st.qr.slice(-40)) {
      img.src = st.qr;
      img.dataset.qr = st.qr.slice(-40);
      img.style.display = "block";
      if (msg) msg.textContent = "Scan with your phone — WhatsApp → Settings → Linked devices → Link a device";
    } else if (msg && st.state === "connecting") {
      msg.textContent = "Reconnecting to WhatsApp…";
    }
  } catch {}
}
async function googleSync(btn) {
  btn.disabled = true;
  btn.textContent = "Syncing…";
  const r = await api("/api/google/sync", {});
  toast(r.ok ? `Google synced · ${r.threads} threads changed, ${r.events} events` : `Google sync failed: ${r.error}`);
  await refresh();
}

async function googleDisconnect() {
  if (!confirm("Disconnect Google? Gmail and Calendar stop syncing until you sign in again.")) return;
  await api("/api/google/disconnect", {});
  toast("Google disconnected");
  await refresh();
}

function closePair() {
  S.pairOpen = false;
  if (pairTimer) { clearInterval(pairTimer); pairTimer = null; }
  refresh();
}
function uploadLinkedIn(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const res = await apiRaw("/api/linkedin/upload?name=" + encodeURIComponent(file.name), reader.result, "text/csv");
    if (res.ok) toast(`LinkedIn export uploaded · ${res.added} new messages ingested`);
    else toast("Upload failed: " + (res.error || "unknown error"));
    await refresh();
  };
  reader.readAsText(file);
}

function match(i) {
  const q = S.query.trim().toLowerCase();
  return (S.filter === "all" || (S.filter === "new" ? i.isNew : i.lane === S.filter)) &&
    (S.source === "all" || i.src === S.source) &&
    (!q || (i.title + " " + i.why + " " + i.srcName + " " + i.handle).toLowerCase().includes(q));
}

function cardHTML(it, compact) {
  return `<button onclick="openDetail('${esc(it.id)}')" class="card elev-sm" style="gap: var(--space-2); padding: var(--space-4); text-align: left; border: 0; font: inherit; cursor: pointer; color: var(--color-text); background: color-mix(in srgb, var(--color-surface) 80%, transparent);" onmouseover="this.style.boxShadow='var(--shadow-md)'" onmouseout="this.style.boxShadow=''">
    <div style="display: flex; align-items: center; gap: var(--space-2);">
      <span style="width: ${compact ? 18 : 20}px; height: ${compact ? 18 : 20}px; flex: none; border-radius: 5px; display: grid; place-items: center; font-size: 9px; background: var(--color-neutral-800); color: var(--color-neutral-200);">${esc(it.mark)}</span>
      <span style="font-size: ${compact ? 11 : 11.5}px; color: var(--color-neutral-500);">${esc(it.handle)}</span>
      <span style="margin-left: auto; font-size: 10.5px; color: ${it.lane === "deadline" ? "var(--color-accent-300)" : "var(--color-neutral-600)"}; font-variant-numeric: tabular-nums;">${esc(it.ago)}</span>
    </div>
    <div style="font-size: ${compact ? 14 : 13.5}px; line-height: 1.35; font-family: var(--font-heading); font-weight: 500; text-wrap: pretty;">${esc(it.title)}</div>
    ${it.gist ? `<div style="font-size: 12px; line-height: 1.45; color: var(--color-neutral-500); text-wrap: pretty;">${esc(it.gist)}</div>` : ""}
  </button>`;
}

function renderNav() {
  const d = S.data;
  return `<div class="nav nav-top" style="gap: var(--space-6); padding: var(--space-3) var(--space-6); flex: none; border-bottom: 1px solid var(--color-divider);">
    <div style="display: flex; align-items: baseline; gap: var(--space-3);">
      <span class="nav-brand" style="margin-right: 0; letter-spacing: -0.02em;">unibox</span>
      <span style="width: 5px; height: 5px; border-radius: 50%; background: var(--color-accent); box-shadow: 0 0 10px 2px color-mix(in srgb, var(--color-accent) 55%, transparent);"></span>
    </div>
    <div class="nav-tabs" style="display: flex; gap: var(--space-1); margin-left: var(--space-4); margin-right: auto;">
      ${TABS.map(t => `<button onclick="pick('${t.key}')" style="border: 0; background: ${S.screen === t.key ? "color-mix(in srgb, var(--color-accent) 14%, transparent)" : "transparent"}; color: ${S.screen === t.key ? "var(--color-accent-200)" : "var(--color-neutral-400)"}; font: inherit; font-size: 13px; padding: 5px var(--space-4); border-radius: var(--radius-sm); cursor: pointer;" onmouseover="if('${t.key}'!=='${S.screen}')this.style.background='color-mix(in srgb, var(--color-text) 7%, transparent)'" onmouseout="if('${t.key}'!=='${S.screen}')this.style.background='transparent'">${t.name}</button>`).join("")}
    </div>
    <span class="nav-digest" style="font-size: 11.5px; color: var(--color-neutral-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto;">${esc(d.digestLine)}</span>
    <input class="input nav-search" placeholder="Search everything" value="${esc(S.query)}" oninput="onQuery(event)" style="flex: 0 1 200px; min-width: 90px; min-height: 32px; background: color-mix(in srgb, var(--color-surface) 70%, transparent);">
    <button class="btn btn-secondary" onclick="doRedigest(this)" style="font-size: 13px; white-space: nowrap; flex: none;">Re-digest</button>
    <span style="width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; color: var(--color-accent-200); background: var(--color-accent-800); flex: none;">D</span>
  </div>`;
}

function renderBrief() {
  const d = S.data;
  const q = S.query.trim().toLowerCase();
  const briefItems = d.items.filter(i => !q || match(i));
  const dl = briefItems.filter(i => i.lane === "deadline").length;
  const lanes = LANES.map(l => ({ ...l, items: briefItems.filter(i => i.lane === l.key) })).filter(l => l.items.length > 0);
  const maxN = Math.max(...d.arrivals.map(a => a.n), 1);
  return `<div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-8) var(--space-8) 56px;">
    <div style="max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-8);">
      <div style="display: flex; align-items: flex-end; gap: var(--space-8); flex-wrap: wrap; padding-bottom: var(--space-4); border-bottom: 1px solid var(--color-divider);">
        <div style="min-width: 0;">
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); margin-bottom: var(--space-3);">Morning brief · ${new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
          <h2 style="font-size: 30px; margin: 0; letter-spacing: -0.022em; max-width: 30ch; text-wrap: pretty;">${briefItems.length === 0 ? "Box empty — nothing left to decide." : dl + (dl === 1 ? " thing has a clock on it." : " things have a clock on them.") + " The rest can wait until you want it."}</h2>
        </div>
        <div style="margin-left: auto; display: flex; gap: var(--space-8); flex-wrap: wrap;">
          ${d.briefStats.map(st => `<div style="flex: none;"><div style="font-family: var(--font-heading); font-size: 27px; letter-spacing: -0.02em; white-space: nowrap; color: ${st.color};">${esc(st.value)}</div><div style="font-size: 11px; color: var(--color-neutral-600); margin-top: 2px; white-space: nowrap;">${esc(st.label)}</div></div>`).join("")}
        </div>
      </div>
      <div style="display: flex; align-items: flex-end; gap: var(--space-6); flex-wrap: wrap;">
        <div style="display: flex; align-items: flex-end; gap: var(--space-4);">
          ${d.arrivals.map(a => `<div style="display: flex; flex-direction: column; align-items: center; gap: var(--space-2); width: 46px;">
            <span style="font-size: 10.5px; color: var(--color-neutral-600); font-variant-numeric: tabular-nums;">${a.n}</span>
            <span style="width: 100%; height: ${Math.round(8 + (a.n / maxN) * 46)}px; border-radius: 3px 3px 0 0; background: var(--color-neutral-800);"></span>
            <span style="width: 100%; height: ${Math.round(4 + a.k * 6)}px; border-radius: 0 0 3px 3px; background: var(--color-accent);"></span>
            <span style="font-size: 10px; color: var(--color-neutral-700); font-variant-numeric: tabular-nums;">${esc(a.t)}</span>
          </div>`).join("")}
        </div>
        <div style="font-size: 11.5px; line-height: 1.5; color: var(--color-neutral-600); max-width: 30ch; padding-bottom: var(--space-6);">Signals arriving per hour; the accent foot is what survived triage.</div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-6); align-items: start;">
        ${lanes.map(ln => `<div style="display: flex; flex-direction: column; gap: var(--space-3); min-width: 0;">
          <div style="display: flex; align-items: baseline; gap: var(--space-3); padding-bottom: var(--space-2);">
            <span style="font-size: 12.5px; letter-spacing: 0.02em;">${esc(ln.name)}</span>
            <span style="font-size: 11px; color: var(--color-neutral-600); font-variant-numeric: tabular-nums;">${ln.items.length}</span>
            <span style="flex: 1; height: 1px; background: linear-gradient(to right, var(--color-divider), transparent);"></span>
          </div>
          <div style="font-size: 11.5px; line-height: 1.45; color: var(--color-neutral-600); max-width: 34ch; margin-bottom: var(--space-1);">${esc(ln.note)}</div>
          ${ln.items.map(it => cardHTML(it, false)).join("")}
        </div>`).join("")}
        ${lanes.length === 0 ? `<div style="padding: var(--space-8); text-align: center; border: 1px dashed var(--color-divider); border-radius: var(--radius-lg); color: var(--color-neutral-500); font-size: 13.5px; grid-column: 1 / -1;">Box empty. Run <b>npm run watch</b> and <b>npm run digest</b> to fill it.</div>` : ""}
      </div>
    </div>
  </div>`;
}

function agendaEntry(e) {
  return `<div style="display: flex; gap: var(--space-3); padding: var(--space-3) 0; border-top: 1px solid var(--color-divider);">
    <span style="min-width: 40px; font-size: 11.5px; color: var(--color-neutral-500); font-variant-numeric: tabular-nums; padding-top: 1px;">${esc(e.time)}</span>
    <span style="width: 2px; flex: none; border-radius: 2px; background: ${e.bar};"></span>
    <div style="min-width: 0; display: flex; flex-direction: column; gap: 3px;">
      <div style="font-size: 13px; line-height: 1.35; text-wrap: pretty;">${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noreferrer" style="color: inherit; text-decoration: none;">${esc(e.title)}</a>` : esc(e.title)}</div>
      <div style="font-size: 11px; color: var(--color-neutral-600);">${esc(e.meta)}</div>
      ${e.fresh ? `<span class="tag tag-accent" style="align-self: flex-start; font-size: 9.5px; padding: 2px 7px; margin-top: 2px; animation: freshIn 220ms ease-out;">just scheduled</span>` : ""}
    </div>
  </div>`;
}

function renderTriage() {
  const d = S.data;
  const visible = d.items.filter(match);
  const detail = d.items.find(i => i.id === S.detailId);
  const agentBar = d.agenda.filter(e => e.bar === "var(--color-accent)").length;
  const todayAgenda = d.agenda.filter(e => e.cal || /^\d{2}:\d{2}$/.test(e.time));
  const later = d.agenda.filter(e => !e.cal && !/^\d{2}:\d{2}$/.test(e.time));
  return `<div class="triage-grid" style="flex: 1; display: grid; grid-template-columns: 196px minmax(0, 1fr) 320px; min-height: 0; position: relative;">
    <div class="triage-side" style="border-right: 1px solid var(--color-divider); padding: var(--space-6) var(--space-4); display: flex; flex-direction: column; gap: var(--space-6); overflow-y: auto;">
      <div style="display: flex; flex-direction: column; gap: var(--space-1);">
        <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); padding: 0 var(--space-2) var(--space-3);">Sources</div>
        ${d.sources.map(s => `<button onclick="pickSource('${s.key}')" style="display: flex; align-items: center; gap: var(--space-3); width: 100%; text-align: left; padding: 6px var(--space-2); border: 0; border-radius: var(--radius-sm); font: inherit; font-size: 13px; cursor: pointer; color: var(--color-text); background: ${S.source === s.key ? "color-mix(in srgb, var(--color-accent) 14%, transparent)" : "transparent"};" onmouseover="if('${s.key}'!=='${S.source}')this.style.background='color-mix(in srgb, var(--color-text) 7%, transparent)'" onmouseout="if('${s.key}'!=='${S.source}')this.style.background='transparent'">
          <span style="width: 20px; height: 20px; flex: none; border-radius: 5px; display: grid; place-items: center; font-size: 9.5px; background: var(--color-neutral-800); color: var(--color-neutral-200);">${esc(s.mark)}</span>
          <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.name)}</span>
          <span style="font-size: 11px; color: var(--color-neutral-600); font-variant-numeric: tabular-nums;">${s.count}</span>
        </button>`).join("")}
      </div>
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); padding: 0 var(--space-2);">Agents</div>
        ${d.agents.map(a => `<div style="display: flex; align-items: flex-start; gap: var(--space-3); padding: 0 var(--space-2);">
          <span style="width: 6px; height: 6px; margin-top: 6px; flex: none; border-radius: 50%; background: var(--color-accent); box-shadow: 0 0 8px 1px color-mix(in srgb, var(--color-accent) 50%, transparent);"></span>
          <div style="min-width: 0;"><div style="font-size: 12.5px;">${esc(a.name)}</div><div style="font-size: 11px; color: var(--color-neutral-600); line-height: 1.35;">${esc(a.status)}</div></div>
        </div>`).join("")}
      </div>
    </div>

    <div style="display: flex; flex-direction: column; min-height: 0;">
      <div style="padding: var(--space-8) var(--space-8) var(--space-4); display: flex; align-items: flex-end; gap: var(--space-6); flex-wrap: wrap; flex: none;">
        <div>
          <h2 style="font-size: 26px; margin: 0 0 var(--space-2); letter-spacing: -0.02em;">Triage</h2>
          <div style="font-size: 13px; color: var(--color-neutral-400);">${esc(d.headline)}</div>
        </div>
        <div class="seg" style="margin-left: auto;">
          ${FILTERS.map(f => `<label class="seg-opt"><input type="radio" name="unibox-filter" value="${f}" ${S.filter === f ? "checked" : ""} onchange="onFilter(event)">${f[0].toUpperCase() + f.slice(1)}</label>`).join("")}
        </div>
      </div>
      <div style="flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--space-8) var(--space-8); display: flex; flex-direction: column; gap: var(--space-3);">
        ${visible.map(it => `<div draggable="true" ondragstart="event.dataTransfer.setData('text/plain','${esc(it.id)}'); S.dragId='${esc(it.id)}'" ondragend="S.dragId=null" class="card elev-sm" style="gap: var(--space-3); padding: var(--space-4) var(--space-6); background: color-mix(in srgb, var(--color-surface) 85%, transparent); opacity: ${S.dragId === it.id ? 0.45 : 1}; cursor: grab;">
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            <span style="width: 20px; height: 20px; flex: none; border-radius: 5px; display: grid; place-items: center; font-size: 9.5px; background: var(--color-neutral-800); color: var(--color-neutral-200);">${esc(it.mark)}</span>
            <span style="font-size: 12.5px; color: var(--color-neutral-300);">${esc(it.srcName)}</span>
            <span style="font-size: 12.5px; color: var(--color-neutral-600);">${esc(it.handle)}</span>
            ${it.isNew ? `<span class="tag tag-accent" style="font-size: 9.5px; padding: 1px 7px;">new</span>` : ""}
            <span style="font-size: 11px; color: var(--color-neutral-600); margin-left: auto; font-variant-numeric: tabular-nums;">${esc(it.ago)}</span>
            <span class="tag tag-neutral" style="font-size: 10px; padding: 2px 8px;">${esc(it.lane)}</span>
          </div>
          <button onclick="openDetail('${esc(it.id)}')" style="border: 0; background: transparent; padding: 0; text-align: left; font: inherit; color: var(--color-text); cursor: pointer; font-family: var(--font-heading); font-weight: 500; font-size: 16.5px; line-height: 1.25; letter-spacing: -0.012em; text-wrap: pretty;" onmouseover="this.style.color='var(--color-accent-200)'" onmouseout="this.style.color='var(--color-text)'">${esc(it.title)}</button>
          <div style="font-size: 13px; line-height: 1.5; color: var(--color-neutral-400); max-width: 68ch; text-wrap: pretty;">${esc(it.why)}</div>
          <div style="display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap;">
            <span class="tag tag-outline" style="font-size: 10.5px; padding: 2px 9px;">${esc(it.srcName)}</span>
            <span style="font-size: 11.5px; color: var(--color-neutral-600);">${esc(it.agentLine)}</span>
            <div style="display: flex; gap: var(--space-2); margin-left: auto;">
              <button class="btn btn-ghost" onclick="openDetail('${esc(it.id)}')" style="font-size: 12px; color: var(--color-neutral-400);">Reasoning</button>
              <button class="btn btn-secondary" onclick="doDismiss('${esc(it.id)}')" style="font-size: 12.5px;">Dismiss</button>
              <button class="btn btn-primary" onclick="doSchedule('${esc(it.id)}')" style="font-size: 12.5px;">Schedule</button>
            </div>
          </div>
        </div>`).join("")}
        ${visible.length === 0 ? `<div style="padding: var(--space-8); text-align: center; border: 1px dashed var(--color-divider); border-radius: var(--radius-lg); color: var(--color-neutral-500); font-size: 13.5px;">Nothing here under this filter.</div>` : ""}
        <div style="font-size: 11.5px; color: var(--color-neutral-700); padding-top: var(--space-2);">Drag a card onto the calendar to place it yourself.</div>
      </div>
      ${S.undo ? `<div style="flex: none; margin: 0 var(--space-8) var(--space-6); padding: var(--space-3) var(--space-4); display: flex; align-items: center; gap: var(--space-4); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-md); animation: freshIn 180ms ease-out;">
        <span style="font-size: 12.5px; color: var(--color-neutral-300); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${S.undo.type === "schedule" ? "Scheduled · " : "Dismissed · "}${esc(S.undo.title || S.undo.id)}</span>
        <button class="btn btn-ghost" onclick="doUndo()" style="margin-left: auto; font-size: 12.5px;">Undo</button>
      </div>` : ""}
    </div>

    <div class="triage-plan" ondragover="event.preventDefault(); S.dropOver=true; this.style.background='color-mix(in srgb, var(--color-accent) 10%, transparent)'" ondragleave="S.dropOver=false; this.style.background='color-mix(in srgb, var(--color-neutral-900) 35%, transparent)'" ondrop="event.preventDefault(); S.dropOver=false; this.style.background='color-mix(in srgb, var(--color-neutral-900) 35%, transparent)'; { const id = event.dataTransfer.getData('text/plain') || S.dragId; if (id) doSchedule(id, '18:30'); }" style="border-left: 1px solid var(--color-divider); display: flex; flex-direction: column; min-height: 0; background: color-mix(in srgb, var(--color-neutral-900) 35%, transparent);">
      <div style="padding: var(--space-8) var(--space-6) var(--space-4); flex: none;">
        <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); margin-bottom: var(--space-2);">Planned</div>
        <div style="font-family: var(--font-heading); font-size: 17px; letter-spacing: -0.01em;">Today · ${new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
        <div style="font-size: 11.5px; color: var(--color-neutral-600); margin-top: var(--space-1);">${agentBar} agent-scheduled · ${d.agenda.length} blocks</div>
      </div>
      <div style="flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--space-6) var(--space-8); display: flex; flex-direction: column;">
        ${todayAgenda.map(agendaEntry).join("")}
        ${later.length > 0 ? `<div style="margin-top: var(--space-6); display: flex; flex-direction: column;">
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); margin-bottom: var(--space-2);">Later</div>
          ${later.map(agendaEntry).join("")}
        </div>` : ""}
        ${d.agenda.length === 0 ? `<div style="font-size: 12px; color: var(--color-neutral-600); padding: var(--space-4) 0;">Nothing planned. Drop tasks here from Triage.</div>` : ""}
      </div>
      <div style="flex: none; border-top: 1px solid var(--color-divider); padding: var(--space-4) var(--space-6); display: flex; align-items: center; gap: var(--space-4);">
        <span style="font-size: 11.5px; color: var(--color-neutral-600);">${d.dismissed} dismissed today · ${later.length} moved to later</span>
        <button class="btn btn-ghost" onclick="doResetDay()" style="margin-left: auto; font-size: 12px;">Reset day</button>
      </div>
    </div>

    ${detail ? `<div style="position: absolute; inset: 0; display: flex; justify-content: flex-end; background: color-mix(in srgb, var(--color-neutral-900) 45%, transparent);" onclick="closeDetail()">
      <div onclick="stop(event)" style="width: 420px; max-width: 92%; height: 100%; overflow-y: auto; background: var(--color-surface); box-shadow: var(--shadow-lg); padding: var(--space-8) var(--space-6); display: flex; flex-direction: column; gap: var(--space-6); animation: drawerIn 200ms ease-out;">
        <div style="display: flex; align-items: center; gap: var(--space-3);">
          <span style="width: 20px; height: 20px; flex: none; border-radius: 5px; display: grid; place-items: center; font-size: 9.5px; background: var(--color-neutral-800); color: var(--color-neutral-200);">${esc(detail.mark)}</span>
          <span style="font-size: 12.5px; color: var(--color-neutral-300);">${esc(detail.srcName)}</span>
          <span style="font-size: 12.5px; color: var(--color-neutral-600);">${esc(detail.handle)}</span>
          <button class="btn btn-ghost" onclick="closeDetail()" style="margin-left: auto; font-size: 12.5px;">Close</button>
        </div>
        <div>
          <h3 style="font-size: 20px; margin: 0 0 var(--space-3); letter-spacing: -0.018em; line-height: 1.2; text-wrap: pretty;">${esc(detail.title)}</h3>
          <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
            <span class="tag tag-outline" style="font-size: 10.5px; padding: 2px 9px;">${esc(detail.srcName)}</span>
            <span class="tag tag-neutral" style="font-size: 10.5px; padding: 2px 9px;">${esc(detail.lane)}</span>
          </div>
        </div>
        <div>
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); margin-bottom: var(--space-3);">Why it matters</div>
          <div style="font-size: 13.5px; line-height: 1.55; color: var(--color-neutral-300); text-wrap: pretty;">${esc(detail.why)}</div>
        </div>
        <div>
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); margin-bottom: var(--space-4);">Reasoning trail</div>
          <div style="display: flex; flex-direction: column;">
            <div style="display: flex; gap: var(--space-4); padding-bottom: var(--space-4);">
              <div style="display: flex; flex-direction: column; align-items: center; flex: none; width: 10px;">
                <span style="width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent); margin-top: 5px;"></span>
                <span style="flex: 1; width: 1px; background: var(--color-divider); margin-top: 4px;"></span>
              </div>
              <div style="min-width: 0;">
                <div style="font-size: 12px; color: var(--color-accent-300); margin-bottom: 3px;">Triage</div>
                <div style="font-size: 12.5px; line-height: 1.5; color: var(--color-neutral-300); text-wrap: pretty;">${esc(detail.agentLine)}</div>
              </div>
            </div>
          </div>
        </div>
        ${detail.raw.length > 0 ? `<div>
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); margin-bottom: var(--space-3);">Raw signals</div>
          <div style="border: 1px solid var(--color-divider); border-radius: var(--radius-md); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); background: color-mix(in srgb, var(--color-neutral-900) 55%, transparent);">
            ${detail.raw.map(r => `<div style="display: flex; gap: var(--space-4); font-size: 12.5px; line-height: 1.45;">
              <span style="color: var(--color-neutral-600); min-width: 52px; font-variant-numeric: tabular-nums;">${esc(r.t)}</span>
              <span style="color: var(--color-neutral-300); text-wrap: pretty;">${esc(r.text)}</span>
            </div>`).join("")}
          </div>
        </div>` : ""}
        <div style="display: flex; gap: var(--space-2); margin-top: auto; padding-top: var(--space-4);">
          <button class="btn btn-primary" onclick="doSchedule('${esc(detail.id)}'); closeDetail();" style="font-size: 13px;">Schedule</button>
          <button class="btn btn-secondary" onclick="doDismiss('${esc(detail.id)}'); closeDetail();" style="font-size: 13px;">Dismiss</button>
        </div>
      </div>
    </div>` : ""}
  </div>`;
}

function stateTag(state) {
  if (state === "live") return `<span class="tag tag-accent" style="flex: none; font-size: 10px; padding: 2px 8px;">live</span>`;
  if (state === "connected") return `<span class="tag tag-accent" style="flex: none; font-size: 10px; padding: 2px 8px;">live</span>`;
  if (state === "error") return `<span class="tag tag-outline" style="flex: none; font-size: 10px; padding: 2px 8px; color: var(--color-danger, #f08a8a);">error</span>`;
  if (state === "pairing" || state === "connecting") return `<span class="tag tag-outline" style="flex: none; font-size: 10px; padding: 2px 8px;">${state}…</span>`;
  return `<span class="tag tag-neutral" style="flex: none; font-size: 10px; padding: 2px 8px;">not connected</span>`;
}

function renderSessions() {
  const d = S.data;
  return `<div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-8) var(--space-8) 56px;">
    <div style="max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-8);">
      <div style="display: flex; align-items: flex-end; gap: var(--space-8); flex-wrap: wrap; padding-bottom: var(--space-4); border-bottom: 1px solid var(--color-divider);">
        <div>
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); margin-bottom: var(--space-3);">Sources &amp; sessions</div>
          <h2 style="font-size: 26px; margin: 0; letter-spacing: -0.02em;">What the agents are allowed to read</h2>
        </div>
        <div style="margin-left: auto; font-size: 12px; color: var(--color-neutral-500);">${esc(d.sourcesLine)}</div>
      </div>
      ${S.toast ? `<div style="padding: var(--space-3) var(--space-4); display: flex; align-items: center; gap: var(--space-4); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-md); animation: freshIn 180ms ease-out;">
        <span style="font-size: 12.5px; color: var(--color-neutral-300);">${esc(S.toast)}</span>
      </div>` : ""}
      <div style="display: flex; flex-direction: column;">
        ${d.connections.map(c => `<div class="conn-row" style="display: flex; align-items: center; gap: var(--space-6); padding: var(--space-4) var(--space-2); border-top: 1px solid var(--color-divider); opacity: ${c.state === "off" ? 0.5 : 1};">
          <span style="width: 30px; height: 30px; flex: none; border-radius: 7px; display: grid; place-items: center; font-size: 10.5px; background: var(--color-neutral-800); color: var(--color-neutral-200);">${esc(c.mark)}</span>
          <div style="width: 150px; flex: none; min-width: 0;">
            <div style="font-size: 13.5px;">${esc(c.name)}</div>
            <div style="font-size: 11px; color: var(--color-neutral-600); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(c.account)}</div>
          </div>
          <div class="conn-rule" style="flex: 1; min-width: 0; font-size: 12px; line-height: 1.45; color: var(--color-neutral-400); text-wrap: pretty;">${esc(c.rule)}</div>
          <div style="width: 110px; flex: none; font-size: 11.5px; color: var(--color-neutral-500); font-variant-numeric: tabular-nums;">${esc(c.flow)}</div>
          ${stateTag(c.state)}
          ${c.key === "whatsapp" ? (c.state === "connected"
            ? `<button class="btn btn-secondary" onclick="togglePair()" style="flex: none; font-size: 12px; width: 78px;">Disconnect</button>`
            : `<button class="btn btn-primary" onclick="togglePair()" style="flex: none; font-size: 12px; width: 96px;">Pair device</button>`) : ""}
          ${c.key === "linkedin" ? `<div style="display: flex; gap: var(--space-2); flex: none;">
            <a class="btn btn-secondary" href="https://www.linkedin.com/settings/data-export" target="_blank" rel="noreferrer" style="font-size: 12px;">Request export ↗</a>
            <label class="btn btn-primary" style="font-size: 12px; cursor: pointer; position: relative; overflow: hidden;">Upload CSV<input type="file" accept=".csv" onchange="uploadLinkedIn(this)" style="position: absolute; inset: 0; opacity: 0; cursor: pointer;"></label>
          </div>` : ""}
          ${c.key === "email" && !d.google?.configured ? `<span style="flex: none; font-size: 11.5px; color: var(--color-neutral-600); width: 78px; text-align: center;">managed by mailos</span>` : ""}
          ${(c.key === "email" || c.key === "calendar") && d.google?.configured ? (c.state === "google-off"
            ? `<a class="btn btn-primary" href="/auth/google" style="flex: none; font-size: 12px;">Sign in with Google</a>`
            : c.key === "email"
              ? `<div style="display: flex; gap: var(--space-2); flex: none;">
                  <button class="btn btn-secondary" onclick="googleSync(this)" style="font-size: 12px;">Sync now</button>
                  <button class="btn btn-secondary" onclick="googleDisconnect()" style="font-size: 12px;">Disconnect</button>
                </div>`
              : c.state === "error" ? `<a class="btn btn-primary" href="/auth/google" style="flex: none; font-size: 12px;">Sign in again</a>` : "") : ""}
        </div>`).join("")}
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-4);">
        <div class="card elev-sm" style="padding: var(--space-6); gap: var(--space-3);">
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-accent-300);">Digest window</div>
          <div style="font-family: var(--font-heading); font-size: 17px;">Digest at ${String(d.digestHour ?? 8).padStart(2, "0")}:00 via worker, or Re-digest on demand</div>
          <div style="font-size: 12.5px; line-height: 1.5; color: var(--color-neutral-500);">Morning notify-send carries the counts; the full brief lives on this page and in digests/.</div>
        </div>
        <div class="card elev-sm" style="padding: var(--space-6); gap: var(--space-3);">
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-accent-300);">Triage rule</div>
          <div style="font-family: var(--font-heading); font-size: 17px;">Rules beat the model, always</div>
          <div style="font-size: 12.5px; line-height: 1.5; color: var(--color-neutral-500);">Your last message means waiting-on-them without asking the LLM; automated senders are no-action on sight. The model only sees what rules can't decide.</div>
        </div>
        <div class="card elev-sm" style="padding: var(--space-6); gap: var(--space-3);">
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-accent-300);">Privacy rule</div>
          <div style="font-family: var(--font-heading); font-size: 17px;">Everything stays on this machine</div>
          <div style="font-size: 12.5px; line-height: 1.5; color: var(--color-neutral-500);">Message bodies live in local SQLite; only triage excerpts go to the LLM gateway; nothing is sent anywhere without your click.</div>
        </div>
      </div>
    </div>
  </div>`;
}

function dumpCard(i) {
  const url = i.url ? esc(i.url) : "";
  const title = esc(i.title);
  const body = esc((i.summary || i.transcript || "").slice(0, 220));
  const preview = i.kind === "image" && (i.thumb || i.media)
    ? `<img src="${esc(i.thumb || i.media)}" alt="" style="max-width: 190px; max-height: 120px; border-radius: var(--radius-sm); border: 1px solid var(--color-divider);">`
    : i.kind === "audio"
      ? `<audio controls preload="none" src="${esc(i.media)}" style="height: 30px;"></audio>`
      : i.kind === "video"
        ? `<video controls preload="metadata" src="${esc(i.media)}" style="max-width: 240px; border-radius: var(--radius-sm);"></video>`
        : "";
  const open = i.state === "done" || i.state === "dropped";
  return `<div class="card elev-sm" style="gap: var(--space-2); padding: var(--space-4) var(--space-5); background: color-mix(in srgb, var(--color-surface) 80%, transparent); opacity: ${open ? 0.55 : 1};">
    <div style="display: flex; align-items: center; gap: var(--space-3);">
      <span style="width: 20px; height: 20px; flex: none; border-radius: 5px; display: grid; place-items: center; font-size: 10px; background: var(--color-neutral-800); color: var(--color-neutral-200);">${esc(KIND_MARK[i.kind] || "•")}</span>
      <span class="tag tag-neutral" style="font-size: 10px; padding: 1px 7px;">${esc(ACTION_LABEL[i.action] || i.action)}</span>
      <span style="font-size: 11px; color: var(--color-neutral-600);">${esc(i.context || "")}${i.effortMin != null ? " · " + i.effortMin + "m" : ""}</span>
      ${i.pending ? `<span class="tag tag-outline" style="font-size: 9.5px; padding: 1px 7px;">processing…</span>` : ""}
      ${i.state === "done" ? `<span class="tag tag-accent" style="font-size: 9.5px; padding: 1px 7px;">done</span>` : ""}
      ${i.state === "dropped" ? `<span class="tag tag-neutral" style="font-size: 9.5px; padding: 1px 7px;">dropped</span>` : ""}
      <span style="margin-left: auto; font-size: 10.5px; color: var(--color-neutral-600); font-variant-numeric: tabular-nums;">${esc(i.ago)}</span>
    </div>
    <div style="display: flex; gap: var(--space-4); align-items: flex-start;">
      <div style="min-width: 0; flex: 1;">
        ${url ? `<a href="${url}" target="_blank" rel="noreferrer" style="font-family: var(--font-heading); font-weight: 500; font-size: 15px; line-height: 1.3; letter-spacing: -0.01em; text-wrap: pretty;">${title}</a>` : `<div style="font-family: var(--font-heading); font-weight: 500; font-size: 15px; line-height: 1.3; letter-spacing: -0.01em; text-wrap: pretty;">${title}</div>`}
        ${body ? `<div style="font-size: 12.5px; line-height: 1.5; color: var(--color-neutral-400); margin-top: 3px; text-wrap: pretty;">${body}</div>` : ""}
        ${i.tags.length ? `<div style="display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2);">${i.tags.map(t => `<span class="tag tag-outline" style="font-size: 9.5px; padding: 1px 7px;">${esc(t)}</span>`).join("")}</div>` : ""}
      </div>
      ${preview}
    </div>
    <div style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${open
        ? `<button class="btn btn-ghost" onclick="dumpItem('${esc(i.id)}', 'reopen')" style="font-size: 12px;">Reopen</button>`
        : `<button class="btn btn-secondary" onclick="dumpItem('${esc(i.id)}', 'done')" style="font-size: 12px;">Done</button>
           <button class="btn btn-ghost" onclick="dumpItem('${esc(i.id)}', 'snooze', 180)" style="font-size: 12px;">Snooze 3h</button>
           <button class="btn btn-ghost" onclick="dumpItem('${esc(i.id)}', 'drop')" style="font-size: 12px; color: var(--color-neutral-500);">Drop</button>`}
    </div>
  </div>`;
}

function groupChip(g) {
  const label = g.key === "quick" ? "Quick wins" : (ACTION_LABEL[g.key] || GROUP_LABEL_FALLBACK[g.key] || g.key);
  return `<div class="card elev-sm" style="padding: var(--space-3) var(--space-4); gap: 2px; min-width: 118px; background: ${g.key === "quick" ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "color-mix(in srgb, var(--color-surface) 80%, transparent)"};">
    <div style="font-family: var(--font-heading); font-size: 20px; letter-spacing: -0.02em;">${g.count}</div>
    <div style="font-size: 11px; color: var(--color-neutral-500);">${esc(label)}${g.minutes ? ` · ${g.minutes}m` : ""}</div>
  </div>`;
}
const GROUP_LABEL_FALLBACK = { quick: "Quick wins", do: "To do", read: "To read", watch: "To watch", listen: "To listen", reference: "Reference" };

function renderDump() {
  const d = S.data;
  const dp = d.dump;
  const n = dp.nudge;
  const q = S.query.trim().toLowerCase();
  const visible = dp.items.filter((i) => {
    if (!S.showDone && (i.state === "done" || i.state === "dropped")) return false;
    if (S.dumpFilter !== "all" && i.action !== S.dumpFilter) return false;
    const hay = (i.title + " " + i.summary + " " + i.transcript + " " + i.tags.join(" ") + " " + i.url).toLowerCase();
    return !q || hay.includes(q);
  });
  const later = n.groups.filter((g) => g.key !== "quick");
  const quick = n.groups.find((g) => g.key === "quick");
  const lastNudge = n.lastNudgeAt ? new Date(n.lastNudgeAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "never";
  return `<div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-8) var(--space-8) 56px;">
    <div style="max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">
      ${S.toast ? `<div style="padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-md); font-size: 12.5px; color: var(--color-neutral-300); animation: freshIn 180ms ease-out;">${esc(S.toast)}</div>` : ""}
      <div class="dump-head" style="display: flex; gap: var(--space-6); align-items: flex-start; flex-wrap: wrap;">
        <div style="flex: 1 1 560px; min-width: 320px; display: flex; flex-direction: column; gap: var(--space-3);">
          <div>
            <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600); margin-bottom: var(--space-2);">Dump · everything in one place</div>
            <h2 style="font-size: 26px; margin: 0 0 var(--space-3); letter-spacing: -0.02em;">Write it down, stop holding it</h2>
          </div>
          <div class="card elev-sm" style="padding: var(--space-5); gap: var(--space-3);">
            <textarea id="dump-text" oninput="S.draft=this.value" placeholder="Dump anything — a link, a thought, a task, a photo, a voice note. One thing per line." style="width: 100%; min-height: 96px; resize: vertical; background: color-mix(in srgb, var(--color-neutral-900) 55%, transparent); color: var(--color-text); border: 1px solid var(--color-divider); border-radius: var(--radius-md); padding: var(--space-4); font: inherit; font-size: 14px; line-height: 1.5;">${esc(S.draft)}</textarea>
            <div style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
              <label class="btn btn-secondary" style="font-size: 12.5px; cursor: pointer; position: relative; overflow: hidden;">Attach files<input type="file" multiple onchange="uploadDumpFiles(this)" style="position: absolute; inset: 0; opacity: 0; cursor: pointer;"></label>
              <button class="btn btn-secondary" onclick="toggleRecord()" style="font-size: 12.5px; ${S.recording ? "color: var(--color-accent-200);" : ""}">${S.recording ? "■ Stop recording" : "● Record voice"}</button>
              <span style="font-size: 11px; color: var(--color-neutral-600);">one line → one item</span>
              <button class="btn btn-primary" id="dump-btn" onclick="dumpSubmit()" style="margin-left: auto; font-size: 13px;">Dump it</button>
            </div>
          </div>
          <div style="font-size: 11.5px; color: var(--color-neutral-600);">${dp.counts.total} filed · ${dp.counts.pending} being processed · ${dp.counts.active} open${dp.selfChat && dp.selfChat.ready ? " · Message-yourself is connected" : ""}</div>
        </div>
        <div class="card elev-sm dump-avail" style="flex: 0 1 268px; min-width: 240px; padding: var(--space-5); gap: var(--space-3); background: color-mix(in srgb, var(--color-neutral-900) 35%, transparent);">
          <div style="font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-neutral-600);">When to be told</div>
          <div style="font-family: var(--font-heading); font-size: 19px; letter-spacing: -0.015em;">${n.available ? "Available" : "Focus mode"}</div>
          <div style="font-size: 12px; line-height: 1.5; color: var(--color-neutral-500);">${n.quiet ? "Quiet hours now — nudges wait." : "Nudges fire when something piles up."} Last nudge ${esc(lastNudge)}.</div>
          <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
            <button class="btn ${n.available ? "btn-secondary" : "btn-primary"}" onclick="toggleAvailable()" style="font-size: 12.5px;">${n.available ? "Focus" : "I'm free"}</button>
            <button class="btn btn-ghost" onclick="nudgeNow()" style="font-size: 12.5px;">Nudge me now</button>
          </div>
          <div style="display: flex; gap: var(--space-2); flex-wrap: wrap; border-top: 1px solid var(--color-divider); padding-top: var(--space-3);">
            ${installPrompt ? `<button class="btn btn-primary" onclick="installApp()" style="font-size: 12.5px;">Install app</button>` : ""}
            <button class="btn btn-secondary" onclick="enablePhoneAlerts()" style="font-size: 12.5px;">Phone alerts</button>
          </div>
          <div style="font-size: 11px; color: var(--color-neutral-600);">Install from Chrome's menu, then share links and photos straight here.</div>
        </div>
      </div>

      ${n.groups.length ? `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; gap: var(--space-3);">
          <span style="font-size: 12.5px;">One go</span>
          <span style="font-size: 11.5px; color: var(--color-neutral-600);">things that fit the same moment, grouped so you can clear them together</span>
        </div>
        <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
          ${quick && quick.count >= 2 ? `<div class="card elev-sm" style="padding: var(--space-3) var(--space-4); gap: 2px; background: color-mix(in srgb, var(--color-accent) 15%, transparent);"><div style="font-size: 12.5px; color: var(--color-accent-200);">${quick.count} quick wins together · ~${quick.minutes} min</div></div>` : ""}
          ${n.groups.map(groupChip).join("")}
        </div>
      </div>` : ""}

      <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding-top: var(--space-2); border-top: 1px solid var(--color-divider);">
        ${DUMP_ACTIONS.map(a => `<button onclick="setDumpFilter('${a}')" style="border: 0; background: ${S.dumpFilter === a ? "color-mix(in srgb, var(--color-accent) 16%, transparent)" : "transparent"}; color: ${S.dumpFilter === a ? "var(--color-accent-200)" : "var(--color-neutral-400)"}; font: inherit; font-size: 12.5px; padding: 4px var(--space-3); border-radius: var(--radius-sm); cursor: pointer;">${esc(a === "all" ? "All" : (ACTION_LABEL[a] || a))}${a !== "all" && dp.byAction[a] ? ` ${dp.byAction[a]}` : ""}</button>`).join("")}
        <button class="btn btn-ghost" onclick="toggleDone()" style="margin-left: auto; font-size: 12px;">${S.showDone ? "Hide" : "Show"} done</button>
      </div>
      <div class="dump-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--space-4); align-items: start;">
        ${visible.map(dumpCard).join("")}
        ${visible.length === 0 ? `<div style="padding: var(--space-8); text-align: center; border: 1px dashed var(--color-divider); border-radius: var(--radius-lg); color: var(--color-neutral-500); font-size: 13.5px; grid-column: 1 / -1;">Nothing here. Dump something above, or drop a file into <b>inbound/notes/</b>.</div>` : ""}
      </div>
    </div>
  </div>`;
}

function renderPairDialog() {
  return `<div class="dialog-backdrop" onclick="closePair()">
    <div class="dialog" onclick="stop(event)">
      <div class="dialog-title">Link WhatsApp</div>
      <div class="dialog-body">On your phone: WhatsApp → Settings → Linked devices → Link a device, then point it at this code.</div>
      <img id="pair-qr" alt="WhatsApp QR" style="display: none; align-self: center; width: 260px; height: 260px; border-radius: var(--radius-md); background: #ffffff; padding: 10px;">
      <div id="pair-msg" style="font-size: 12.5px; color: var(--color-neutral-500);">Requesting QR from WhatsApp…</div>
      <div class="dialog-actions">
        <button class="btn btn-secondary" onclick="closePair()">Close</button>
      </div>
    </div>
  </div>`;
}

function render() {
  const root = document.getElementById("app");
  if (!S.data) { root.innerHTML = "<div style='padding: var(--space-8); color: var(--color-neutral-500);'>Loading…</div>"; return; }
  const body = S.screen === "brief" ? renderBrief() : S.screen === "triage" ? renderTriage() : S.screen === "dump" ? renderDump() : renderSessions();
  root.innerHTML = renderNav() + body + (S.pairOpen ? renderPairDialog() : "");
  if (S.pairOpen && !pairTimer) pairTimer = setInterval(pairPoll, 2000);
}
