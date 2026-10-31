import { db } from "./db.js";
import { localDate } from "./planner.js";
import { addDays } from "./days.js";

// Sleep, as the phone estimated it (last use of the night to the alarm or the first pickup):
// one row a night, kept so the stats can be read back.

db.exec(`
CREATE TABLE IF NOT EXISTS sleep (
  date TEXT PRIMARY KEY,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  minutes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

/** The night that ended at `end`, under the day you woke up on. False if it can't be a night's sleep. */
export function record(start: number, end: number): boolean {
  const minutes = Math.round((end - start) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 180 || minutes > 16 * 60 || end > Date.now() + 60_000) return false;
  db.prepare(
    `INSERT INTO sleep (date, start_ts, end_ts, minutes, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET start_ts = excluded.start_ts, end_ts = excluded.end_ts, minutes = excluded.minutes, updated_at = excluded.updated_at`
  ).run(localDate(end), start, end, minutes, Date.now());
  return true;
}

export function sleepPayload(now = Date.now()) {
  const since = localDate(addDays(now, -29));
  const nights = (db.prepare("SELECT date, start_ts AS start, end_ts AS end, minutes FROM sleep WHERE date >= ? ORDER BY date DESC").all(since) as any[]);
  const week = nights.slice(0, 7);
  const avg = (xs: any[]) => (xs.length ? Math.round(xs.reduce((s, n) => s + n.minutes, 0) / xs.length) : null);
  return {
    nights,
    avg7: avg(week),
    avg30: avg(nights),
    shortest: nights.length ? nights.reduce((a, b) => (b.minutes < a.minutes ? b : a)) : null,
    longest: nights.length ? nights.reduce((a, b) => (b.minutes > a.minutes ? b : a)) : null,
  };
}
