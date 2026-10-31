import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

export interface MailTodo {
  id: string;
  subject: string;
  fromAddr: string;
  snippet: string;
  state: string;
  lastDate: number;
}

function normalizeEpoch(v: number): number {
  if (v > 1e12) return v;
  if (v > 1e9) return v * 1000;
  return v;
}

export function mailosTodos(): MailTodo[] {
  let mailos: DatabaseSync;
  try {
    mailos = new DatabaseSync(`file:${config.mailosDb}?mode=ro`, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = mailos
      .prepare(
        `SELECT t.id,
                COALESCE(NULLIF(t.subject, ''), NULLIF(m.subject, ''), '(no subject)') AS subject,
                m.from_addr,
                COALESCE(NULLIF(t.snippet, ''), substr(m.body, 1, 180)) AS snippet,
                t.state,
                t.last_message_date
         FROM threads t
         LEFT JOIN messages m ON m.id = (
           SELECT id FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1
         )
         WHERE t.state IN ('needs-reply', 'waiting-on-them')
         ORDER BY t.last_message_date DESC
         LIMIT 100`
      )
      .all() as {
      id: string;
      subject: string;
      from_addr: string | null;
      snippet: string;
      state: string;
      last_message_date: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      fromAddr: r.from_addr ?? "",
      snippet: r.snippet.replace(/\s+/g, " ").trim(),
      state: r.state,
      lastDate: normalizeEpoch(r.last_message_date),
    }));
  } finally {
    mailos.close();
  }
}
