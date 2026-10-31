import { db, getMeta, setMeta } from "./db.js";
import { sleepPayload } from "./sleep.js";
import { config } from "./config.js";
import { journalPayload } from "./journal.js";
import { llm } from "./llm.js";
import { upcomingEvents, googleConnected, googleConfigured, googleAccount } from "./google.js";
import { addEvent } from "./capture/ingest.js";
import { waStatus } from "./wamanager.js";
import { parseDue, isExpired, dueLabel } from "./deadline.js";
import { reminders } from "./reminders.js";
import { policy, activeWindow } from "./policy.js";
import { githubSnapshot, githubConfigured } from "./github.js";
import { planPayload, outdated } from "./planner.js";
import { archivedCount } from "./slate.js";
import { aiWaiting } from "./aitasks.js";
import { current as presenceNow, pendingQuestion } from "./presence.js";
import { pending as aiPending } from "./assistant.js";

// Data for the phone UI (web/mobile.js): Hoy, Memoria, Metas, Calendario.
// Everything here is derived from the same todos/items/calendar the desktop
// UI reads; goals and focus blocks are the only new state.

db.exec(`
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  due TEXT,
  sessions_per_week INTEGER NOT NULL DEFAULT 3,
  session_minutes INTEGER NOT NULL DEFAULT 60,
  steps TEXT,
  margin TEXT,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS goal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_logs_goal ON goal_logs (goal_id, at);
CREATE TABLE IF NOT EXISTS focus_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT,
  title TEXT,
  planned_min INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_focus_started ON focus_blocks (started_at);
`);

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const DAYS = ["DOMINGO", "LUNES", "MARTES", "MIÉRCOLES", "JUEVES", "VIERNES", "SÁBADO"];
const MONTHS = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
const MON3 = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];

// The design's palette: one tint/ink pair per kind of thing.
const TONES = {
  green: { tint: "#E3EAE2", color: "#3F6B4C", ink: "#2F5A3C" },
  blue: { tint: "#E7E9F3", color: "#4D60A0", ink: "#3D4F8C" },
  amber: { tint: "#F2EBDD", color: "#8A6B3A", ink: "#6E5228" },
  rose: { tint: "#F3E4E0", color: "#9A4A3A", ink: "#8E3B2B" },
};
const GOAL_TONES = [TONES.blue, TONES.green, TONES.amber, TONES.rose];

function startOfDay(ts = Date.now()): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function normalizeTs(ts: number): number {
  return ts > 1e12 ? ts : ts > 1e9 ? ts * 1000 : ts;
}

function whenLabel(ts: number): string {
  const t = normalizeTs(ts);
  const today = startOfDay();
  if (t >= today) return hhmm(t);
  if (t >= today - DAY) return "ayer";
  const d = new Date(t);
  return `${d.getDate()} ${MON3[d.getMonth()].toLowerCase()}`;
}

function sinceLabel(ts: number): string {
  const today = startOfDay();
  const day = ts >= today ? "HOY" : ts >= today - DAY ? "AYER" : `EL ${DAYS[new Date(ts).getDay()].slice(0, 3)}`;
  return `DESDE ${day}, ${hhmm(ts)}`;
}

function firstName(): string {
  const n = config.meName || getMeta("li_me_name") || "";
  return n.split(/\s+/)[0] ?? "";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --- Hoy ---------------------------------------------------------------

interface Candidate {
  id: string;
  kind: "todo" | "item";
  title: string;
  meta: string;
  why: string;
  icon: string;
  score: number;
  url?: string;
  minutes: number;
  /** end of the day named in the text, if it names one */
  due?: number;
}

const CONTEXT_ES: Record<string, string> = {
  quick: "rápido",
  focus: "de foco",
  phone: "por teléfono",
  commute: "en el camino",
  desk: "en el ordenador",
  errand: "fuera de casa",
};

const ACTION_ES: Record<string, string> = {
  read: "Leer",
  watch: "Ver",
  listen: "Escuchar",
  do: "Hacer",
  buy: "Comprar",
  reply: "Responder",
  reference: "Guardar",
};

function skipped(id: string): boolean {
  return Number(getMeta(`skip:${id}`) ?? 0) > Date.now();
}

/** The deadline in the text, unless you said it still stands (then it's treated as undated for a while). */
function dueOf(id: string, text: string | null | undefined, writtenAt: number): number | undefined {
  if (Number(getMeta(`due_ok:${id}`) ?? 0) > Date.now()) return undefined;
  return parseDue(text, writtenAt) ?? undefined;
}

/** A deadline in the next three days moves up and says so. */
function withDue(c: Candidate): Candidate {
  if (c.due == null || isExpired(c.due)) return c;
  const days = Math.floor((startOfDay(c.due) - startOfDay()) / DAY);
  if (days > 3) return c;
  const when = days <= 0 ? "vence hoy" : days === 1 ? "vence mañana" : `vence el ${dueLabel(c.due)}`;
  return { ...c, score: c.score + 40, why: `Elegido porque ${when}.` };
}

function todoCandidates(): Candidate[] {
  const rows = db
    .prepare("SELECT * FROM todos WHERE state = 'needs-reply' ORDER BY last_ts DESC LIMIT 50")
    .all() as any[];
  return rows.map((t) => {
    const id = `${t.source}:${t.ref}`;
    const age = Math.max(0, Math.floor((Date.now() - normalizeTs(t.last_ts)) / DAY));
    const who = t.title ? ` a ${t.title}` : "";
    return {
      id,
      kind: "todo" as const,
      title: t.task || `Responder${who}`,
      meta: `${t.source === "email" ? "Correo" : t.source === "whatsapp" ? "WhatsApp" : "LinkedIn"}${who ? ` · ${t.title}` : ""}${age ? ` · hace ${plural(age, "día", "días")}` : ""}`,
      why: t.state_reason ? `Elegido porque ${lowerFirst(t.state_reason)}.` : "Elegido porque alguien espera tu respuesta.",
      icon: t.lane === "deadline" ? "clock" : "reply",
      // a dated ask outranks everything; an unanswered person outranks most dumps
      score: (t.lane === "deadline" ? 120 : 85) + Math.min(age, 7) * 2,
      url: todoUrl(t.source, t.ref) || undefined,
      minutes: 10,
      due: dueOf(id, `${t.task ?? ""} ${t.state_reason ?? ""}`, normalizeTs(t.last_ts)),
    };
  });
}

/** Where "Responder" should take you for a chat. */
function todoUrl(source: string, ref: string): string {
  if (source === "email") return `https://mail.google.com/mail/u/0/#all/${ref}`;
  if (source === "whatsapp") {
    const num = /^(\d+)@s\.whatsapp\.net$/.exec(ref)?.[1];
    return num ? `https://wa.me/${num}` : "";
  }
  if (source === "linkedin") return "https://www.linkedin.com/messaging/";
  return "";
}

/** "a", "a y b", "a, b y c" */
function joinEs(parts: string[]): string {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1).replace(/\.$/, "") : s;
}

function itemCandidates(): Candidate[] {
  const rows = db
    .prepare(
      `SELECT * FROM items WHERE state IN ('active', 'inbox') AND processed_at IS NOT NULL
         AND (snooze_until IS NULL OR snooze_until <= ?)
       ORDER BY priority DESC LIMIT 50`
    )
    .all(Date.now()) as any[];
  return rows.map((r) => {
    const effort = r.effort_min ?? 5;
    const reasons: string[] = [];
    if ((r.urgency ?? 0) >= 2) reasons.push("tiene prisa");
    if ((r.importance ?? 0) >= 4) reasons.push("es importante para ti");
    if (effort <= 5) reasons.push(`son solo ${effort} min`);
    const age = Math.floor((Date.now() - r.created_at) / DAY);
    if (!reasons.length && age >= 3) reasons.push(`lleva ${plural(age, "día", "días")} esperando`);
    return {
      id: r.id,
      kind: "item" as const,
      title: r.title || r.raw || r.url || "Algo que guardaste",
      meta: [`${effort} min ${CONTEXT_ES[r.context] ?? ""}`.trim(), ACTION_ES[r.action] ?? ""].filter(Boolean).join(" · "),
      why: `Elegido porque ${reasons.length ? joinEs(reasons) : "es lo más alto de tu lista"}.`,
      icon: r.action === "read" || r.action === "watch" || r.action === "listen" ? "book" : "task",
      score: r.priority ?? 0,
      url: r.url || undefined,
      minutes: effort,
      due: dueOf(r.id, r.title || r.raw, r.created_at),
    };
  });
}

function candidates(): Candidate[] {
  return [...todoCandidates(), ...itemCandidates()].filter((c) => !skipped(c.id)).map(withDue);
}

/** The best thing to do now. A passed deadline is never offered as a next step. */
function nowCandidate(all: Candidate[]): Candidate | null {
  return all.filter((c) => !isExpired(c.due ?? null)).sort((a, b) => b.score - a.score)[0] ?? null;
}

/** Things whose date has passed: ask whether they still stand instead of pretending they're upcoming. */
function expiredCandidates(all: Candidate[]) {
  return all
    .filter((c) => isExpired(c.due ?? null))
    .sort((a, b) => b.due! - a.due!)
    .slice(0, 3)
    .map((c) => ({ id: c.id, kind: c.kind, title: c.title, due: `era para el ${dueLabel(c.due!)}` }));
}

function activeBlock(): { id: number; ref: string; title: string; startedAt: number; plannedMin: number } | null {
  const row = db
    .prepare("SELECT * FROM focus_blocks WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
    .get() as any;
  return row ? { id: row.id, ref: row.ref ?? "", title: row.title, startedAt: row.started_at, plannedMin: row.planned_min } : null;
}

function timeline(): { time: string; title: string; meta: string; tint: string; color: string; ts: number }[] {
  const from = startOfDay();
  const now = Date.now();
  const out: { time: string; title: string; meta: string; tint: string; color: string; ts: number }[] = [];
  const doneToday = new Set(
    (db.prepare("SELECT item_id FROM item_events WHERE at >= ? AND event = 'done'").all(from) as { item_id: string }[]).map((r) => r.item_id)
  );
  // A task finished inside a focus block shows once, as the block.
  const blockRefs = new Set<string>();
  for (const b of db
    .prepare("SELECT * FROM focus_blocks WHERE started_at >= ? AND ended_at IS NOT NULL")
    .all(from) as any[]) {
    const mins = Math.max(1, Math.round((b.ended_at - b.started_at) / 60_000));
    const finished = b.ref && doneToday.has(b.ref);
    if (finished) blockRefs.add(b.ref);
    out.push({ ts: b.started_at, time: hhmm(b.started_at), title: b.title || "Bloque de foco", meta: `${mins} min medidos · ${finished ? "completada en foco" : "trabajo profundo"}`, ...TONES.blue });
  }
  for (const e of upcomingEvents(1)) {
    if (e.start_ts > now) continue;
    out.push({ ts: e.start_ts, time: e.all_day ? "día" : hhmm(e.start_ts), title: e.title, meta: e.location ? `Calendario · ${e.location}` : "Calendario", ...TONES.amber });
  }
  for (const r of db
    .prepare(
      `SELECT e.item_id, e.at, e.event, COALESCE(i.title, i.raw, t.task, t.title, e.item_id) AS title
       FROM item_events e
       LEFT JOIN items i ON i.id = e.item_id
       LEFT JOIN todos t ON (t.source || ':' || t.ref) = e.item_id
       WHERE e.at >= ? AND e.event IN ('done', 'dismiss', 'schedule')`
    )
    .all(from) as any[]) {
    if (r.event === "done" && blockRefs.has(r.item_id)) continue;
    const meta = r.event === "done" ? "Marcada por ti" : r.event === "dismiss" ? "Descartada" : "Planificada";
    out.push({ ts: r.at, time: hhmm(r.at), title: String(r.title).slice(0, 80), meta, ...TONES.green });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, 6);
}

/** Share of today's important things already handled; null when there is nothing to measure. */
function dayScore(): number | null {
  const from = startOfDay();
  const handled = (
    db
      .prepare("SELECT COUNT(DISTINCT item_id) n FROM item_events WHERE at >= ? AND event IN ('done', 'dismiss', 'schedule')")
      .get(from) as { n: number }
  ).n;
  const open =
    (db.prepare("SELECT COUNT(*) n FROM todos WHERE state = 'needs-reply'").get() as { n: number }).n +
    (
      db
        .prepare("SELECT COUNT(*) n FROM items WHERE state IN ('active', 'inbox') AND COALESCE(urgency, 0) >= 2 AND (snooze_until IS NULL OR snooze_until <= ?)")
        .get(Date.now()) as { n: number }
    ).n;
  if (!handled && !open) return null;
  return Math.round((100 * handled) / (handled + open));
}

function greeting(): string {
  const h = new Date().getHours();
  const name = firstName();
  const hello = h < 6 ? "Buenas noches" : h < 13 ? "Buenos días" : h < 21 ? "Buenas tardes" : "Buenas noches";
  return name ? `${hello}, ${name}.` : `${hello}.`;
}

function dateLine(short: boolean): string {
  const d = new Date();
  return short
    ? `${DAYS[d.getDay()]}, ${d.getDate()} ${MON3[d.getMonth()]}`
    : `${DAYS[d.getDay()]}, ${d.getDate()} DE ${MONTHS[d.getMonth()]}`;
}

// --- Memoria -----------------------------------------------------------

const SOURCE_TAG: Record<string, { label: string; tone: (typeof TONES)["green"] }> = {
  email: { label: "GMAIL", tone: TONES.blue },
  whatsapp: { label: "WHATSAPP", tone: TONES.green },
  linkedin: { label: "LINKEDIN", tone: TONES.blue },
};

const LANE_ACTION: Record<string, string> = {
  reply: "Responder",
  deadline: "Responder hoy",
  opportunity: "Mirar",
  explore: "Leer luego",
};

function memoria() {
  const since = Number(getMeta("last_digest_at") ?? 0) || Date.now() - DAY;
  const worth: any[] = [];
  for (const t of db
    .prepare("SELECT * FROM todos WHERE state = 'needs-reply' AND last_ts > ? ORDER BY last_ts DESC")
    .all(since) as any[]) {
    const tag = SOURCE_TAG[t.source] ?? { label: t.source.toUpperCase(), tone: TONES.amber };
    worth.push({
      id: `${t.source}:${t.ref}`,
      kind: "todo",
      source: tag.label,
      when: whenLabel(t.last_ts),
      tint: tag.tone.tint,
      color: tag.tone.ink,
      title: t.task || `Responder a ${t.title}`,
      why: t.state_reason || `${t.title} espera respuesta.`,
      action: LANE_ACTION[t.lane] ?? "Responder",
      url: todoUrl(t.source, t.ref),
      score: (t.lane === "deadline" ? 120 : 85),
    });
  }
  for (const r of db
    .prepare(
      `SELECT * FROM items WHERE created_at > ? AND state IN ('active', 'inbox') AND processed_at IS NOT NULL
         AND (COALESCE(urgency, 0) >= 1 OR COALESCE(importance, 0) >= 4)
       ORDER BY priority DESC LIMIT 10`
    )
    .all(since) as any[]) {
    const self = /whatsapp/.test(r.source);
    worth.push({
      id: r.id,
      kind: "item",
      source: self ? "WHATSAPP · TÚ" : "TÚ",
      when: whenLabel(r.created_at),
      tint: TONES.amber.tint,
      color: TONES.amber.ink,
      title: r.title || r.raw || r.url,
      why: r.summary || "Lo guardaste tú.",
      action: ACTION_ES[r.action] ?? "Abrir",
      url: r.url || "",
      score: r.priority ?? 0,
    });
  }
  worth.sort((a, b) => b.score - a.score);

  const ignoredRows = db
    .prepare("SELECT * FROM todos WHERE state = 'no-action' AND last_ts > ? ORDER BY last_ts DESC")
    .all(since) as any[];
  const automated = ignoredRows.filter((r) => /automated/i.test(r.state_reason ?? "")).length;
  const parts = [
    automated ? plural(automated, "aviso automático", "avisos automáticos") : "",
    ignoredRows.length - automated ? `${ignoredRows.length - automated} sin respuesta necesaria` : "",
  ].filter(Boolean);
  const n = worth.length;
  const saved = savedWorth(since);
  return {
    since: sinceLabel(since),
    headline: n === 0 ? "Nada nuevo importante." : n === 1 ? "1 cosa vale la pena." : `${n} cosas valen la pena.`,
    sub: ignoredRows.length
      ? "El resto lo filtré por ti."
      : n
        ? "Nada más ha entrado."
        : saved.total
          ? "Pero tienes cosas guardadas que merecen tu tiempo."
          : "Puedes seguir con lo tuyo.",
    worth: worth.slice(0, 6),
    saved,
    ignored: {
      count: ignoredRows.length,
      breakdown: parts.join(" · "),
      items: ignoredRows.slice(0, 30).map((r) => ({
        id: `${r.source}:${r.ref}`,
        title: r.title,
        source: (SOURCE_TAG[r.source]?.label ?? r.source).toLowerCase(),
        reason: r.state_reason ?? "",
        when: whenLabel(r.last_ts),
      })),
    },
  };
}

function hostTag(url: string | null): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "").toUpperCase() : "GUARDADO";
  } catch {
    return "GUARDADO";
  }
}

const SAVED_ACTION: Record<string, string> = { read: "Leer", watch: "Ver", listen: "Escuchar", reference: "Abrir" };

/**
 * Things you saved to come back to (reading, videos, references) that rank high but haven't
 * come up lately. Three a day, rotating, so the backlog surfaces instead of rotting.
 */
function savedWorth(since: number) {
  const where = `state IN ('active', 'inbox') AND processed_at IS NOT NULL
         AND action IN ('read', 'watch', 'listen', 'reference') AND created_at <= ?
         AND (snooze_until IS NULL OR snooze_until <= ?)
         AND (COALESCE(importance, 0) >= 3 OR COALESCE(priority, 0) >= 50)`;
  const total = (db.prepare(`SELECT COUNT(*) n FROM items WHERE ${where}`).get(since, Date.now()) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM items WHERE ${where} ORDER BY COALESCE(importance, 0) DESC, priority DESC LIMIT 60`)
    .all(since, Date.now()) as any[];
  const fresh = rows.filter((r) => !skipped(r.id) && !isExpired(parseDue(r.title || r.raw, r.created_at)));
  const day = Math.floor(startOfDay() / DAY);
  const start = fresh.length ? (day * 3) % fresh.length : 0;
  const pick = [...fresh.slice(start), ...fresh.slice(0, start)].slice(0, 3);
  return {
    total,
    items: pick.map((r) => ({
      id: r.id,
      kind: "item",
      source: hostTag(r.url),
      when: whenLabel(r.created_at),
      tint: TONES.blue.tint,
      color: TONES.blue.ink,
      title: r.title || r.raw || r.url,
      why: r.summary || "Lo guardaste para volver a ello.",
      action: SAVED_ACTION[r.action] ?? "Abrir",
      url: r.url || "",
      minutes: r.effort_min ?? 10,
    })),
  };
}

// --- Metas -------------------------------------------------------------

interface GoalRow {
  id: number;
  name: string;
  due: string | null;
  sessions_per_week: number;
  session_minutes: number;
  steps: string | null;
  margin: string | null;
  created_at: number;
}

function goalView(g: GoalRow, i: number) {
  const tone = GOAL_TONES[i % GOAL_TONES.length];
  const weekLogs = (
    db.prepare("SELECT COUNT(*) n FROM goal_logs WHERE goal_id = ? AND at > ?").get(g.id, Date.now() - WEEK) as { n: number }
  ).n;
  const total = g.due ? Math.max(1, Math.ceil((Date.parse(g.due) - g.created_at) / WEEK)) : 0;
  const week = Math.min(total || Infinity, Math.floor((Date.now() - g.created_at) / WEEK) + 1);
  const target = Math.max(1, g.sessions_per_week);
  // A new goal gets the benefit of the doubt until it has been around for a few days.
  const young = Date.now() - g.created_at < 3 * DAY;
  // a goal made of to-dos (tags goal:<id>) moves as they get done, not by sessions
  const linked = db.prepare("SELECT state FROM items WHERE tags = ?").all(`goal:${g.id}`) as { state: string }[];
  if (linked.length) {
    const done = linked.filter((x) => x.state === "done").length;
    const dueIn = g.due ? Math.ceil((Date.parse(g.due) + DAY - Date.now()) / DAY) : null;
    const elapsed = g.due ? Math.min(1, (Date.now() - g.created_at) / Math.max(DAY, Date.parse(g.due) + DAY - g.created_at)) : 0;
    const share = done / linked.length;
    return {
      id: g.id, name: g.name, due: g.due,
      meta: `${done} de ${linked.length} hechas${dueIn != null ? ` · ${dueIn > 0 ? `quedan ${dueIn} días` : "fecha pasada"}` : ""}`,
      pct: `${Math.round(100 * share)}%`,
      onTrack: young || share >= elapsed * 0.8,
      behind: !young && share < elapsed * 0.5,
      weekLogs: done, target: linked.length,
      steps: g.steps ? (JSON.parse(g.steps) as { when: string; what: string }[]) : [],
      margin: g.margin ?? "", tint: tone.tint, color: tone.color,
    };
  }
  return {
    id: g.id,
    name: g.name,
    due: g.due,
    meta: total ? `semana ${week} de ${total} · ${weekLogs}/${target}` : `${weekLogs} de ${target} esta semana`,
    pct: `${Math.min(100, Math.round((100 * weekLogs) / target))}%`,
    onTrack: young || weekLogs >= Math.ceil(target * 0.6),
    behind: !young && weekLogs < Math.ceil(target / 2),
    weekLogs,
    target,
    steps: g.steps ? (JSON.parse(g.steps) as { when: string; what: string }[]) : [],
    margin: g.margin ?? "",
    tint: tone.tint,
    color: tone.color,
  };
}

/**
 * Where measured focus time leads in three years, as a scenario with its assumptions spelled out:
 * your real pace (timed blocks of the last four weeks) against what your goals plan for.
 */
function focusProjection(goals: GoalRow[]) {
  const since = Date.now() - 28 * DAY;
  const rows = db
    .prepare("SELECT started_at, ended_at FROM focus_blocks WHERE ended_at IS NOT NULL AND started_at > ?")
    .all(since) as { started_at: number; ended_at: number }[];
  const hours4w = rows.reduce((a, r) => a + (r.ended_at - r.started_at) / 3_600_000, 0);
  const totalHours =
    ((db.prepare("SELECT COALESCE(SUM(ended_at - started_at), 0) s FROM focus_blocks WHERE ended_at IS NOT NULL").get() as { s: number }).s) /
    3_600_000;
  const pace = hours4w / 4;
  const plan = goals.length ? goals.reduce((a, g) => a + (g.sessions_per_week * g.session_minutes) / 60, 0) : null;
  const weeks = 156;
  const atRate = Math.round(totalHours + pace * weeks);
  const atTarget = plan == null ? null : Math.round(totalHours + plan * weeks);
  // "~1.100 h": round big numbers, and group thousands even with four digits (es-ES won't).
  const fmt = (n: number) => `~${String(n >= 1000 ? Math.round(n / 100) * 100 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} h`;
  const perWeek = (h: number) => `${String(Math.round(h * 10) / 10).replace(".", ",")} h/semana`;
  const y = new Date().getFullYear();
  const assumption = "Supone que el ritmo no cambia: es un escenario, no una predicción. Solo cuentan los bloques cronometrados.";
  let note: string;
  if (rows.length && plan != null) {
    note = `A tu ritmo de las últimas 4 semanas (${perWeek(pace)}) llegas a <b>${fmt(atRate)}</b> en 3 años. Lo que planean tus metas (${perWeek(plan)}) daría ${fmt(atTarget!)}. ${assumption}`;
  } else if (rows.length) {
    note = `A tu ritmo de las últimas 4 semanas (${perWeek(pace)}) llegas a <b>${fmt(atRate)}</b> en 3 años. ${assumption}`;
  } else if (plan != null) {
    note = `Tus metas piden ${perWeek(plan)}: <b>${fmt(atTarget!)}</b> en 3 años si las cumples. Tu ritmo real aparecerá cuando cronometres bloques desde Hoy.`;
  } else {
    note = "Aún no hay datos. Cuando cronometres bloques desde Hoy, verás aquí adónde te lleva tu ritmo real.";
  }
  return {
    total: Math.round(totalHours * 10) / 10,
    blocks4w: rows.length,
    atTarget,
    atRate,
    years: [y + 1, y + 2, y + 3],
    note,
  };
}

function metas() {
  const rows = db.prepare("SELECT * FROM goals WHERE archived = 0 ORDER BY created_at").all() as unknown as GoalRow[];
  const goals = rows.map(goalView);
  const good = goals.filter((g) => g.onTrack).length;
  const behind = goals.filter((g) => g.behind).sort((a, b) => a.weekLogs / a.target - b.weekLogs / b.target)[0];
  return {
    headline: goals.length ? `Vas bien en ${good} de ${goals.length}.` : "Aún no tienes metas.",
    projection: focusProjection(rows),
    anticipo: behind
      ? {
          goalId: behind.id,
          text: `${behind.name}: ${behind.weekLogs} de ${behind.target} sesiones esta semana.${behind.due ? ` Si sigue así, el margen hasta el ${behind.due.slice(8, 10)}/${behind.due.slice(5, 7)} se acaba.` : ""}`,
        }
      : null,
    goals,
  };
}

// --- Calendario --------------------------------------------------------

function calendario() {
  const days = new Map<string, { label: string; events: any[] }>();
  const today = startOfDay();
  for (const e of upcomingEvents(config.calendarDays)) {
    const d = startOfDay(e.start_ts);
    const key = String(d);
    const label =
      d === today ? "HOY" : d === today + DAY ? "MAÑANA" : `${DAYS[new Date(d).getDay()]}, ${new Date(d).getDate()} ${MON3[new Date(d).getMonth()]}`;
    const entry = days.get(key) ?? { label, events: [] };
    entry.events.push({
      time: e.all_day ? "todo el día" : hhmm(e.start_ts),
      end: e.end_ts && !e.all_day ? hhmm(e.end_ts) : "",
      title: e.title,
      location: e.location ?? "",
      link: e.link ?? "",
      past: (e.end_ts ?? e.start_ts) < Date.now(),
    });
    days.set(key, entry);
  }
  const planned = (db.prepare("SELECT * FROM agenda ORDER BY time").all() as any[]).map((a) => ({ id: a.id, time: a.time, title: a.title }));
  return {
    connected: googleConnected(),
    canConnect: googleConfigured(),
    days: [...days.values()],
    planned,
  };
}

/** What the app actually observes. Anything else on Hoy is what you marked yourself, so gaps here aren't progress. */
function coverage() {
  const google = googleConnected();
  const sources = [
    { name: "foco", on: true },
    { name: "correo", on: google },
    { name: "calendario", on: google },
    { name: "WhatsApp", on: waStatus().state === "connected" },
    { name: "GitHub", on: !!githubSnapshot() },
  ];
  const on = sources.filter((s) => s.on).map((s) => s.name);
  const off = sources.filter((s) => !s.on).map((s) => s.name);
  return {
    sources,
    note: `Mido: ${joinEs(on)}.${off.length ? ` Sin datos de ${joinEs(off)}.` : ""} Lo demás es lo que marcas tú.`,
  };
}

/**
 * The launcher's Pendiente panel. Things to do (not reading: that's Memoria), best first,
 * plus whatever you saved in the last day at the top, sorted or not yet, so a note you just
 * wrote shows up at once. Passed dates say so.
 */
function backlog(all: Candidate[]) {
  const since = Date.now() - DAY;
  const fresh = (db.prepare(
    `SELECT id, title, raw, url, action, effort_min, processed_at FROM items
     WHERE state IN ('active', 'inbox') AND created_at >= ? ORDER BY created_at DESC LIMIT 20`
  ).all(since) as any[]).map((r) => ({
    id: r.id, kind: "item" as const, title: r.title || r.raw || r.url || "Algo que guardaste", minutes: r.effort_min ?? 5, url: r.url ?? "",
    meta: r.processed_at ? `${ACTION_ES[r.action] ?? ""}`.trim() || "Guardado" : "Ordenando…", expired: false,
  }));
  const freshIds = new Set(fresh.map((f) => f.id));
  const todos = all
    .filter((c) => c.kind === "todo")
    .map((c) => ({ id: c.id, kind: c.kind, title: c.title, minutes: c.minutes, url: c.url ?? "", meta: c.meta, expired: false }));
  const items = (db.prepare(
    `SELECT * FROM items WHERE state IN ('active', 'inbox') AND processed_at IS NOT NULL AND action IN ('do', 'reply')
       AND (snooze_until IS NULL OR snooze_until <= ?) ORDER BY priority DESC LIMIT 200`
  ).all(Date.now()) as any[])
    .filter((r) => !freshIds.has(r.id) && !skipped(r.id) && !outdated(r))
    .map((r) => {
      const due = dueOf(r.id, r.title || r.raw || "", r.created_at);
      const late = isExpired(due ?? null);
      const effort = r.effort_min ?? 5;
      return {
        id: r.id, kind: "item" as const, title: r.title || r.raw || r.url || "Algo que guardaste", minutes: effort, url: r.url ?? "",
        meta: late ? `era para el ${dueLabel(due!)}` : [`${effort} min ${CONTEXT_ES[r.context] ?? ""}`.trim(), ACTION_ES[r.action] ?? ""].filter(Boolean).join(" · "),
        expired: late,
      };
    });
  const total =
    todos.length +
    (db.prepare(
      `SELECT COUNT(*) n FROM items WHERE state IN ('active', 'inbox') AND processed_at IS NOT NULL AND action IN ('do', 'reply')
         AND (snooze_until IS NULL OR snooze_until <= ?)`
    ).get(Date.now()) as { n: number }).n;
  return { fresh, list: [...todos, ...items], total };
}

/** Today's blocks for the Pendiente panel: planned windows and the focus blocks you ran. */
function todayBlocks(p: ReturnType<typeof policy>) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = start.getTime() + DAY;
  const planned = p.windows
    .filter((w) => (w.kind === "session" || w.kind === "focus") && w.start < end)
    .map((w) => ({ key: w.key, title: w.title, start: w.start, end: w.end, state: w.start > Date.now() ? "next" : "now" }));
  const ran = (db.prepare("SELECT * FROM focus_blocks WHERE started_at >= ? AND ended_at IS NOT NULL ORDER BY started_at").all(start.getTime()) as any[])
    .map((b) => ({ key: `ran:${b.id}`, title: b.title || "Bloque de foco", start: b.started_at, end: b.ended_at, state: "done" }));
  return [...ran, ...planned].sort((a, b) => a.start - b.start);
}

/** Changes on every deploy: the always-open home screen reloads when it sees a new one. */
const BUILD = String(Date.now());

/** Tasks switched off for now: nothing is suggested, planned or asked about; nothing is deleted. */
export const tasksPaused = () => getMeta("tasks_paused") === "1";
const NO_PLAN = { date: "", note: "", review: "", planning: false, slots: [], top: [], asking: [], now: null, next: null, ask: [], tomorrowFirst: null, upcoming: [] };

export function mobilePayload() {
  const paused = tasksPaused();
  const all = paused ? [] : candidates();
  const now = nowCandidate(all);
  const pol = policy();
  return {
    dateLong: dateLine(false),
    dateShort: dateLine(true),
    greeting: greeting(),
    score: dayScore(),
    now,
    expired: expiredCandidates(all),
    coverage: coverage(),
    reminders: reminders(),
    policy: { ...pol, active: activeWindow(pol) },
    plan: paused ? NO_PLAN : planPayload(),
    tasksPaused: paused,
    archived: archivedCount(),
    presence: { state: presenceNow().state, question: pendingQuestion() },
    assistant: { pending: paused ? [] : aiPending() },
    backlog: paused ? { fresh: [], list: [], total: 0 } : backlog(all),
    build: BUILD,
    github: githubSnapshot()?.items ?? [],
    todayBlocks: todayBlocks(pol),
    fuentes: {
      google: { configured: googleConfigured(), connected: googleConnected(), account: googleConnected() ? googleAccount() : "", waiting: aiWaiting() },
      whatsapp: { state: waStatus().state, phoneKnown: !!config.mePhone },
      github: { configured: githubConfigured(), login: githubSnapshot()?.login ?? "", nextRepo: getMeta("next_repo") ?? "" },
    },
    block: activeBlock(),
    timeline: timeline(),
    memoria: memoria(),
    metas: metas(),
    journal: journalPayload(),
    sleep: sleepPayload(),
    calendario: calendario(),
  };
}

// --- actions -----------------------------------------------------------

export function skipNow(id: string, hours = 3): void {
  setMeta(`skip:${id}`, String(Date.now() + hours * 3_600_000));
}

/** "It still stands": stop treating its date as passed for a week, then ask again. */
export function keepDue(id: string, days = 7): void {
  setMeta(`due_ok:${id}`, String(Date.now() + days * DAY));
  setMeta(`skip:${id}`, "0");
}

export function startBlock(ref: string, title: string, minutes: number): number {
  db.prepare("UPDATE focus_blocks SET ended_at = ? WHERE ended_at IS NULL").run(Date.now());
  const r = db
    .prepare("INSERT INTO focus_blocks (ref, title, planned_min, started_at) VALUES (?, ?, ?, ?)")
    .run(ref, title, Math.max(5, Math.min(240, minutes || 45)), Date.now());
  return Number(r.lastInsertRowid);
}

/** Close the open block; `done` also completes the task it was for. */
export function stopBlock(done: boolean): void {
  const b = db.prepare("SELECT * FROM focus_blocks WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get() as any;
  if (!b) return;
  db.prepare("UPDATE focus_blocks SET ended_at = ? WHERE id = ?").run(Date.now(), b.id);
  if (!done || !b.ref) return;
  if (db.prepare("SELECT 1 FROM items WHERE id = ?").get(b.ref)) {
    db.prepare("UPDATE items SET state = 'done' WHERE id = ?").run(b.ref);
    addEvent(b.ref, "done");
  } else {
    const i = b.ref.indexOf(":");
    db.prepare("UPDATE todos SET state = 'done', state_reason = 'hecho en un bloque de foco' WHERE source = ? AND ref = ?").run(
      b.ref.slice(0, i),
      b.ref.slice(i + 1)
    );
    addEvent(b.ref, "done");
  }
}

export function createGoal(p: {
  name: string;
  due?: string | null;
  sessions_per_week?: number;
  session_minutes?: number;
  steps?: { when: string; what: string }[];
  margin?: string;
}): number {
  const r = db
    .prepare(
      "INSERT INTO goals (name, due, sessions_per_week, session_minutes, steps, margin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      String(p.name).slice(0, 80),
      /^\d{4}-\d{2}-\d{2}$/.test(p.due ?? "") ? p.due! : null,
      Math.max(1, Math.min(14, Math.round(p.sessions_per_week ?? 3))),
      Math.max(5, Math.min(240, Math.round(p.session_minutes ?? 60))),
      JSON.stringify((p.steps ?? []).slice(0, 8).map((s) => ({ when: String(s.when).slice(0, 16), what: String(s.what).slice(0, 140) }))),
      String(p.margin ?? "").slice(0, 200),
      Date.now()
    );
  return Number(r.lastInsertRowid);
}

export function logGoal(id: number): void {
  db.prepare("INSERT INTO goal_logs (goal_id, at) VALUES (?, ?)").run(id, Date.now());
}

export function archiveGoal(id: number): void {
  db.prepare("UPDATE goals SET archived = 1 WHERE id = ?").run(id);
}

/** The model sometimes anchors to the wrong year; a goal's deadline can't be in the past. */
function futureDate(due: unknown): string | null {
  if (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  let [y, m, d] = due.split("-").map(Number);
  const today = startOfDay();
  while (new Date(y, m - 1, d).getTime() < today) y++;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** One turn of the "Nueva meta" conversation: a short question, or a plan worked back from the deadline. */
export async function goalChat(turns: ChatTurn[]): Promise<{ reply: string; plan: any | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const transcript = turns
    .slice(-12)
    .map((t) => `${t.role === "user" ? "Usuario" : "Unibox"}: ${t.content.slice(0, 800)}`)
    .join("\n");
  const asked = turns.filter((t) => t.role === "assistant").length;
  const out = await llm(
    [
      {
        role: "system",
        content:
          `Eres el planificador de metas de Unibox. Hoy es ${today}. Conviertes una meta en un plan realista trabajando hacia atrás desde la fecha límite. ` +
          `Habla en español, breve y cálido, sin emojis. Haz como mucho 2 preguntas en total, una por turno ` +
          `(lo más útil: horas reales disponibles por semana, o la fecha si no la dio). ` +
          (asked >= 2 ? "Ya has preguntado suficiente: propón el plan ahora. " : "") +
          `Cuando tengas lo necesario, propón el plan. Responde SOLO JSON: ` +
          `{"reply":"texto para el usuario","plan":null} o ` +
          `{"reply":"Trabajando hacia atrás desde la fecha:","plan":{"name":"nombre corto de la meta","due":"YYYY-MM-DD",` +
          `"sessions_per_week":número,"session_minutes":número,"steps":[{"when":"SEM 1–8","what":"qué hacer"}],` +
          `"margin":"Margen: N semanas. Te aviso si 3 sesiones seguidas no ocurren."}}. ` +
          `Usa entre 3 y 5 pasos; el último es la fecha límite, con when en formato "MES DÍA" en mayúsculas (p. ej. "FEB 26"). ` +
          `La fecha límite siempre es futura: si el usuario nombra un mes que este año ya pasó, es el del año que viene. ` +
          `"Antes de marzo" significa como tarde el último día de febrero. ` +
          `sessions_per_week y session_minutes salen de lo que el usuario dijo que puede (p. ej. 1 h de lunes a viernes y 2 h el sábado = 6 sesiones).`,
      },
      { role: "user", content: transcript },
    ],
    // reasoning on: counting sessions from "1 h weekdays + 2 h Saturdays" is where the fast mode slips
    { json: true, temperature: 0.4, thinking: true }
  );
  const data = JSON.parse(out) as { reply?: string; plan?: any };
  const plan = data.plan && data.plan.name && Array.isArray(data.plan.steps) ? data.plan : null;
  if (plan) {
    plan.due = futureDate(plan.due);
    // the last step is the deadline itself; take its label from the date, not the model
    const last = plan.steps[plan.steps.length - 1];
    if (plan.due && last) {
      const [, m, d] = plan.due.split("-").map(Number);
      last.when = `${MON3[m - 1]} ${d}`;
    }
  }
  return { reply: String(data.reply ?? "").slice(0, 600) || "¿Me cuentas un poco más?", plan };
}
