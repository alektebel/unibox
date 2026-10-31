// Phone UI — the "Unibox Android" design: Hoy · Memoria · Metas · Calendario, plus Nueva meta.
// Loaded after app.js; takes over render() at phone width and reuses S, api(), refresh(), esc().

const mStored = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
function mKeepDraft(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} }
const M = {
  tab: "hoy", sheet: false, draft: mStored("unibox_draft"), openGoal: null, showIgnored: false, hideAnticipo: false,
  chat: [], chatBusy: false, plan: null, chatDraft: mStored("unibox_goal_draft"), recording: false,
  apps: null, appQuery: "", panel: 0, drawer: false
};
if (window.UniboxNative && !window.Capacitor) window.Capacitor = { triggerEvent() {} };
// Inside the Android app Unibox is the home screen: it also lists your apps and enforces the policy.
const M_NATIVE = !!(window.UniboxNative && window.UniboxNative.listApps);
const M_TABS = [
  { key: "hoy", name: "Hoy", icon: `<span style="font-size:15px;line-height:1">✦</span>` },
  { key: "memoria", name: "Memoria", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 13h5l1 3h6l1-3h5"/></svg>` },
  { key: "metas", name: "Metas", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>` },
  { key: "calendario", name: "Calendario", icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>` }
];
const M_ICONS = {
  task: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2M3 12h18"/></svg>`,
  reply: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/></svg>`,
  clock: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  book: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/></svg>`
};

function mobileUI() {
  const pref = (() => { try { return localStorage.getItem("unibox_ui"); } catch { return null; } })();
  if (pref === "classic") return false;
  return pref === "mobile" || window.matchMedia("(max-width: 820px)").matches;
}

function setUI(v) {
  try { localStorage.setItem("unibox_ui", v); } catch {}
  render();
}

const classicRender = render;
render = function () {
  const mobile = mobileUI();
  document.body.classList.toggle("m", mobile);
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.content = mobile ? "#F4F3EE" : "#161826";
  if (!mobile) {
    classicRender();
    if (window.matchMedia("(max-width: 820px)").matches) {
      document.getElementById("app").insertAdjacentHTML("beforeend", `<button class="m-classic" onclick="setUI('mobile')">Vista nueva</button>`);
    }
    return;
  }
  const root = document.getElementById("app");
  // only a fresh answer says which build the server runs (the cached one may be older)
  if (S.data?.mobile?.build && !S.fromCache) {
    if (M.build && M.build !== S.data.mobile.build) reloadWhenAway();
    M.build = S.data.mobile.build;
  }
  if (!S.data || !S.data.mobile) { root.innerHTML = `<div class="m-screen"><div class="m-body"><div class="m-kicker">Cargando…</div></div></div>`; return; }
  const keep = captureFocus();
  if (M.sheet && keep && keep.id === "m-draft" && !M.renderNow) return;
  if (M.tab === "chat" && document.getElementById("m-ai-chat") && !M.chatForce) return;
  // writing the journal: a refresh never redraws the page under your fingers
  if (M.tab === "diario" && document.getElementById("m-journal") && !M.chatForce) return;
  M.chatForce = false;
  M.renderNow = false;
  if (M_NATIVE && M.tab === "hoy") {
    // a finger on the screen or a swipe still settling: redraw once it's over, or the
    // swipe would be cut off and snap back
    // (a move asked for from code, like back or a button, goes ahead)
    if ((mTouching() || mScrolling || (!M.smooth && Date.now() - mTouchEndAt < 500)) && document.getElementById("l-pager")) { mDefer(); return; }
    mPendingRender = false;
    if (!mPatchLauncher(root)) {
      const pos = mSavePager();
      root.innerHTML = mLauncher();
      mRestorePager(pos);
    }
    restoreFocus(keep);
    mTick();
    mSyncReminders();
    mSyncPolicy();
    mBars(S.data.mobile.policy?.active?.kind === "night" && !M.sheet);
    return;
  }
  root.innerHTML = M.tab === "nueva" ? mNueva() : M.tab === "chat" ? mChat() : M.tab === "diario" ? mDiario() : M.tab === "sueno" ? mSueno() : M.tab === "pantalla" ? mPantalla() : `<div class="m-screen">
      ${M_NATIVE ? `<div class="m-topbar"><button onclick="mGo('hoy')" aria-label="Volver">←</button><span>${esc((M_TABS.find(t => t.key === M.tab) || {}).name || "")}</span></div>` : ""}
      <main class="m-body" id="m-body">${M.tab === "hoy" ? mHoy() : M.tab === "memoria" ? mMemoria() : M.tab === "metas" ? mMetas() : M.tab === "apps" ? mApps() : mCalendario()}</main>
      ${M.tab === "hoy" ? `<button class="m-capture" onclick="mOpenSheet()"><b>+</b>Cuéntame algo o pide un recordatorio…</button>` : ""}
      ${M_NATIVE ? "" : mNav()}
    </div>`;
  root.insertAdjacentHTML("beforeend", (M.sheet ? mSheet() : "") + (S.toast ? `<div class="m-toast" role="status">${esc(S.toast)}</div>` : ""));
  mBars(false);
  restoreFocus(keep);
  mTick();
  mSyncReminders();
  mSyncPolicy();
};

// In the Android app, a link that leaves Unibox opens in the browser instead of replacing the app.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || !window.UniboxNative?.openExternal) return;
  const url = new URL(a.getAttribute("href"), location.href);
  const leaves = url.origin !== location.origin || url.pathname.startsWith("/auth/google");
  if (!leaves) return;
  e.preventDefault();
  window.UniboxNative.openExternal(url.href);
});

// Inside the Android app, hand the week's reminders to the phone (it skips unchanged sets).
function mSyncReminders() {
  const list = S.data?.mobile?.reminders;
  if (!list || !window.UniboxNative?.scheduleReminders) return;
  try { window.UniboxNative.scheduleReminders(JSON.stringify(list)); } catch {}
}

// status and navigation bars follow the screen: dark at night, the page colour by day
let mBarsNight = null;
function mBars(night) {
  if (!window.UniboxNative?.setBars || mBarsNight === night) return;
  mBarsNight = night;
  try { window.UniboxNative.setBars(night ? "#161B17" : "#F4F3EE", !night); } catch {}
}

function mSyncPolicy() {
  const p = S.data?.mobile?.policy;
  if (!p || !window.UniboxNative?.setPolicy) return;
  const { active, ...rest } = p;
  try { window.UniboxNative.setPolicy(JSON.stringify(rest)); } catch {}
}

// --- Home screen (Android) ------------------------------------------------

function mLoadApps() {
  try { M.apps = JSON.parse(window.UniboxNative.listApps()).sort((a, b) => a.label.localeCompare(b.label, "es")); }
  catch { M.apps = []; }
}

// last night's sleep, estimated on the phone (nothing leaves it); shown on the home screen until the afternoon
function mLoadSleep() {
  try {
    const j = window.UniboxNative.sleepLast();
    M.sleep = j ? JSON.parse(j) : null;
  } catch { M.sleep = null; }
  mSaveSleep();
}
// the night goes to the server once (the stats read it back); the phone keeps nothing else of it
async function mSaveSleep() {
  const z = M.sleep;
  if (!z) return;
  let done = "";
  try { done = localStorage.getItem("unibox_sleep_sent") || ""; } catch {}
  if (done === String(z.end)) return;
  try {
    await api("/api/sleep", { start: z.start, end: z.end });
    try { localStorage.setItem("unibox_sleep_sent", String(z.end)); } catch {}
    refresh();
  } catch {}
}
const mDur = (min) => `${Math.floor(min / 60)} h${min % 60 ? ` ${String(min % 60).padStart(2, "0")} min` : ""}`;

function mSueno() {
  const z = S.data.mobile.sleep || { nights: [] };
  const day = (d) => new Date(d + "T12:00:00").toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
  const nights = [...z.nights].reverse().slice(-14);
  const bars = nights.map(n => `<div class="m-sbar" title="${esc(day(n.date))}"><div class="m-sbar-fill${n.minutes >= 420 ? " ok" : ""}" style="height:${Math.min(100, Math.round(n.minutes / 6))}%"></div>
      <span>${new Date(n.date + "T12:00:00").toLocaleDateString("es-ES", { weekday: "narrow" })}</span></div>`).join("");
  return `<div class="m-screen">
      <div class="m-topbar"><button onclick="mGo('hoy')" aria-label="Volver">←</button><span>Sueño</span></div>
      <main class="m-body">
        ${nights.length ? `<div class="m-sstats">
            <div><b>${z.avg7 != null ? mDur(z.avg7) : "–"}</b><span>media 7 días</span></div>
            <div><b>${z.avg30 != null ? mDur(z.avg30) : "–"}</b><span>media 30 días</span></div>
          </div>
          <div class="m-sbars">${bars}</div>
          <div class="m-sline">Barra completa = 10 h · en verde, 7 h o más</div>
          <div class="l-sec">NOCHES</div>
          ${z.nights.slice(0, 14).map(n => `<div class="m-row"><span>${esc(day(n.date))}</span><span>${mDur(n.minutes)} · ${mHHMM(n.start)}–${mHHMM(n.end)}</span></div>`).join("")}
          <p class="m-sline">Es una estimación: del último uso del móvil por la noche a la alarma o al primer uso por la mañana.</p>`
        : `<div class="m-empty">Aún no hay noches guardadas. Por la mañana aparece la primera.</div>`}
      </main>
    </div>`;
}

// screen time: today's total against a daily limit, from the phone's own usage records
function mLoadScreen() {
  try {
    const j = window.UniboxNative.screenToday();
    M.screen = j ? JSON.parse(j) : null;
  } catch { M.screen = null; }
}
function mScreenLimit(delta) {
  if (!M.screen) return;
  const next = Math.max(30, Math.min(720, M.screen.limit + delta));
  try { window.UniboxNative.setScreenLimit(next); } catch {}
  M.screen.limit = next;
  render();
}
window.mScreenLimit = mScreenLimit;

function mPantalla() {
  mLoadScreen();
  const z = M.screen;
  if (!z) return `<div class="m-screen"><div class="m-topbar"><button onclick="mGo('hoy')" aria-label="Volver">←</button><span>Pantalla</span></div>
    <main class="m-body"><div class="m-empty">Sin datos de uso todavía.</div></main></div>`;
  const over = z.total > z.limit;
  const max = Math.max(z.limit, ...z.days.map(d => d.min), 1);
  const bars = z.days.map(d => `<div class="m-sbar"><div class="m-sbar-fill${d.min <= z.limit ? " ok" : ""}" style="height:${Math.round(d.min / max * 100)}%"></div>
      <span>${new Date(d.date).toLocaleDateString("es-ES", { weekday: "narrow" })}</span></div>`).join("");
  const week = Math.round(z.days.reduce((a, d) => a + d.min, 0) / z.days.length);
  return `<div class="m-screen">
      <div class="m-topbar"><button onclick="mGo('hoy')" aria-label="Volver">←</button><span>Pantalla</span></div>
      <main class="m-body">
        <div class="m-sstats">
          <div><b${over ? ' style="color:#B5483A"' : ""}>${mDur(z.total)}</b><span>hoy · límite ${mDur(z.limit)}</span></div>
          <div><b>${mDur(week)}</b><span>media 7 días</span></div>
        </div>
        <div class="m-sbars">${bars}</div>
        <div class="m-sline">En verde, los días dentro del límite</div>
        <div class="l-sec">LÍMITE DIARIO</div>
        <div class="m-row"><span>${mDur(z.limit)}</span><span><button onclick="mScreenLimit(-30)">− 30 min</button> <button onclick="mScreenLimit(30)">+ 30 min</button></span></div>
        <p class="m-sline">Te aviso al 75 %, al llegar y cada hora de más. También cuando llevas minutos haciendo scroll sin parar.</p>
        <div class="l-sec">HOY, POR APP</div>
        ${z.apps.map(a => `<div class="m-row"><span>${esc(a.label)}</span><span>${mDur(a.min)}</span></div>`).join("") || `<div class="m-empty">Nada aún.</div>`}
      </main>
    </div>`;
}

function mScreenLine() {
  const z = M.screen;
  if (!z) return "";
  return `<button class="l-sleep" onclick="mGo('pantalla')"${z.total > z.limit ? ' style="color:#B5483A"' : ""}>Pantalla ${mDur(z.total)} de ${mDur(z.limit)}</button>`;
}

function mSleepLine() {
  const z = M.sleep;
  if (!z || new Date().getHours() >= 15 || Date.now() - z.end > 14 * 3600_000) return "";
  const h = Math.floor(z.minutes / 60), m = z.minutes % 60;
  return `<button class="l-sleep" onclick="mGo('sueno')">Dormiste unas ${h} h${m ? ` ${m} min` : ""} · ${mHHMM(z.start)}–${mHHMM(z.end)}</button>`;
}

function mLaunch(pkg) {
  // a long press just asked to uninstall: the finger lifting isn't also a tap
  if (Date.now() - (M.longAt || 0) < 900) return;
  try { window.UniboxNative.launchApp(pkg); } catch {}
}

// holding an app in the drawer or its search results offers to uninstall it (Android asks to confirm)
let mHold = null;
document.addEventListener("touchstart", (e) => {
  clearTimeout(mHold);
  const b = e.target.closest?.(".m-app[data-pkg]");
  if (!b || !M_NATIVE) return;
  const pkg = b.dataset.pkg;
  mHold = setTimeout(() => {
    M.longAt = Date.now();
    try { navigator.vibrate?.(30); } catch {}
    try { window.UniboxNative.uninstallApp(pkg); } catch {}
  }, 550);
}, { capture: true, passive: true });
for (const t of ["touchend", "touchcancel", "touchmove"]) document.addEventListener(t, () => clearTimeout(mHold), { capture: true, passive: true });

function mApps() {
  if (!M.apps) mLoadApps();
  const q = M.appQuery.trim().toLowerCase();
  const list = M.apps.filter(a => !q || a.label.toLowerCase().includes(q));
  const active = S.data.mobile.policy?.active;
  return `<div class="m-head"><div class="m-titleblock"><div class="m-kicker">${M.apps.length} APPS</div><h1 class="m-h1">Apps</h1></div></div>
    ${active ? `<div class="m-coverage" style="margin:0 0 12px">${esc(mWindowLine(active))} Las demás piden una espera y un motivo.</div>` : ""}
    <input id="m-app-q" class="m-app-q" placeholder="Buscar" autocomplete="off" value="${esc(M.appQuery)}"
      oninput="M.appQuery = this.value; render()" onkeydown="if (event.key === 'Enter') { const a = document.querySelector('.m-app'); if (a) a.click(); }">
    <div class="m-applist">${list.map(a => `<button class="m-app${a.blocked ? " off" : ""}" data-pkg="${esc(a.pkg)}" onclick="mLaunch('${esc(a.pkg)}')">
        <span>${esc(a.label)}</span>${a.blocked ? `<span class="m-app-tag">espera</span>` : ""}</button>`).join("") || `<div class="m-empty">Ninguna app se llama así.</div>`}</div>`;
}

const M_KIND = { focus: "BLOQUE DE FOCO", session: "SESIÓN", plan: "HUECO", work: "HORARIO DE TRABAJO", night: "A DORMIR" };

function mHHMM(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function mWindowLine(w) {
  return w.kind === "work" ? `Horario de trabajo hasta las ${mHHMM(w.end)}: sin feeds ni navegador.`
    : w.kind === "night" ? `Modo noche hasta las ${mHHMM(w.end)}.`
    : `${w.title}, hasta las ${mHHMM(w.end)}.`;
}

// What the phone is for right now, and the apps that go with it.
function mWindow(w, tomorrow = "") {
  if (!M_NATIVE) return "";
  if (!M.apps) mLoadApps();
  const allowed = w.mode === "allow" ? M.apps.filter(a => w.list.includes(a.pkg)) : [];
  const head = w.kind === "night" ? "Mañana sigue." : w.kind === "work" ? "Horario de trabajo." : w.title;
  const sub = w.kind === "night" ? `Hasta las ${mHHMM(w.end)}, solo lo esencial.`
    : w.kind === "work" ? `Hasta las ${mHHMM(w.end)}: sin juegos, feeds ni navegador.`
    : `Hasta las ${mHHMM(w.end)}. Lo demás puede esperar.`;
  return `<section class="m-card m-card-pad m-window m-window-${esc(w.kind)}">
      <div class="m-now-label"><span class="m-now-dot"></span>${M_KIND[w.kind] || "AHORA"}</div>
      <div class="m-now-text"><span class="t">${esc(head)}</span><span class="s">${esc(sub)}</span></div>
      ${allowed.length ? `<div class="m-chips">${allowed.map(a => `<button class="m-chip" onclick="mLaunch('${esc(a.pkg)}')">${esc(a.label)}</button>`).join("")}</div>` : ""}
      ${tomorrow ? `<div class="m-tomorrow">Lo primero mañana: <b>${esc(tomorrow)}</b></div>` : ""}
    </section>`;
}

function mBlockerOff() {
  if (!M_NATIVE || !window.UniboxNative.blockerOn || window.UniboxNative.blockerOn()) return "";
  return `<section class="m-card m-card-pad">
      <div class="m-now-text"><span class="t">El bloqueo está apagado</span>
      <span class="s">Sin él, Unibox no puede frenar las apps que no tocan. Actívalo en Accesibilidad → Bloqueo de Unibox.</span></div>
      <button class="m-btn m-btn-primary" onclick="UniboxNative.openBlockerSettings()">Activar</button>
    </section>`;
}

// Android: a fresh "apps you use at this hour" ranking is ready
window.mAppsChanged = function () {
  if (!M_NATIVE || M.tab !== "hoy") return;
  // an open drawer keeps its own list: refresh it with the new apps, keeping what you typed
  if (M.drawer && document.getElementById("m-app-q")) { M.searchStack = []; mLoadApps(); mDrawerInput(document.getElementById("m-app-q")); return; }
  render();
};

// Android: the home button and back while Unibox is the home screen.
window.mHomePressed = function () {
  M.sheet = false;
  M.drawer = false;
  M.appQuery = "";
  M.panel = 0;
  mGo("hoy");
  refresh();
};
window.mBackPressed = function () {
  if (M.sheet) { M.sheet = false; render(); return; }
  // the panel you're on, not the last one the scroll handler had time to record
  const pager = document.getElementById("l-pager");
  if (pager) M.panel = Math.round(pager.scrollLeft / pager.clientWidth);
  if (M.drawer) { M.drawer = false; M.appQuery = ""; render(); return; }
  if (M.tab !== "hoy") { mGo("hoy"); return; }  // includes the conversation
  if (M.panel !== 0) mShowPanel(0);
};

// --- Launcher: home › Guardado, apps one swipe up ------------------

// The launcher's parts, each drawn on its own: a refresh only touches what changed, so
// nothing flashes, scroll positions stay, and the drawer and sheet don't replay their animation.
function mLauncherParts() {
  return {
    "l-p1": mHomePanel(),
    "l-p2": mPendiente(),
    "l-drawer-slot": M.drawer ? mDrawer() : "",
    "l-sheet-slot": M.sheet ? mSheet() : "",
    "l-toast-slot": S.toast ? `<div class="m-toast" role="status">${esc(S.toast)}</div>` : "",
  };
}
// with the app drawer open, the panels behind it stay put (a sideways swipe while searching moved them)
const mRootClass = () => `l-root${S.data.mobile.policy?.active?.kind === "night" ? " l-night" : ""}${M.drawer ? " l-drawer-open" : ""}`;
let mDrawn = {};

function mLauncher() {
  const p = mDrawn = mLauncherParts();
  return `<div class="${mRootClass()}" id="l-root">
      <div class="l-pager" id="l-pager" onscroll="mPagerScrolled(this)">
        <section class="l-panel l-home" id="l-p1" aria-label="Inicio" ontouchstart="mSwipeStart(event)" ontouchend="mSwipeEnd(event)">${p["l-p1"]}</section>
        <section class="l-panel" id="l-p2" aria-label="Pendiente">${p["l-p2"]}</section>
      </div>
      <div class="l-slot-wrap" id="l-drawer-slot">${p["l-drawer-slot"]}</div>
    </div>
    <div class="l-slot-wrap" id="l-sheet-slot">${p["l-sheet-slot"]}</div>
    <div class="l-slot-wrap" id="l-toast-slot">${p["l-toast-slot"]}</div>`;
}

/** Update the launcher in place; false if it isn't on screen yet (draw it whole). */
function mPatchLauncher(root) {
  const lroot = document.getElementById("l-root");
  if (!lroot || !root.contains(lroot)) return false;
  const next = mLauncherParts();
  const cls = mRootClass();
  if (lroot.className !== cls) lroot.className = cls;
  for (const [id, html] of Object.entries(next)) {
    if (mDrawn[id] === html) continue;
    // the drawer's list follows your typing on its own (mDrawerInput): leave an open drawer be
    if (id === "l-drawer-slot" && html && mDrawn[id] && document.getElementById("m-app-q")) continue;
    // nor an open sheet: what you're typing lives in its text box (M.draft follows it)
    if (id === "l-sheet-slot" && html && mDrawn[id] && document.getElementById("m-draft") && !M.renderNow) continue;
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
  mDrawn = { ...mDrawn, ...next };
  const pager = document.getElementById("l-pager");
  const want = M.panel * pager.clientWidth;
  if (!mScrolling && (M.smooth || Date.now() - mTouchEndAt > 500) && Math.abs(pager.scrollLeft - want) > 2) pager.scrollTo({ left: want, behavior: M.smooth ? "smooth" : "auto" });
  M.smooth = false;
  return true;
}

function mSavePager() {
  const pos = {};
  for (const id of ["l-p1", "l-p2", "l-drawer-list"]) {
    const el = document.getElementById(id);
    if (el) pos[id] = el.scrollTop;
  }
  return pos;
}
function mRestorePager(pos) {
  const pager = document.getElementById("l-pager");
  if (pager) pager.scrollLeft = M.panel * pager.clientWidth;
  for (const [id, top] of Object.entries(pos)) {
    const el = document.getElementById(id);
    if (el) el.scrollTop = top;
  }
}
let mPagerTimer = null;
let mScrolling = false, mPendingRender = false, mTouchAt = 0, mRetry = null;
// a finger counts as down for at most 1.5 s, so a lost touchend can never freeze the screen
const mTouching = () => mTouchAt > 0 && Date.now() - mTouchAt < 1500;
/** Go to a panel from code (back, buttons): wins over a swipe that's still settling. */
function mShowPanel(n) {
  clearTimeout(mPagerTimer);
  mScrolling = false;
  M.panel = n;
  M.smooth = true;
  render();
}
function mDefer() {
  mPendingRender = true;
  clearTimeout(mRetry);
  mRetry = setTimeout(() => { if (mPendingRender) render(); }, 400);
}
function mPagerScrolled(el) {
  mScrolling = true;
  clearTimeout(mPagerTimer);
  mPagerTimer = setTimeout(() => {
    M.panel = Math.round(el.scrollLeft / el.clientWidth);
    mScrolling = false;
    if (mPendingRender) render();
  }, 150);
}
let mTouchX = 0;
document.addEventListener("touchstart", (e) => { mTouchAt = Date.now(); mTouchX = e.touches[0]?.clientX ?? 0; }, { capture: true, passive: true });
// a finger that just swiped sideways: the swipe's own scrolling hasn't begun yet, so nothing may
// move the pager for a moment (a tap doesn't count: what it opens shows at once)
let mTouchEndAt = 0;
const mTouchEnd = (e) => {
  mTouchAt = 0;
  const x = e?.changedTouches?.[0]?.clientX;
  if (x != null && Math.abs(x - mTouchX) > 15) mTouchEndAt = Date.now();
};
document.addEventListener("touchend", mTouchEnd, { capture: true, passive: true });
document.addEventListener("touchcancel", mTouchEnd, { capture: true, passive: true });

let mSwipe = null;
function mSwipeStart(e) {
  const t = e.touches[0];
  mSwipe = { x: t.clientX, y: t.clientY };
}
function mSwipeEnd(e) {
  if (!mSwipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - mSwipe.x, dy = t.clientY - mSwipe.y;
  mSwipe = null;
  if (dy < -70 && Math.abs(dx) < 60) mOpenDrawer();
}
function mOpenDrawer() {
  M.drawer = true;
  M.appQuery = "";
  mLoadApps();
  render();
  setTimeout(() => document.getElementById("m-app-q")?.focus(), 60);
}

/** Apps for this moment: what the block is for first, then what you usually open at this hour. */
function mMomentApps(w) {
  if (!M.apps) mLoadApps();
  const out = [];
  let learned = [];
  try { learned = JSON.parse(window.UniboxNative.suggestApps(8)); } catch {}
  // messages waiting first (the native side already put them at the top)
  for (const a of learned) if (a.unread > 0) out.push(a);
  if (w && w.mode === "allow" && w.kind !== "work") {
    for (const a of M.apps) if (w.list.includes(a.pkg) && !a.quiet && !out.some(o => o.pkg === a.pkg)) out.push(a);
  }
  for (const a of learned) if (!out.some(o => o.pkg === a.pkg)) out.push(a);
  return out.slice(0, 6);
}

function mHomePanel() {
  const m = S.data.mobile;
  const w = m.policy?.active;
  let focus = "";
  if (m.block) {
    focus = `<div class="l-k">EN BLOQUE</div>
      <div class="l-t">${esc(m.block.title)}</div>
      <div class="l-s"><span class="m-timer l-timer" id="m-timer" data-start="${m.block.startedAt}" data-planned="${m.block.plannedMin}">00:00</span> de ${m.block.plannedMin} min</div>
      <div class="l-acts"><button onclick="mBlockDone()">Hecho</button><button onclick="mStopBlock(false)">Parar</button></div>`;
  } else if (m.plan && m.plan.now) {
    const p = m.plan.now;
    // a suggestion for the gap you have, not an order: start it, or say "otra cosa"
    focus = `<div class="l-k">TIENES HUECO HASTA LAS ${mHHMM(p.end)}</div>
      <div class="l-t">${esc(p.title)}</div>
      ${p.why ? `<div class="l-s">${esc(p.why)}</div>` : ""}
      <div class="l-acts">${p.url ? `<button onclick="mOpenSlot(${p.id})">Abrir</button>` : ""}<button onclick="mStartSlot(${p.id})">Empezar</button><button onclick="mAskAbout(S.data.mobile.plan.now)">Hecho</button><button onclick="mSlotMove(${p.id})">Otra cosa</button><button onclick="mSwipeClose(S.data.mobile.plan.now, 'archived')">Descartar</button></div>`;
  } else if (w && (w.kind === "session" || w.kind === "focus")) {
    focus = `<div class="l-k">AHORA TOCA</div>
      <div class="l-t">${esc(w.title)}</div>
      <div class="l-s">hasta las ${mHHMM(w.end)}</div>
      <div class="l-acts"><button onclick="mStartWindow()">Empezar bloque</button></div>`;
  } else if (w && w.kind === "night") {
    focus = `<div class="l-k">A DORMIR</div>
      <div class="l-t">Mañana sigue.</div>
      <div class="l-s">hasta las ${mHHMM(w.end)}${m.plan?.tomorrowFirst ? ` · mañana a las ${mHHMM(m.plan.tomorrowFirst.start)}: ${esc(m.plan.tomorrowFirst.title)}` : m.now ? ` · lo primero: ${esc(m.now.title)}` : ""}</div>`;
  } else if (m.now) {
    focus = `<div class="l-k">${w && w.kind === "work" ? `TRABAJO · HASTA LAS ${mHHMM(w.end)}` : "AHORA"}</div>
      <div class="l-t">${esc(m.now.title)}</div>
      <div class="l-s">${esc(m.now.meta || "")}</div>
      <div class="l-acts"><button onclick="mStartBlock()">Empezar</button><button onclick="mAskAbout({ ref: S.data.mobile.now.id })">Hecho</button><button onclick="mSkip()">Luego</button></div>`;
  }
  const nextUp = !m.block && !(m.plan && m.plan.now) && m.plan && m.plan.next
    ? `<button class="l-next" onclick="mShowPanel(1)">Luego, a las ${mHHMM(m.plan.next.start)}: ${esc(m.plan.next.title)}</button>` : "";
  const apps = mMomentApps(w);
  const off = M_NATIVE && window.UniboxNative.blockerOn && !window.UniboxNative.blockerOn();
  return `<div class="l-top">
      <button class="l-clock" id="l-clock" onclick="UniboxNative.openClock()" aria-label="Abrir el reloj">${mHHMM(Date.now())}</button>
      <div class="l-date">${esc(m.dateShort)}</div>
      ${mSleepLine()}${mScreenLine()}
    </div>
    ${off ? `<button class="l-warn" onclick="UniboxNative.openBlockerSettings()">El bloqueo está apagado · Activar</button>` : ""}
    ${m.presence?.question ? `<div class="l-where"><span>¿Estás en el curro ahora? <span class="l-where-net">${esc(m.presence.question.ssid)}</span></span>
      <div class="l-acts"><button onclick="mWhere('work')">Sí</button><button onclick="mWhere('home')">En casa</button><button onclick="mWhere('other')">Otro sitio</button></div></div>` : ""}
    ${M.undo ? `<div class="l-undo"><span>${M.undo.as === "done" ? "Hecho" : "Quitado"}: ${esc(M.undo.title.slice(0, 50))}</span><button onclick="mUndo()">Deshacer</button></div>` : ""}
    <div class="l-focus">${focus}${nextUp}</div>
    <nav class="l-apps" aria-label="Apps para ahora">${apps.map(a => `<button onclick="mLaunch('${esc(a.pkg)}')">${esc(a.label)}${a.unread > 0 ? `<span class="l-unread">${a.unread}</span>` : ""}</button>`).join("")}</nav>
    <div class="l-bottom">
      <button class="l-capture" onclick="mOpenSheet()">Cuéntame algo…</button>
      <div class="l-hints"><button onclick="mOpenDrawer()">Apps</button><button onclick="mShowPanel(1)">Guardado ›</button></div>
    </div>`;
}

// a block on a planned thing ends with the AI asking for your summary
async function mBlockDone() {
  const b = S.data.mobile.block;
  const slot = b && (S.data.mobile.plan?.slots || []).find(x => x.ref === b.ref && x.status !== "done");
  await mStopBlock(!slot);
  if (slot) mAskAbout(slot);
}

async function mWhere(label) {
  const q = S.data.mobile.presence?.question;
  if (!q) return;
  await api("/api/presence", { net: q.net, label });
  toast(label === "work" ? "Apuntado: aquí trabajas." : "Apuntado.");
  await refresh();
}

async function mStartWindow() {
  const w = S.data.mobile.policy?.active;
  if (!w) return;
  await api("/api/focus/start", { ref: w.key, title: w.title, minutes: Math.max(10, Math.round((w.end - Date.now()) / 60000)) });
  await refresh();
}

async function mStartOn(id) {
  const b = S.data.mobile.backlog || { fresh: [], list: [] };
  const t = [...b.fresh, ...b.list].find(x => x.id === id);
  if (!t) return;
  await api("/api/focus/start", { ref: t.id, title: t.title, minutes: Math.max(25, t.minutes || 25) });
  M.panel = 0;
  await refresh();
}

function mCheck(btn, kind, id) {
  btn.closest(".l-todo")?.classList.add("done");
  setTimeout(() => mDone(kind, id), 250);
}

function mTodoRow(t) {
  return `<div class="l-todo${t.expired ? " late" : ""}">
      <button class="l-check" onclick="mCheck(this,'${esc(t.kind)}','${esc(t.id)}')" aria-label="Marcar hecho"></button>
      <div class="l-todo-text"><span class="t">${esc(t.title)}</span><span class="s">${esc(t.meta)}</span></div>
      <button class="l-play" onclick="mStartOn('${esc(t.id)}')" aria-label="Empezar un bloque">▶</button>
    </div>`;
}

const M_SLOT_MARK = { done: "✓", now: "●", next: "○", missed: "·" };

function mPendiente() {
  const m = S.data.mobile;
  const plan = m.plan || { top: [], ask: [] };
  const top = plan.top || [];
  const pend = m.assistant?.pending || [];
  const head = m.tasksPaused ? "Tareas en pausa" : top.length ? "Lo que tienes guardado" : "Nada guardado";
  const when = (x) => x.status === "now" ? `hueco ahora · hasta las ${mHHMM(x.end)}` : x.status === "fixed" ? `a las ${mHHMM(x.start)}` : x.status === "next" ? `hueco a las ${mHHMM(x.start)}` : "cuando tengas un hueco";
  return `<div class="m-titleblock"><div class="m-kicker">GUARDADO · DESLIZA UNA FILA PARA QUITARLA</div><h1 class="m-h1">${esc(head)}</h1></div>
    ${M.undo ? `<div class="l-undo"><span>${M.undo.as === "done" ? "Hecho" : "Quitado"}: ${esc(M.undo.title.slice(0, 50))}</span><button onclick="mUndo()">Deshacer</button></div>` : ""}
    ${top.map((x, i) => {
      const row = `<div class="l-slot ${x.status}"${x.kind !== "commitment" ? ` data-swipe="${i}"` : ""}>
        <div class="l-todo-text"><span class="l-when">${esc(when(x))}</span><span class="t">${esc(x.title)}</span>${x.why && x.status !== "spare" ? `<span class="s">${esc(x.why)}</span>` : ""}</div>
        ${x.kind === "commitment" ? "" : `<button class="l-close-btn" onclick="mAskAbout(S.data.mobile.plan.top[${i}])">Contar</button>`}
        ${x.kind !== "commitment" ? `<button class="l-play" onclick="mStartTop(${i})" aria-label="Empezar un bloque">▶</button>` : ""}
      </div>`;
      // swiping the row left uncovers Hecho and Archivar underneath
      return x.kind === "commitment" ? row : `<div class="l-swipe-wrap"><div class="l-swipe-acts">
          <button class="done" onclick="mSwipeClose(S.data.mobile.plan.top[${i}], 'done')">Hecho</button>
          <button class="arch" onclick="mSwipeClose(S.data.mobile.plan.top[${i}], 'archived')">Archivar</button></div>${row}</div>`;
    }).join("")}
    ${!top.length ? `<button class="l-add" onclick="mShowPanel(0); setTimeout(mOpenSheet, 350)">+ Añadir algo que hacer</button>` : ""}
    ${(plan.upcoming || []).length ? `<div class="l-sec">ESTA SEMANA</div>
      ${plan.upcoming.map(u => `<div class="l-week"><span class="l-when">${esc(u.when)}</span><span class="t">${esc(u.title)}</span></div>`).join("")}` : ""}
    ${(plan.ask || []).length ? `<div class="l-sec">¿SIGUE IMPORTANDO?</div>
      ${plan.ask.map(a => `<div class="l-ask"><span class="t">${esc(a.title)}</span><span class="s">Se te ha pasado dos veces.</span>
        <div class="l-acts"><button onclick="mAsk('${esc(a.ref)}', true)">Sí, sigue</button><button onclick="mAsk('${esc(a.ref)}', false)">No, quítala</button></div></div>`).join("")}` : ""}
    <div class="l-links"><button onclick="mPauseTasks(${m.tasksPaused ? "false" : "true"})">${m.tasksPaused ? "Retomar tareas" : "Pausar tareas"}</button><button onclick="mOpenChat()">Hablar con Unibox</button><button onclick="mGo('metas')">Metas y diario</button><button onclick="mGo('sueno')">Sueño</button><button onclick="mGo('pantalla')">Pantalla</button><button onclick="mGo('calendario')">Conexiones</button>${m.archived ? `<button onclick="mRestore()">Quitadas (${m.archived})</button>` : ""}</div>`;
}

// --- Swiping a row in Hoy left: Hecho or Archivar (with a moment to undo) -----------

let mRow = null;
const M_REVEAL = 176;
function mCloseRows(except) {
  for (const r of document.querySelectorAll("[data-swipe].open")) if (r !== except) { r.classList.remove("open"); r.style.transform = ""; }
}
document.addEventListener("touchstart", (e) => {
  const row = e.target.closest && e.target.closest("[data-swipe]");
  if (!row) { if (!(e.target.closest && e.target.closest(".l-swipe-acts"))) mCloseRows(); mRow = null; return; }
  if (e.target.closest("button")) { mRow = null; return; }
  const t = e.touches[0];
  mRow = { row, x: t.clientX, y: t.clientY, dx: 0, on: false, base: row.classList.contains("open") ? -M_REVEAL : 0 };
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (!mRow) return;
  const t = e.touches[0];
  const dx = t.clientX - mRow.x, dy = t.clientY - mRow.y;
  // only leftward (or closing an open row): rightward is how you go back to the home screen
  if (!mRow.on && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5 && (dx < 0 || mRow.base < 0)) mRow.on = true;
  if (!mRow.on) return;
  mRow.dx = dx;
  const x = Math.min(0, Math.max(-M_REVEAL - 40, mRow.base + dx));
  mRow.row.style.transition = "none";
  mRow.row.style.transform = `translateX(${x}px)`;
}, { passive: true });
document.addEventListener("touchend", () => {
  if (!mRow) return;
  const { row, dx, on, base } = mRow;
  mRow = null;
  if (!on) return;
  row.style.transition = "transform .18s ease-out";
  const open = base + dx < -M_REVEAL / 2;
  mCloseRows(row);
  row.classList.toggle("open", open);
  row.style.transform = open ? `translateX(${-M_REVEAL}px)` : "";
}, { passive: true });

async function mSwipeClose(x, as) {
  try {
    if (as === "done" && x.id) await api("/api/plan/done", { id: x.id });
    else await api("/api/plan/close", { ref: x.ref, as });
  } catch {}
  M.undo = { ref: x.ref, title: x.title, as };
  clearTimeout(M.undoTimer);
  M.undoTimer = setTimeout(() => { M.undo = null; render(); }, 6000);
  await refresh();
  render();
}
async function mPauseTasks(paused) {
  await api("/api/plan/pause", { paused });
  toast(paused ? "Tareas en pausa." : "Tareas de vuelta.");
  await refresh();
}
async function mUndo() {
  const u = M.undo;
  if (!u) return;
  M.undo = null;
  clearTimeout(M.undoTimer);
  try { await api("/api/plan/reopen", { ref: u.ref }); } catch {}
  await refresh();
}
window.mUndo = mUndo;

// --- The conversation with the AI ----------------------------------------------

async function mOpenChat() {
  M.tab = "chat";
  M.drawer = false;
  M.sheet = false;
  M.aiDraft ??= mStored("unibox_ai_draft");
  mRenderChat();
  try {
    const r = await api("/api/assistant");
    if (r.ok) M.ai = r;
  } catch {}
  mRenderChat();
  mScrollAi();
}
window.mOpenChat = mOpenChat;

/** A notification was tapped (the native side holds which screen it wants). */
window.mOpenFromNative = function () {
  let v = "";
  try { v = window.UniboxNative?.takeOpen ? window.UniboxNative.takeOpen() : ""; } catch {}
  if (v === "chat") mOpenChat();
  if (v === "diario") mOpenJournal();
  if (v === "pantalla") { mLoadScreen(); mGo("pantalla"); }
};

/** Tapping something: the AI asks about it in the conversation. */
async function mAskAbout(x) {
  if (!x) return;
  try {
    const r = await api("/api/assistant/about", x.id ? { slotId: x.id } : { ref: x.ref });
    if (r.ok) M.ai = { ...(M.ai || {}), messages: r.messages };
  } catch {}
  await mOpenChat();
  document.getElementById("m-ai-input")?.focus();
}

/** Redraw the conversation (background refreshes don't: they'd lose your place). */
function mRenderChat() {
  M.chatForce = true;
  render();
}

function mScrollAi() {
  const c = document.getElementById("m-ai-chat");
  if (c) c.scrollTop = c.scrollHeight;
}

function mChat() {
  const msgs = M.ai?.messages || [];
  const bubbles = msgs.map(t => `<div class="m-bub ${t.role === "user" ? "me" : "ai"}">${esc(t.content)}</div>`);
  if (!msgs.length) bubbles.push(`<div class="m-bub ai">Aquí te iré preguntando cómo va cada cosa cuando acabe su hora, y por la noche repasamos el día. Puedes contarme varias cosas en un mensaje.</div>`);
  if (M.aiBusy) bubbles.push(`<div class="m-bub ai typing">Pensando…</div>`);
  return `<div class="m-screen">
      <div class="m-topbar"><button onclick="mGo('hoy')" aria-label="Volver">←</button><span>Unibox</span></div>
      <div class="m-chat" id="m-ai-chat"><div class="spacer"></div>${bubbles.join("")}</div>
      <form class="m-composer" onsubmit="event.preventDefault(); mAiSend()">
        <textarea id="m-ai-input" rows="1" placeholder="Cuéntame cómo ha ido…" oninput="M.aiDraft = this.value; mKeepDraft('unibox_ai_draft', this.value)" ${M.aiBusy ? "disabled" : ""}>${esc(M.aiDraft || "")}</textarea>
        <button class="m-send" type="submit" aria-label="Enviar" ${M.aiBusy ? "disabled" : ""}>→</button>
      </form>
    </div>`;
}

async function mAiSend() {
  const text = (document.getElementById("m-ai-input")?.value || "").trim();
  if (!text || M.aiBusy) return;
  M.ai = { ...(M.ai || {}), messages: [...(M.ai?.messages || []), { role: "user", content: text, at: Date.now() }] };
  M.aiDraft = "";
  mKeepDraft("unibox_ai_draft", "");
  M.aiBusy = true;
  mRenderChat();
  mScrollAi();
  try {
    const r = await api("/api/assistant", { text });
    if (r.ok) M.ai = { ...M.ai, messages: r.messages };
  } catch {
    M.ai.messages.push({ role: "assistant", content: "No he podido contestar ahora; tu mensaje está guardado.", at: Date.now() });
  }
  M.aiBusy = false;
  mRenderChat();
  mScrollAi();
  refresh();
}

function mOpenUrl(url) { window.UniboxNative?.openExternal ? UniboxNative.openExternal(url) : window.open(url, "_blank"); }
const mSlot = (id) => (S.data.mobile.plan?.slots || []).find(x => x.id === id);
function mOpenSlot(id) {
  const x = mSlot(id);
  if (x?.url) window.UniboxNative?.openExternal ? UniboxNative.openExternal(x.url) : window.open(x.url, "_blank");
}
async function mStartSlot(id) {
  const x = mSlot(id);
  if (!x) return;
  await api("/api/focus/start", { ref: x.ref, title: x.title, minutes: Math.max(10, Math.round((x.end - Math.max(Date.now(), x.start)) / 60000)) });
  M.panel = 0;
  await refresh();
  if (x.url) mOpenSlot(id);
}
/** ▶ on one of the five: a planned slot runs to its end; something spare gets its own length. */
async function mStartTop(i) {
  const x = (S.data.mobile.plan?.top || [])[i];
  if (!x) return;
  if (x.id) return mStartSlot(x.id);
  await api("/api/focus/start", { ref: x.ref, title: x.title, minutes: 45 });
  M.panel = 0;
  await refresh();
  if (x.url) window.UniboxNative?.openExternal ? UniboxNative.openExternal(x.url) : window.open(x.url, "_blank");
}
async function mSlotDone(id) {
  await api("/api/plan/done", { id });
  toast("Hecho.");
  await refresh();
}
function mSlotCheck(btn, id) {
  btn.classList.add("on");
  btn.closest(".l-slot")?.classList.add("done");
  setTimeout(() => mSlotDone(id), 250);
}
async function mSlotMove(id) {
  await api("/api/plan/move", { id });
  toast("Vale. Rehago el resto del día.");
  setTimeout(refresh, 6000);
  await refresh();
}
async function mReplan() {
  await api("/api/plan/replan", {});
  toast("Replanificando…");
  setTimeout(refresh, 8000);
  await refresh();
}
async function mAsk(ref, keep) {
  await api("/api/plan/ask", { ref, keep });
  toast(keep ? "Vuelve al plan." : "Quitada.");
  await refresh();
}

/** Every app, searchable, grouped by initial, like a folder launcher. */
const mNorm = (t) => t.normalize("NFD").replace(/[^\p{L}\p{N} ]/gu, "").toLowerCase();

function mDrawerRows(list, q) {
  let letter = "";
  return list.map(a => {
    const c = a.key.charAt(0).toUpperCase();
    const l = /\p{L}/u.test(c) ? c : "#";
    const head = !q && l !== letter ? `<div class="l-letter">${esc((letter = l))}</div>` : "";
    return `${head}<button class="m-app${a.blocked ? " off" : ""}" data-pkg="${esc(a.pkg)}" onclick="mLaunch('${esc(a.pkg)}')"><span>${esc(a.label)}</span>${a.blocked ? `<span class="m-app-tag">espera</span>` : ""}</button>`;
  }).join("") || `<div class="m-empty">Ninguna app se llama así.</div>`;
}

function mSortedApps() {
  const apps = M.apps || [];
  if (M.appsSortedFrom !== apps) {
    for (const a of apps) a.key = mNorm(a.label);
    M.appsSorted = [...apps].sort((x, y) => x.key.localeCompare(y.key, "es"));
    M.appsSortedFrom = apps;
    M.searchStack = [];
  }
  return M.appsSorted;
}

/**
 * Typing narrows the last result instead of searching everything again: each prefix's
 * matches are kept on a stack, so another letter filters only the previous matches and
 * deleting goes back to a result already computed.
 */
function mSearch(q) {
  const all = mSortedApps();
  const needle = mNorm(q.trim());
  if (!needle) { M.searchStack = []; return all; }
  const stack = (M.searchStack ||= []);
  while (stack.length && !needle.startsWith(stack[stack.length - 1].q)) stack.pop();
  const top = stack[stack.length - 1];
  if (top && top.q === needle) return top.list;
  const list = (top ? top.list : all).filter(a => a.key.includes(needle));
  stack.push({ q: needle, list });
  return list;
}

function mDrawerInput(el) {
  M.appQuery = el.value;
  const list = document.getElementById("l-drawer-list");
  if (list) list.innerHTML = mDrawerRows(mSearch(M.appQuery), M.appQuery.trim());
}

function mDrawer() {
  return `<div class="l-drawer" role="dialog" aria-label="Todas las apps">
      <div class="l-drawer-top">
        <input id="m-app-q" class="m-app-q" placeholder="Buscar app" autocomplete="off" value="${esc(M.appQuery)}"
          oninput="mDrawerInput(this)" onkeydown="if (event.key === 'Enter') { const a = document.querySelector('.l-drawer .m-app'); if (a) a.click(); }">
        <button class="l-close" onclick="M.drawer = false; render()" aria-label="Cerrar">✕</button>
      </div>
      <div class="l-drawer-list" id="l-drawer-list">${mDrawerRows(mSearch(M.appQuery), M.appQuery.trim())}</div>
    </div>`;
}

if (M_NATIVE) { mLoadSleep(); mLoadScreen(); setInterval(() => { if (M.tab === "hoy" && !document.hidden) { mLoadScreen(); } }, 120000); }
// opened from a notification while the app was closed
setTimeout(() => window.mOpenFromNative && window.mOpenFromNative(), 1200);

// the home clock
setInterval(() => {
  const c = document.getElementById("l-clock");
  if (c) c.textContent = mHHMM(Date.now());
}, 15000);

// coming back to the home screen: show what's true now, not 30 s ago
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // blocked/unread marks change while you're away: re-read them after this frame
  setTimeout(() => { if (M.apps) mLoadApps(); mLoadSleep(); mLoadScreen(); refresh(); }, 0);
});

// innerHTML re-renders (30 s polling) must not eat what you're typing.
function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.id || !/^m-/.test(el.id)) return null;
  return { id: el.id, start: el.selectionStart, end: el.selectionEnd };
}
function restoreFocus(k) {
  if (!k) return;
  const el = document.getElementById(k.id);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(k.start, k.end); } catch {}
}

function mGo(tab) {
  if (M.tab === "diario" && tab !== "diario") mJournalSave();
  if (M_NATIVE && tab === "hoy") {
    M.panel = 0;
    M.drawer = false;
    tab = "hoy";
    clearTimeout(mPagerTimer);
    mScrolling = false;
  }
  M.tab = tab;
  M.openGoal = null;
  render();
  const b = document.getElementById("m-body");
  if (b) b.scrollTop = 0;
}

function mNav() {
  return `<nav class="m-nav" aria-label="Secciones">${M_TABS.map(t => `<button class="${M.tab === t.key ? "on" : ""}" onclick="mGo('${t.key}')" aria-current="${M.tab === t.key ? "page" : "false"}">
      <span class="pill">${t.icon}</span><span class="lbl">${t.name}</span></button>`).join("")}</nav>`;
}

function mRing(score) {
  const C = 2 * Math.PI * 22;
  const dash = score == null ? `0 ${C}` : `${(score / 100) * C} ${C}`;
  return `<div class="m-ring" title="Lo que llevas resuelto hoy, según lo que marcas"><svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r="22" fill="none" stroke="#E2E1DA" stroke-width="3"/>
      <circle cx="26" cy="26" r="22" fill="none" stroke="#3F6B4C" stroke-width="3" stroke-linecap="round" stroke-dasharray="${dash}" transform="rotate(-90 26 26)"/></svg>
      <span>${score == null ? "–" : score}</span></div>`;
}

// --- Hoy ---------------------------------------------------------------

function mHoy() {
  const m = S.data.mobile;
  // night: only sleep and what comes first tomorrow
  if (m.policy?.active?.kind === "night") {
    return `<div class="m-head">
      <div class="m-titleblock"><div class="m-kicker">${esc(m.dateShort)}</div><h1 class="m-h1">${esc(m.greeting)}</h1></div>
    </div>
    ${mBlockerOff()}
    ${mWindow(m.policy.active, m.now ? m.now.title : "")}`;
  }
  return `<div class="m-head">
      <div class="m-titleblock"><div class="m-kicker">${esc(m.dateShort)}</div><h1 class="m-h1">${esc(m.greeting)}</h1></div>
      ${mRing(m.score)}
    </div>
    ${mBlockerOff()}
    ${m.policy?.active && !m.block ? mWindow(m.policy.active) : ""}
    ${m.block ? mBlock(m.block) : m.now ? mNow(m.now) : `<div class="m-card m-card-pad"><div class="m-now-label"><span class="m-now-dot"></span>AHORA</div>
      <div class="m-now-text"><span class="t">Nada pendiente.</span><span class="s">Lo que guardes o te llegue aparecerá aquí.</span></div></div>`}
    ${m.expired && m.expired.length && !m.block ? mExpired(m.expired) : ""}
    <section class="m-card m-card-pad">
      <div class="m-section-head"><span class="t">Tu día, hasta ahora</span><button class="l" onclick="mGo('calendario')">Ver todo →</button></div>
      ${m.timeline.length ? m.timeline.map(t => `<div class="m-row">
          <span class="m-time">${esc(t.time)}</span>
          <span class="m-swatch" style="background:${t.tint}"><i style="background:${t.color}"></i></span>
          <div class="m-row-text"><span class="t">${esc(t.title)}</span><span class="s">${esc(t.meta)}</span></div>
        </div>`).join("") : `<div class="m-empty">Aún nada. Lo que completes hoy aparecerá aquí.</div>`}
      ${m.coverage ? `<div class="m-coverage">${esc(m.coverage.note)}${m.coverage.sources.some(s => !s.on) ? ` <button class="m-link" onclick="mGo('calendario'); setTimeout(() => document.getElementById('m-fuentes')?.scrollIntoView(), 50)">Conectar →</button>` : ""}</div>` : ""}
    </section>`;
}

// A passed date isn't a next step: ask whether it still stands.
function mExpired(list) {
  return `<section class="m-card m-card-pad m-expired">
      <div class="m-section-head"><span class="t">¿Sigue en pie?</span><span class="m-when">${list.length === 1 ? "su fecha ya pasó" : "sus fechas ya pasaron"}</span></div>
      ${list.map(e => `<div class="m-exp-row">
          <div class="m-row-text"><span class="t">${esc(e.title)}</span><span class="s">${esc(e.due)}</span></div>
          <div class="m-exp-btns">
            <button class="m-btn m-btn-ghost m-btn-sm" onclick="mDone('${esc(e.kind)}','${esc(e.id)}')">Ya está</button>
            <button class="m-btn m-btn-ghost m-btn-sm" onclick="mKeep('${esc(e.id)}')">Sigue</button>
            <button class="m-btn m-btn-ghost m-btn-sm" onclick="mDrop('${esc(e.kind)}','${esc(e.id)}')">Descartar</button>
          </div>
        </div>`).join("")}
    </section>`;
}
async function mKeep(id) {
  await api("/api/now/keep", { id });
  toast("Vale, sigue en tu lista.");
  await refresh();
}
async function mDrop(kind, id) {
  if (kind === "item") await api("/api/item", { type: "drop", id });
  else await api("/api/action", { type: "dismiss", id });
  toast("Descartado.");
  await refresh();
}

function mNow(n) {
  const title = n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noreferrer" style="color:inherit">${esc(n.title)}</a>` : esc(n.title);
  return `<section class="m-card">
      <div class="m-card-pad">
        <div class="m-now-label"><span class="m-now-dot"></span>AHORA</div>
        <div class="m-now-row">
          <div class="m-icon-box">${M_ICONS[n.icon] || M_ICONS.task}</div>
          <div class="m-now-text"><span class="k">Tu siguiente paso</span><span class="t">${title}</span><span class="s">${esc(n.meta)}</span></div>
        </div>
        <div class="m-btns">
          <button class="m-btn m-btn-primary" onclick="mStartBlock()">Empezar bloque</button>
          <button class="m-btn m-btn-ghost" onclick="mSkip()">Ahora no</button>
        </div>
      </div>
      <div class="m-card-foot">✦ ${esc(n.why)}</div>
    </section>`;
}

function mBlock(b) {
  return `<section class="m-card">
      <div class="m-card-pad">
        <div class="m-now-label"><span class="m-now-dot"></span>BLOQUE EN CURSO</div>
        <div class="m-now-text"><span class="t">${esc(b.title)}</span><span class="s">Plan: ${b.plannedMin} min · lo demás puede esperar</span></div>
        <div class="m-timer" id="m-timer" data-start="${b.startedAt}" data-planned="${b.plannedMin}">00:00</div>
        <div class="m-btns">
          <button class="m-btn m-btn-primary" onclick="mStopBlock(true)">Hecho</button>
          <button class="m-btn m-btn-ghost" onclick="mStopBlock(false)">Parar</button>
        </div>
      </div>
    </section>`;
}

let mTimer = null;
function mTick() {
  if (mTimer) { clearInterval(mTimer); mTimer = null; }
  const el = document.getElementById("m-timer");
  if (!el) return;
  const paint = () => {
    const s = Math.max(0, Math.floor((Date.now() - Number(el.dataset.start)) / 1000));
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  paint();
  mTimer = setInterval(paint, 1000);
}

async function mStartBlock() {
  const n = S.data.mobile.now;
  if (!n) return;
  await api("/api/focus/start", { ref: n.id, title: n.title, minutes: Math.max(25, n.minutes || 45) });
  await refresh();
}
async function mStopBlock(done) {
  await api("/api/focus/stop", { done });
  toast(done ? "Hecho. Bien." : "Bloque parado. Queda anotado.");
  await refresh();
}
async function mSkip() {
  const n = S.data.mobile.now;
  if (!n) return;
  await api("/api/now/skip", { id: n.id, hours: 3 });
  toast("Vale, te lo vuelvo a proponer en 3 horas.");
  await refresh();
}

// --- capture sheet -------------------------------------------------------

function mOpenSheet() { M.sheet = true; render(); setTimeout(() => document.getElementById("m-draft")?.focus(), 50); }
function mCloseSheet() { M.sheet = false; render(); }
function mSheet() {
  return `<div class="m-scrim" onclick="mCloseSheet()"></div>
    <div class="m-sheet" role="dialog" aria-label="Guardar algo">
      <div class="m-kicker">GUÁRDALO AQUÍ</div>
      <textarea id="m-draft" placeholder="Un enlace, una idea, un recordatorio… una cosa por línea. También puedes pegar capturas." oninput="M.draft = this.value; mKeepDraft('unibox_draft', this.value)">${esc(M.draft)}</textarea>
      <div class="tools">
        <label class="m-btn m-btn-ghost m-btn-sm m-file">Foto o archivo<input type="file" accept="image/*,video/*,audio/*,application/pdf" multiple onchange="mUpload(this)"></label>
        <button class="m-btn m-btn-ghost m-btn-sm ${M.recording ? "m-rec" : ""}" onclick="mRecord()">${M.recording ? "● Parar" : "Voz"}</button>
        <button class="m-btn m-btn-primary m-btn-sm" onclick="mSubmit()">Guardar</button>
      </div>
    </div>`;
}
async function mSubmit() {
  const text = (document.getElementById("m-draft")?.value ?? M.draft).trim();
  if (!text) { mCloseSheet(); return; }
  const res = await api("/api/capture", { text });
  M.draft = "";
  mKeepDraft("unibox_draft", "");
  M.sheet = false;
  toast(res.added ? `Guardado${res.added > 1 ? ` (${res.added})` : ""}. Lo ordeno en unos segundos.` : "Ya lo tenías guardado.");
  await refresh();
  // classification lands a few seconds later
  setTimeout(refresh, 8000);
}
async function mUpload(input) {
  const files = [...(input.files || [])];
  if (!files.length) return;
  toast(`Subiendo ${files.length === 1 ? "1 archivo" : files.length + " archivos"}…`);
  for (const f of files) {
    await fetch("/api/capture/file?name=" + encodeURIComponent(f.name), {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: await f.arrayBuffer()
    });
  }
  M.sheet = false;
  toast("Guardado. Lo miro y lo ordeno.");
  await refresh();
  setTimeout(refresh, 15000);
}
let mRecorder = null;
async function mRecord() {
  if (M.recording) { mRecorder && mRecorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast("El micrófono necesita HTTPS en esta dirección."); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    mRecorder = new MediaRecorder(stream);
    mRecorder.ondataavailable = (e) => chunks.push(e.data);
    mRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      M.recording = false;
      M.sheet = false;
      const blob = new Blob(chunks, { type: mRecorder.mimeType || "audio/webm" });
      await fetch(`/api/capture/file?name=voz-${Date.now()}.webm`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: blob });
      toast("Nota de voz guardada. La transcribo.");
      await refresh();
      setTimeout(refresh, 15000);
    };
    mRecorder.start();
    M.recording = true;
    render();
  } catch {
    toast("No tengo acceso al micrófono.");
  }
}

// --- Memoria -------------------------------------------------------------

function mMemoria() {
  const d = S.data.mobile.memoria;
  return `<div class="m-titleblock"><div class="m-kicker">${esc(d.since)}</div><h1 class="m-h1">${esc(d.headline)}</h1><div class="m-sub">${esc(d.sub)}</div></div>
    ${d.worth.map(w => `<article class="m-dcard">
        <div class="m-tagrow"><span class="m-tag" style="background:${w.tint};color:${w.color}">${esc(w.source)}</span><span class="m-when">${esc(w.when)}</span></div>
        <div class="t">${esc(w.title)}</div>
        <div class="w">${esc(w.why)}</div>
        <div class="m-dactions">
          ${w.url ? `<a class="a" href="${esc(w.url)}" target="_blank" rel="noreferrer">${esc(w.action)}</a>` : `<button class="a" onclick="mFocusOn('${esc(w.id)}')">${esc(w.action)}</button>`}
          <button class="b" onclick="mDone('${esc(w.kind)}','${esc(w.id)}')">Hecho</button>
          <button class="b" onclick="mLater('${esc(w.kind)}','${esc(w.id)}')">Más tarde</button>
        </div>
      </article>`).join("")}
    ${d.saved && d.saved.items.length ? `<div class="m-kicker m-saved-k">VALE LA PENA VOLVER A ESTO · ${d.saved.total} GUARDADAS</div>
      ${d.saved.items.map(w => `<article class="m-dcard">
        <div class="m-tagrow"><span class="m-tag" style="background:${w.tint};color:${w.color}">${esc(w.source)}</span><span class="m-when">${esc(w.when)}</span></div>
        <div class="t">${esc(w.title)}</div>
        <div class="w">${esc(w.why)}</div>
        <div class="m-dactions">
          ${w.url ? `<a class="a" href="${esc(w.url)}" target="_blank" rel="noreferrer">${esc(w.action)}</a>` : ""}
          <button class="b" onclick="mDone('item','${esc(w.id)}')">Hecho</button>
          <button class="b" onclick="mDrop('item','${esc(w.id)}')">Ya no</button>
        </div>
      </article>`).join("")}` : ""}
    ${d.ignored.count ? `<button class="m-ignored" onclick="M.showIgnored = !M.showIgnored; render()" aria-expanded="${M.showIgnored}">
        <span style="display:flex;flex-direction:column;gap:2px"><span class="t">${d.ignored.count} ${d.ignored.count === 1 ? "ignorado" : "ignorados"}</span><span class="s">${esc(d.ignored.breakdown)}</span></span>
        <span class="r">${M.showIgnored ? "Cerrar" : "Revisar"}</span>
      </button>
      ${M.showIgnored ? `<div>${d.ignored.items.map(i => `<div class="m-ign-row">
          <div class="m-row-text"><span class="t">${esc(i.title)}</span><span class="s">${esc(i.source)} · ${esc(i.when)} · ${esc(i.reason)}</span></div>
          <button class="m-btn m-btn-ghost m-btn-sm" onclick="mRescue('${esc(i.id)}')">Rescatar</button>
        </div>`).join("")}</div>` : ""}` : ""}`;
}

// No link to open: the action means "do it now", so start a focus block on it.
async function mFocusOn(id) {
  const w = S.data.mobile.memoria.worth.find(x => x.id === id);
  if (!w) return;
  await api("/api/focus/start", { ref: w.id, title: w.title, minutes: 25 });
  M.tab = "hoy";
  await refresh();
}

async function mDone(kind, id) {
  if (kind === "item") await api("/api/item", { type: "done", id });
  else await api("/api/action", { type: "dismiss", id });
  toast("Hecho.");
  await refresh();
}
async function mLater(kind, id) {
  if (kind === "item") await api("/api/item", { type: "snooze", id, minutes: 240 });
  else await api("/api/now/skip", { id, hours: 4 });
  toast("Te lo recuerdo más tarde.");
  await refresh();
}
async function mRescue(id) {
  await api("/api/action", { type: "rescue", id });
  toast("Rescatado: ahora está en tu lista.");
  await refresh();
}

// --- Metas ---------------------------------------------------------------

function mProjection(p) {
  const max = Math.max(p.atTarget ?? 0, p.atRate, 1);
  const y = (h) => Math.round(110 - (h / max) * 92);
  const y0 = y(p.total);
  return `<svg viewBox="0 0 320 120" width="100%" height="120" role="img" aria-label="Proyección de horas de foco a 3 años">
      <path d="M0 110 L320 110" stroke="#EEECE6"/><path d="M0 70 L320 70" stroke="#EEECE6"/><path d="M0 30 L320 30" stroke="#EEECE6"/>
      <path d="M0 110 C40 ${110 - (110 - y0) * 0.3} 70 ${110 - (110 - y0) * 0.7} 100 ${y0}" fill="none" stroke="#3F6B4C" stroke-width="2.5"/>
      ${p.atTarget == null ? "" : `<path d="M100 ${y0} C170 ${y0 - (y0 - y(p.atTarget)) * 0.45} 240 ${y0 - (y0 - y(p.atTarget)) * 0.8} 320 ${y(p.atTarget)}" fill="none" stroke="#B9B7AE" stroke-width="2" stroke-dasharray="4 5"/>`}
      <path d="M100 ${y0} C170 ${y0 - (y0 - y(p.atRate)) * 0.45} 240 ${y0 - (y0 - y(p.atRate)) * 0.8} 320 ${y(p.atRate)}" fill="none" stroke="#3F6B4C" stroke-width="2" stroke-dasharray="4 5"/>
      <circle cx="100" cy="${y0}" r="4" fill="#3F6B4C"/>
    </svg>`;
}

function mMetas() {
  const d = S.data.mobile.metas;
  const p = d.projection;
  return `<div class="m-titleblock"><div class="m-kicker">SI SIGUES ASÍ</div><h1 class="m-h1">${esc(d.headline)}</h1></div>
    <section class="m-card m-card-pad" style="gap:12px">
      <div class="m-proj-head"><span class="t">Horas de foco profundo</span><span class="k">PROYECCIÓN 3 AÑOS</span></div>
      ${mProjection(p)}
      <div class="m-axis"><span>HOY</span>${p.years.map(y => `<span>${y}</span>`).join("")}</div>
      ${p.atTarget != null ? `<div class="m-legend"><span><i style="background:#3F6B4C"></i>tu ritmo</span><span><i style="background:#B9B7AE"></i>lo que planean tus metas</span></div>` : ""}
      <div class="m-note">${p.note}</div>
    </section>
    ${d.anticipo && !M.hideAnticipo ? `<section class="m-anticipo">
        <div class="k">ANTICIPO</div>
        <div class="t">${esc(d.anticipo.text)}</div>
        <div class="acts"><button onclick="mLogGoal(${d.anticipo.goalId})">Registrar sesión</button><button onclick="M.hideAnticipo = true; render()">Más tarde</button></div>
      </section>` : ""}
    ${mJournalRow()}
    ${d.goals.map(g => `<div class="m-goal">
        <button class="m-goal-row" onclick="M.openGoal = M.openGoal === ${g.id} ? null : ${g.id}; render()" aria-expanded="${M.openGoal === g.id}" style="text-align:left">
          <span class="m-swatch" style="background:${g.tint}"><i style="background:${g.color}"></i></span>
          <span class="m-goal-main">
            <span class="m-goal-top"><span class="n">${esc(g.name)}</span><span class="m">${esc(g.meta)}</span></span>
            <span class="m-bar"><i style="width:${g.pct};background:${g.color}"></i></span>
          </span>
        </button>
        ${M.openGoal === g.id ? `<div class="m-goal-detail">
            ${g.steps.map(s => `<div class="m-step"><span class="w">${esc(s.when)}</span><span class="x">${esc(s.what)}</span></div>`).join("")}
            ${g.margin ? `<div class="m-margin">${esc(g.margin)}</div>` : ""}
            <div class="m-btns"><button class="m-btn m-btn-primary m-btn-sm" onclick="mLogGoal(${g.id})">Sesión hecha hoy</button>
              <button class="m-btn m-btn-ghost m-btn-sm" onclick="mArchiveGoal(${g.id})">Archivar</button></div>
          </div>` : ""}
      </div>`).join("")}
    <button class="m-newgoal" onclick="mNewGoal()">+ Nueva meta</button>`;
}

// --- The journal ------------------------------------------------------------------

function mJournalRow() {
  const j = S.data.mobile.journal;
  if (!j) return "";
  const meta = `${j.week} de 7 esta semana${j.run > 1 ? ` · racha de ${j.run} días` : ""}`;
  return `<div class="m-goal"><button class="m-goal-row" onclick="mOpenJournal()" style="text-align:left">
      <span class="m-swatch" style="background:#ECE7DA"><i style="background:#8A6D3B"></i></span>
      <span class="m-goal-main">
        <span class="m-goal-top"><span class="n">Diario${j.today ? " ✓" : ""}</span><span class="m">${esc(meta)}</span></span>
        <span class="m-bar"><i style="width:${Math.round(100 * j.week / 7)}%;background:#8A6D3B"></i></span>
      </span></button>
      ${j.today ? "" : `<div class="m-journal-hint">${esc(j.prompts[0] || "")}</div>`}
    </div>`;
}

function mOpenJournal() {
  M.tab = "diario";
  M.drawer = false;
  M.sheet = false;
  const j = S.data.mobile.journal || {};
  // one page per day: yesterday's unsent draft doesn't land on today's
  if (M.journalDay !== mToday()) { M.journalDay = mToday(); M.journalDraft = null; M.journalSaved = false; }
  M.journalDraft ??= j.todayText || mStored(`unibox_journal_draft:${mToday()}`) || "";
  mRenderChat();
  setTimeout(() => document.getElementById("m-journal")?.focus(), 80);
}
window.mOpenJournal = mOpenJournal;

const mToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function mDiario() {
  const j = S.data.mobile.journal || { prompts: [], recent: [] };
  const today = mToday();
  const past = (j.recent || []).filter(e => e.date !== today);
  const day = (d) => new Date(d + "T12:00:00").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  return `<div class="m-screen">
      <div class="m-topbar"><button onclick="mGo('metas')" aria-label="Volver">←</button><span>Diario</span></div>
      <main class="m-body m-journal-body">
        <div class="m-kicker">${esc(day(today).toUpperCase())}</div>
        <ul class="m-journal-q">${(j.prompts || []).map(q => `<li>${esc(q)}</li>`).join("")}</ul>
        <textarea id="m-journal" placeholder="Escribe como te salga. Se guarda solo." oninput="M.journalDraft = this.value; mKeepDraft('unibox_journal_draft:' + mToday(), this.value); mJournalAutosave()">${esc(M.journalDraft || "")}</textarea>
        <div class="m-journal-status" id="m-journal-status">${M.journalSaved ? "Guardado." : ""}</div>
        ${past.length ? `<div class="l-sec">DÍAS ANTERIORES</div>${past.map(e => `<details class="m-journal-past"><summary>${esc(day(e.date))}</summary><p>${esc(e.text)}</p></details>`).join("")}` : ""}
      </main>
    </div>`;
}

// saved a moment after you stop typing, and when you leave
let mJournalTimer = null;
function mJournalAutosave() {
  clearTimeout(mJournalTimer);
  const st = document.getElementById("m-journal-status");
  if (st) st.textContent = "";
  mJournalTimer = setTimeout(mJournalSave, 1500);
}
async function mJournalSave() {
  clearTimeout(mJournalTimer);
  const text = M.journalDraft ?? "";
  if (!text.trim()) return;
  try {
    const r = await api("/api/journal", { text });
    if (r.ok) {
      S.data.mobile.journal = { ...S.data.mobile.journal, ...r, entry: undefined };
      M.journalSaved = true;
      const st = document.getElementById("m-journal-status");
      if (st) st.textContent = "Guardado.";
    }
  } catch {
    const st = document.getElementById("m-journal-status");
    if (st) st.textContent = "Sin conexión: lo guardo en cuanto pueda.";
  }
}

async function mLogGoal(id) {
  await api("/api/goals", { op: "log", id });
  toast("Sesión anotada.");
  await refresh();
}
async function mArchiveGoal(id) {
  if (!confirm("¿Archivar esta meta?")) return;
  await api("/api/goals", { op: "archive", id });
  M.openGoal = null;
  await refresh();
}

// --- Nueva meta ------------------------------------------------------------

// Goal conversations live on the server: opening Nueva meta resumes the unfinished one.
async function mNewGoal() {
  M.tab = "nueva";
  M.chat = [];
  M.plan = null;
  M.chatId = null;
  M.chatDraft = mStored("unibox_goal_draft");
  render();
  try {
    const r = await api("/api/chats/open?kind=goal");
    if (r.chat && r.chat.turns.length) {
      M.chatId = r.chat.id;
      M.chat = r.chat.turns.map(t => ({ role: t.role, content: t.content }));
      const last = r.chat.turns[r.chat.turns.length - 1];
      M.plan = last.role === "assistant" && last.data?.plan ? last.data.plan : null;
      render();
      mScrollChat();
    }
  } catch {}
  if (!M.plan) setTimeout(() => document.getElementById("m-chat-input")?.focus(), 50);
}

/** Set the current conversation aside (it stays saved) and start a fresh one. */
async function mFreshGoal() {
  if (M.chatId) await api("/api/chats/close", { chatId: M.chatId });
  M.chatId = null;
  M.chat = [];
  M.plan = null;
  M.chatDraft = "";
  render();
  document.getElementById("m-chat-input")?.focus();
}

function mNueva() {
  // With a plan on screen, the model's last line becomes the plan's header instead of its own bubble.
  const turns = M.plan ? M.chat.slice(0, -1) : M.chat;
  const bubbles = [
    `<div class="m-bub ai">¿Qué quieres conseguir, y para cuándo?</div>`,
    ...turns.map(t => `<div class="m-bub ${t.role === "user" ? "me" : "ai"}">${esc(t.content)}</div>`)
  ];
  if (M.plan) {
    const due = M.plan.due ? M.plan.due.split("-").reverse().join("/") : "";
    bubbles.push(`<div class="m-bub ai plan">
        <div>Trabajando hacia atrás desde ${due ? "el " + esc(due) : "la fecha"}:</div>
        ${(M.plan.steps || []).map(s => `<div class="m-step"><span class="w">${esc(s.when)}</span><span class="x">${esc(s.what)}</span></div>`).join("")}
        ${M.plan.margin ? `<div class="m-margin">${esc(M.plan.margin)}</div>` : ""}
        <div class="m-btns"><button class="m-btn m-btn-primary m-btn-sm" style="flex:none" onclick="mAcceptPlan()">Aceptar plan</button>
          <button class="m-btn m-btn-ghost m-btn-sm" onclick="mAdjustPlan()">Ajustar</button></div>
      </div>`);
  }
  if (M.chatBusy) bubbles.push(`<div class="m-bub ai typing">Pensando…</div>`);
  return `<div class="m-screen">
      <div class="m-topbar"><button onclick="mGo('metas')" aria-label="Volver">←</button><span>Nueva meta</span>
        ${M.chat.length ? `<button class="m-topbar-act" onclick="mFreshGoal()">Empezar otra</button>` : ""}</div>
      <div class="m-chat" id="m-chat"><div class="spacer"></div>${bubbles.join("")}</div>
      <form class="m-composer" onsubmit="event.preventDefault(); mSend()">
        <input id="m-chat-input" placeholder="Responde…" autocomplete="off" value="${esc(M.chatDraft)}" oninput="M.chatDraft = this.value; mKeepDraft('unibox_goal_draft', this.value)" ${M.chatBusy ? "disabled" : ""}>
        <button class="m-send" type="submit" aria-label="Enviar" ${M.chatBusy ? "disabled" : ""}>→</button>
      </form>
    </div>`;
}

function mScrollChat() {
  const c = document.getElementById("m-chat");
  if (c) c.scrollTop = c.scrollHeight;
}

async function mSend() {
  const text = M.chatDraft.trim();
  if (!text || M.chatBusy) return;
  M.chat.push({ role: "user", content: text });
  M.chatDraft = "";
  mKeepDraft("unibox_goal_draft", "");
  M.plan = null;
  M.chatBusy = true;
  render();
  mScrollChat();
  try {
    const r = await api("/api/goals/chat", { chatId: M.chatId, text });
    if (r.chatId) M.chatId = r.chatId;
    if (!r.ok) throw new Error(r.error);
    M.chat.push({ role: "assistant", content: r.reply });
    M.plan = r.plan;
  } catch {
    M.chat.push({ role: "assistant", content: "No he podido pensar ahora mismo. ¿Lo intentamos otra vez?" });
  }
  M.chatBusy = false;
  render();
  mScrollChat();
  // a plan needs the whole screen to read; a question wants an answer
  if (M.plan) document.getElementById("m-chat-input")?.blur();
  else document.getElementById("m-chat-input")?.focus();
}

async function mAcceptPlan() {
  if (!M.plan) return;
  await api("/api/goals", { op: "create", plan: M.plan, chatId: M.chatId });
  M.chatId = null;
  toast(`Meta creada: ${M.plan.name}. Te aviso si se tuerce.`);
  M.plan = null;
  M.chat = [];
  M.tab = "metas";
  await refresh();
}
function mAdjustPlan() {
  M.chatDraft = "Ajusta el plan: ";
  render();
  const i = document.getElementById("m-chat-input");
  if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

// --- Calendario ------------------------------------------------------------

function mCalendario() {
  const c = S.data.mobile.calendario;
  const connect = c.connected || !c.canConnect ? "" : `<section class="m-card m-card-pad">
      <div class="m-now-text"><span class="t">Conecta tu calendario</span>
      <span class="s">Con Google Calendar, Hoy sabe cuándo tienes hueco y te aviso antes de cada evento.</span></div>
      <a class="m-btn m-btn-primary" href="/auth/google">Conectar Google</a>
    </section>`;
  return `<div class="m-titleblock"><div class="m-kicker">${esc(S.data.mobile.dateLong)}</div><h1 class="m-h1">Calendario</h1></div>
    ${connect}
    ${c.days.map(d => `<section class="m-day"><div class="m-kicker">${esc(d.label)}</div>
        <div>${d.events.map(e => `<div class="m-ev ${e.past ? "past" : ""}"><span class="h">${esc(e.time)}${e.end ? "–" + esc(e.end) : ""}</span>
          <div class="m-row-text">${e.link ? `<a class="t" href="${esc(e.link)}" target="_blank" rel="noreferrer">${esc(e.title)}</a>` : `<span class="t">${esc(e.title)}</span>`}${e.location ? `<span class="s">${esc(e.location)}</span>` : ""}</div></div>`).join("")}</div>
      </section>`).join("")}
    ${c.connected && !c.days.length ? `<div class="m-empty">Nada en el calendario estos días.</div>` : ""}
    ${c.planned.length ? `<section class="m-day"><div class="m-kicker">PLANIFICADO EN UNIBOX</div>
        <div>${c.planned.map(p => `<div class="m-ev"><span class="h">${esc(p.time)}</span><div class="m-row-text"><span class="t">${esc(p.title)}</span></div></div>`).join("")}</div></section>` : ""}
    ${mFuentes()}
    <div class="m-links"><button onclick="setUI('classic')" style="color:var(--m-green)">Vista clásica</button></div>`;
}

// --- Conexiones ------------------------------------------------------------

function mFuentes() {
  const f = S.data.mobile.fuentes;
  if (!f) return "";
  const g = f.google;
  const wa = f.whatsapp.state;
  const waiting = (g.waiting || []).length
    ? `<span class="s">La IA tiene ${g.waiting.length === 1 ? "esto esperando" : `${g.waiting.length} cosas esperando`} a que conectes Google: ${g.waiting.map(w => esc(w.title)).join("; ")}.</span>` : "";
  const google = g.connected
    ? `<span class="s">Conectado${g.account ? ` · ${esc(g.account)}` : ""}. Leo tu correo y tu calendario.</span>`
    : g.configured
      ? `<span class="s">Lee tu correo y tu calendario. Se abre en el navegador.</span><a class="m-btn m-btn-primary m-btn-sm" href="/auth/google">Conectar Google</a>`
      : `<span class="s">Falta crear el acceso de Google en el servidor (lo hago yo con tus datos de Google Cloud).</span>`;
  const whatsapp = wa === "connected"
    ? `<span class="s">Vinculado. Leo tus chats para saber qué has quedado y cuándo; lo que te envíes a ti mismo llega aquí.</span>`
    : M.waCode
      ? `<span class="s">En WhatsApp: Ajustes → Dispositivos vinculados → Vincular un dispositivo → <b>Vincular con número de teléfono</b>, y escribe:</span>
         <div class="m-code">${esc(M.waCode)}</div><span class="s">Caduca en unos minutos. Cuando lo aceptes, esto se pone en verde solo.</span>`
      : f.whatsapp.phoneKnown
        ? `<span class="s">Vincúlalo para que lea tus chats y sepa qué has quedado y cuándo.</span>
           <button class="m-btn m-btn-primary m-btn-sm" onclick="mWaPair()" ${M.waBusy ? "disabled" : ""}>${M.waBusy ? "Pidiendo código…" : "Obtener código"}</button>`
        : `<span class="s">Vincúlalo para que lea tus chats y sepa qué has quedado y cuándo.</span>
         <form class="m-wa-form" onsubmit="event.preventDefault(); mWaPair()">
           <input id="m-wa-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Tu número, con prefijo: +34 600 000 000" value="${esc(M.waPhone || "")}" oninput="M.waPhone = this.value">
           <button class="m-btn m-btn-primary m-btn-sm" type="submit" ${M.waBusy ? "disabled" : ""}>${M.waBusy ? "Pidiendo código…" : "Obtener código"}</button>
         </form>`;
  return `<section class="m-day" id="m-fuentes"><div class="m-kicker">CONEXIONES</div>
      <div class="m-card m-card-pad m-fuente"><div class="m-now-text"><span class="t">${g.connected ? "● " : ""}Google · Gmail y Calendar</span>${google}${waiting}</div></div>
      <div class="m-card m-card-pad m-fuente"><div class="m-now-text"><span class="t">${wa === "connected" ? "● " : ""}WhatsApp</span>${whatsapp}</div></div>
      ${f.github?.configured ? `<div class="m-card m-card-pad m-fuente"><div class="m-now-text"><span class="t">${f.github.login ? "● " : ""}GitHub</span>
        <span class="s">${f.github.login ? `Conectado como ${esc(f.github.login)}. Veo y edito tus repos.` : "Conectando…"}</span></div></div>` : ""}
    </section>`;
}

async function mWaPair() {
  const phone = (document.getElementById("m-wa-phone")?.value || "").trim();
  if (!phone && !S.data.mobile.fuentes?.whatsapp?.phoneKnown) return;
  M.waBusy = true;
  render();
  try {
    const r = await api("/api/wa/pair", { phone });
    if (!r.ok) throw new Error(r.error);
    M.waCode = r.code;
  } catch (e) {
    toast(`No he podido pedir el código: ${e.message || e}`);
  }
  M.waBusy = false;
  render();
}

// Only crossing the phone/desktop width needs a re-render. The keyboard opening or closing
// also resizes the page; re-rendering then would refocus the text box and reopen it.
let mWasMobile = mobileUI();
window.addEventListener("resize", () => {
  if (!S.data || mobileUI() === mWasMobile) return;
  mWasMobile = mobileUI();
  render();
});
