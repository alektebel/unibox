import { db } from "./db.js";

// Every conversation is kept, turn by turn, on the server: goal planning now, the assistant
// later. Nothing lives only on the phone's screen; an unfinished one resumes where it was.

db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- open | done | set_aside
  status TEXT NOT NULL DEFAULT 'open',
  result TEXT
);
CREATE TABLE IF NOT EXISTS chat_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_turns_chat ON chat_turns (chat_id, id);
`);

export interface Turn {
  role: "user" | "assistant";
  content: string;
  data?: any;
  at: number;
}

export function startChat(kind: string): number {
  const now = Date.now();
  return Number(db.prepare("INSERT INTO chats (kind, started_at, updated_at) VALUES (?, ?, ?)").run(kind, now, now).lastInsertRowid);
}

export function addTurn(chatId: number, role: Turn["role"], content: string, data?: unknown): void {
  const now = Date.now();
  db.prepare("INSERT INTO chat_turns (chat_id, at, role, content, data) VALUES (?, ?, ?, ?, ?)")
    .run(chatId, now, role, content, data == null ? null : JSON.stringify(data));
  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId);
}

export function turns(chatId: number): Turn[] {
  return (db.prepare("SELECT at, role, content, data FROM chat_turns WHERE chat_id = ? ORDER BY id").all(chatId) as any[])
    .map((t) => ({ at: t.at, role: t.role, content: t.content, ...(t.data ? { data: JSON.parse(t.data) } : {}) }));
}

export function chatExists(chatId: number, kind: string): boolean {
  return !!db.prepare("SELECT 1 FROM chats WHERE id = ? AND kind = ?").get(chatId, kind);
}

/** The most recent unfinished conversation of a kind, with its turns. */
export function openChat(kind: string): { id: number; turns: Turn[] } | null {
  const c = db.prepare("SELECT id FROM chats WHERE kind = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1").get(kind) as { id: number } | undefined;
  return c ? { id: c.id, turns: turns(c.id) } : null;
}

export function closeChat(chatId: number, status: "done" | "set_aside", result?: unknown): void {
  db.prepare("UPDATE chats SET status = ?, result = ?, updated_at = ? WHERE id = ?")
    .run(status, result == null ? null : JSON.stringify(result), Date.now(), chatId);
}

export function listChats(limit = 50): { id: number; kind: string; status: string; startedAt: number; updatedAt: number; first: string; turns: number }[] {
  return (db.prepare(`
    SELECT c.id, c.kind, c.status, c.started_at, c.updated_at,
      (SELECT content FROM chat_turns WHERE chat_id = c.id AND role = 'user' ORDER BY id LIMIT 1) first,
      (SELECT COUNT(*) FROM chat_turns WHERE chat_id = c.id) n
    FROM chats c ORDER BY c.updated_at DESC LIMIT ?`).all(limit) as any[])
    .map((c) => ({ id: c.id, kind: c.kind, status: c.status, startedAt: c.started_at, updatedAt: c.updated_at, first: c.first ?? "", turns: c.n }));
}
