#!/usr/bin/env node
// End-to-end test of the Android launcher on a real device or emulator.
//
//   node tests/e2e/phone.mjs <adb-serial> [--writes]
//
// Drives the phone like a person (adb taps, swipes, home/back keys) and checks the
// result inside the page through the WebView's DevTools socket (debug builds expose it).
// Without --writes it only reads: safe against the real server. With --writes it also
// saves a note, starts a block and gets through a block: run that against a test server.

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const serial = process.argv[2];
const writes = process.argv.includes("--writes");
if (!serial) {
  console.error("usage: node tests/e2e/phone.mjs <adb-serial> [--writes]");
  process.exit(2);
}
const ADB = process.env.ADB ?? `${process.env.ANDROID_HOME ?? ""}/platform-tools/adb`;
const PKG = "app.unibox.launcher";

const adb = (...args) => execFileSync(ADB, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
// over Wi-Fi (ip:port) airplane mode would cut adb itself
const overWifi = /:\d+$/.test(serial);
const shell = (cmd) => adb("shell", cmd);
const key = (k) => shell(`input keyevent ${k}`);
const top = () => (shell("dumpsys activity activities").match(/topResumedActivity=.*? ([\w.]+\/[\w.$]+)/) ?? [])[1] ?? "";

// --- DevTools ------------------------------------------------------------

let ws = null;
let msgId = 0;
const pending = new Map();

async function connect() {
  if (ws) try { ws.close(); } catch {}
  ws = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pid = shell(`pidof ${PKG}`).split(/\s+/)[0];
    const socks = shell("cat /proc/net/unix").match(new RegExp(`webview_devtools_remote_${pid}\\b`));
    if (pid && socks) {
      adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
      try {
        const pages = await (await fetch("http://127.0.0.1:9333/json/list")).json();
        const page = pages.find((p) => p.type === "page" && /^https?:/.test(p.url) && !p.url.includes("localhost"));
        if (page) {
          ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
          ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          };
          if (!writes) await guardWrites();
          return;
        }
      } catch {}
    }
    await sleep(700);
  }
  throw new Error("no WebView page to attach to");
}

function cdp(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  // a page in the background (another app on top) may never answer: fail, don't hang
  return new Promise((ok, fail) => {
    const t = setTimeout(() => { pending.delete(id); fail(new Error(`no answer from the page to ${method}`)); }, 15_000);
    pending.set(id, (m) => { clearTimeout(t); ok(m); });
  });
}

async function js(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`page error: ${r.result.exceptionDetails.text} ${r.result.exceptionDetails.exception?.description ?? ""}`);
  return r.result?.result?.value;
}

// Read-only runs go against the real server: the page refuses every write, now and after reloads.
const GUARD = `(() => { if (window.__e2eGuard) return; window.__e2eGuard = true; const f = window.fetch.bind(window);
  window.fetch = (u, o = {}) => { const m = (o.method || "GET").toUpperCase(); const url = String(u && u.url || u);
    if (m !== "GET" && /\\/api\\//.test(url)) { console.warn("e2e read-only: blocked", m, url); return Promise.reject(new Error("e2e read-only")); }
    return f(u, o); }; })()`;
async function guardWrites() {
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: GUARD });
  await cdp("Runtime.evaluate", { expression: GUARD });
}

/** Tap an element the way a finger would (touch events at its centre), only if it's really there. */
async function tapEl(selector, tries = 0) {
  const rect = await js(`(async () => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    e.scrollIntoView({ block: "center", inline: "nearest" });
    await new Promise(r => setTimeout(r, 400)); // let a scroll or snap finish before aiming
    const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, ok: !!hit && (hit === e || e.contains(hit)), hit: hit ? hit.className || hit.tagName : "nothing" }; })()`);
  if (!rect) throw new Error(`nothing matches ${selector}`);
  if (!rect.ok) {
    // out of view for a moment (keyboard closing, a scroll settling): look again before giving up
    if (tries < 3) { await sleep(500); return tapEl(selector, tries + 1); }
    throw new Error(`${selector} is covered by ${rect.hit}; not tapping`);
  }
  const p = [{ x: rect.x, y: rect.y }];
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: p });
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function waitFor(expr, ms = 10_000, what = expr) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await js(expr)) return; } catch {}
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** Type only once the keyboard is up, as a person would (adb text sent earlier gets dropped). */
async function typeText(text) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !keyboardUp()) await sleep(200);
  await sleep(600);
  shell(`input text ${text.replace(/ /g, "%s")}`);
}

async function openSheet() {
  for (let i = 0; i < 2; i++) {
    await tapEl(".l-capture");
    try { await waitFor(`!!document.querySelector(".m-sheet") && document.activeElement && document.activeElement.id === "m-draft"`, 2500, "sheet open with the cursor in it"); return; } catch (e) { if (i) throw e; }
  }
}

const keyboardUp = () => shell("dumpsys input_method | grep -m1 mInputShown").includes("mInputShown=true");
/** Back as a person presses it: if the keyboard is up, the first press only closes it. */
async function back() {
  if (keyboardUp()) {
    key("KEYCODE_BACK");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && keyboardUp()) await sleep(150);
    await sleep(400);
  }
  key("KEYCODE_BACK");
  await sleep(300);
}

/** Only hide the keyboard (a Back press when it's up), never navigate. */
async function hideKeyboard() {
  if (!keyboardUp()) return;
  key("KEYCODE_BACK");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && keyboardUp()) await sleep(150);
  await sleep(400);
}

async function waitTop(fragment, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (top().includes(fragment)) return;
    await sleep(300);
  }
  throw new Error(`expected ${fragment} on top, got ${top()}`);
}

// native screens (BlockActivity): find text in the uiautomator dump and tap it
function nativeTap(text) {
  shell("uiautomator dump /sdcard/e2e-ui.xml");
  const xml = shell("cat /sdcard/e2e-ui.xml");
  const m = xml.match(new RegExp(`text="${text}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  if (!m) throw new Error(`no native element with text "${text}"`);
  shell(`input tap ${(+m[1] + +m[3]) >> 1} ${(+m[2] + +m[4]) >> 1}`);
}
function nativeText() {
  shell("uiautomator dump /sdcard/e2e-ui.xml");
  return [...shell("cat /sdcard/e2e-ui.xml").matchAll(/text="([^"]+)"/g)].map((m) => m[1]);
}

const size = shell("wm size").match(/(\d+)x(\d+)/).slice(1).map(Number);
const [W, H] = size;
const swipe = (x1, y1, x2, y2, ms = 280) => shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
const swipeLeft = () => swipe(W * 0.85, H * 0.45, W * 0.15, H * 0.45);
const swipeRight = () => swipe(W * 0.15, H * 0.45, W * 0.85, H * 0.45);
const swipeUp = () => swipe(W / 2, H * 0.82, W / 2, H * 0.4, 220);

const panel = () => js(`(() => { const p = document.getElementById("l-pager"); return p ? Math.round(p.scrollLeft / p.clientWidth) : -1; })()`);
async function waitPanel(n) {
  await waitFor(`(() => { const p = document.getElementById("l-pager"); return p && Math.round(p.scrollLeft / p.clientWidth) === ${n} && p.scrollLeft % p.clientWidth < 2; })()`, 5000, `panel ${n}`);
  await sleep(350);
}
const launcherShown = () => js(`!!document.getElementById("l-clock")`);

// --- run -----------------------------------------------------------------

const results = [];
async function step(name, fn, { write = false, cable = false } = {}) {
  if (write && !writes) { results.push({ name, status: "skip" }); console.log(`  -  ${name} (needs --writes)`); return; }
  if (cable && overWifi) { results.push({ name, status: "skip" }); console.log(`  -  ${name} (not over Wi-Fi adb)`); return; }
  const t = Date.now();
  try {
    await fn();
    results.push({ name, status: "ok" });
    console.log(`  ✓  ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push({ name, status: "fail", error: e.message });
    console.log(`  ✗  ${name}\n       ${e.message}`);
    try { shell(`screencap -p /sdcard/e2e-fail.png`); adb("pull", "/sdcard/e2e-fail.png", `/tmp/e2e-fail-${results.length}.png`); } catch {}
    // get back to a known state
    try { key("KEYCODE_HOME"); await sleep(1200); await connect(); } catch {}
  }
}

console.log(`Unibox e2e on ${serial} (${W}x${H})${writes ? ", with writes" : ", read-only"}`);
shell(`am force-stop ${PKG}`);
try { shell(`run-as ${PKG} rm -f shared_prefs/unibox_policy.xml`); } catch {}
shell("input keyevent KEYCODE_WAKEUP");
shell("wm dismiss-keyguard");

await step("Home button opens Unibox as the launcher", async () => {
  const home = shell("cmd role get-role-holders android.app.role.HOME");
  if (!home.includes(PKG)) throw new Error(`home app is ${home || "none"}`);
  key("KEYCODE_HOME");
  await waitTop(`${PKG}/.MainActivity`);
  await connect();
  await waitFor(`!!document.getElementById("l-clock")`, 15_000, "launcher clock");
});

await step("Clock shows the current time and the date", async () => {
  const clock = await js(`document.getElementById("l-clock").textContent`);
  const now = new Date(Date.parse(shell("date -Iseconds")));
  const want = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (Math.abs(toMin(clock) - toMin(want)) > 1) throw new Error(`clock says ${clock}, phone says ${want}`);
  if (!(await js(`document.querySelector(".l-date").textContent.trim().length > 5`))) throw new Error("no date");
});
function toMin(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

await step("Home shows a focus line and apps for the moment, none of them a quiet messaging app", async () => {
  if (!(await js(`document.querySelector(".l-focus").textContent.trim().length > 0`))) throw new Error("empty focus line");
  const apps = await js(`[...document.querySelectorAll(".l-apps button")].map(b => b.textContent)`);
  const quiet = await js(`JSON.parse(UniboxNative.listApps()).filter(a => a.quiet).map(a => a.label)`);
  const shown = apps.filter((a) => quiet.some((q) => a.startsWith(q)));
  if (shown.length) throw new Error(`quiet messaging apps on home: ${shown.join(", ")}`);
  console.log(`       apps now: ${apps.join(", ") || "(none)"}`);
});

await step("Swipe left opens Hoy: at most the five things that matter now", async () => {
  // right after a cold start the page may still be loading: a swipe then goes nowhere
  await waitFor(`!!S.data && !S.fromCache`, 15_000, "fresh data");
  // the first second after opening, the app is still settling (no one swipes that fast)
  await sleep(1500);
  swipeLeft();
  await waitPanel(1);
  if (!(await js(`/GUARDADO/.test(document.querySelector("#l-p2 .m-kicker").textContent)`))) throw new Error("no Hoy heading");
  await waitFor(`(async () => { await refresh(); return !S.data.mobile.plan.planning; })()`, 60_000, "plan ready");
  const plan = await js(`S.data.mobile.plan`);
  if (plan.top.length > 5) throw new Error(`${plan.top.length} things shown`);
  for (let i = 0; i < plan.slots.length; i++) {
    const x = plan.slots[i];
    if (!(x.start < x.end)) throw new Error(`slot ${x.title} has no time`);
    if (i && plan.slots[i - 1].end > x.start && plan.slots[i - 1].status !== "moved" && x.status !== "moved") throw new Error(`slots overlap: ${plan.slots[i - 1].title} / ${x.title}`);
  }
  const rows = await js(`document.querySelectorAll("#l-p2 .l-slot").length`);
  if (rows !== plan.top.length) throw new Error(`${plan.top.length} to show but ${rows} rows`);
  if (await js(`document.querySelectorAll("#l-p2 .l-todo, #l-p2 .l-gh").length`)) throw new Error("more than the top five is showing");
  console.log(`       shown: ${plan.top.map((x) => x.title.slice(0, 32)).join(" · ") || "(nothing)"}`);
  key("KEYCODE_BACK");
  await waitPanel(0);
});

await step("The sleep estimate answers without breaking the home screen (a JSON night or nothing)", async () => {
  const r = await js(`(() => { const j = UniboxNative.sleepLast(); if (j) { const z = JSON.parse(j); if (!(z.end > z.start && z.minutes >= 180)) throw new Error("bad night " + j); } mLoadSleep(); return typeof j; })()`);
  if (r !== "string") throw new Error(`sleepLast returned ${r}`);
  if (!(await launcherShown())) throw new Error("launcher gone");
});

await step("Sueño: a night is saved on the server and the stats screen shows it", async () => {
  await js(`(async () => { const end = Date.now() - 3600_000; await api("/api/sleep", { start: end - 7 * 3600_000, end }); await refresh(); return true; })()`);
  await waitFor(`S.data.mobile.sleep.nights.length > 0`, 6000, "night in the payload");
  await js(`mGo("sueno"); true`);
  await waitFor(`/sueño/i.test(document.body.innerText) && /media 7 d/i.test(document.body.innerText) && !!document.querySelector(".m-sbar")`, 5000, "stats screen");
  key("KEYCODE_BACK");
  await waitFor(`!!document.getElementById("l-clock")`, 4000, "back to the launcher");
}, { write: true });

await step("Metas and the journal open from Guardado; the journal saves what you write, and back keeps it", async () => {
  swipeLeft();
  await waitPanel(1);
  await js(`(() => { [...document.querySelectorAll("#l-p2 .l-links button")].forEach((b) => b.dataset.e2e = b.textContent.trim()); return true; })()`);
  await tapEl('#l-p2 .l-links button[data-e2e="Metas y diario"]');
  await waitFor(`M.tab === "metas" && !!document.querySelector(".m-goal-row")`, 4000, "Metas");
  await tapEl(".m-goal-row");
  await waitFor(`M.tab === "diario" && !!document.getElementById("m-journal")`, 4000, "journal screen");
  await tapEl("#m-journal");
  await typeText("Prueba e2e del diario");
  await hideKeyboard();
  key("KEYCODE_BACK");
  await waitFor(`!!document.getElementById("l-clock")`, 4000, "back to launcher");
  await waitFor(`(async () => { const r = await api("/api/journal"); return /Prueba e2e del diario/.test(r.todayText); })()`, 8000, "saved on the server");
}, { write: true });

await step("Swipe up opens all apps; search filters; back closes it", async () => {
  swipeUp();
  await waitFor(`!!document.querySelector(".l-drawer")`, 4000, "drawer");
  const all = await js(`document.querySelectorAll(".l-drawer .m-app").length`);
  if (all < 5) throw new Error(`only ${all} apps listed`);
  // search for one of the listed apps by the first letters of its name
  const label = await js(`document.querySelectorAll(".l-drawer .m-app > span:first-child")[3].textContent`);
  const q = label.normalize("NFD").replace(/[^A-Za-z]/g, "").slice(0, 4).toLowerCase();
  await tapEl("#m-app-q");
  await typeText(q);
  await waitFor(`(() => { const a = [...document.querySelectorAll(".l-drawer .m-app")]; return a.length >= 1 && a.length < ${all} && a.some(x => x.textContent.startsWith(${JSON.stringify(label)})); })()`, 4000, `filtered to ${label}`);
  await back();
  await waitFor(`!document.querySelector(".l-drawer")`, 4000, "drawer closed");
  if (!(await launcherShown())) throw new Error("launcher gone after closing the drawer");
});

await step("With the app drawer open, a sideways swipe doesn't move the panels behind it", async () => {
  swipeUp();
  await waitFor(`!!document.querySelector(".l-drawer")`, 4000, "drawer");
  const before = await panel();
  swipeRight();
  await sleep(1200);
  if ((await panel()) !== before) throw new Error(`the panels moved from ${before} to ${await panel()}`);
  if (!(await js(`!!document.querySelector(".l-drawer")`))) throw new Error("the drawer closed");
  await hideKeyboard();
  key("KEYCODE_BACK");
  await waitFor(`!document.querySelector(".l-drawer")`, 4000, "drawer closed");
});

await step("Opening an allowed app from the drawer launches it", async () => {
  swipeUp();
  await waitFor(`!!document.querySelector(".l-drawer")`, 4000, "drawer");
  const target = await js(`(() => { const a = JSON.parse(UniboxNative.listApps()).find(a => !a.blocked && /settings|ajustes/i.test(a.label)); return a && a.pkg; })()`);
  if (!target) throw new Error("no allowed Settings app");
  await js(`mLaunch(${JSON.stringify(target)})`);
  await waitTop(target);
  key("KEYCODE_HOME");
  await waitTop(`${PKG}/.MainActivity`);
  await connect();
  await waitFor(`!!document.getElementById("l-clock") && !document.querySelector(".l-drawer")`, 8000, "clean home after home key");
});

await step("Holding an app in the drawer offers to uninstall it, in the list and in search results", async () => {
  swipeUp();
  await waitFor(`!!document.querySelector(".l-drawer")`, 4000, "drawer");
  const hold = async (sel) => {
    const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await sleep(400);
    await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x, y: r.y }] });
    await sleep(900);
    await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  // an app that isn't Unibox (that one asks for the guardian's code instead)
  const pkg = await js(`(() => { const a = JSON.parse(UniboxNative.listApps()).find(a => !a.blocked && a.pkg !== "app.unibox.launcher" && !/settings|ajustes|unibox/i.test(a.label) && a.label.length > 3); return a && a.pkg; })()`);
  if (!pkg) throw new Error("no spare app to hold");
  const label = await js(`JSON.parse(UniboxNative.listApps()).find(a => a.pkg === ${JSON.stringify(pkg)}).label`);
  await hold(`.l-drawer .m-app[data-pkg="${pkg}"]`);
  await waitTop("ninstall");
  key("KEYCODE_BACK");
  await waitTop(`${PKG}/.MainActivity`);
  await connect();
  swipeUp();
  await waitFor(`!!document.querySelector(".l-drawer")`, 4000, "drawer");
  await js(`(() => { const i = document.getElementById("m-app-q"); i.value = ${JSON.stringify(label.slice(0, 3))}; mDrawerInput(i); return true; })()`);
  await hold(`.l-drawer .m-app[data-pkg="${pkg}"]`);
  await waitTop("ninstall");
  key("KEYCODE_BACK");
  await waitTop(`${PKG}/.MainActivity`);
  await connect();
  await js(`M.drawer = false; M.appQuery = ""; render(); true`);
  await waitFor(`!document.querySelector(".l-drawer")`, 4000, "drawer closed");
});

await step("“Cuéntame algo” sheet: back closes it and the launcher keeps working", async () => {
  await js(`M.draft = ""; mKeepDraft("unibox_draft", ""); true`);
  await openSheet();
  await typeText("borrador");
  await sleep(300);
  key("KEYCODE_BACK"); // hides the keyboard
  await sleep(1200);
  if (keyboardUp()) throw new Error("keyboard came back after back");
  await back();
  await waitFor(`!document.querySelector(".m-sheet")`, 4000, "sheet closed by back");
  if (await js(`M.draft !== "borrador"`)) throw new Error("the unsent text was lost");
  swipeLeft();
  await waitPanel(1);
  key("KEYCODE_BACK");
  await waitPanel(0);
  // tidy: forget the draft
  await js(`M.draft = ""; mKeepDraft("unibox_draft", ""); true`);
});

await step("Sub-screen (Calendario y conexiones) has a back bar; Android back returns home", async () => {
  swipeLeft();
  await waitPanel(1);
  await js(`(() => { [...document.querySelectorAll("#l-p2 .l-links button")].forEach((b, i) => b.dataset.e2e = b.textContent.trim()); return true; })()`);
  await tapEl('#l-p2 .l-links button[data-e2e="Conexiones"]');
  await waitFor(`!!document.getElementById("m-fuentes")`, 5000, "Conexiones");
  key("KEYCODE_BACK");
  await waitFor(`!!document.getElementById("l-clock")`, 4000, "back to launcher");
});

await step("A blocked app gets the block screen; “Volver a Unibox” returns home", async () => {
  const blocked = await js(`(() => { const apps = JSON.parse(UniboxNative.listApps()).filter(a => a.blocked);
    const pref = ["com.android.chrome", "com.android.camera2", "com.google.android.youtube", "com.twitter.android"];
    const a = pref.map(p => apps.find(x => x.pkg === p)).find(Boolean) || apps[0]; return a && a.pkg; })()`);
  if (!blocked) throw new Error("nothing is blocked right now (no window and no distraction installed)");
  shell(`monkey -p ${blocked} -c android.intent.category.LAUNCHER 1`);
  await waitTop(`${PKG}/.BlockActivity`);
  const text = nativeText();
  if (!text.some((t) => t.startsWith("Necesito "))) throw new Error(`block screen text: ${text.join(" | ")}`);
  nativeTap("Volver a Unibox");
  await waitTop(`${PKG}/.MainActivity`);
});

await step("While you should be working or on your plan, a feed has no way through", async () => {
  const kind = await js(`S.data.mobile.policy?.active?.kind || ""`);
  if (!kind || kind === "night") return console.log(`       (no work/plan window now: ${kind || "none"})`);
  const yt = await js(`JSON.parse(UniboxNative.listApps()).some(a => a.pkg === "com.google.android.youtube")`);
  if (!yt) return console.log("       (YouTube not installed)");
  shell("monkey -p com.google.android.youtube -c android.intent.category.LAUNCHER 1");
  await waitTop(`${PKG}/.BlockActivity`);
  // an app can throw its own screen over the block (YouTube's "update" prompt); the watchdog puts it back
  await sleep(4000);
  await waitTop(`${PKG}/.BlockActivity`);
  const text = nativeText();
  if (text.some((t) => t.startsWith("Necesito "))) throw new Error(`a way through is offered: ${text.join(" | ")}`);
  if (!text.some((t) => /no se abre/.test(t))) throw new Error(`block screen text: ${text.join(" | ")}`);
  nativeTap("Volver a Unibox");
  await waitTop(`${PKG}/.MainActivity`);
});

await step("Getting through a block costs the wait plus a reason, then opens the app", async () => {
  const blocked = await js(`(() => { const apps = JSON.parse(UniboxNative.listApps()).filter(a => a.blocked);
    const pref = ["com.android.chrome", "com.android.camera2", "com.google.android.youtube", "com.twitter.android"];
    const a = pref.map(p => apps.find(x => x.pkg === p)).find(Boolean) || apps[0]; return a && a.pkg; })()`);
  shell(`monkey -p ${blocked} -c android.intent.category.LAUNCHER 1`);
  await waitTop(`${PKG}/.BlockActivity`);
  nativeTap("Necesito ");
  await sleep(500);
  shell("input text e2e");
  key("KEYCODE_BACK"); // keyboard
  if (!nativeText().some((t) => /^Espera \d+ s$/.test(t))) throw new Error("no countdown");
  const wait = (await js(`S.data.mobile.policy.frictionSeconds`)) ?? 60;
  await sleep((wait + 2) * 1000);
  nativeTap("Abrir ");
  // the app opens; on a first launch it may put its own permission prompt on top
  await waitTop(blocked, 10_000).catch(async () => { if (!top().includes("permissioncontroller")) throw new Error(`expected ${blocked} on top, got ${top()}`); });
  key("KEYCODE_HOME");
  await waitTop(`${PKG}/.MainActivity`);
  await connect();
}, { write: true });

await step("Saving a note from “Cuéntame algo” reaches the server and the backlog", async () => {
  await js(`M.draft = ""; mKeepDraft("unibox_draft", ""); true`);
  await openSheet();
  await typeText("Revisar informe de prueba e2e antes del viernes");
  // the keyboard sometimes swallows the first letters on a slow emulator: check and type again
  if ((await js(`document.getElementById("m-draft").value`)) !== "Revisar informe de prueba e2e antes del viernes") {
    await js(`(() => { const t = document.getElementById("m-draft"); t.value = ""; M.draft = ""; return true; })()`);
    await sleep(800);
    await typeText("Revisar informe de prueba e2e antes del viernes");
  }
  await tapEl(".m-sheet .m-btn-primary");
  await waitFor(`!document.querySelector(".m-sheet")`, 6000, "sheet closed after saving");
  await waitFor(`(async () => { await refresh(); return S.data.mobile.backlog.fresh.some(t => /^Revisar informe de prueba e2e antes del viernes$/i.test(t.title) || /informe de prueba/i.test(t.title)); })()`, 20_000, "note under Recién guardado");
  const raw = await js(`(S.data.mobile.backlog.fresh.find(t => /informe de prueba/i.test(t.title)) || {}).title`);
  if (raw !== "Revisar informe de prueba e2e antes del viernes") throw new Error(`saved as "${raw}"`);

}, { write: true });

await js(`S.data.mobile.block ? mStopBlock(false) : null`).catch(() => {});

await step("▶ on a planned or backlog thing starts a block: home shows it, the timer runs, non-allowed apps wait", async () => {
  swipeLeft();
  await waitPanel(1);
  await tapEl(`#l-p2 .l-slot .l-play`);
  // a reading slot also opens its article in the browser: come back to the home screen
  await sleep(1500);
  if (!top().includes(`${PKG}/.MainActivity`)) { key("KEYCODE_HOME"); await waitTop(`${PKG}/.MainActivity`); await connect(); }
  await waitFor(`!!S.data.mobile.block && /EN BLOQUE/.test(document.getElementById("l-p1").textContent)`, 8000, "block on home");
  const t1 = await js(`document.getElementById("m-timer").textContent`);
  await sleep(2200);
  const t2 = await js(`document.getElementById("m-timer").textContent`);
  if (t1 === t2) throw new Error(`timer not running (${t1})`);
  if ((await js(`S.data.mobile.policy.active && S.data.mobile.policy.active.kind`)) !== "focus") throw new Error("no focus window in force");
  await tapEl(".l-acts button:last-child"); // Parar
  await waitFor(`!S.data.mobile.block`, 6000, "block stopped");
}, { write: true });

await step("“Contar” opens the conversation about it; one message closes it", async () => {
  swipeLeft();
  await waitPanel(1);
  const first = await js(`(S.data.mobile.plan.top.find(x => x.kind !== "commitment") || {}).title`);
  if (!first) throw new Error("nothing to talk about");
  await tapEl("#l-p2 .l-close-btn");
  await waitFor(`M.tab === "chat" && !!document.getElementById("m-ai-input") && (M.ai?.messages || []).some(m => m.role === "assistant" && m.content.includes(${JSON.stringify(first.slice(0, 20))}))`, 8000, "the AI asks about it in the conversation");
  await tapEl("#m-ai-input");
  // "no longer needed" closes whatever it is (a "done" needs content about the thing itself)
  await typeText("Eso ya no hace falta: lo descarto porque ahora mismo no es relevante para mi");
  await hideKeyboard();
  await tapEl(".m-send");
  await waitFor(`!M.aiBusy && (M.ai?.messages || []).at(-1)?.role === "assistant"`, 60_000, "the AI's answer");
  await waitFor(`(async () => { await refresh(); return !S.data.mobile.plan.top.some(x => x.title === ${JSON.stringify(first)}); })()`, 20_000, "closed and gone from the five");
  key("KEYCODE_BACK");
  await waitFor(`M.tab === "hoy"`, 4000, "back from the conversation");
}, { write: true });

await step("Swiping a row in Hoy left uncovers Hecho; it closes it, and Deshacer brings it back", async () => {
  swipeLeft();
  await waitPanel(1);
  const r = await js(`(() => { const el = document.querySelector("#l-p2 [data-swipe]"); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width, i: Number(el.dataset.swipe), title: S.data.mobile.plan.top[Number(el.dataset.swipe)].title, dpr: devicePixelRatio }; })()`);
  if (!r) throw new Error("no row to swipe");
  const px = (v) => Math.round(v * r.dpr);
  // leftward uncovers Hecho / Archivar
  swipe(px(r.x + r.w * 0.85), px(r.y), px(r.x + r.w * 0.3), px(r.y), 250);
  await waitFor(`!!document.querySelector("[data-swipe].open")`, 4000, "row opened");
  await tapEl(".l-swipe-wrap:has([data-swipe].open) .l-swipe-acts .done");
  await waitFor(`!!document.querySelector("#l-p2 .l-undo")`, 8000, "undo bar");
  await waitFor(`(async () => { await refresh(); return !S.data.mobile.plan.top.some(x => x.title === ${JSON.stringify(r.title)}); })()`, 10_000, "gone from the five");
  await tapEl("#l-p2 .l-undo button");
  await waitFor(`(async () => { await refresh(); return S.data.mobile.plan.top.some(x => x.title === ${JSON.stringify(r.title)}); })()`, 15_000, "back after Deshacer");
}, { write: true });

await step("A goal conversation is saved and resumes after leaving it", async () => {
  await js(`mNewGoal()`);
  await waitFor(`M.tab === "nueva" && !!document.getElementById("m-chat-input")`, 5000, "Nueva meta");
  // the planner's reply takes a while: don't hold the page call open for it, wait below
  await js(`M.chatDraft = "Quiero leer The Future of the Professions antes del 30 de noviembre"; mSend(); true`);
  await waitFor(`!M.chatBusy && M.chat.length >= 2`, 90_000, "planner reply");
  const id = await js(`M.chatId`);
  if (!id) throw new Error("no conversation id from the server");
  await back();
  await waitFor(`!!document.getElementById("l-clock")`, 4000, "back home");
  await js(`mNewGoal()`);
  await waitFor(`M.chatId === ${id} && M.chat.length >= 2`, 8000, "same conversation resumed");
  await js(`mFreshGoal()`);
  key("KEYCODE_BACK");
}, { write: true });

await step("Blocker switches itself back on after the app is force-stopped", async () => {
  shell(`am force-stop ${PKG}`);
  await sleep(800);
  key("KEYCODE_HOME");
  await waitTop(`${PKG}/.MainActivity`, 10_000);
  await sleep(2500);
  const on = shell("settings get secure enabled_accessibility_services");
  if (!on.includes(`${PKG}/${PKG}.BlockerService`) && !on.includes(`${PKG}/.BlockerService`)) throw new Error(`blocker off: ${on}`);
  await connect();
});

await step("Reminders are scheduled on the phone", async () => {
  const n = (shell("dumpsys alarm").match(/app\.unibox\.launcher\.REMINDER/g) ?? []).length;
  if (!n) throw new Error("no reminder alarms");
  console.log(`       ${n} reminders scheduled`);
});

await step("Offline: the home screen still lists apps, and comes back on its own", async () => {
  shell("cmd connectivity airplane-mode enable");
  await sleep(1500);
  shell(`am force-stop ${PKG}`);
  key("KEYCODE_HOME");
  await sleep(9000);
  const offlineApps = shell("uiautomator dump /sdcard/e2e-ui.xml >/dev/null; cat /sdcard/e2e-ui.xml");
  shell("cmd connectivity airplane-mode disable");
  if (!/Sin conexión/.test(offlineApps)) throw new Error("no offline notice");
  if (!/Ajustes|Settings/.test(offlineApps)) throw new Error("no app list while offline");
  await sleep(4000);
  await connect();
  await waitFor(`!!document.getElementById("l-clock")`, 40_000, "launcher after reconnecting");
}, { cable: true });

const failed = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skip");
console.log(`\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
try { ws?.close(); } catch {}
process.exit(failed.length ? 1 : 0);
