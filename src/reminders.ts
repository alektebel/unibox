import { itemGoal } from "./slate.js";
import { addDays } from "./days.js";
import { db, getMeta } from "./db.js";
import { streak, journalAt } from "./journal.js";
import { config } from "./config.js";
import { upcomingEvents } from "./google.js";
import { aiReminders } from "./aitasks.js";
import { commitmentsBetween } from "./commitments.js";
import { wrapAt } from "./assistant.js";

// The week of phone reminders. The Android app schedules these locally (AlarmManager),
// so they fire with the app closed and without a push service; every launch replaces them.

const DAY = 86_400_000;
const HORIZON_DAYS = 7;

export interface Reminder {
  /** stable across rebuilds, so rescheduling replaces instead of duplicating */
  key: string;
  at: number;
  title: string;
  body: string;
  /** what tapping it opens in the app ("chat": the conversation with the AI) */
  open?: string;
}

/** "19:00" → [19, 0]; anything unparsable falls back. */
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

function startOfDay(ts = Date.now()): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday-based weekday, 0..6 */
function weekday(ts: number): number {
  return (new Date(ts).getDay() + 6) % 7;
}

/** n sessions spread over the week: 3 → Mon, Wed, Fri; 2 → Tue, Fri; 7 → every day. */
export function sessionDays(n: number): number[] {
  const k = Math.max(0, Math.min(7, Math.round(n)));
  if (!k) return [];
  const step = 7 / k;
  const offset = k === 2 ? 1 : 0;
  return [...new Set(Array.from({ length: k }, (_, i) => (Math.round(i * step) + offset) % 7))].sort();
}

export function reminders(now = Date.now()): Reminder[] {
  const out: Reminder[] = [];
  const today = startOfDay(now);
  const morning: [number, number] = [config.digestHour, 0];
  const exercise = config.exerciseAt ? hm(config.exerciseAt, [19, 0]) : null;
  const session = hm(config.sessionAt, [18, 0]);
  const goals = db.prepare("SELECT * FROM goals WHERE archived = 0").all() as any[];

  // Monday of this week, for "already done this week" checks
  const weekStart = today - weekday(today) * DAY;
  const doneThisWeek = new Map<number, number>();
  for (const g of goals) {
    doneThisWeek.set(
      g.id,
      (db.prepare("SELECT COUNT(*) n FROM goal_logs WHERE goal_id = ? AND at >= ?").get(g.id, weekStart) as { n: number }).n
    );
  }

  const paused = getMeta("tasks_paused") === "1";
  for (let i = 0; i < HORIZON_DAYS && !paused; i++) {
    const day = addDays(today, i);
    const date = localDate(day);
    out.push({ key: `morning:${date}`, at: at(day, morning), title: "Buenos días", body: "Cuéntame qué tienes hoy y lo organizo.", open: "chat" });
    if (exercise) {
      out.push({ key: `exercise:${date}`, at: at(day, exercise), title: "Hora de moverte", body: "30 minutos de ejercicio. Luego lo marcas en Unibox." });
    }
    const wd = weekday(day);
    for (const g of goals) {
      if (itemGoal(g.id)) continue;
      if (!sessionDays(g.sessions_per_week).includes(wd)) continue;
      // this week's target already met: don't nag for the rest of it
      if (day < weekStart + 7 * DAY && (doneThisWeek.get(g.id) ?? 0) >= g.sessions_per_week) continue;
      if (g.due && day > Date.parse(g.due) + DAY) continue;
      out.push({ key: `goal:${g.id}:${date}`, at: at(day, session), title: g.name, body: `Sesión de hoy: ${g.session_minutes} min. Empieza un bloque desde Hoy.` });
    }
  }

  // Things you planned for a time today
  for (const a of paused ? [] : db.prepare("SELECT * FROM agenda WHERE created_at >= ?").all(today) as any[]) {
    if (!/^\d{2}:\d{2}$/.test(a.time)) continue;
    out.push({ key: `agenda:${a.id}`, at: at(today, hm(a.time, [9, 0])), title: a.title, body: "Lo planificaste para ahora." });
  }

  // Calendar: ten minutes before each timed event
  for (const e of upcomingEvents(HORIZON_DAYS)) {
    if (e.all_day) continue;
    const when = new Date(e.start_ts).toTimeString().slice(0, 5);
    out.push({ key: `cal:${e.id}`, at: e.start_ts - 10 * 60_000, title: e.title, body: `A las ${when}${e.location ? ` · ${e.location}` : ""}` });
  }

  // reminders you asked the AI for
  if (!paused) out.push(...aiReminders(now));
  // and from the set hour, the day's review
  for (let i = 0; i < HORIZON_DAYS && !paused; i++) {
    const day = addDays(today, i);
    const t = wrapAt(day);
    const date = localDate(day);
    if (db.prepare("SELECT 1 FROM plan_slots WHERE date = ? LIMIT 1").get(date)) {
      out.push({ key: `wrap:${date}`, at: t, title: "Repasamos el día", body: "Cuéntame cómo ha ido y vemos lo de mañana.", open: "chat" });
    }
  }
  // the journal, every evening it isn't written yet
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const day = addDays(today, i);
    if (i === 0 && streak(now).today) continue;
    out.push({ key: `journal:${localDate(day)}`, at: journalAt(day), title: "Diario", body: "Tres líneas sobre hoy y tu meta.", open: "diario" });
  }
  // what your messages committed you to, 15 minutes before
  for (const c of commitmentsBetween(now, now + HORIZON_DAYS * DAY)) {
    const when = new Date(c.start).toTimeString().slice(0, 5);
    out.push({ key: `commit:${c.id}`, at: c.start - 15 * 60_000, title: c.title, body: `A las ${when}${c.location ? ` · ${c.location}` : ""}` });
  }

  return out.filter((r) => r.at > now).sort((a, b) => a.at - b.at);
}
