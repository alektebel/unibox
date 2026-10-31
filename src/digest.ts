import fs from "node:fs";
import path from "node:path";
import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";
import { llm } from "./llm.js";
import { mailosTodos } from "./sources/mailos.js";
import { ingestLinkedin } from "./sources/linkedin.js";
import { agingDays, digestCounts, syncWhatsappTodos, syncLinkedinTodos, syncGmailTodos } from "./classify.js";
import { googleConnected, upcomingEvents } from "./google.js";

/** YYYY-MM-DD in local time; toISOString() is UTC and names the file after yesterday past midnight. */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function windowStart(): number {
  const last = getMeta("last_digest_at");
  if (last) return Number(last);
  return Date.now() - config.digestWindowHours * 3600 * 1000;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function buildMailSection(): string {
  // Gmail threads are already in the todo layer when Google is connected.
  if (googleConnected()) return "";
  const todos = mailosTodos();
  if (!todos.length) return "EMAIL: no open items.\n";
  const lines = todos.map((t) => {
    const age = agingDays(t.lastDate);
    return `- [${t.state}${age > 0 ? `, ${age}d old` : ""}] "${t.subject}" from ${t.fromAddr.split(",")[0]} | ${t.snippet.slice(0, 140)} | last: ${fmtDate(t.lastDate)}`;
  });
  return `EMAIL (from mailos, open todos):\n${lines.join("\n").slice(0, config.maxCharsPerSource)}\n`;
}

function buildCalendarSection(): string {
  if (!googleConnected()) return "";
  const events = upcomingEvents(2);
  if (!events.length) return "CALENDAR: nothing scheduled today or tomorrow.\n";
  const lines = events.map(
    (e) => `- ${e.all_day ? new Date(e.start_ts).toDateString() + " (all day)" : fmtDate(e.start_ts)} ${e.title}${e.location ? ` @ ${e.location}` : ""}`
  );
  return `CALENDAR (today and tomorrow — use it to say when things can fit):\n${lines.join("\n")}\n`;
}

function buildTodosSection(): string {
  syncWhatsappTodos();
  syncLinkedinTodos();
  syncGmailTodos();
  const rows = db
    .prepare(
      `SELECT * FROM todos WHERE state IN ('needs-reply', 'waiting-on-them')
       ORDER BY last_ts ASC`
    )
    .all() as {
    source: string;
    ref: string;
    title: string | null;
    last_ts: number;
    state: string;
    state_reason: string | null;
  }[];
  if (!rows.length) return "CHAT TODOS: none.\n";
  const lines = rows.map(
    (r) =>
      `- [${r.source}/${r.state}${agingDays(r.last_ts) > 0 ? `, ${agingDays(r.last_ts)}d old` : ""}] ${r.title} (${r.state_reason ?? ""}) | last: ${fmtDate(r.last_ts)}`
  );
  return `TODOS (classified Gmail threads [email] and WhatsApp/LinkedIn chats):\n${lines.join("\n").slice(0, config.maxCharsPerSource)}\n`;
}

function buildWhatsappSection(since: number): string {
  const rows = db
    .prepare(
      `SELECT chat_jid, sender_name, text, ts, from_me
       FROM wa_messages WHERE ts > ? AND text IS NOT NULL
       ORDER BY ts ASC LIMIT 500`
    )
    .all(since) as {
    chat_jid: string;
    sender_name: string | null;
    text: string;
    ts: number;
    from_me: number;
  }[];
  if (!rows.length) return "WHATSAPP: no messages in window.\n";
  const byChat = new Map<string, string[]>();
  for (const r of rows) {
    const who = r.from_me ? "me" : (r.sender_name ?? "unknown");
    const line = `[${fmtDate(r.ts)}] ${who}: ${r.text.slice(0, 300)}`;
    const arr = byChat.get(r.chat_jid) ?? [];
    arr.push(line);
    byChat.set(r.chat_jid, arr);
  }
  let out = `WHATSAPP (${rows.length} messages in window):\n`;
  for (const [chat, lines] of byChat) {
    out += `\n--- chat ${chat} ---\n${lines.join("\n")}\n`;
  }
  return out.slice(0, config.maxCharsPerSource) + "\n";
}

function buildLinkedinSection(since: string): string {
  const rows = db
    .prepare(
      `SELECT from_name, to_name, content, date FROM li_messages
       WHERE date > ? ORDER BY date ASC LIMIT 200`
    )
    .all(since) as {
    from_name: string;
    to_name: string;
    content: string;
    date: string;
  }[];
  if (!rows.length) return "LINKEDIN: no messages in window.\n";
  const lines = rows.map(
    (r) => `- [${r.date}] ${r.from_name} -> ${r.to_name}: ${r.content.slice(0, 300)}`
  );
  return `LINKEDIN:\n${lines.join("\n").slice(0, config.maxCharsPerSource)}\n`;
}

export async function digest(): Promise<string> {
  ingestLinkedin();
  const sinceTs = windowStart();
  const sinceLi =
    new Date(sinceTs).toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const context = [
    buildMailSection(),
    buildCalendarSection(),
    buildTodosSection(),
    buildWhatsappSection(sinceTs),
    buildLinkedinSection(sinceLi),
  ].join("\n");

  const today = localDate();
  const md = await llm([
    {
      role: "system",
      content:
        "You are a personal inbox digest assistant. You receive a classified todo layer plus raw inbox data from email, WhatsApp and LinkedIn, plus today's calendar. Produce a markdown digest. Be concrete: name people, quote the essential ask, propose the next action. Never invent items that are not in the data.",
    },
    {
      role: "user",
      content: `Window started: ${fmtDate(sinceTs)}. Today: ${today}.

${context}

Produce a markdown digest with exactly these sections:

# Inbox digest ${today}

## Needs action
(numbered list: source, who, what they want, suggested action; oldest first)

## Waiting on them
(items where I wrote last and no answer, or I am blocked on someone)

## Worth knowing
(important but no action needed)

## Skipped noise
(one line summarizing what was ignored and why)

Then a final section:

## Todo checklist
- [ ] (every concrete action, ordered by priority)`,
    },
  ]);

  const file = path.join(config.digestsDir, `${today}.md`);
  fs.writeFileSync(file, md, { flag: "a" });
  setMeta("last_digest_at", String(Date.now()));
  return md;
}

export { digestCounts };
