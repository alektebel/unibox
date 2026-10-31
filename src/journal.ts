import { db } from "./db.js";
import { config } from "./config.js";
import { localDate } from "./planner.js";
import { addDays } from "./days.js";

// The journal: a few lines a day, next to the goals. The questions come from the day itself
// (what got done, the goal you're on, what the phone saw); what you write is kept whole and
// the evening review and the AI can read it back.

db.exec(`
CREATE TABLE IF NOT EXISTS journal (
  date TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  prompts TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

const DAY = 86_400_000;

export interface Entry { date: string; text: string; prompts: string[]; updated_at: number }

/** Today's questions: three, from the day and the goal you're on. */
export function prompts(now = Date.now()): string[] {
  const date = localDate(now);
  const done = (db.prepare("SELECT title FROM plan_slots WHERE date = ? AND status = 'done' ORDER BY start").all(date) as any[]).map((r) => r.title);
  const goal = db.prepare("SELECT id, name FROM goals WHERE archived = 0 ORDER BY created_at DESC LIMIT 1").get() as any;
  const out: string[] = [];
  if (goal) out.push(`¿Qué has avanzado hoy en «${goal.name}»? ¿Y qué es lo siguiente?`);
  out.push(done.length ? `Has cerrado ${done.length === 1 ? `«${done[0]}»` : `${done.length} cosas`}. ¿Qué te llevas de ello?` : "¿Qué ha pasado hoy que merezca recordarse?");
  out.push("¿Qué te ha frenado o distraído, y qué harías distinto mañana?");
  return out;
}

export function entry(date: string): Entry | null {
  const r = db.prepare("SELECT * FROM journal WHERE date = ?").get(date) as any;
  return r ? { date: r.date, text: r.text, prompts: r.prompts ? JSON.parse(r.prompts) : [], updated_at: r.updated_at } : null;
}

/** Save the day's entry (writing again the same day replaces it: it's one page per day). */
export function save(text: string, now = Date.now()): Entry {
  const date = localDate(now);
  const clean = text.trim().slice(0, 20_000);
  db.prepare(
    `INSERT INTO journal (date, text, prompts, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`
  ).run(date, clean, JSON.stringify(prompts(now)), now, now);
  return entry(date)!;
}

export function recent(limit = 14): Entry[] {
  return (db.prepare("SELECT * FROM journal WHERE text != '' ORDER BY date DESC LIMIT ?").all(limit) as any[])
    .map((r) => ({ date: r.date, text: r.text, prompts: r.prompts ? JSON.parse(r.prompts) : [], updated_at: r.updated_at }));
}

/** Days written this week and the run of days in a row up to today (or yesterday, if today isn't written yet). */
export function streak(now = Date.now()): { week: number; run: number; today: boolean } {
  const written = new Set((db.prepare("SELECT date FROM journal WHERE text != '' AND date >= ?").all(localDate(now - 60 * DAY)) as any[]).map((r) => r.date));
  const today = written.has(localDate(now));
  let run = 0;
  for (let i = today ? 0 : 1; written.has(localDate(addDays(now, -i))); i++) run++;
  let week = 0;
  for (let i = 0; i < 7; i++) if (written.has(localDate(addDays(now, -i)))) week++;
  return { week, run, today };
}

export function journalAt(day: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(config.journalAt) ?? ["", "22", "00"];
  const d = new Date(day);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

/** For Metas and the journal screen. */
export function journalPayload(now = Date.now()) {
  return { ...streak(now), prompts: prompts(now), todayText: entry(localDate(now))?.text ?? "", recent: recent(14) };
}
