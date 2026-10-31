import { db } from "./db.js";
import { llm } from "./llm.js";
import { config } from "./config.js";
import { addEvent } from "./capture/ingest.js";
import { googleConnected, createCalendarEvent } from "./google.js";

// Things the AI does instead of listing them for you: putting something in the calendar,
// setting a reminder. They never show up in your to-dos; what can't be done yet (no Google)
// waits here and is done the moment it can be.

db.exec(`
CREATE TABLE IF NOT EXISTS ai_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT,
  -- queued | waiting_google | done | failed
  status TEXT NOT NULL DEFAULT 'queued',
  result TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
`);

// matched without accents ("apúntame", "recuérdame")
const CALENDAR = /\b(anot\w*|apunt\w*|anad\w*|pon\w*|met\w*|agend\w*|add|put)\b.{0,40}\b(calendario|agenda|calendar)\b/i;
const REMIND = /\b(recuerd\w*|recordatorio|avisa\w*|remind)\b/i;

/** Is this something the AI can just do? */
export function aiKind(title: string): "calendar" | "reminder" | null {
  const t = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (CALENDAR.test(t)) return "calendar";
  if (REMIND.test(t)) return "reminder";
  return null;
}

export interface AiTask { id: number; item_id: string; kind: string; title: string; payload: string | null; status: string; result: string | null }

/** Take AI-doable items out of your list and into the AI's queue. */
export function adoptAiItems(): number {
  const rows = db.prepare("SELECT id, title, raw FROM items WHERE state IN ('active', 'inbox')").all() as any[];
  let n = 0;
  for (const r of rows) {
    const kind = aiKind(r.title || r.raw || "");
    if (!kind) continue;
    db.prepare("INSERT OR IGNORE INTO ai_tasks (item_id, kind, title, created_at) VALUES (?, ?, ?, ?)").run(r.id, kind, r.title || r.raw, Date.now());
    db.prepare("UPDATE items SET state = 'ai' WHERE id = ?").run(r.id);
    addEvent(r.id, "ai", kind);
    n++;
  }
  return n;
}

/** Turn the text into a concrete event or reminder (dates resolved against today). */
async function parse(task: AiTask): Promise<any> {
  const now = new Date();
  const out = await llm(
    [
      {
        role: "system",
        content:
          `Hoy es ${now.toISOString().slice(0, 10)} (${now.toLocaleDateString("es-ES", { weekday: "long" })}), zona horaria Europe/Madrid. ` +
          `Convierte la petición en un ${task.kind === "calendar" ? "evento de calendario" : "recordatorio"}. Responde SOLO JSON: ` +
          (task.kind === "calendar"
            ? `{"title":"título corto del evento","start":"YYYY-MM-DDTHH:MM","end":"YYYY-MM-DDTHH:MM","location":"lugar o vacío"} (si no dice duración, 1 hora)`
            : `{"text":"qué recordar","at":"YYYY-MM-DDTHH:MM"}`),
      },
      { role: "user", content: task.title },
    ],
    { json: true, temperature: 0 }
  );
  return JSON.parse(out);
}

let running = false;

/** Do what can be done now; leave the rest waiting for what it needs. */
export async function runAiTasks(): Promise<void> {
  if (running || !config.nanApiKey) return;
  running = true;
  try {
    adoptAiItems();
    const open = db.prepare("SELECT * FROM ai_tasks WHERE status IN ('queued', 'waiting_google')").all() as unknown as AiTask[];
    for (const t of open) {
      try {
        const payload = t.payload ? JSON.parse(t.payload) : await parse(t);
        if (!t.payload) db.prepare("UPDATE ai_tasks SET payload = ? WHERE id = ?").run(JSON.stringify(payload), t.id);
        if (t.kind === "calendar") {
          if (!googleConnected()) {
            db.prepare("UPDATE ai_tasks SET status = 'waiting_google' WHERE id = ?").run(t.id);
            continue;
          }
          const link = await createCalendarEvent(payload.title, new Date(payload.start).getTime(), new Date(payload.end).getTime(), payload.location || "");
          finish(t, link);
        } else {
          // reminders go out through the phone's own alarms (see reminders.ts)
          finish(t, `recordatorio ${payload.at}`);
        }
      } catch (e) {
        db.prepare("UPDATE ai_tasks SET status = 'failed', result = ? WHERE id = ?").run(String(e instanceof Error ? e.message : e).slice(0, 300), t.id);
      }
    }
  } finally {
    running = false;
  }
}

function finish(t: AiTask, result: string): void {
  db.prepare("UPDATE ai_tasks SET status = 'done', result = ?, done_at = ? WHERE id = ?").run(result, Date.now(), t.id);
  db.prepare("UPDATE items SET state = 'done' WHERE id = ?").run(t.item_id);
  addEvent(t.item_id, "done", `ia: ${result}`);
}

/** Reminders the AI set, for the phone's alarm list. */
export function aiReminders(now = Date.now()): { key: string; at: number; title: string; body: string }[] {
  return (db.prepare("SELECT * FROM ai_tasks WHERE kind = 'reminder' AND payload IS NOT NULL").all() as unknown as AiTask[])
    .map((t) => ({ t, p: JSON.parse(t.payload!) }))
    .map(({ t, p }) => ({ key: `ai:${t.id}`, at: new Date(p.at).getTime(), title: "Recordatorio", body: String(p.text ?? t.title) }))
    .filter((r) => Number.isFinite(r.at) && r.at > now);
}

/** What the AI is holding: shown only where the missing connection is, never as a to-do. */
export function aiWaiting(): { title: string; needs: string }[] {
  return (db.prepare("SELECT title FROM ai_tasks WHERE status = 'waiting_google' ORDER BY created_at").all() as any[])
    .map((r) => ({ title: r.title, needs: "google" }));
}
