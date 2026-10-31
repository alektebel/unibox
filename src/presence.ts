import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";

// Are you at work? The phone reports the Wi-Fi it's on; networks get a label once (the AI
// asks "¿Estás en el curro?" the first times it sees a frequent one on a weekday), and the
// labelled history becomes a per-weekday pattern that predicts work hours when there's no
// known Wi-Fi. Until there's data, the configured work hours stand in.

db.exec(`
CREATE TABLE IF NOT EXISTS presence (
  at INTEGER NOT NULL,
  net TEXT,
  ssid TEXT,
  charging INTEGER
);
CREATE INDEX IF NOT EXISTS idx_presence_at ON presence (at);
`);

const MIN = 60_000;
const DAY = 86_400_000;

export type Label = "work" | "home" | "other";

export interface Sample { net?: string; ssid?: string; charging?: boolean }

const weekday = (ts: number) => (new Date(ts).getDay() + 6) % 7;
const isWeekday = (ts: number) => weekday(ts) < 5;

/** A reading from the phone, at most one every five minutes. */
export function record(s: Sample, now = Date.now()): void {
  const last = db.prepare("SELECT at, net FROM presence ORDER BY at DESC LIMIT 1").get() as any;
  const net = s.net && s.net !== "none" ? s.net.slice(0, 64) : null;
  if (last && now - last.at < 5 * MIN && last.net === net) return;
  db.prepare("INSERT INTO presence (at, net, ssid, charging) VALUES (?, ?, ?, ?)")
    .run(now, net, s.ssid ? s.ssid.slice(0, 64) : null, s.charging ? 1 : 0);
}

export function labelOf(net: string | null): Label | null {
  if (!net) return null;
  const v = getMeta(`net_label:${net}`);
  return v === "work" || v === "home" || v === "other" ? v : null;
}

export function setLabel(net: string, label: Label): void {
  setMeta(`net_label:${net}`, label);
}

/** Where you are now, from the last reading if it's fresh (15 min). */
export function current(now = Date.now()): { state: "work" | "away" | "unknown"; net: string | null; ssid: string | null } {
  const last = db.prepare("SELECT * FROM presence WHERE at > ? ORDER BY at DESC LIMIT 1").get(now - 15 * MIN) as any;
  if (!last) return { state: "unknown", net: null, ssid: null };
  const l = labelOf(last.net);
  return { state: l === "work" ? "work" : l === "home" || l === "other" ? "away" : "unknown", net: last.net, ssid: last.ssid };
}

/**
 * Typical work hours for a weekday, learned from readings on networks labelled "work"
 * over the last four weeks: from the hour you usually arrive to the hour you usually leave.
 * Null when there isn't enough to go on (fewer than three such days).
 */
export function learnedHours(wd: number, now = Date.now()): [number, number] | null {
  const rows = db.prepare("SELECT at, net FROM presence WHERE at > ? AND net IS NOT NULL").all(now - 28 * DAY) as any[];
  const days = new Map<string, { first: number; last: number }>();
  for (const r of rows) {
    if (labelOf(r.net) !== "work") continue;
    const d = new Date(r.at);
    if ((d.getDay() + 6) % 7 !== wd) continue;
    const key = d.toDateString();
    const h = d.getHours() + d.getMinutes() / 60;
    const e = days.get(key) ?? { first: h, last: h };
    e.first = Math.min(e.first, h);
    e.last = Math.max(e.last, h);
    days.set(key, e);
  }
  if (days.size < 3) return null;
  const firsts = [...days.values()].map((d) => d.first).sort((a, b) => a - b);
  const lasts = [...days.values()].map((d) => d.last).sort((a, b) => a - b);
  const median = (a: number[]) => a[Math.floor(a.length / 2)];
  return [median(firsts), median(lasts)];
}

const toHHMM = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60) % 60).padStart(2, "0")}`;

/**
 * Work hours to use for a given day: learned for that weekday if there's enough history,
 * the configured ones otherwise; none on weekends, and none for the rest of today if you're
 * known to be away (home Wi-Fi) during them.
 */
export function workHoursFor(day: number, now = Date.now()): string | null {
  if (!isWeekday(day)) return null;
  const learned = learnedHours(weekday(day), now);
  const hours = learned ? `${toHHMM(learned[0])}-${toHHMM(learned[1])}` : config.workHours || null;
  if (!hours) return null;
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  if (day === today.getTime() && current(now).state === "away") {
    const [s, e] = hours.split("-");
    const [eh, em] = e.split(":").map(Number);
    const end = new Date(day); end.setHours(eh, em, 0, 0);
    // at home in the middle of the usual hours: the rest of today isn't work
    if (now < end.getTime()) return `${s}-${toHHMM(new Date(now).getHours() + new Date(now).getMinutes() / 60)}`;
  }
  return hours;
}

/**
 * A network you're on a lot on weekdays during the day that has no label yet: worth one
 * question. (Asked about once; "other" is a valid answer.)
 */
export function pendingQuestion(now = Date.now()): { net: string; ssid: string } | null {
  const c = current(now);
  if (!c.net || labelOf(c.net)) return null;
  if (Number(getMeta(`net_asked:${c.net}`) ?? 0) > now - DAY) return null;
  const seen = (db.prepare("SELECT at FROM presence WHERE net = ? AND at > ?").all(c.net, now - 14 * DAY) as any[])
    .filter((r) => isWeekday(r.at) && new Date(r.at).getHours() >= 8 && new Date(r.at).getHours() < 20);
  const days = new Set(seen.map((r) => new Date(r.at).toDateString()));
  return seen.length >= 3 || days.size >= 2 ? { net: c.net, ssid: c.ssid ?? "esta red" } : null;
}

export function answerQuestion(net: string, label: Label): void {
  setLabel(net, label);
  setMeta(`net_asked:${net}`, String(Date.now()));
}
