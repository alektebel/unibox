import { itemGoal } from "./slate.js";
import { addDays } from "./days.js";
import { db, getMeta } from "./db.js";
import { config } from "./config.js";
import { sessionDays } from "./reminders.js";
// plan_slots is created by the planner
import "./planner.js";
import { workHoursFor } from "./presence.js";
import { guardHash } from "./guardian.js";

// What the phone allows, and when. The launcher's accessibility service enforces this
// locally from a cached copy (so it holds offline); the server only decides the windows.
//
// - A window (a goal session, a focus block, work hours, night) allows only its list;
//   anything else costs friction: a wait plus a reason, which is logged.
// - Distractions (games, feeds, streaming) cost friction at any time.
// - Essentials (phone, clock, maps, authenticators, Unibox itself) are never blocked.

db.exec(`
CREATE TABLE IF NOT EXISTS policy_exits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  pkg TEXT NOT NULL,
  reason TEXT,
  window_key TEXT
);
`);

const DAY = 86_400_000;
const HORIZON_DAYS = 2;

export const ESSENTIALS = [
  "app.unibox.launcher",
  "com.android.systemui",
  "com.android.settings",
  "com.android.deskclock",
  "com.android.phone",
  "com.android.incallui",
  "com.android.server.telecom",
  "com.google.android.dialer",
  "com.android.contacts",
  "com.google.android.contacts",
  "com.callapp.contacts",
  "com.google.android.apps.maps",
  "com.google.android.apps.authenticator2",
  "com.azure.authenticator",
  "oracle.idm.mobile.authenticator",
  "com.google.android.permissioncontroller",
  "com.android.permissioncontroller",
  "com.google.android.packageinstaller",
  "com.miui.securitycenter",
  // paying and banking: the card can never be blocked (tapping to pay opens these)
  "com.google.android.apps.walletnfcrel",
  "com.google.android.apps.nbu.paisa.user",
  "com.imaginbank.app",
  "es.lacaixa.mobile.android.newwapicon",
  "com.bbva.bbvacontigo",
  "es.bancosantander.apps",
  "es.ingdirect.ingmovil",
  "com.ingdirect.mobile",
  "net.inverline.bancosabadell.officelocator.android",
  "com.bankinter.launcher",
  "es.openbank.mobile",
  "com.revolut.revolut",
  "de.number26.android",
  "com.paypal.android.p2pmobile",
  "es.bizum.app",
  "com.imaginecurve.curve.prd",
  "com.mi.android.globalwallet",
  // what you may need at any moment
  "com.google.android.gm",
  "com.google.android.calendar",
  "com.android.calendar",
  "com.xiaomi.calendar",
  "com.android.camera",
  "com.android.camera2",
  "com.google.android.GoogleCamera",
  "com.miui.calculator",
  "com.google.android.calculator",
  "com.google.android.apps.nbu.files",
  "com.mi.android.globalFileexplorer",
  "com.google.android.apps.docs",
  "com.google.android.apps.translate",
  "com.ubercab",
  "com.cabify.rider",
  "ee.mtakso.client",
  "com.tranzmate",
];

const NIGHT_ALLOW = ["com.whatsapp", "com.spotify.music", "com.urbandroid.lux"];

export const YOUTUBE = "com.google.android.youtube";

// open freely (to post, to read a thread you were sent): only scrolling is limited (the phone
// cuts a few minutes of nonstop scrolling and closes the feeds for a while)
export const SCROLL_ONLY = ["com.twitter.android"];

// closed at any hour, no wait-and-reason pass (in free time the reason turned into "por pereza")
export const CLOSED = ["com.instagram.android", "com.instagram.lite"];

export const DISTRACTIONS = [
  "com.instagram.android",
  "com.zhiliaoapp.musically",
  "com.google.android.youtube",
  "com.netflix.mediaclient",
  "com.disney.disneyplus",
  "com.amazon.avod.thirdpartyclient",
  "com.activision.callofduty.shooter",
  "com.valvesoftware.android.steam.community",
  "air.com.midjiwan.polytopia",
  "io.anuke.mindustry",
  "com.chess",
  "org.lichess.mobileV2",
  "com.rummikubfree",
  "com.nf.snake",
  "com.indiefoundry.darksquares",
  "com.PalmCourt.Wavelength",
  "me.magnum.melonds",
  "com.discord",
  "com.reddit.frontpage",
  // the same feeds under other names
  "com.instagram.barcelona",
  "com.instagram.lite",
  "com.zhiliaoapp.musically.go",
  "com.ss.android.ugc.trill",
  "com.facebook.katana",
  "com.facebook.lite",
  "com.snapchat.android",
  "com.pinterest",
  "tv.twitch.android.app",
];

/** Browsing is how feeds come back in; it's off during work hours and blocks. */
export const BROWSERS = [
  "com.android.chrome",
  "com.brave.browser",
  "com.opera.preinstall",
  "com.opera.browser",
  "org.torproject.torbrowser",
  "com.mi.globalbrowser",
  "org.mozilla.firefox",
  "org.mozilla.focus",
  "com.duckduckgo.mobile.android",
  "com.microsoft.emmx",
  "com.vivaldi.browser",
  "com.kiwibrowser.browser",
  "com.sec.android.app.sbrowser",
  // its feed and results are a browser too (Shorts play right there)
  "com.google.android.googlequicksearchbox",
];

export interface Window {
  /** stable id, also what exits are logged against */
  key: string;
  start: number;
  end: number;
  title: string;
  kind: "focus" | "session" | "plan" | "work" | "night";
  /** blocks you can't wave away: a longer wait */
  hard: boolean;
  /** "allow": only ESSENTIALS + allow pass; "deny": everything except deny passes */
  mode: "allow" | "deny";
  list: string[];
}

export interface Policy {
  generatedAt: number;
  essentials: string[];
  distractions: string[];
  windows: Window[];
  /** seconds of waiting before an exit is granted, and how long it lasts */
  frictionSeconds: number;
  hardFrictionSeconds: number;
  passMinutes: number;
  guardHash: string;
  feedBudgetMinutes: number;
  scrollOnly: string[];
  closed: string[];
  gameBudgetMinutes: number;
}

function hm(v: string, fallback: [number, number]): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? [Number(m[1]), Number(m[2])] : fallback;
}

function at(dayStart: number, [h, m]: [number, number]): number {
  const d = new Date(dayStart);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** YYYY-MM-DD in local time (toISOString would give yesterday's date before 02:00 in Madrid) */
function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const weekday = (ts: number) => (new Date(ts).getDay() + 6) % 7;

export function policy(now = Date.now()): Policy {
  const windows: Window[] = [];
  const today = startOfDay(now);
  // learned from where you are (presence.ts), the configured hours until there's data
  const workOn = (day: number): [[number, number], [number, number]] | null => {
    const wh = workHoursFor(day, now);
    return wh ? [hm(wh.split("-")[0] ?? "", [9, 0]), hm(wh.split("-")[1] ?? "", [17, 0])] : null;
  };
  const night: [[number, number], [number, number]] | null = config.nightHours
    ? [hm(config.nightHours.split("-")[0] ?? "", [23, 30]), hm(config.nightHours.split("-")[1] ?? "", [7, 0])]
    : null;
  const session = hm(config.sessionAt, [18, 0]);
  const goals = db.prepare("SELECT * FROM goals WHERE archived = 0").all() as any[];
  // blocks and the plan stop what pulls you away (feeds, games, browsing), not what you may
  // need: everything else stays open
  const pulls = [...DISTRACTIONS, ...config.extraDistractions, ...BROWSERS];

  // a block started from Hoy
  const open = db.prepare("SELECT * FROM focus_blocks WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get() as any;
  if (open && open.started_at + open.planned_min * 60_000 > now) {
    windows.push({
      key: `focus:${open.id}`, start: open.started_at, end: open.started_at + open.planned_min * 60_000,
      title: open.title || "Bloque de foco", kind: "focus", hard: false, mode: "deny", list: pulls,
    });
  }

  // yesterday too, so a night window that started then still covers this morning
  for (let i = -1; i < HORIZON_DAYS; i++) {
    const day = addDays(today, i);
    const date = localDate(day);
    const wd = weekday(day);
    const work = workOn(day);
    if (work && wd < 5 && at(day, work[1]) > at(day, work[0])) {
      windows.push({
        key: `work:${date}`, start: at(day, work[0]), end: at(day, work[1]),
        title: "Horario de trabajo", kind: "work", hard: false, mode: "deny", list: [...DISTRACTIONS, ...config.extraDistractions, ...BROWSERS],
      });
    }
    if (night) {
      windows.push({
        key: `night:${date}`, start: at(day, night[0]), end: at(day + DAY, night[1]),
        title: "A dormir", kind: "night", hard: false, mode: "allow", list: NIGHT_ALLOW,
      });
    }
    for (const g of goals) {
      if (itemGoal(g.id)) continue;
      if (!sessionDays(g.sessions_per_week).includes(wd)) continue;
      if (g.due && day > Date.parse(g.due) + DAY) continue;
      const start = at(day, session);
      // logged a session already that day: nothing left to hold you to
      const logged = (db.prepare("SELECT COUNT(*) n FROM goal_logs WHERE goal_id = ? AND at >= ? AND at < ?").get(g.id, day, day + DAY) as { n: number }).n;
      if (logged) continue;
      windows.push({
        key: `goal:${g.id}:${date}`, start, end: start + g.session_minutes * 60_000,
        title: g.name, kind: "session", hard: false, mode: "deny", list: pulls,
      });
    }
  }

  // planned slots outside work hours hold you to them (work hours keep their own rule);
  // reading is mostly articles, so a reading slot also allows the browser
  const inWork = (ts: number) => {
    const d = startOfDay(ts);
    const work = workOn(d);
    if (!work) return false;
    return ts >= at(d, work[0]) && ts < at(d, work[1]);
  };
  // planned gaps are suggestions, not windows: nothing blocks you for not doing them then (what
  // holds you is a block you start yourself, work hours and the night)
  return {
    generatedAt: now,
    essentials: [...ESSENTIALS, ...config.alwaysAllow],
    guardHash: guardHash(),
    distractions: [...DISTRACTIONS, ...config.extraDistractions],
    scrollOnly: SCROLL_ONLY,
    closed: CLOSED,
    windows: windows.filter((w) => w.end > now).sort((a, b) => a.start - b.start),
    frictionSeconds: config.frictionSeconds,
    hardFrictionSeconds: config.hardFrictionSeconds,
    passMinutes: config.passMinutes,
    feedBudgetMinutes: config.feedBudgetMinutes,
    gameBudgetMinutes: config.gameBudgetMinutes,
  };
}

/** The window in force at `now`, preferring the most specific: focus > session > plan > night > work. */
export function activeWindow(p: Policy, now = Date.now()): Window | null {
  const rank = { focus: 0, session: 1, plan: 2, night: 3, work: 4 };
  return p.windows.filter((w) => w.start <= now && now < w.end).sort((a, b) => rank[a.kind] - rank[b.kind])[0] ?? null;
}

export function logExit(pkg: string, reason: string, windowKey: string, when = Date.now()): void {
  db.prepare("INSERT INTO policy_exits (at, pkg, reason, window_key) VALUES (?, ?, ?, ?)").run(when, pkg, reason.slice(0, 500), windowKey);
}

export function recentExits(since: number): { at: number; pkg: string; reason: string; window_key: string }[] {
  return db.prepare("SELECT at, pkg, reason, window_key FROM policy_exits WHERE at >= ? ORDER BY at DESC").all(since) as any[];
}
