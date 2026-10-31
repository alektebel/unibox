import { extractCommitments } from "./commitments.js";
import { db } from "./db.js";
import { config } from "./config.js";
import { llm, langLine } from "./llm.js";
import "./google.js"; // creates gm_messages

export interface TodoRow {
  source: string;
  ref: string;
  title: string | null;
  last_ts: number;
  last_from_me: number;
  state: string;
  state_reason: string | null;
  state_updated_at: number | null;
}

const NOREPLY_RE =
  /^(noreply|no-reply|donotreply|do-not-reply|notification|notifications|newsletter|marketing|support|billing|security|alerts|team|hello|info|contact|jobs?|linkedin)\b/i;

export function agingDays(lastTs: number): number {
  return Math.max(0, Math.floor((Date.now() - lastTs) / 86_400_000));
}

function upsertTodo(
  source: string,
  ref: string,
  title: string,
  lastTs: number,
  lastFromMe: number
): void {
  db.prepare(
    `INSERT INTO todos (source, ref, title, last_ts, last_from_me)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, ref) DO UPDATE SET
       title = excluded.title,
       last_ts = excluded.last_ts,
       last_from_me = excluded.last_from_me`
  ).run(source, ref, title, lastTs, lastFromMe);
}

function dirtyTodos(): TodoRow[] {
  return db
    .prepare(
      `SELECT * FROM todos
       WHERE state_updated_at IS NOT last_ts
       ORDER BY last_ts DESC
       LIMIT ?`
    )
    .all(config.classifyBatch) as unknown as TodoRow[];
}

export function syncWhatsappTodos(): void {
  const rows = db
    .prepare(
      `SELECT chat_jid,
              MAX(ts) AS last_ts,
              (SELECT from_me FROM wa_messages w2
               WHERE w2.chat_jid = w.chat_jid ORDER BY ts DESC LIMIT 1) AS last_from_me,
              (SELECT COALESCE(sender_name, chat_jid) FROM wa_messages w3
               WHERE w3.chat_jid = w.chat_jid AND from_me = 0
               ORDER BY ts DESC LIMIT 1) AS title
       FROM wa_messages w
       GROUP BY chat_jid`
    )
    .all() as { chat_jid: string; last_ts: number; last_from_me: number; title: string | null }[];
  for (const r of rows) {
    const name = (r.title ?? r.chat_jid.split("@")[0]).trim();
    upsertTodo("whatsapp", r.chat_jid, name, r.last_ts, r.last_from_me);
  }
}

function detectLiMe(): string {
  if (config.meName) return config.meName;
  const cached = db.prepare("SELECT value FROM meta WHERE key = 'li_me_name'").get() as
    | { value: string }
    | undefined;
  if (cached?.value) return cached.value;
  const froms = db
    .prepare("SELECT from_name n, COUNT(*) c FROM li_messages GROUP BY from_name")
    .all() as { n: string; c: number }[];
  const tos = new Map<string, number>();
  for (const r of db
    .prepare("SELECT to_name n, COUNT(*) c FROM li_messages GROUP BY to_name")
    .all() as { n: string; c: number }[]) {
    tos.set(r.n, r.c);
  }
  let best = "";
  let bestScore = 0;
  let bestTotal = 0;
  for (const { n, c } of froms) {
    const t = tos.get(n) ?? 0;
    const score = c * t;
    const total = c + t;
    if (
      score > bestScore ||
      (score === bestScore && (total > bestTotal || (total === bestTotal && n < best)))
    ) {
      bestScore = score;
      bestTotal = total;
      best = n;
    }
  }
  if (!best) {
    best = froms.sort((a, b) => b.c - a.c)[0]?.n ?? "";
  }
  // Only cache a real answer: an empty guess (no messages yet) used to stick forever.
  if (best) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('li_me_name', ?)").run(best);
  return best;
}

export function syncLinkedinTodos(): void {
  const liMe = detectLiMe();
  const rows = db
    .prepare(
      `SELECT conv_id,
              MAX(date) AS last_date,
              (SELECT from_name FROM li_messages l2
               WHERE l2.conv_id = l.conv_id ORDER BY date DESC LIMIT 1) AS last_from,
              (SELECT from_name FROM li_messages l3
               WHERE l3.conv_id = l.conv_id AND from_name != ? ORDER BY date DESC LIMIT 1) AS counterpart
       FROM li_messages l
       WHERE conv_id != ''
       GROUP BY conv_id`
    )
    .all(liMe) as {
    conv_id: string;
    last_date: string;
    last_from: string;
    counterpart: string | null;
  }[];
  for (const r of rows) {
    const lastTs = Date.parse(r.last_date.replace(" UTC", "Z"));
    const lastFromMe = r.last_from === liMe ? 1 : 0;
    const title = r.counterpart || r.conv_id;
    upsertTodo("linkedin", r.conv_id, title, lastTs, lastFromMe);
  }
}

// Gmail threads join the same todo layer as chats (source "email"), replacing mailos when Google is connected.
export function syncGmailTodos(): void {
  const rows = db
    .prepare(
      `SELECT thread_id,
              MAX(ts) AS last_ts,
              (SELECT from_me FROM gm_messages g2
               WHERE g2.thread_id = g.thread_id ORDER BY ts DESC LIMIT 1) AS last_from_me,
              (SELECT from_name FROM gm_messages g3
               WHERE g3.thread_id = g.thread_id AND from_me = 0 ORDER BY ts DESC LIMIT 1) AS title
       FROM gm_messages g
       GROUP BY thread_id`
    )
    .all() as { thread_id: string; last_ts: number; last_from_me: number; title: string | null }[];
  for (const r of rows) {
    upsertTodo("email", r.thread_id, (r.title ?? "me").trim(), r.last_ts, r.last_from_me);
  }
}

function gmailSenderAddr(threadId: string): string {
  const row = db
    .prepare("SELECT from_addr FROM gm_messages WHERE thread_id = ? AND from_me = 0 ORDER BY ts DESC LIMIT 1")
    .get(threadId) as { from_addr: string } | undefined;
  return row?.from_addr ?? "";
}

async function triage(
  source: string,
  todo: TodoRow
): Promise<{ state: string; lane: string; task: string; reason: string; failed?: boolean }> {
  if (todo.last_from_me) {
    return { state: "waiting-on-them", lane: "reply", task: "", reason: "last message is yours" };
  }
  const title = todo.title ?? "";
  const addr = source === "email" ? gmailSenderAddr(todo.ref) : "";
  if (NOREPLY_RE.test(title) || NOREPLY_RE.test(addr)) {
    return { state: "no-action", lane: "explore", task: "", reason: `automated sender (${title})` };
  }

  const recent = db
    .prepare(
      source === "whatsapp"
        ? `SELECT text FROM wa_messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 3`
        : source === "email"
          ? `SELECT (CASE WHEN from_me THEN '${(config.meFirst || "Me").replace(/'/g, "''")}' ELSE from_name END) || ' — ' || subject || ': ' || snippet AS text
             FROM gm_messages WHERE thread_id = ? ORDER BY ts DESC LIMIT 3`
          : `SELECT content AS text FROM li_messages WHERE conv_id = ? ORDER BY date DESC LIMIT 3`
    )
    .all(todo.ref) as { text: string }[];
  const text = recent
    .map((r) => r.text.slice(0, 500))
    .join("\n---\n");

  const prompt =
    `You triage ${config.meFirst || "the user"}'s ${source} chat with ${title}.\n\n${text}\n\n` +
    `Does ${config.meFirst || "the user"} need to personally reply to this to avoid dropping the ball?` +
    ` Automated noise, FYIs, newsletters, and things needing no answer are no-action.` +
    ` Reply JSON {"state":"needs-reply"|"no-action","lane":"reply"|"deadline"|"opportunity"|"explore","task":"imperative task, max 12 words","reason":"max 8 words"}` +
    langLine();
  try {
    const content = await llm([{ role: "user", content: prompt }], {
      json: true,
      temperature: 0,
    });
    const data = JSON.parse(content) as {
      state?: string;
      lane?: string;
      task?: string;
      reason?: string;
    };
    const state = data.state === "no-action" ? "no-action" : "needs-reply";
    const lane = ["reply", "deadline", "opportunity", "explore"].includes(
      data.lane ?? ""
    )
      ? (data.lane as string)
      : "reply";
    return {
      state,
      lane,
      task: (data.task ?? "").slice(0, 120),
      reason: (data.reason ?? "").slice(0, 80),
    };
  } catch (e) {
    console.error(`  classify failed for ${todo.source}/${todo.ref}: ${e}`);
    return {
      state: "needs-reply",
      lane: "reply",
      task: "",
      reason: "unclassified - kept for review",
      failed: true,
    };
  }
}

let classifying = false;

export async function classifyTodos(): Promise<number> {
  // The worker tick and an upload can both ask; one run at a time.
  if (classifying) return 0;
  classifying = true;
  try {
    return await classifyBatch();
  } finally {
    classifying = false;
  }
}

async function classifyBatch(): Promise<number> {
  syncWhatsappTodos();
  syncLinkedinTodos();
  syncGmailTodos();
  const batch = dirtyTodos();
  const deadline = Date.now() + config.classifyMinutes * 60_000;
  let done = 0;
  for (const todo of batch) {
    // agreed times, whoever wrote last (your "vale, el jueves a las 7" counts too)
    if (todo.source === "whatsapp" || todo.source === "email") {
      await extractCommitments(todo.source, todo.ref, todo.title ?? "").catch((e) => console.error(`  commitments failed for ${todo.source}/${todo.ref}: ${e}`));
    }
    const { state, lane, task, reason, failed } = await triage(todo.source, todo);
    // A failed LLM call stays dirty (state_updated_at NULL) so the next tick retries it.
    db.prepare(
      "UPDATE todos SET state = ?, state_reason = ?, state_updated_at = ?, lane = ?, task = ? WHERE source = ? AND ref = ?"
    ).run(state, reason, failed ? null : todo.last_ts, lane, task, todo.source, todo.ref);
    done++;
    if (Date.now() > deadline) break;
  }
  return done;
}

export function digestCounts(): {
  needsReply: number;
  overdue: number;
  waiting: number;
} {
  const needsReply = db
    .prepare("SELECT COUNT(*) n FROM todos WHERE state = 'needs-reply'")
    .get() as { n: number };
  const overdue = db
    .prepare(
      `SELECT COUNT(*) n FROM todos WHERE state = 'needs-reply' AND last_ts < ?`
    )
    .get(Date.now() - 7 * 86_400_000) as { n: number };
  const waiting = db
    .prepare("SELECT COUNT(*) n FROM todos WHERE state = 'waiting-on-them'")
    .get() as { n: number };
  return { needsReply: needsReply.n, overdue: overdue.n, waiting: waiting.n };
}
