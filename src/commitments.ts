import { db } from "./db.js";
import { llm } from "./llm.js";
import { config } from "./config.js";

// What your messages and email commit you to, and when: "quedamos el jueves a las 7", "la
// reunión es mañana a las 10", "entrégalo antes del viernes a las 14". Read from each
// conversation that has something new, whoever wrote last (your own "vale, el jueves a las 7"
// counts). The planner keeps that time free, the phone reminds you, Hoy shows it.

db.exec(`
CREATE TABLE IF NOT EXISTS commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  location TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (source, ref, start)
);
CREATE INDEX IF NOT EXISTS idx_commitments_start ON commitments (start);
`);

const MIN = 60_000;

export interface Commitment { id: number; source: string; ref: string; title: string; start: number; end: number; location: string | null }

function recentMessages(source: string, ref: string): { who: string; text: string; ts: number }[] {
  if (source === "whatsapp") {
    return (db.prepare("SELECT from_me, sender_name, text, ts FROM wa_messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 6").all(ref) as any[])
      .map((r) => ({ who: r.from_me ? (config.meFirst || "yo") : r.sender_name || "la otra persona", text: r.text ?? "", ts: r.ts }));
  }
  if (source === "email") {
    return (db.prepare("SELECT from_me, from_name, subject, snippet, ts FROM gm_messages WHERE thread_id = ? ORDER BY ts DESC LIMIT 4").all(ref) as any[])
      .map((r) => ({ who: r.from_me ? (config.meFirst || "yo") : r.from_name || "remitente", text: `${r.subject ?? ""}: ${r.snippet ?? ""}`, ts: r.ts }));
  }
  return [];
}

const stamp = (ts: number) => {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  return `${d.toLocaleDateString("es-ES", { weekday: "long" })} ${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
};

/** Read one conversation for agreed times; store what's in the future. */
export async function extractCommitments(source: string, ref: string, title: string, now = Date.now()): Promise<Commitment[]> {
  const msgs = recentMessages(source, ref);
  if (!msgs.length) return [];
  const convo = msgs.reverse().map((m) => `[${stamp(m.ts)}] ${m.who}: ${m.text.slice(0, 400)}`).join("\n");
  const out = await llm(
    [
      {
        role: "system",
        content:
          `Hoy es ${stamp(now)} (Europe/Madrid). Lees una conversación de ${source === "email" ? "correo" : "WhatsApp"} de ${config.meFirst || "el usuario"} con ${title || "alguien"}. ` +
          `Extrae solo compromisos con hora o día concretos que afecten a ${config.meFirst || "el usuario"}: quedadas, reuniones, llamadas, citas, entregas con hora. ` +
          `Resuelve "mañana", "el jueves", etc. respecto a la fecha del mensaje donde se dice. Ignora propuestas que nadie ha aceptado y cosas ya pasadas. ` +
          `Si no hay hora, usa 09:00 para entregas y no inventes quedadas sin día. ` +
          `Responde SOLO JSON {"items":[{"what":"título corto en español","start":"YYYY-MM-DDTHH:MM","minutes":60,"where":"lugar o vacío"}]} (lista vacía si no hay nada).`,
      },
      { role: "user", content: convo },
    ],
    { json: true, temperature: 0 }
  );
  const items = (JSON.parse(out).items ?? []) as any[];
  const saved: Commitment[] = [];
  for (const it of items) {
    const start = new Date(String(it.start)).getTime();
    if (!Number.isFinite(start) || start < now - 30 * MIN) continue;
    const end = start + Math.max(15, Math.min(480, Number(it.minutes) || 60)) * MIN;
    const what = String(it.what ?? "").slice(0, 120);
    if (!what) continue;
    db.prepare(
      `INSERT INTO commitments (source, ref, title, start, end, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, ref, start) DO UPDATE SET title = excluded.title, end = excluded.end, location = excluded.location`
    ).run(source, ref, what, start, end, String(it.where ?? "").slice(0, 120) || null, now);
    saved.push(db.prepare("SELECT * FROM commitments WHERE source = ? AND ref = ? AND start = ?").get(source, ref, start) as unknown as Commitment);
  }
  return saved;
}

/** Commitments overlapping a time range (the planner keeps them free; Hoy shows them). */
export function commitmentsBetween(from: number, to: number): Commitment[] {
  return db.prepare("SELECT * FROM commitments WHERE end > ? AND start < ? ORDER BY start").all(from, to) as unknown as Commitment[];
}
