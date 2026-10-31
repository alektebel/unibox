import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { config } from "./config.js";

export const db = new DatabaseSync(path.join(config.dataDir, "unibox.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS wa_messages (
  id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  sender TEXT,
  sender_name TEXT,
  text TEXT,
  ts INTEGER NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wa_ts ON wa_messages (ts);
CREATE INDEX IF NOT EXISTS idx_wa_chat ON wa_messages (chat_jid);

CREATE TABLE IF NOT EXISTS li_messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT,
  from_name TEXT,
  to_name TEXT,
  content TEXT,
  date TEXT
);
CREATE INDEX IF NOT EXISTS idx_li_date ON li_messages (date);

CREATE TABLE IF NOT EXISTS todos (
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT,
  last_ts INTEGER NOT NULL,
  last_from_me INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  state_reason TEXT,
  state_updated_at INTEGER,
  PRIMARY KEY (source, ref)
);
CREATE INDEX IF NOT EXISTS idx_todos_state ON todos (state);

CREATE TABLE IF NOT EXISTS agenda (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  title TEXT NOT NULL,
  meta TEXT,
  bar TEXT NOT NULL DEFAULT 'accent',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  wa_msg_id TEXT,
  kind TEXT NOT NULL DEFAULT 'note',
  raw TEXT,
  url TEXT,
  title TEXT,
  summary TEXT,
  transcript TEXT,
  media_path TEXT,
  thumb_path TEXT,
  tags TEXT,
  action TEXT,
  effort_min INTEGER,
  context TEXT,
  priority REAL,
  urgency INTEGER,
  importance INTEGER,
  batch_key TEXT,
  content_hash TEXT,
  state TEXT NOT NULL DEFAULT 'inbox',
  snooze_until INTEGER,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_state ON items (state);
CREATE INDEX IF NOT EXISTS idx_items_created ON items (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_hash ON items (content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_item_events_item ON item_events (item_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

for (const col of ["lane", "task"]) {
  try {
    db.exec(`ALTER TABLE todos ADD COLUMN ${col} TEXT`);
  } catch {
  }
}

// a priority you (or the chat) set: the worker's aging formula leaves it alone
try {
  db.exec("ALTER TABLE items ADD COLUMN priority_set REAL");
} catch {
}

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
