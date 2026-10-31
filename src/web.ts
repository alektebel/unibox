import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import QRCode from "qrcode";
import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";
import * as journal from "./journal.js";
import * as sleep from "./sleep.js";
import * as guardian from "./guardian.js";
import { digest, digestCounts } from "./digest.js";
import { classifyTodos, syncWhatsappTodos, syncLinkedinTodos, syncGmailTodos } from "./classify.js";
import { mailosTodos } from "./sources/mailos.js";
import { ingestLinkedin } from "./sources/linkedin.js";
import { ingestWhatsappExports, looksLikeExport } from "./sources/whatsapp-export.js";
import { unzip } from "./sources/zip.js";

/** The files of a WhatsApp export, if that's what was shared (.txt, or .zip with the chat and its media). */
function whatsappExport(name: string, buf: Buffer): { name: string; data: Buffer }[] | null {
  try {
    if (/\.txt$/i.test(name) && looksLikeExport(buf.toString("utf8"))) return [{ name: name.replace(/\.txt$/i, "") + ".txt", data: buf }];
    if (/\.zip$/i.test(name) || buf.readUInt32LE(0) === 0x04034b50) {
      const files = unzip(buf);
      const chat = files.find((f) => /\.txt$/i.test(f.name) && looksLikeExport(f.data.toString("utf8")));
      return chat ? files.filter((f) => f.data.length < 25 * 1024 * 1024) : null;
    }
  } catch {
  }
  return null;
}
import { ingestNotes } from "./capture/notes.js";
import { capture, captureBlob, mediaKind, addEvent } from "./capture/ingest.js";
import { processItems } from "./capture/process.js";
import { nudgeStatus, sendNudge, setAvailable } from "./nudge.js";
import { pushConfigured, pushPublicKey, removeSubscription, saveSubscription, subscriptionCount } from "./push.js";
import { ownJid, waPairCode, waStart, waStop, waStatus } from "./wamanager.js";
import {
  authUrl,
  dropSession,
  googleAccount,
  googleConfigured,
  googleConnected,
  googleLoginEnabled,
  googleSignOut,
  handleCallback,
  newSession,
  syncGoogle,
  upcomingEvents,
  validSession,
} from "./google.js";
import { hasLlm } from "./llm.js";
import { policy, logExit } from "./policy.js";
import * as github from "./github.js";
import { answerAsk, closeRef, reopenRef, checkIn, ensurePlan, markDone, moveSlot, notYet } from "./planner.js";
import { addItems, archiveAll, restoreArchive } from "./slate.js";
import { record as recordPresence, answerQuestion } from "./presence.js";
import * as assistant from "./assistant.js";
import { addTurn, chatExists, closeChat, listChats, openChat, startChat, turns as chatTurns } from "./chats.js";
import { archiveGoal, createGoal, goalChat, keepDue, logGoal, mobilePayload, skipNow, startBlock, stopBlock } from "./mobile.js";

const webDir = path.join(config.root, "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const MARKS: Record<string, string> = {
  whatsapp: "WA",
  linkedin: "in",
  email: "@",
};
const SRC_NAMES: Record<string, string> = {
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
  email: "Email",
};

function normalizeTs(ts: number): number {
  if (ts > 1e12) return ts;
  if (ts > 1e9) return ts * 1000;
  return ts;
}

function ago(rawTs: number): string {
  const ts = normalizeTs(rawTs);
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface Item {
  id: string;
  src: string;
  mark: string;
  srcName: string;
  handle: string;
  ago: string;
  lane: string;
  isNew: boolean;
  title: string;
  gist: string;
  why: string;
  agentLine: string;
  lastTs: number;
  raw: { t: string; text: string }[];
}

function rawMessages(source: string, ref: string): { t: string; text: string }[] {
  if (source === "email") {
    return (
      db
        .prepare(
          "SELECT from_name, subject, snippet, ts, from_me FROM gm_messages WHERE thread_id = ? ORDER BY ts DESC LIMIT 3"
        )
        .all(ref) as any[]
    )
      .reverse()
      .map((r) => ({
        t: new Date(r.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
        text: `${r.from_me ? "me" : r.from_name}: ${r.subject ? `[${r.subject}] ` : ""}${r.snippet}`.slice(0, 300),
      }));
  }
  const q =
    source === "whatsapp"
      ? db
          .prepare(
            "SELECT sender_name, text, ts FROM wa_messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 3"
          )
          .all(ref)
      : db
          .prepare(
            "SELECT from_name AS sender_name, content AS text, date FROM li_messages WHERE conv_id = ? ORDER BY date DESC LIMIT 3"
          )
          .all(ref) as any[];
  return (q as any[])
    .reverse()
    .map((r) => ({
      t:
        source === "whatsapp"
          ? new Date(r.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
          : String(r.date).slice(11, 16),
      text: `${r.sender_name ? r.sender_name + ": " : ""}${r.text}`.slice(0, 300),
    }));
}

function buildItems(digestAt: number): Item[] {
  const items: Item[] = [];
  const todos = db
    .prepare(
      `SELECT * FROM todos WHERE state = 'needs-reply' ORDER BY last_ts DESC`
    )
    .all() as any[];
  for (const t of todos) {
    const raw = rawMessages(t.source, t.ref);
    const lastText = raw.length ? raw[raw.length - 1].text : "";
    items.push({
      id: `${t.source}:${t.ref}`,
      src: t.source,
      mark: MARKS[t.source] ?? "•",
      srcName: SRC_NAMES[t.source] ?? t.source,
      handle: t.title ?? "",
      ago: ago(t.last_ts),
      lane: t.lane ?? "reply",
      isNew: t.last_ts > digestAt,
      title: (t.task || lastText || "(no content)").slice(0, 140),
      gist: (t.task ? lastText : "").slice(0, 160),
      why: t.state_reason ?? "",
      agentLine: `Triage · ${t.state_reason ?? ""}`,
      lastTs: t.last_ts,
      raw,
    });
  }
  for (const m of googleConnected() ? [] : mailosTodos()) {
    if (m.state !== "needs-reply") continue;
    if (getMeta(`dismissed:email:${m.id}`) === "1") continue;
    items.push({
      id: `email:${m.id}`,
      src: "email",
      mark: "@",
      srcName: "Email",
      handle: m.fromAddr.split(",")[0],
      ago: ago(m.lastDate),
      lane: "reply",
      isNew: m.lastDate > digestAt,
      title: m.subject.slice(0, 140),
      gist: m.snippet.slice(0, 160),
      why: "mailos classified this thread as needing a reply",
      agentLine: "mailos · needs-reply",
      lastTs: m.lastDate,
      raw: [],
    });
  }
  return items;
}

function buildArrivals(): { t: string; n: number; k: number }[] {
  const now = new Date();
  const out: { t: string; n: number; k: number }[] = [];
  const wa = db
    .prepare("SELECT ts FROM wa_messages WHERE ts > ?")
    .all(now.getTime() - 6 * 3600_000) as { ts: number }[];
  const li = db
    .prepare("SELECT date FROM li_messages WHERE date > ?")
    .all(
      new Date(now.getTime() - 6 * 3600_000).toISOString().replace("T", " ").slice(0, 19) +
        " UTC"
    ) as { date: string }[];
  const needs = db
    .prepare("SELECT ref, last_ts FROM todos WHERE state = 'needs-reply' AND source = 'whatsapp'")
    .all() as { ref: string; last_ts: number }[];
  for (let i = 5; i >= 0; i--) {
    const h = new Date(now.getTime() - i * 3600_000);
    const start = new Date(h); start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 3600_000);
    const n =
      wa.filter((r) => normalizeTs(r.ts) >= start.getTime() && normalizeTs(r.ts) < end.getTime()).length +
      li.filter((r) => {
        const t = Date.parse(r.date.replace(" UTC", "Z"));
        return t >= start.getTime() && t < end.getTime();
      }).length;
    const k = needs.filter(
      (r) => normalizeTs(r.last_ts) >= start.getTime() && normalizeTs(r.last_ts) < end.getTime()
    ).length;
    out.push({
      t: start.toTimeString().slice(0, 5),
      n,
      k: Math.max(k, k > 0 ? 1 : 0),
    });
  }
  return out;
}

function dumpPayload() {
  const rows = db
    .prepare(
      `SELECT * FROM items ORDER BY COALESCE(priority, 0) DESC, created_at DESC LIMIT 500`
    )
    .all() as any[];
  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    source: r.source,
    title: (r.title ?? r.raw ?? r.url ?? r.kind) as string,
    summary: (r.summary ?? "") as string,
    transcript: (r.transcript ?? "") as string,
    url: (r.url ?? "") as string,
    media: r.media_path ? `/api/media/${r.id}` : "",
    thumb: r.thumb_path ? `/api/media/${r.id}?thumb=1` : "",
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    action: (r.action ?? "reference") as string,
    effortMin: (r.effort_min ?? null) as number | null,
    context: (r.context ?? "quick") as string,
    batchKey: (r.batch_key ?? "reference") as string,
    state: r.state as string,
    snoozedUntil: (r.snooze_until ?? null) as number | null,
    pending: r.processed_at == null,
    ago: ago(r.created_at),
    created: new Date(r.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
  }));
  const byAction: Record<string, number> = {};
  for (const r of db
    .prepare(
      "SELECT COALESCE(action, 'reference') AS action, COUNT(*) AS n FROM items WHERE state IN ('active', 'inbox') GROUP BY 1"
    )
    .all() as { action: string; n: number }[]) {
    byAction[r.action] = r.n;
  }
  return {
    items,
    // Counted in SQL: the list above is capped at 500 rows.
    counts: db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(state IN ('active', 'inbox')), 0) AS active,
                COALESCE(SUM(processed_at IS NULL), 0) AS pending,
                COALESCE(SUM(state = 'done'), 0) AS done
         FROM items`
      )
      .get() as { total: number; active: number; pending: number; done: number },
    byAction,
    nudge: nudgeStatus(),
    selfChat: { ownJid: ownJid(), ready: waStatus().state === "connected" },
  };
}

function mediaFile(id: string, thumb: boolean): { path: string; mime: string } | null {
  const row = db.prepare("SELECT media_path, thumb_path FROM items WHERE id = ?").get(id) as
    | { media_path: string | null; thumb_path: string | null }
    | undefined;
  const file = thumb ? row?.thumb_path : row?.media_path;
  if (!file || !fs.existsSync(file)) return null;
  const MEDIA_MIME: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".bin": "application/octet-stream",
  };
  return { path: file, mime: MEDIA_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
}

/** Pull in new LinkedIn/notes/WhatsApp exports and sync reply todos. */
function ingestAll(): void {
  ingestLinkedin();
  ingestNotes();
  ingestWhatsappExports();
  syncWhatsappTodos();
  syncLinkedinTodos();
  syncGmailTodos();
}

// The phone polls every 30 s: importing on each request made every refresh slow.
let lastIngest = 0;
function ingestSoon(): void {
  if (Date.now() - lastIngest < 60_000) return;
  lastIngest = Date.now();
  setImmediate(() => {
    try { ingestAll(); } catch (e) { console.warn("[ingest]", e instanceof Error ? e.message : e); }
  });
}

function statePayload() {
  ingestAll();
  lastIngest = Date.now();
  const digestAt = Number(getMeta("last_digest_at") ?? 0);
  const items = buildItems(digestAt);
  let emailCount = 0;
  if (googleConnected()) {
    emailCount = (db.prepare("SELECT COUNT(*) n FROM gm_messages").get() as any).n;
  } else try {
    const mailos = new DatabaseSync(`file:${config.mailosDb}?mode=ro`, { readOnly: true });
    emailCount = (
      mailos.prepare("SELECT COUNT(*) n FROM threads WHERE state IN ('needs-reply','waiting-on-them')").get() as any
    ).n;
    mailos.close();
  } catch {
  }
  const signals =
    (db.prepare("SELECT COUNT(*) n FROM wa_messages").get() as any).n +
    (db.prepare("SELECT COUNT(*) n FROM li_messages").get() as any).n +
    emailCount;
  const digestTime = digestAt
    ? new Date(digestAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : "never";
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dismissed = (
    db
      .prepare("SELECT COUNT(*) n FROM todos WHERE state = 'done' AND state_updated_at > ?")
      .get(dayStart.getTime()) as any
  ).n;
  const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const calendar = upcomingEvents(1).map((e) => ({
    id: `cal:${e.id}`,
    time: e.all_day ? "all day" : hhmm(e.start_ts),
    title: e.title,
    meta: ["Calendar", e.end_ts && !e.all_day ? `until ${hhmm(e.end_ts)}` : "", e.location ?? ""].filter(Boolean).join(" · "),
    bar: "var(--color-neutral-700)",
    created_at: 0,
    cal: true,
    link: e.link,
  }));
  const planned = db
    .prepare("SELECT * FROM agenda ORDER BY time")
    .all() as any[];
  const agenda = [...calendar, ...planned].sort(
    (a, b) => Number(b.time === "all day") - Number(a.time === "all day") || String(a.time).localeCompare(String(b.time))
  );
  const googleError = getMeta("google_error") ?? "";
  const googleSynced = Number(getMeta("google_synced_at") ?? 0);
  const counts = digestCounts();
  const wa = waStatus();
  const connections = [
    googleConnected() || googleConfigured()
      ? {
          key: "email",
          mark: "@",
          name: "Gmail",
          account: googleAccount() || "Google account",
          rule: googleError
            ? googleError
            : `inbox threads from the last ${config.gmailDays} days, promotions/social skipped · read-only · triaged per thread`,
          flow: googleConnected() ? `${emailCount} messages` : "—",
          state: googleConnected() ? (googleError ? "error" : "live") : "google-off",
        }
      : {
          key: "email",
          mark: "@",
          name: "Email",
          account: "via mailos",
          rule: "threads mailos classified needs-reply · set GOOGLE_CLIENT_ID to read Gmail directly",
          flow: `${emailCount} tracked`,
          state: fs.existsSync(config.mailosDb) ? "live" : "off",
        },
    ...(googleConfigured()
      ? [
          {
            key: "calendar",
            mark: "▦",
            name: "Calendar",
            account: googleAccount() || "Google account",
            rule: `primary calendar, today + ${config.calendarDays} days · shown in Planned, fed to the digest · read-only`,
            flow: googleConnected()
              ? `${calendar.length} today${googleSynced ? ` · synced ${ago(googleSynced)} ago` : ""}`
              : "—",
            state: googleConnected() ? (googleError ? "error" : "live") : "google-off",
          },
        ]
      : []),
    {
      key: "whatsapp",
      mark: "WA",
      name: "WhatsApp",
      account: "Baileys linked device",
      rule: "direct messages and groups stored on watch · triaged per chat",
      flow: `${db.prepare("SELECT COUNT(*) n FROM wa_messages").get()!.n} messages`,
      state: wa.state === "connected" ? "live" : wa.state,
    },
    {
      key: "linkedin",
      mark: "in",
      name: "LinkedIn",
      account: "GDPR export CSVs",
      rule: "drop messages.csv into inbound/linkedin/ · hash-deduped ingest",
      flow: `${db.prepare("SELECT COUNT(*) n FROM li_messages").get()!.n} messages`,
      state: "live",
    },
  ];
  return {
    items,
    connections,
    arrivals: buildArrivals(),
    agenda: agenda.map((a) => ({ ...a, bar: a.bar === "accent" ? "var(--color-accent)" : "var(--color-neutral-700)", fresh: Date.now() - a.created_at < 3000 })),
    later: agenda.filter((a) => !a.cal && !/^\d{2}:\d{2}$/.test(a.time)),
    sources: [
      { key: "all", mark: "◈", name: "All sources", count: items.length },
      { key: "email", mark: "@", name: "Email", count: items.filter((i) => i.src === "email").length },
      { key: "whatsapp", mark: "WA", name: "WhatsApp", count: items.filter((i) => i.src === "whatsapp").length },
      { key: "linkedin", mark: "in", name: "LinkedIn", count: items.filter((i) => i.src === "linkedin").length },
    ],
    agents: [
      { name: "Triage", status: `watching 3 feeds · ${counts.needsReply} need replies, ${counts.waiting} waiting` },
      { name: "Digest", status: "writes the task and the why" },
      { name: "Model", status: hasLlm() ? `${config.llmModel} via nan` : "NAN_API_KEY not set — rules only" },
      { name: "Worker", status: `classifies every ${config.syncIntervalMinutes} min · digest at ${String(config.digestHour).padStart(2, "0")}:00` },
    ],
    digestLine: `digested ${digestTime} · ${signals} signals · 3 sources · ${counts.needsReply} need replies (${counts.overdue} over 7d)`,
    headline: `${items.length} task${items.length === 1 ? "" : "s"} distilled from ${signals} signals — drag, schedule or drop them`,
    digestHour: config.digestHour,
    google: { configured: googleConfigured(), connected: googleConnected(), account: googleAccount(), login: googleLoginEnabled() },
    sourcesLine: `3 connected · ${signals} signals read · ${items.length} tasks kept`,
    briefStats: [
      { value: items.filter((i) => i.isNew).length, label: "new since digest", color: "var(--color-accent-200)" },
      { value: items.filter((i) => i.lane === "deadline").length, label: "on the clock", color: "var(--color-text)" },
      { value: `${signals} → ${items.length}`, label: "signals to tasks", color: "var(--color-text)" },
    ],
    dismissed,
    dump: dumpPayload(),
    mobile: mobilePayload(),
  };
}

function findTodo(id: string): any {
  const idx = id.indexOf(":");
  return db
    .prepare("SELECT * FROM todos WHERE source = ? AND ref = ?")
    .get(id.slice(0, idx), id.slice(idx + 1));
}

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    return false;
  }
  if (url.pathname === "/api/state" && req.method === "GET") {
    json(res, 200, statePayload());
    return true;
  }
  // the phone only needs its own part: no desktop dump, no import on the request path
  if (url.pathname === "/api/mobile" && req.method === "GET") {
    ingestSoon();
    try {
      const ctx = url.searchParams.get("ctx");
      if (ctx) recordPresence(JSON.parse(ctx));
    } catch {}
    // the AI's questions about what just ended, and the day's review from the set hour
    assistant.syncQuestions();
    void assistant.maybeWrapUp().catch((e) => console.warn("[assistant]", e instanceof Error ? e.message : e));
    json(res, 200, { mobile: mobilePayload() });
    return true;
  }
  // the launcher's blocker refreshes its cached copy from here, without the web UI
  if (url.pathname === "/api/policy" && req.method === "GET") {
    json(res, 200, policy());
    return true;
  }

  const mediaMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/);
  if (mediaMatch && req.method === "GET") {
    const f = mediaFile(decodeURIComponent(mediaMatch[1]), url.searchParams.get("thumb") === "1");
    if (!f) {
      res.writeHead(404);
      res.end("not found");
      return true;
    }
    res.writeHead(200, { "content-type": f.mime, "cache-control": "private, max-age=86400" });
    fs.createReadStream(f.path).pipe(res);
    return true;
  }

  // --- raw (binary-safe) uploads, read before the JSON body ---
  if (url.pathname === "/api/linkedin/upload" && req.method === "POST") {
    const buf = await readRaw(req);
    if (!buf.length) {
      json(res, 400, { ok: false, error: "empty file" });
      return true;
    }
    const name = (url.searchParams.get("name") ?? "messages.csv").replace(/[^\w.-]/g, "_");
    fs.mkdirSync(config.linkedinInbound, { recursive: true });
    fs.writeFileSync(path.join(config.linkedinInbound, `${Date.now()}-${name}`), buf);
    const added = ingestLinkedin();
    if (added) void classifyTodos();
    json(res, 200, { ok: true, added });
    return true;
  }
  if (url.pathname === "/api/capture/file" && req.method === "POST") {
    const buf = await readRaw(req);
    if (!buf.length) {
      json(res, 400, { ok: false, error: "empty file" });
      return true;
    }
    const name = (url.searchParams.get("name") ?? "upload.bin").replace(/[^\w.-]/g, "_");
    // a WhatsApp chat exported and shared here (your chat with yourself): read message by message
    const exported = whatsappExport(name, buf);
    if (exported) {
      const dir = path.join(config.whatsappInbound, `${Date.now().toString(36)}-compartido`);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of exported) fs.writeFileSync(path.join(dir, path.basename(f.name).replace(/[^\w. -]/g, "_")), f.data);
      const added = ingestWhatsappExports();
      void processItems();
      json(res, 200, { ok: true, added, whatsapp: true });
      return true;
    }
    const kind = mediaKind(null, name);
    const file = path.join(config.mediaDir, `${Date.now().toString(36)}-${name}`);
    fs.writeFileSync(file, buf);
    const added = capture(name, { source: "web", kind, mediaPath: file, title: name }).added;
    void processItems();
    json(res, 200, { ok: true, added: added ? 1 : 0 });
    return true;
  }

  const raw = (await readRaw(req)).toString("utf8");
  let action: any = {};
  try {
    action = JSON.parse(raw);
  } catch {
  }

  if (url.pathname === "/api/redigest") {
    const md = await digest();
    json(res, 200, { ok: true, digest: md.slice(0, 200) });
    return true;
  }
  if (url.pathname === "/api/wa/status") {
    const st = waStatus();
    json(res, 200, {
      state: st.state,
      hasSession: st.hasSession,
      qr: st.qr ? await QRCode.toDataURL(st.qr, { margin: 1, width: 280 }) : null,
    });
    return true;
  }
  if (url.pathname === "/api/google/sync" && req.method === "POST") {
    const r = await syncGoogle();
    json(res, r.error ? 502 : 200, { ok: !r.error, ...r });
    return true;
  }
  if (url.pathname === "/api/google/disconnect" && req.method === "POST") {
    googleSignOut();
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/wa/start" && req.method === "POST") {
    await waStart();
    json(res, 200, { ok: true });
    return true;
  }
  // GitHub: read what needs you and your repos; edit issues, comments, files, branches, PRs
  if (url.pathname.startsWith("/api/github")) {
    const q = (k: string) => url.searchParams.get(k) ?? String(action[k] ?? "");
    const routes: Record<string, () => Promise<unknown>> = {
      "GET /api/github": () => github.githubRefresh(),
      "GET /api/github/repos": () => github.listRepos(),
      "GET /api/github/tree": () => github.listTree(q("repo"), q("ref") || undefined),
      "GET /api/github/file": () => github.readFile(q("repo"), q("path"), q("ref") || undefined),
      "POST /api/github/issue": () => github.createIssue(q("repo"), q("title"), q("body")),
      "POST /api/github/comment": () => github.comment(q("repo"), Number(q("number")), q("body")),
      "POST /api/github/state": () => github.setIssueState(q("repo"), Number(q("number")), q("state") === "open" ? "open" : "closed"),
      "POST /api/github/file": () => github.writeFile(q("repo"), q("path"), String(action.content ?? ""), q("message") || `Update ${q("path")}`, q("branch") || undefined),
      "POST /api/github/branch": () => github.createBranch(q("repo"), q("branch")),
      "POST /api/github/pr": () => github.openPullRequest(q("repo"), q("branch"), q("title"), q("body")),
    };
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return false;
    if (!github.githubConfigured()) {
      json(res, 400, { ok: false, error: "GitHub no está conectado" });
      return true;
    }
    try {
      json(res, 200, { ok: true, result: (await route()) ?? null });
    } catch (e) {
      json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  if (url.pathname === "/api/wa/pair" && req.method === "POST") {
    try {
      json(res, 200, { ok: true, code: await waPairCode(String(action.phone || config.mePhone || "")) });
    } catch (e) {
      json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  if (url.pathname === "/api/wa/stop" && req.method === "POST") {
    waStop();
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/capture" && req.method === "POST") {
    const added = captureBlob(String(action.text ?? ""), "web");
    void processItems();
    json(res, 200, { ok: true, added });
    return true;
  }
  if (url.pathname === "/api/available" && req.method === "POST") {
    setAvailable(Boolean(action.available));
    json(res, 200, { ok: true, available: Boolean(action.available) });
    return true;
  }
  if (url.pathname === "/api/push/key" && req.method === "GET") {
    json(res, 200, {
      enabled: pushConfigured(),
      key: pushPublicKey(),
      devices: subscriptionCount(),
    });
    return true;
  }
  if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
    const ok = saveSubscription(action.subscription ?? {});
    json(res, 200, { ok, devices: subscriptionCount() });
    return true;
  }
  if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
    const endpoint = action.endpoint ?? action.subscription?.endpoint;
    if (endpoint) removeSubscription(endpoint);
    json(res, 200, { ok: true, devices: subscriptionCount() });
    return true;
  }
  if (url.pathname === "/api/nudge" && req.method === "POST") {
    const result = await sendNudge(Boolean(action.force));
    json(res, 200, { ok: true, ...result });
    return true;
  }
  if (url.pathname === "/api/item" && req.method === "POST") {
    const { type, id } = action;
    const minutes = Number(action.minutes) || 120;
    if (id && db.prepare("SELECT 1 FROM items WHERE id = ?").get(id)) {
      if (type === "done" || type === "drop") {
        db.prepare("UPDATE items SET state = ? WHERE id = ?").run(
          type === "done" ? "done" : "dropped",
          id
        );
      } else if (type === "reopen") {
        db.prepare("UPDATE items SET state = 'active', snooze_until = NULL WHERE id = ?").run(id);
      } else if (type === "snooze") {
        db.prepare("UPDATE items SET snooze_until = ? WHERE id = ?").run(Date.now() + minutes * 60_000, id);
      } else if (type === "unsnooze") {
        db.prepare("UPDATE items SET snooze_until = NULL WHERE id = ?").run(id);
      }
      addEvent(id, type ?? "action");
    }
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/now/skip" && req.method === "POST") {
    if (action.id) skipNow(String(action.id), Number(action.hours) || 3);
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/policy/exit" && req.method === "POST") {
    if (action.pkg) logExit(String(action.pkg), String(action.reason ?? ""), String(action.window ?? ""), Number(action.at) || Date.now());
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/now/keep" && req.method === "POST") {
    if (action.id) keepDue(String(action.id));
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/focus/start" && req.method === "POST") {
    const id = startBlock(String(action.ref ?? ""), String(action.title ?? ""), Number(action.minutes));
    json(res, 200, { ok: true, id });
    return true;
  }
  if (url.pathname === "/api/focus/stop" && req.method === "POST") {
    stopBlock(Boolean(action.done));
    json(res, 200, { ok: true });
    return true;
  }
  // Goal planning conversations are stored turn by turn; the client sends only the new message.
  if (url.pathname === "/api/goals/chat" && req.method === "POST") {
    const text = String(action.text ?? "").trim();
    let chatId = Number(action.chatId) || 0;
    if (!chatId || !chatExists(chatId, "goal")) chatId = startChat("goal");
    if (text) addTurn(chatId, "user", text);
    try {
      const out = await goalChat(chatTurns(chatId).map((t) => ({ role: t.role, content: t.content })));
      addTurn(chatId, "assistant", out.reply, out.plan ? { plan: out.plan } : undefined);
      json(res, 200, { ok: true, chatId, ...out });
    } catch (e) {
      // the user's message is already saved; a retry answers it
      json(res, 502, { ok: false, chatId, error: String(e) });
    }
    return true;
  }
  // the day plan: done, not now (re-plans the rest), re-plan, and "¿sigue importando?"
  if (url.pathname.startsWith("/api/plan/") && req.method === "POST") {
    const op = url.pathname.slice("/api/plan/".length);
    if (op === "done" && action.id) markDone(Number(action.id));
    else if (op === "move" && action.id) moveSlot(Number(action.id));
    else if (op === "replan") ensurePlan(Date.now(), true);
    else if (op === "ask" && action.ref) answerAsk(String(action.ref), !!action.keep);
    else if (op === "close" && action.ref) closeRef(String(action.ref), action.as === "archived" ? "archived" : "done");
    else if (op === "reopen" && action.ref) reopenRef(String(action.ref));
    else if (op === "pause") setMeta("tasks_paused", action.paused === false ? "0" : "1");
    else { json(res, 400, { ok: false, error: "unknown plan op" }); return true; }
    json(res, 200, { ok: true });
    return true;
  }
  // the conversation with the AI: read it, say something, or ask it about one thing
  if (url.pathname === "/api/assistant" && req.method === "GET") {
    assistant.syncQuestions();
    await assistant.maybeWrapUp().catch(() => false);
    json(res, 200, { ok: true, messages: assistant.messages(), pending: assistant.pending() });
    return true;
  }
  if (url.pathname === "/api/assistant" && req.method === "POST") {
    const text = String(action.text ?? "").trim().slice(0, 4000);
    if (!text) { json(res, 400, { ok: false, error: "empty" }); return true; }
    json(res, 200, { ok: true, ...(await assistant.reply(text)), messages: assistant.messages() });
    return true;
  }
  if (url.pathname === "/api/assistant/about" && req.method === "POST") {
    try {
      assistant.askAbout(Number(action.slotId) || null, action.ref ? String(action.ref) : null);
      json(res, 200, { ok: true, messages: assistant.messages() });
    } catch (e) {
      json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  // the AI asks whether you finished something: your summary, or "aún no"
  if (url.pathname === "/api/checkin" && req.method === "POST") {
    try {
      json(res, 200, { ok: true, ...(await checkIn(Number(action.slotId) || null, String(action.text ?? "").slice(0, 4000), action.ref ? String(action.ref) : null)) });
    } catch (e) {
      json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
  if (url.pathname === "/api/checkin/notyet" && req.method === "POST") {
    notYet(Number(action.slotId));
    json(res, 200, { ok: true });
    return true;
  }
  // "¿Estás en el curro?" for a network it keeps seeing
  if (url.pathname === "/api/presence" && req.method === "POST") {
    const label = ["work", "home", "other"].includes(action.label) ? action.label : null;
    if (!action.net || !label) { json(res, 400, { ok: false, error: "net and label" }); return true; }
    answerQuestion(String(action.net), label);
    json(res, 200, { ok: true });
    return true;
  }
  // clean slate: archive everything open (reversible), or bring it back
  if (url.pathname === "/api/slate" && req.method === "POST") {
    const n = action.op === "restore" ? restoreArchive() : action.op === "archive" ? archiveAll() : -1;
    if (n < 0) { json(res, 400, { ok: false, error: "op must be archive or restore" }); return true; }
    ensurePlan(Date.now(), true);
    json(res, 200, { ok: true, items: n });
    return true;
  }
  // to-dos that come already sorted (from another assistant, or the assistant itself)
  if (url.pathname === "/api/items/add" && req.method === "POST") {
    const ids = addItems(Array.isArray(action.items) ? action.items : []);
    if (ids.length) ensurePlan(Date.now(), true);
    json(res, 200, { ok: true, ids });
    return true;
  }
  if (url.pathname === "/api/chats/open" && req.method === "GET") {
    json(res, 200, { ok: true, chat: openChat(url.searchParams.get("kind") ?? "goal") });
    return true;
  }
  if (url.pathname === "/api/chats/close" && req.method === "POST") {
    if (action.chatId) closeChat(Number(action.chatId), "set_aside");
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/chats" && req.method === "GET") {
    const id = Number(url.searchParams.get("id"));
    json(res, 200, id ? { ok: true, turns: chatTurns(id) } : { ok: true, chats: listChats() });
    return true;
  }
  // a new guardian link (with a code set, only with that code)
  if (url.pathname === "/api/guardian/link" && req.method === "POST") {
    const link = guardian.newLink(action.code, config.publicUrl || `https://${req.headers.host}`);
    json(res, link ? 200 : 403, link ? { ok: true, link } : { ok: false, error: "hace falta el código actual" });
    return true;
  }
  if (url.pathname === "/api/sleep" && req.method === "POST") {
    const ok = sleep.record(Number(action.start), Number(action.end));
    json(res, ok ? 200 : 400, { ok, ...sleep.sleepPayload() });
    return true;
  }
  if (url.pathname === "/api/sleep" && req.method === "GET") {
    json(res, 200, { ok: true, ...sleep.sleepPayload() });
    return true;
  }
  if (url.pathname === "/api/journal" && req.method === "GET") {
    json(res, 200, { ok: true, ...journal.journalPayload() });
    return true;
  }
  if (url.pathname === "/api/journal" && req.method === "POST") {
    const e = journal.save(String(action.text ?? ""));
    json(res, 200, { ok: true, entry: e, ...journal.journalPayload() });
    return true;
  }
  if (url.pathname === "/api/goals" && req.method === "POST") {
    if (action.op === "create" && action.plan?.name) {
      const id = createGoal(action.plan);
      if (action.chatId) closeChat(Number(action.chatId), "done", { goalId: id });
      json(res, 200, { ok: true, id });
    } else if (action.op === "log" && action.id) {
      logGoal(Number(action.id));
      json(res, 200, { ok: true });
    } else if (action.op === "archive" && action.id) {
      archiveGoal(Number(action.id));
      json(res, 200, { ok: true });
    } else {
      json(res, 400, { ok: false, error: "unknown goal op" });
    }
    return true;
  }
  if (url.pathname === "/api/action") {
    const { type, id, time } = action;
    // Undo restores the triage reason the card had, instead of a generic one.
    const keepReason = () => {
      const todo = findTodo(id);
      if (todo) setMeta(`undo_reason:${id}`, todo.state_reason ?? "");
    };
    const restoredReason = () => getMeta(`undo_reason:${id}`) || "unclassified - kept for review";
    if (type === "dismiss" && id) {
      if (id.startsWith("email:") && !findTodo(id)) {
        setMeta(`dismissed:${id}`, "1");
      } else {
        keepReason();
        db.prepare(
          "UPDATE todos SET state = 'done', state_reason = 'dismissed by you', state_updated_at = last_ts WHERE source = ? AND ref = ?"
        ).run(id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1));
      }
    } else if (type === "undo-dismiss" && id) {
      if (id.startsWith("email:") && !findTodo(id)) {
        setMeta(`dismissed:${id}`, "0");
      } else {
        db.prepare(
          "UPDATE todos SET state = 'needs-reply', state_reason = ?, state_updated_at = last_ts WHERE source = ? AND ref = ?"
        ).run(restoredReason(), id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1));
      }
    } else if (type === "schedule" && id) {
      const todo = findTodo(id);
      const item = buildItems(Number(getMeta("last_digest_at") ?? 0)).find((i) => i.id === id);
      const slot = time || new Date().toTimeString().slice(0, 5);
      db.prepare(
        "INSERT OR REPLACE INTO agenda (id, time, title, meta, bar, created_at) VALUES (?, ?, ?, ?, 'accent', ?)"
      ).run(id, slot, item?.title ?? todo?.title ?? id, "Agent · now", Date.now());
      if (todo) {
        keepReason();
        db.prepare(
          "UPDATE todos SET state = 'done', state_reason = 'scheduled at ' || ?, state_updated_at = last_ts WHERE source = ? AND ref = ?"
        ).run(slot, id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1));
      }
    } else if (type === "undo-schedule" && id) {
      db.prepare("DELETE FROM agenda WHERE id = ?").run(id);
      const todo = findTodo(id);
      if (todo) {
        db.prepare(
          "UPDATE todos SET state = 'needs-reply', state_reason = ?, state_updated_at = last_ts WHERE source = ? AND ref = ?"
        ).run(restoredReason(), id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1));
      }
    } else if (type === "rescue" && id) {
      // triage filtered it out, you disagree: back on the list, and the worker won't re-filter it
      db.prepare(
        "UPDATE todos SET state = 'needs-reply', state_reason = ?, lane = 'reply', state_updated_at = last_ts WHERE source = ? AND ref = ?"
      ).run(config.lang === "es" ? "rescatado por ti" : "rescued by you", id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1));
    } else if (type === "resetDay") {
      db.prepare("DELETE FROM agenda WHERE bar = 'accent'").run();
    }
    if (id && (type === "dismiss" || type === "schedule")) addEvent(id, type);
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}

const PUBLIC_PATHS = new Set(["/manifest.webmanifest", "/sw.js", "/login", "/auth/google", "/auth/google/callback"]);

function isPublicPath(p: string): boolean {
  // fonts are public because the login page uses them
  return PUBLIC_PATHS.has(p) || p.startsWith("/icons/") || p.startsWith("/fonts/");
}

function getCookie(req: http.IncomingMessage, name: string): string | undefined {
  return (req.headers.cookie ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function authRequired(): boolean {
  return Boolean(config.token) || googleLoginEnabled();
}

function checkAuth(
  req: http.IncomingMessage,
  url: URL
): "ok" | "settoken" | "deny" {
  if (!authRequired()) return "ok";
  if (validSession(getCookie(req, "unibox_session"))) return "ok";
  if (!config.token) return "deny";
  const header = req.headers["x-unibox-token"];
  const cookie = getCookie(req, "unibox_token");
  const q = url.searchParams.get("token");
  if (q && q === config.token) return "settoken";
  if (header === config.token || cookie === config.token) return "ok";
  return "deny";
}

function origin(req: http.IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
  return `${proto}://${req.headers.host ?? `127.0.0.1:${process.env.UNIBOX_PORT ?? 8124}`}`;
}

function secureFlag(req: http.IncomingMessage): string {
  return origin(req).startsWith("https:") ? "; Secure" : "";
}

const LOGIN_TEXT = {
  es: {
    tagline: "Correo, chats y calendario en una sola bandeja revisada.",
    token: "Token de acceso", openToken: "Entrar con token", google: "Entrar con Google", or: "o",
    badToken: "Ese token no funciona", setGoogle: "Configura GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en .env",
  },
  en: {
    tagline: "Email, chats and calendar in one reviewed inbox.",
    token: "Access token", openToken: "Open with token", google: "Sign in with Google", or: "or",
    badToken: "That token didn't work", setGoogle: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env",
  },
};

function loginText() {
  return config.lang === "es" ? LOGIN_TEXT.es : LOGIN_TEXT.en;
}

function loginPage(error = ""): string {
  const t = loginText();
  // The Android app has no address bar, so a token field must live on this page.
  const tokenForm = config.token
    ? `<form method="get" action="/"><input name="token" type="password" placeholder="${t.token}" autocomplete="current-password" required>
<button class="btn" type="submit">${t.openToken}</button></form>`
    : "";
  const body = [googleConfigured() ? `<a class="btn" href="/auth/google">${t.google}</a>` : "", tokenForm]
    .filter(Boolean)
    .join(`<p class="or">${t.or}</p>`);
  // Same look as the phone UI (web/mobile.css).
  return `<!doctype html><html lang="${config.lang === "es" ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#F4F3EE"><title>unibox</title><style>
@font-face{font-family:"Geist";font-weight:400 600;font-display:swap;src:url("/fonts/geist-latin.woff2") format("woff2")}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F3EE;color:#1E2620;font:15px/1.5 "Geist",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(360px,100%);padding:32px 18px;box-sizing:border-box;display:flex;flex-direction:column;gap:6px}
.brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600;letter-spacing:-.02em}
.dot{width:7px;height:7px;border-radius:50%;background:#3F6B4C;box-shadow:0 0 0 3px #E3EAE2}
p{margin:6px 0 12px;color:#6B7068;font-size:14px}
.btn{display:flex;align-items:center;justify-content:center;height:48px;border-radius:12px;background:#26392B;color:#fff;text-decoration:none;font-weight:500;font-size:15px}
.err{color:#8E3B2B;font-size:13px;margin-top:12px}.or{margin:10px 0;font-size:12px;text-align:center;color:#8A8E86}
form{display:flex;flex-direction:column;gap:8px}form .btn{border:0;font:inherit;font-weight:500;cursor:pointer;width:100%}
input{height:48px;padding:0 14px;border-radius:12px;border:1px solid #E6E4DD;background:#fff;color:#1E2620;font:inherit;box-sizing:border-box}
input:focus{outline:none;border-color:#3F6B4C}</style></head><body><main><div class="brand"><span class="dot"></span>unibox</div>
<p>${t.tagline}</p>${body}${error ? `<p class="err">${error.replace(/[&<>"]/g, "")}</p>` : ""}</main></body></html>`;
}

async function handleAuth(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/login") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(loginPage(url.searchParams.get("error") ?? (url.searchParams.has("bad") ? loginText().badToken : "")));
    return true;
  }
  if (url.pathname === "/auth/google") {
    if (!googleConfigured()) {
      res.writeHead(302, { location: "/login?error=" + encodeURIComponent(loginText().setGoogle) });
      res.end();
      return true;
    }
    const state = crypto.randomBytes(16).toString("base64url");
    res.writeHead(302, {
      location: authUrl(origin(req), state),
      "set-cookie": `unibox_oauth=${state}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax${secureFlag(req)}`,
    });
    res.end();
    return true;
  }
  if (url.pathname === "/auth/google/callback") {
    const fail = (msg: string) => {
      res.writeHead(302, { location: "/login?error=" + encodeURIComponent(msg) });
      res.end();
    };
    const state = url.searchParams.get("state");
    if (!state || state !== getCookie(req, "unibox_oauth")) return fail("Sign-in expired, try again"), true;
    const code = url.searchParams.get("code");
    if (!code) return fail(url.searchParams.get("error") ?? "Google sign-in was cancelled"), true;
    try {
      await handleCallback(code, origin(req));
    } catch (e) {
      return fail(String(e instanceof Error ? e.message : e)), true;
    }
    void syncGoogle();
    res.writeHead(302, {
      location: "/?screen=sessions",
      "set-cookie": [
        `unibox_session=${newSession()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secureFlag(req)}`,
        `unibox_oauth=; Path=/auth; Max-Age=0`,
      ],
    });
    res.end();
    return true;
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") {
    dropSession(getCookie(req, "unibox_session"));
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": ["unibox_session=; Path=/; Max-Age=0", "unibox_token=; Path=/; Max-Age=0"],
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}

export function serve(): void {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await handleAuth(req, res, url)) return;
      // the guardian's one-time link: public, the link itself is the secret
      const g = /^\/guardian\/([a-f0-9]{48})$/.exec(url.pathname);
      if (g) { await guardian.handle(req, res, g[1]); return; }
      if (authRequired() && !isPublicPath(url.pathname)) {
        const auth = checkAuth(req, url);
        if (auth === "deny") {
          const isApi = url.pathname.startsWith("/api/");
          if (!isApi && req.method === "GET") {
            res.writeHead(302, { location: url.searchParams.has("token") ? "/login?bad=1" : "/login" });
            res.end();
            return;
          }
          res.writeHead(401, { "content-type": isApi ? "application/json" : "text/plain; charset=utf-8" });
          res.end(isApi ? JSON.stringify({ ok: false, error: "unauthorized" }) : "unauthorized — open this URL with ?token=… once");
          return;
        }
        if (auth === "settoken") {
          const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
          res.setHeader("set-cookie", `unibox_token=${config.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
        }
      }
      if (await handleApi(req, res)) return;
      const file = url.pathname === "/" ? "/index.html" : url.pathname;
      const full = path.normalize(path.join(webDir, file));
      if (!full.startsWith(webDir) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const headers: Record<string, string> = {
        "content-type": MIME[path.extname(full)] ?? "application/octet-stream",
      };
      if (url.pathname === "/sw.js") {
        headers["service-worker-allowed"] = "/";
        headers["cache-control"] = "no-cache";
      }
      res.writeHead(200, headers);
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  const port = Number(process.env.UNIBOX_PORT ?? 8124);
  server.listen(port, config.host, () => {
    const shown = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    console.log(`unibox serve → http://${shown}:${port}`);
    if (config.token && config.host === "0.0.0.0") {
      // never print the token itself: hosted logs (NaN, Docker) are readable by others
      console.log(`  phone URL: http://<this-machine-ip>:${port}/?token=<UNIBOX_TOKEN>`);
    }
    if (waStatus().hasSession) {
      waStart().catch((e) => console.error(`whatsapp auto-start failed: ${e}`));
    }
  });
}
