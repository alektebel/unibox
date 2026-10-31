import { itemGoal } from "./slate.js";
import { addDays } from "./days.js";
import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";
import { llm } from "./llm.js";
import { upcomingEvents } from "./google.js";
import { addEvent } from "./capture/ingest.js";
import { parseDue, isExpired } from "./deadline.js";
import { startChat, addTurn, turns as chatTurns } from "./chats.js";
import { aiKind, runAiTasks } from "./aitasks.js";
import { workHoursFor } from "./presence.js";
import { commitmentsBetween } from "./commitments.js";

// The day plan: out of hundreds of open things, pick a few, give each one a time, then look
// at what actually happened and adapt (what slipped comes back or gets questioned, parts of
// the day you don't follow through get fewer things, slot lengths follow your real pace).

db.exec(`
CREATE TABLE IF NOT EXISTS plan_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  action TEXT,
  url TEXT,
  -- planned | asking (ended: the AI asks if you did it) | done | missed | moved
  status TEXT NOT NULL DEFAULT 'planned',
  why TEXT,
  created_at INTEGER NOT NULL,
  evaluated_at INTEGER,
  actual_min INTEGER
);
CREATE INDEX IF NOT EXISTS idx_plan_date ON plan_slots (date, start);
CREATE TABLE IF NOT EXISTS plan_days (
  date TEXT PRIMARY KEY,
  note TEXT,
  review TEXT,
  planned_at INTEGER NOT NULL,
  by TEXT
);
`);

// a slot you (or the chat) put on a given day: replanning that day leaves it where it is
try { db.exec("ALTER TABLE plan_slots ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch {}

const MIN = 60_000;
const DAY = 86_400_000;
const BREAK_MIN = 10;

export interface Gap { start: number; end: number; tag: "trabajo" | "libre" }
export interface Candidate {
  ref: string;
  kind: "item" | "todo";
  title: string;
  action: string;
  context: string;
  effort: number;
  url: string;
  score: number;
  due: number | null;
  misses: number;
}
export interface Pick { ref: string; gap: number; why: string }
export interface Slot {
  id: number; date: string; start: number; end: number; ref: string; kind: string; title: string;
  action: string | null; url: string | null; status: string; why: string | null; actual_min: number | null;
}

// --- time ---------------------------------------------------------------

export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function at(day: number, hhmm: string, fallback: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!;
  const d = new Date(day);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const partOfDay = (ts: number) => {
  const h = new Date(ts).getHours();
  return h < 12 ? "mañana" : h < 17 ? "mediodía" : "tarde";
};

/**
 * Free time in a day: from the start of the day (or now) to its end, cut at work hours,
 * minus what's already taken (calendar, goal sessions, focus blocks, exercise).
 */
export function freeGaps(day: number, now: number, busy: { start: number; end: number }[]): Gap[] {
  const weekend = new Date(day).getDay() % 6 === 0;
  const from = Math.max(now, weekend ? at(day, config.planWeekendStart, "09:30") : at(day, config.planDayStart, "07:30"));
  const to = at(day, config.planDayEnd, "23:00");
  if (from >= to) return [];
  // learned from where you've been (presence.ts); configured hours until there's data
  const [ws, we] = (workHoursFor(day, now) || "").split("-");
  const cuts: { start: number; end: number; tag: Gap["tag"] }[] = [];
  if (ws && we) {
    const w0 = at(day, ws, "09:00"), w1 = at(day, we, "17:00");
    cuts.push({ start: from, end: Math.min(to, w0), tag: "libre" });
    cuts.push({ start: Math.max(from, w0), end: Math.min(to, w1), tag: "trabajo" });
    cuts.push({ start: Math.max(from, w1), end: to, tag: "libre" });
  } else {
    cuts.push({ start: from, end: to, tag: "libre" });
  }
  const taken = [...busy].sort((a, b) => a.start - b.start);
  const out: Gap[] = [];
  for (const c of cuts) {
    let cursor = c.start;
    for (const b of taken) {
      if (b.end <= cursor || b.start >= c.end) continue;
      if (b.start > cursor) out.push({ start: cursor, end: b.start, tag: c.tag });
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < c.end) out.push({ start: cursor, end: c.end, tag: c.tag });
  }
  return out.filter((g) => g.end - g.start >= 20 * MIN);
}

/** How long a slot for this item lasts, given how your real time compares to estimates. Deep work gets up to two hours. */
export function slotMinutes(effort: number, ratio = effortRatio(), deep = false): number {
  return Math.max(15, Math.min(deep ? 120 : 60, Math.round((effort || 15) * ratio / 5) * 5));
}
const isDeep = (c: { action: string; context: string }) => c.action === "do" && (c.context === "desk" || c.context === "focus");

/** "Leer X, cap. 3" and "Leer X, cap. 4" are the same series. */
export function seriesKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[,(]?\s*(caps?\.?|cap[ií]tulos?|chapters?|parte?s?|part)\s*[\d\s,y&-]+.*$/u, "")
    .replace(/\d+/g, "")
    .trim();
}

/** At most two chapters of one book a day (stages of a project can run back to back). */
export function capSeries(picks: Pick[], cands: Map<string, Candidate>, perDay = 2): Pick[] {
  const seen = new Map<string, number>();
  return picks.filter((p) => {
    const c = cands.get(p.ref);
    if (!c) return false;
    if (!["read", "watch", "listen"].includes(c.action)) return true;
    const k = seriesKey(c.title);
    const n = seen.get(k) ?? 0;
    if (n >= perDay) return false;
    seen.set(k, n + 1);
    return true;
  });
}

/** Lay picks out back to back inside their gaps, with a short break; what doesn't fit is left out. */
export function pack(gaps: Gap[], picks: Pick[], cands: Map<string, Candidate>, ratio = effortRatio()) {
  const cursor = gaps.map((g) => g.start);
  const out: { ref: string; start: number; end: number; why: string }[] = [];
  for (const p of picks) {
    const c = cands.get(p.ref);
    const g = gaps[p.gap];
    if (!c || !g) continue;
    const len = slotMinutes(c.effort, ratio, isDeep(c)) * MIN;
    if (cursor[p.gap] + len > g.end) continue;
    out.push({ ref: p.ref, start: cursor[p.gap], end: cursor[p.gap] + len, why: p.why });
    cursor[p.gap] += len + BREAK_MIN * MIN;
  }
  return out.sort((a, b) => a.start - b.start);
}

// --- what to choose from ------------------------------------------------

// work hours: doing and replying; free time: everything (deep work too: weekends count)
// work hours are for your job: only things marked as work go there (your own projects, reading
// and errands wait for after work and the weekend)
const fits = (c: Candidate, tag: Gap["tag"]) =>
  tag === "trabajo" ? c.context === "work" : true;

const STALE_DAYS = 45;

/**
 * Something that no longer belongs on the list: its date has passed (unless you said it still
 * stands), or it's been sitting for weeks with nobody choosing it (no priority you set, not part
 * of a goal). It isn't deleted, just kept out of sight.
 */
export function outdated(r: { id: string; title?: string | null; raw?: string | null; created_at: number; tags?: string | null; priority_set?: number | null }, now = Date.now()): boolean {
  if (String(r.tags ?? "").startsWith("goal:")) return false;
  const okUntil = Number(getMeta(`due_ok:${r.id}`) ?? 0);
  if (okUntil <= now && isExpired(parseDue(r.title || r.raw || "", r.created_at), now)) return true;
  return r.priority_set == null && now - r.created_at > STALE_DAYS * DAY;
}

export function candidates(now: number, exclude: Set<string> = new Set()): Candidate[] {
  const rows = db.prepare(
    `SELECT * FROM items WHERE state IN ('active', 'inbox') AND processed_at IS NOT NULL
       AND action IN ('do', 'reply', 'read', 'watch', 'listen', 'buy')
       AND (snooze_until IS NULL OR snooze_until <= ?) ORDER BY priority DESC LIMIT 150`
  ).all(now) as any[];
  const out: Candidate[] = [];
  for (const r of rows) {
    if (exclude.has(r.id)) continue;
    const misses = Number(getMeta(`plan_miss:${r.id}`) ?? 0);
    // missed twice: it waits for your answer in "¿Sigue importando?" instead (except a goal's
    // next part: the goal doesn't move without it, so it keeps coming back)
    const goalPart = String(r.tags ?? "").startsWith("goal:");
    if (misses >= 2 && !goalPart) continue;
    const title = r.title || r.raw || r.url || "";
    if (!title) continue;
    // the AI does these itself (aitasks.ts): never yours to plan
    if (aiKind(title)) continue;
    if (outdated(r, now)) continue;
    const okUntil = Number(getMeta(`due_ok:${r.id}`) ?? 0);
    const due = okUntil > now ? null : parseDue(title, r.created_at);
    let score = r.priority ?? 0;
    if (due != null && due - now < 3 * DAY) score += 40;
    else if (due != null && due - now < 7 * DAY) score += 15;
    if ((r.urgency ?? 0) >= 2) score += 10;
    if (now - r.created_at < DAY) score += 5;
    score -= (goalPart ? Math.min(misses, 1) : misses) * 15;
    out.push({
      ref: r.id, kind: "item", title, action: r.action, context: r.context ?? "", effort: r.effort_min ?? 15,
      url: r.url ?? "", score, due, misses,
    });
  }
  for (const t of db.prepare("SELECT * FROM todos WHERE state = 'needs-reply' ORDER BY last_ts DESC LIMIT 10").all() as any[]) {
    const ref = `${t.source}:${t.ref}`;
    if (exclude.has(ref)) continue;
    const misses = Number(getMeta(`plan_miss:${ref}`) ?? 0);
    if (misses >= 2) continue;
    out.push({
      ref, kind: "todo", title: t.task || `Responder a ${t.title ?? "alguien"}`, action: "reply", context: "phone",
      effort: 10, url: "", score: 60 - misses * 15, due: null, misses,
    });
  }
  const turn = whoseTurn();
  return out.filter((c) => c.kind !== "item" || turn(c.ref)).sort((a, b) => b.score - a.score);
}

/**
 * Whether an item's turn has come: the next open part of its series (decided over every open
 * part: if the current stage is set aside, the series waits for it) and, in a goal, the first
 * open part in the goal's order (A6 waits for A1, A1 for A5's last stage). Stage 2 comes before
 * a raised stage 5. Also what the chat may schedule directly.
 */
export function whoseTurn(): (ref: string) => boolean {
  const open = db.prepare("SELECT id, title, raw, tags FROM items WHERE state IN ('active', 'inbox')").all() as any[];
  const heads = new Set(nextInSeries(open.map((r) => ({ id: r.id, title: r.title || r.raw || "" }))).map((r) => r.id));
  const goalHead = new Map<string, string>();
  for (const r of db.prepare("SELECT id, tags FROM items WHERE state IN ('active', 'inbox') AND tags LIKE 'goal:%' ORDER BY priority DESC, rowid").all() as any[]) {
    if (heads.has(r.id) && !goalHead.has(r.tags)) goalHead.set(r.tags, r.id);
  }
  const goalOf = new Map(open.filter((r) => String(r.tags ?? "").startsWith("goal:")).map((r) => [r.id, r.tags]));
  return (ref: string) => heads.has(ref) && (!goalOf.has(ref) || goalHead.get(goalOf.get(ref)) === ref);
}

/**
 * Numbered parts of one thing (stage 3/18, cap. 4, checks 10–18) go one at a time: the next
 * part only comes up once the one before is done. Items that share a title once their numbers
 * are taken out are a series; only the lowest-numbered one still open stays.
 */
export function nextInSeries<T extends { title: string }>(cands: T[]): T[] {
  // "A5 infrastructure-from-scratch · etapa 3/18: cache.py" → series "infrastructure-from-scratch · etapa", part 3
  const SERIES = /(etapa|stage|cap\.?|cap[ií]tulos?|chapters?|parte?|part|checks?|lecci[oó]n|lesson|episodio|ep\.?|semana|week|\()\s*$/i;
  const part = (t: string): { key: string; n: number } | null => {
    const rest = t.replace(/^[A-Za-z]\d+\s+/, "");
    const m = /^(.*?)(\d+)/.exec(rest);
    if (!m || !SERIES.test(m[1]) || m[1].trim().length < 6) return null;
    return { key: m[1].toLowerCase().replace(/\s+/g, " ").trim(), n: Number(m[2]) };
  };
  const first = new Map<string, { c: T; n: number }>();
  for (const c of cands) {
    const p = part(c.title);
    if (!p) continue;
    const f = first.get(p.key);
    if (!f || p.n < f.n) first.set(p.key, { c, n: p.n });
  }
  return cands.filter((c) => {
    const p = part(c.title);
    return !p || first.get(p.key)!.c === c;
  });
}

// --- what happened, and what it teaches ----------------------------------

/** actual / estimated minutes for slots you did in a timed block (1 = estimates are right). */
export function effortRatio(): number {
  const r = Number(getMeta("plan_effort_ratio") ?? 1);
  return Number.isFinite(r) && r > 0 ? Math.max(0.5, Math.min(2.5, r)) : 1;
}

/** Done/total per part of the day, from slots already evaluated. */
export function followThrough(): Record<string, { done: number; total: number }> {
  try {
    return JSON.parse(getMeta("plan_parts") ?? "{}");
  } catch {
    return {};
  }
}

/** How many things a part of the day gets: fewer where you rarely get to them. */
export function capacityFor(part: string, tag: Gap["tag"]): number {
  const base = tag === "trabajo" ? config.planWorkSlots : config.planFreeSlots;
  const s = followThrough()[part];
  if (s && s.total >= 5 && s.done / s.total < 0.3) return Math.min(base, 1);
  if (s && s.total >= 5 && s.done / s.total < 0.6) return Math.max(1, base - 1);
  return base;
}

function isDone(slot: Slot): boolean {
  if (slot.kind === "item") {
    const r = db.prepare("SELECT state FROM items WHERE id = ?").get(slot.ref) as { state: string } | undefined;
    return !r || r.state === "done";
  }
  const i = slot.ref.indexOf(":");
  const t = db.prepare("SELECT state FROM todos WHERE source = ? AND ref = ?").get(slot.ref.slice(0, i), slot.ref.slice(i + 1)) as { state: string } | undefined;
  return !t || t.state !== "needs-reply";
}

function blockMinutes(slot: Slot): number {
  const day = startOfDay(slot.start);
  const r = db.prepare(
    "SELECT COALESCE(SUM(ended_at - started_at), 0) ms FROM focus_blocks WHERE ref = ? AND ended_at IS NOT NULL AND started_at >= ? AND started_at < ?"
  ).get(slot.ref, day, day + DAY) as { ms: number };
  return Math.round(r.ms / MIN);
}

/**
 * Look at every slot that has ended: done (marked, or a timed block on it) or missed.
 * Learns from it, and reports whether today needs replanning.
 */
/** You started a block on it around its time (from Hoy or the home screen). */
function startedIn(s: Slot): boolean {
  return !!db.prepare("SELECT 1 FROM focus_blocks WHERE ref = ? AND started_at BETWEEN ? AND ?").get(s.ref, s.start - 60 * MIN, s.end);
}

export function evaluate(now = Date.now()): { missed: number; done: number } {
  // asked yesterday or before and never answered: that's a miss
  for (const s of db.prepare("SELECT * FROM plan_slots WHERE status = 'asking' AND end < ?").all(startOfDay(now)) as unknown as Slot[]) {
    if (isDone(s)) continue;
    db.prepare("UPDATE plan_slots SET status = 'missed', evaluated_at = ? WHERE id = ?").run(now, s.id);
    setMeta(`plan_miss:${s.ref}`, String(Number(getMeta(`plan_miss:${s.ref}`) ?? 0) + 1));
  }
  const open = db.prepare("SELECT * FROM plan_slots WHERE status IN ('planned', 'asking') AND start < ?").all(now + DAY) as unknown as Slot[];
  const parts = followThrough();
  let missed = 0, done = 0;
  for (const s of open) {
    // taken over by the AI, archived or dropped since it was planned: it leaves the plan
    if (s.kind === "item") {
      const st = (db.prepare("SELECT state FROM items WHERE id = ?").get(s.ref) as any)?.state;
      if (st === "ai" || st === "archived" || st === "dropped") {
        db.prepare("UPDATE plan_slots SET status = 'moved', evaluated_at = ? WHERE id = ?").run(now, s.id);
        continue;
      }
    }
    const finished = isDone(s);
    // done early, or done some other way: it no longer needs its slot
    if (finished) {
      const minutes = blockMinutes(s);
      db.prepare("UPDATE plan_slots SET status = 'done', evaluated_at = ?, actual_min = ? WHERE id = ?").run(now, minutes || null, s.id);
      if (minutes > 0) {
        const est = (s.end - s.start) / MIN / effortRatio();
        const ratio = 0.8 * effortRatio() + 0.2 * Math.max(0.5, Math.min(2.5, minutes / Math.max(5, est)));
        setMeta("plan_effort_ratio", ratio.toFixed(3));
      }
      if (s.start < now) {
        const p = (parts[partOfDay(s.start)] ??= { done: 0, total: 0 });
        p.done++;
        p.total++;
      }
      done++;
      continue;
    }
    if (s.end > now || s.status === "asking") continue;
    // the plan proposes, it doesn't oblige: a gap that passed without you starting it just goes
    // back to the queue (no miss, no question). Only what you started gets asked about.
    if (startedIn(s)) db.prepare("UPDATE plan_slots SET status = 'asking', evaluated_at = ? WHERE id = ?").run(now, s.id);
    else db.prepare("UPDATE plan_slots SET status = 'moved', evaluated_at = ? WHERE id = ?").run(now, s.id);
  }
  // older evidence matters less: keep the counts to roughly the last few weeks
  for (const p of Object.values(parts)) {
    if (p.total > 60) { p.done = Math.round(p.done * 0.8); p.total = Math.round(p.total * 0.8); }
  }
  setMeta("plan_parts", JSON.stringify(parts));
  return { missed, done };
}

// --- planning -------------------------------------------------------------

function busyFor(day: number, now: number): { start: number; end: number }[] {
  const busy: { start: number; end: number }[] = [];
  // hours the agent gave you off (you had plans): nothing goes there
  const off = freeWindow(now);
  if (off) busy.push(off);
  for (const e of upcomingEvents(Math.max(2, Math.ceil((day - startOfDay(now)) / DAY) + 1))) {
    if (e.all_day || startOfDay(e.start_ts) !== day) continue;
    busy.push({ start: e.start_ts - 10 * MIN, end: (e.end_ts ?? e.start_ts + 60 * MIN) + 10 * MIN });
  }
  // what your messages and email commit you to (commitments.ts)
  for (const c of commitmentsBetween(day, day + DAY)) busy.push({ start: c.start - 15 * MIN, end: c.end + 15 * MIN });
  if (config.exerciseAt) {
    const s = at(day, config.exerciseAt, "19:00");
    busy.push({ start: s, end: s + 45 * MIN });
  }
  // goal sessions on their days (policy windows) and a block running now
  const goals = db.prepare("SELECT * FROM goals WHERE archived = 0").all() as any[];
  const wd = (new Date(day).getDay() + 6) % 7;
  for (const g of goals) {
    if (itemGoal(g.id)) continue;
    const n = Math.max(0, Math.min(7, Math.round(g.sessions_per_week)));
    const days = n ? [...new Set(Array.from({ length: n }, (_, i) => (Math.round(i * (7 / n)) + (n === 2 ? 1 : 0)) % 7))] : [];
    if (!days.includes(wd)) continue;
    const s = at(day, config.sessionAt, "18:00");
    busy.push({ start: s, end: s + g.session_minutes * MIN });
  }
  const open = db.prepare("SELECT * FROM focus_blocks WHERE ended_at IS NULL").get() as any;
  if (open) busy.push({ start: open.started_at, end: open.started_at + open.planned_min * MIN });
  // slots already kept for that day (done, or still to come)
  for (const s of db.prepare("SELECT start, end FROM plan_slots WHERE date = ? AND status IN ('planned', 'done') AND end > ?").all(localDate(day), now) as any[]) {
    busy.push({ start: s.start, end: s.end + BREAK_MIN * MIN });
  }
  return busy;
}

/** Best things first, each into the first gap it fits, within each part of the day's capacity. */
export function greedy(cands: Candidate[], gaps: Gap[]): Pick[] {
  const used = new Set<string>();
  const left = gaps.map((g) => capacityFor(partOfDay(g.start), g.tag));
  const room = gaps.map((g) => g.end - g.start);
  const picks: Pick[] = [];
  for (const c of cands) {
    if (picks.length >= config.planMaxSlots) break;
    if (used.has(c.ref)) continue;
    const len = (slotMinutes(c.effort, effortRatio(), isDeep(c)) + BREAK_MIN) * MIN;
    const i = gaps.findIndex((g, k) => left[k] > 0 && room[k] >= len && fits(c, g.tag));
    if (i < 0) continue;
    left[i]--;
    room[i] -= len;
    used.add(c.ref);
    picks.push({ ref: c.ref, gap: i, why: c.due != null ? "tiene fecha cerca" : c.misses ? "se quedó pendiente" : "de lo más importante" });
  }
  return picks;
}

/** The model chooses and orders; anything it gets wrong falls back to the greedy plan. */
async function modelPicks(cands: Candidate[], gaps: Gap[], day: number): Promise<{ picks: Pick[]; note: string } | null> {
  if (!config.nanApiKey || !gaps.length || !cands.length) return null;
  const top = cands.slice(0, 30);
  const hh = (t: number) => new Date(t).toTimeString().slice(0, 5);
  const parts = followThrough();
  const history = Object.entries(parts).map(([p, s]) => `${p}: ${s.done}/${s.total} hechas`).join(", ") || "sin datos aún";
  const missedRecently = (db.prepare(
    "SELECT title FROM plan_slots WHERE status = 'missed' AND start > ? ORDER BY start DESC LIMIT 8"
  ).all(day - 7 * DAY) as any[]).map((r) => r.title);
  const prompt = [
    `Hoy es ${localDate(day)}. Huecos libres (índice, horario, tipo, cuántas cosas como mucho):`,
    ...gaps.map((g, i) => `${i}: ${hh(g.start)}-${hh(g.end)} ${g.tag} max ${capacityFor(partOfDay(g.start), g.tag)}`),
    ``,
    `Cumplimiento por parte del día: ${history}.`,
    missedRecently.length ? `No llegó a hacer esta semana: ${missedRecently.join("; ")}.` : ``,
    ``,
    `Candidatas, de más a menos prioritaria (id | prioridad 0-100 | acción | minutos | contexto | fecha | veces sin hacer | título):`,
    ...top.map((c) => `${c.ref} | ${Math.round(c.score)} | ${c.action} | ${c.effort} | ${c.context || "-"} | ${c.due ? localDate(c.due) : "-"} | ${c.misses} | ${c.title.slice(0, 120)}`),
  ].join("\n");
  try {
    const out = await llm(
      [
        {
          role: "system",
          content:
            `Eres el planificador diario de Unibox. Elige como mucho ${config.planMaxSlots} cosas de las candidatas y asigna cada una a un hueco. ` +
            `Respeta la prioridad: lo de prioridad alta va antes que lo rápido o lo cómodo, y no dejes fuera algo de prioridad alta si cabe en un hueco donde encaja. ` +
            `Si hay varias partes de una misma serie (capítulos), van en orden y como mucho una o dos por día. ` +
            `Sé realista: menos es mejor si en esa parte del día cumple poco. ` +
            `Los huecos de "trabajo" son para su empleo: solo tareas con contexto work; sus proyectos personales, lecturas y vídeos van a huecos "libre" (después del trabajo y fines de semana). ` +
            `Las etapas numeradas de un proyecto van en orden. ` +
            `Respeta el máximo de cada hueco. Responde SOLO JSON: {"plan":[{"id":"...","gap":0,"why":"por qué ahora, en 4-8 palabras naturales para ${config.meFirst || "el usuario"}, sin jerga interna (nada de prioridad, contexto, max, desk, hueco)"}],"note":"una frase para el usuario sobre el plan de hoy, en español, sin emojis"}`,
        },
        { role: "user", content: prompt },
      ],
      { json: true, temperature: 0.2 }
    );
    const parsed = JSON.parse(out);
    const ids = new Set(top.map((c) => c.ref));
    const count = gaps.map(() => 0);
    const picks: Pick[] = [];
    for (const p of parsed.plan ?? []) {
      const gap = Number(p.gap);
      const c = top.find((x) => x.ref === String(p.id));
      if (!c || !ids.has(c.ref) || !gaps[gap] || !fits(c, gaps[gap].tag)) continue;
      if (count[gap] >= capacityFor(partOfDay(gaps[gap].start), gaps[gap].tag)) continue;
      if (picks.some((x) => x.ref === c.ref) || picks.length >= config.planMaxSlots) continue;
      count[gap]++;
      picks.push({ ref: c.ref, gap, why: String(p.why ?? "").slice(0, 80) });
    }
    // the note describes the model's own choice: only keep it if that choice survived intact
    const intact = picks.length === (parsed.plan ?? []).length;
    return picks.length ? { picks, note: intact ? String(parsed.note ?? "").slice(0, 240) : "" } : null;
  } catch (e) {
    console.warn("[planner] model plan failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

function review(day: number): string {
  const prev = localDate(day - DAY);
  const rows = db.prepare("SELECT status, COUNT(*) n FROM plan_slots WHERE date = ? GROUP BY status").all(prev) as any[];
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const total = (by.done ?? 0) + (by.missed ?? 0) + (by.moved ?? 0);
  if (!total) return "";
  const parts = [`Ayer: ${by.done ?? 0} de ${total} hechas.`];
  if (by.missed) parts.push(`Lo que no hiciste vuelve a entrar con menos prioridad; si se te escapa dos veces, te pregunto si sigue importando.`);
  const ratio = effortRatio();
  if (ratio > 1.2) parts.push(`Tardas más de lo estimado, así que doy huecos más largos.`);
  return parts.join(" ");
}

let planning: Promise<void> | null = null;
export const isPlanning = () => !!planning;

/**
 * Make sure a day has a plan. Today: planned once (and again when something slipped or you
 * moved something); tomorrow: planned in the evening so the night screen can show it.
 */
let lastAiRun = 0;
export function ensurePlan(now = Date.now(), force = false): void {
  if (now - lastAiRun > 60_000) {
    lastAiRun = now;
    void runAiTasks().catch((e) => console.warn("[aitasks]", e instanceof Error ? e.message : e));
  }
  if (planning) return;
  const today = startOfDay(now);
  const date = localDate(today);
  const ev = evaluate(now);
  const has = db.prepare("SELECT 1 FROM plan_days WHERE date = ?").get(date);
  const tomorrow = today + DAY;
  const evening = new Date(now).getHours() >= 21;
  const hasTomorrow = db.prepare("SELECT 1 FROM plan_days WHERE date = ?").get(localDate(tomorrow));
  const replanToday = force || !has;
  if (!replanToday && !(evening && !hasTomorrow)) return;
  planning = (async () => {
    try {
      if (replanToday) await planDay(today, now, !has);
      // replanning (new priorities, the button) redoes tomorrow too if it's already planned
      if (evening && !db.prepare("SELECT 1 FROM plan_days WHERE date = ?").get(localDate(tomorrow))) await planDay(tomorrow, now, true);
      else if (force && hasTomorrow) await planDay(tomorrow, now, false);
    } catch (e) {
      console.warn("[planner]", e instanceof Error ? e.message : e);
    } finally {
      planning = null;
    }
  })();
}

/** Plan (or re-plan the rest of) one day. Done and past slots stay; future ones are redone. */
export async function planDay(day: number, now: number, first: boolean): Promise<void> {
  const date = localDate(day);
  db.prepare("DELETE FROM plan_slots WHERE date = ? AND status = 'planned' AND pinned = 0 AND start >= ?").run(date, now);
  // already in this day's plan, or planned and still to come on another day
  // (a goal's next part that slipped earlier today can come back later: the goal waits on it)
  const keep = new Set((db.prepare(
    `SELECT s.ref FROM plan_slots s LEFT JOIN items i ON i.id = s.ref
      WHERE (s.date = ? AND s.status NOT IN ('moved', 'missed') AND NOT (s.status = 'asking' AND COALESCE(i.tags, '') LIKE 'goal:%'))
         OR (s.status = 'planned' AND s.end > ?)`
  ).all(date, now) as any[]).map((r) => r.ref));
  const cands = candidates(now, keep);
  const gaps = freeGaps(day, now, busyFor(day, now));
  const byRef = new Map(cands.map((c) => [c.ref, c]));
  const model = await modelPicks(cands, gaps, day);
  const picks = capSeries(model?.picks ?? greedy(cands, gaps), byRef);
  const placed = pack(gaps, picks, byRef);
  const ins = db.prepare(
    "INSERT INTO plan_slots (date, start, end, ref, kind, title, action, url, why, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const p of placed) {
    const c = byRef.get(p.ref)!;
    ins.run(date, p.start, p.end, c.ref, c.kind, c.title.slice(0, 200), c.action, c.url || null, p.why || null, now);
  }
  // describe the whole day still ahead, including slots kept from before
  const ahead = db.prepare("SELECT action FROM plan_slots WHERE date = ? AND status = 'planned' AND end > ?").all(date, now) as { action: string | null }[];
  const kinds = (a: string | null) => (a === "read" || a === "watch" || a === "listen" ? "lectura" : "tarea");
  const counts = ahead.reduce((m, p) => { const k = kinds(p.action); m[k] = (m[k] ?? 0) + 1; return m; }, {} as Record<string, number>);
  const plain = ahead.length
    ? `${ahead.length} ${ahead.length === 1 ? "cosa" : "cosas"} (${Object.entries(counts).map(([k, n]) => `${n} de ${k}`).join(", ")}), cada una con su hora; el resto espera su momento.`
    : "Hoy no queda hueco libre: nada nuevo que hacer.";
  // a model note is only true if everything it chose made it into the day
  const note = model?.note && placed.length === model.picks.length ? model.note : plain;
  db.prepare(
    `INSERT INTO plan_days (date, note, review, planned_at, by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET note = excluded.note, planned_at = excluded.planned_at, by = excluded.by` + (first ? ", review = excluded.review" : "")
  ).run(date, note, first ? review(day) : null, now, model ? "model" : "greedy");
}

// --- hours off ------------------------------------------------------------------

/** The time you were given off, if it's still running. */
export function freeWindow(now = Date.now()): { start: number; end: number } | null {
  const v = getMeta("free_window");
  if (!v) return null;
  const w = JSON.parse(v) as { start: number; end: number };
  return w.end > now ? w : null;
}

/**
 * Give you hours off from now (you have plans): what was planned in them goes, the questions
 * wait, plan blocks don't hold you, and the rest of the day is planned around it.
 */
export function freeHours(hours: number, now = Date.now()): { end: number; moved: string[] } {
  const end = now + Math.round(Math.max(0.5, Math.min(12, hours)) * 60) * MIN;
  setMeta("free_window", JSON.stringify({ start: now, end }));
  const slots = db.prepare("SELECT id, title FROM plan_slots WHERE status = 'planned' AND end > ? AND start < ?").all(now, end) as any[];
  for (const s of slots) db.prepare("UPDATE plan_slots SET status = 'moved', evaluated_at = ? WHERE id = ?").run(now, s.id);
  setMeta("assistant_quiet_until", String(Math.max(Number(getMeta("assistant_quiet_until") ?? 0), end)));
  ensurePlan(now, true);
  return { end, moved: slots.map((s) => s.title) };
}

// --- the week: where things can go -----------------------------------------------

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "hoy a las 18:30", "mañana a las 9:00", "el sábado 25 a las 10:00". */
export function whenLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / DAY);
  const day = days === 0 ? "hoy" : days === 1 ? "mañana" : `el ${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
  return `${day} a las ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface Spot { start: number; end: number; tag: Gap["tag"]; label: string }

/** What kind of time a gap is, the way you'd say it: "después del trabajo", "sábado por la mañana". */
function spotLabel(g: Gap, now: number): string {
  const d = new Date(g.start);
  const days = Math.round((startOfDay(g.start) - startOfDay(now)) / DAY);
  const day = days === 0 ? "hoy" : days === 1 ? "mañana" : `${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
  if (g.tag === "trabajo") return `${day}, en horario de trabajo`;
  const h = d.getHours();
  const weekday = d.getDay() >= 1 && d.getDay() <= 5 && !!workHoursFor(startOfDay(g.start), now);
  const part = h < 14 ? (weekday ? "antes del trabajo" : "por la mañana") : h < 20 ? (weekday ? "después del trabajo" : "por la tarde") : "por la noche";
  return `${day} ${part}`;
}

/** Free time over the next days, after what's already planned or pinned; a long free stretch is split into morning, afternoon and night so each can be named. */
export function spots(now = Date.now(), days = 7): Spot[] {
  const out: Spot[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(now, i);
    const cuts = [at(day, "14:00", "14:00"), at(day, "20:00", "20:00")];
    for (const g of freeGaps(day, now, busyFor(day, now))) {
      const edges = [g.start, ...(g.tag === "libre" ? cuts.filter((c) => c > g.start && c < g.end) : []), g.end];
      for (let k = 0; k + 1 < edges.length; k++) {
        const part = { start: edges[k], end: edges[k + 1], tag: g.tag };
        if (part.end - part.start >= 20 * MIN) out.push({ ...part, label: spotLabel(part, now) });
      }
    }
  }
  return out;
}

/**
 * Give something a time in the coming week and keep it there: inside [from, to] if given
 * (a spot the chat chose), otherwise the first free time it fits (deep work and reading in
 * free time, quick doing and replying in work hours too).
 */
export function schedule(ref: string, now = Date.now(), within?: { from: number; to: number }): Slot | null {
  const it = db.prepare("SELECT * FROM items WHERE id = ?").get(ref) as any;
  if (!it) return null;
  const c = { action: it.action ?? "do", context: it.context ?? "" } as Candidate;
  const len = slotMinutes(it.effort_min ?? 15, effortRatio(), isDeep(c)) * MIN;
  // calls and errands only when places are open; nothing in the next quarter of an hour
  const opening = it.context === "phone" || it.context === "errand";
  for (const s of spots(now, 8)) {
    const d0 = startOfDay(s.start);
    let start = Math.max(within ? Math.max(s.start, within.from) : s.start, now + 15 * MIN);
    let end = within ? Math.min(s.end, within.to) : s.end;
    if (opening) { start = Math.max(start, at(d0, "09:00", "09:00")); end = Math.min(end, at(d0, "20:00", "20:00")); }
    start = Math.ceil(start / (5 * MIN)) * 5 * MIN;
    if (end - start < len || !fits(c, s.tag)) continue;
    db.prepare("DELETE FROM plan_slots WHERE ref = ? AND status = 'planned' AND start >= ?").run(ref, now);
    const id = Number(db.prepare(
      "INSERT INTO plan_slots (date, start, end, ref, kind, title, action, url, why, pinned, created_at) VALUES (?, ?, ?, ?, 'item', ?, ?, ?, ?, 1, ?)"
    ).run(localDate(start), start, start + len, ref, String(it.title || it.raw).slice(0, 200), it.action, it.url ?? null, s.label, now).lastInsertRowid);
    return slotById(id);
  }
  return null;
}

/** What's already set for the coming days, for Hoy and for the chat. */
export function upcoming(now = Date.now(), days = 7): { id: number; ref: string; title: string; start: number; end: number; when: string }[] {
  return (db.prepare("SELECT * FROM plan_slots WHERE status = 'planned' AND start >= ? AND start < ? ORDER BY start")
    .all(addDays(now, 1), addDays(now, days + 1)) as unknown as Slot[])
    .map((s) => ({ id: s.id, ref: s.ref, title: s.title, start: s.start, end: s.end, when: whenLabel(s.start, now) }));
}

// --- your actions ------------------------------------------------------------

export function slotById(id: number): Slot | null {
  return (db.prepare("SELECT * FROM plan_slots WHERE id = ?").get(id) as unknown as Slot) ?? null;
}

/** Marked done from the plan: the thing itself is done too. */
export function markDone(id: number): void {
  const s = slotById(id);
  if (!s) return;
  db.prepare("UPDATE plan_slots SET status = 'done', evaluated_at = ? WHERE id = ?").run(Date.now(), id);
  if (s.kind === "item") {
    db.prepare("UPDATE items SET state = 'done' WHERE id = ?").run(s.ref);
    addEvent(s.ref, "done", "plan");
  } else {
    const i = s.ref.indexOf(":");
    db.prepare("UPDATE todos SET state = 'done', state_reason = 'hecho desde el plan' WHERE source = ? AND ref = ?").run(s.ref.slice(0, i), s.ref.slice(i + 1));
  }
}

/** What's being closed: a planned slot, or any open thing straight from the list. */
export interface Target { slot: Slot | null; ref: string; kind: string; title: string; action: string | null; url: string | null }

export function target(slotId: number | null, ref: string | null): Target {
  if (slotId) {
    const slot = slotById(slotId);
    if (!slot) throw new Error("no existe ese bloque");
    return { slot, ref: slot.ref, kind: slot.kind, title: slot.title, action: slot.action, url: slot.url };
  }
  if (!ref) throw new Error("falta qué cerrar");
  const it = db.prepare("SELECT title, raw, action, url FROM items WHERE id = ?").get(ref) as any;
  if (it) return { slot: null, ref, kind: "item", title: it.title || it.raw, action: it.action, url: it.url };
  const i = ref.indexOf(":");
  const t = db.prepare("SELECT task, title FROM todos WHERE source = ? AND ref = ?").get(ref.slice(0, i), ref.slice(i + 1)) as any;
  if (!t) throw new Error("no encuentro eso");
  return { slot: null, ref, kind: "todo", title: t.task || `Responder a ${t.title}`, action: "reply", url: null };
}

const isReading = (a: string | null) => a === "read" || a === "watch" || a === "listen";

function checkinChat(t: Target): number {
  const key = t.slot ? `checkin_chat:${t.slot.id}` : `checkin_chat:ref:${t.ref}`;
  const existing = Number(getMeta(key) ?? 0);
  if (existing) return existing;
  const id = startChat("checkin");
  setMeta(key, String(id));
  addTurn(id, "assistant", `¿Cómo va «${t.title}»? Cuéntame en dos o tres líneas ${isReading(t.action) ? "qué has sacado" : "qué has hecho"}, o por qué no.`);
  return id;
}

function appendSummary(ref: string, line: string): void {
  const prev = (db.prepare("SELECT summary FROM items WHERE id = ?").get(ref) as any)?.summary;
  db.prepare("UPDATE items SET summary = ? WHERE id = ?").run(prev ? `${prev}\n\n${line}` : line, ref);
}

export type Outcome = "done" | "not_yet" | "not_needed" | "unclear";

/**
 * You close things by explaining, in your own words. The AI reads it as one of: done (and
 * checks it shows it: ideas from what you read, a result for a task), not yet (and why), no
 * longer needed (and why), or unclear (it asks). Every turn is saved; what you wrote stays
 * with the thing.
 */
export async function checkIn(slotId: number | null, text: string, ref: string | null = null): Promise<{ outcome: Outcome; done: boolean; reply: string }> {
  const t = target(slotId, ref);
  const chat = checkinChat(t);
  addTurn(chat, "user", text);
  const history = chatTurns(chat).map((x) => `${x.role === "user" ? "Usuario" : "Unibox"}: ${x.content}`).join("\n");
  let outcome: Outcome = "unclear";
  let reply = "";
  try {
    const out = await llm(
      [
        {
          role: "system",
          content:
            `Eres Unibox. El usuario te cuenta cómo va algo de su lista: «${t.title}» (tipo: ${t.action ?? "tarea"}${t.url ? `, enlace ${t.url}` : ""}). ` +
            `Clasifica lo que dice: "done" si lo ha terminado y su explicación lo demuestra (para lecturas y vídeos, ideas concretas del contenido; para tareas, qué hizo o qué resultado hubo; ` +
            `sé razonable, dos o tres frases concretas bastan, "ya está" o "ok" no), "not_yet" si no lo ha hecho o le falta, "not_needed" si ya no hace falta o no lo va a hacer, ` +
            `"unclear" si dice que lo hizo pero sin concretar, o no se entiende. ` +
            `Responde SOLO JSON {"outcome":"done"|"not_yet"|"not_needed"|"unclear","reply":"1-2 frases en español, cálidas y sin emojis: si done, un comentario breve sobre lo que contó; si unclear, una pregunta concreta; si not_yet o not_needed, una frase que lo acuse"}`,
        },
        { role: "user", content: history },
      ],
      { json: true, temperature: 0.3 }
    );
    const v = JSON.parse(out);
    outcome = (["done", "not_yet", "not_needed", "unclear"] as const).includes(v.outcome) ? v.outcome : "unclear";
    reply = String(v.reply ?? "").slice(0, 400);
  } catch {
    // without the model: an explanation of some substance counts as done
    outcome = text.trim().split(/\s+/).length >= 12 ? "done" : "unclear";
    reply = outcome === "done" ? "Apuntado." : "Cuéntame un poco más: qué has hecho en concreto, o por qué no.";
  }
  addTurn(chat, "assistant", reply, { outcome });
  applyOutcome(t, outcome, text);
  return { outcome, done: outcome === "done", reply };
}

/** Apply what you said about something: done, not yet, or no longer needed (unclear: nothing). */
export function applyOutcome(t: Target, outcome: Outcome, text: string): void {
  const d = new Date();
  const when = `${d.getDate()}/${d.getMonth() + 1}`;
  if (outcome === "done") {
    if (t.slot) markDone(t.slot.id);
    else closeThing(t, "done");
    if (t.kind === "item") appendSummary(t.ref, `Tu resumen (${when}): ${text.trim()}`);
    // the next part of its series or goal can come in now
    ensurePlan(Date.now(), true);
  } else if (outcome === "not_yet") {
    if (t.slot) notYet(t.slot.id, false);
    else setMeta(`plan_miss:${t.ref}`, String(Number(getMeta(`plan_miss:${t.ref}`) ?? 0) + 1));
    if (t.kind === "item") appendSummary(t.ref, `Aún no (${when}): ${text.trim()}`);
  } else if (outcome === "not_needed") {
    if (t.slot) db.prepare("UPDATE plan_slots SET status = 'moved', evaluated_at = ? WHERE id = ?").run(Date.now(), t.slot.id);
    closeThing(t, "dropped");
    if (t.kind === "item") appendSummary(t.ref, `Descartada (${when}): ${text.trim()}`);
    ensurePlan(Date.now(), true);
  }
}

function closeThing(t: Target, as: "done" | "dropped"): void {
  if (t.kind === "item") {
    db.prepare("UPDATE items SET state = ? WHERE id = ?").run(as, t.ref);
    addEvent(t.ref, as === "done" ? "done" : "drop", "explicado");
  } else {
    const i = t.ref.indexOf(":");
    db.prepare("UPDATE todos SET state = ?, state_reason = ? WHERE source = ? AND ref = ?")
      .run(as === "done" ? "done" : "dismissed", as === "done" ? "hecho, explicado" : "ya no hace falta", t.ref.slice(0, i), t.ref.slice(i + 1));
  }
}

/** "Aún no": it counts as missed, comes back with less weight, and the rest of the day is redone. */
export function notYet(slotId: number, record = true): void {
  const s = slotById(slotId);
  if (!s) return;
  if (record) addTurn(checkinChat(target(slotId, null)), "user", "Aún no.");
  db.prepare("UPDATE plan_slots SET status = 'missed', evaluated_at = ? WHERE id = ?").run(Date.now(), slotId);
  setMeta(`plan_miss:${s.ref}`, String(Number(getMeta(`plan_miss:${s.ref}`) ?? 0) + 1));
  const parts = followThrough();
  (parts[partOfDay(s.start)] ??= { done: 0, total: 0 }).total++;
  setMeta("plan_parts", JSON.stringify(parts));
  ensurePlan(Date.now(), true);
}

/** "Not now": your choice, so it doesn't count as missed; the rest of the day is redone. */
export function moveSlot(id: number): void {
  const s = slotById(id);
  if (!s) return;
  db.prepare("UPDATE plan_slots SET status = 'moved', evaluated_at = ? WHERE id = ?").run(Date.now(), id);
  // "otra cosa": the next suggestion is something else; this one comes back in a couple of hours
  if (s.kind === "item") db.prepare("UPDATE items SET snooze_until = ? WHERE id = ?").run(Date.now() + 2 * 3_600_000, s.ref);
  ensurePlan(Date.now(), true);
}

/** Close something straight from the list (a swipe): done, or archived (it can come back from Archivo). */
export function closeRef(ref: string, as: "done" | "archived", now = Date.now()): void {
  const it = db.prepare("SELECT id FROM items WHERE id = ?").get(ref);
  if (it) {
    db.prepare("UPDATE items SET state = ? WHERE id = ?").run(as, ref);
    addEvent(ref, as === "done" ? "done" : "archived", "deslizando");
  } else {
    const i = ref.indexOf(":");
    if (i > 0) db.prepare("UPDATE todos SET state = ?, state_reason = ? WHERE source = ? AND ref = ?")
      .run(as === "done" ? "done" : "dismissed", as === "done" ? "hecho, deslizando" : "archivado, deslizando", ref.slice(0, i), ref.slice(i + 1));
  }
  db.prepare("UPDATE plan_slots SET status = ?, evaluated_at = ? WHERE ref = ? AND status IN ('planned', 'asking')").run(as === "done" ? "done" : "moved", now, ref);
  ensurePlan(now, true);
}

/** Undo a swipe: back on the list as it was. */
export function reopenRef(ref: string, now = Date.now()): void {
  if (db.prepare("UPDATE items SET state = 'active' WHERE id = ? AND state IN ('done', 'archived')").run(ref).changes) addEvent(ref, "reopened", "deshacer");
  else {
    const i = ref.indexOf(":");
    if (i > 0) db.prepare("UPDATE todos SET state = 'needs-reply', state_reason = NULL WHERE source = ? AND ref = ?").run(ref.slice(0, i), ref.slice(i + 1));
  }
  ensurePlan(now, true);
}

/** "¿Sigue importando?": yes gives it a fresh start, no drops it. */
export function answerAsk(ref: string, keep: boolean): void {
  setMeta(`plan_miss:${ref}`, "0");
  if (keep) return;
  if (db.prepare("SELECT 1 FROM items WHERE id = ?").get(ref)) {
    db.prepare("UPDATE items SET state = 'dropped' WHERE id = ?").run(ref);
    addEvent(ref, "drop", "plan");
  } else {
    const i = ref.indexOf(":");
    db.prepare("UPDATE todos SET state = 'dismissed', state_reason = 'ya no importa' WHERE source = ? AND ref = ?").run(ref.slice(0, i), ref.slice(i + 1));
  }
}

// --- what the phone shows ------------------------------------------------------

/** The last thing the AI said in a check-in, if one has started. */
function lastAsk(slotId: number): string {
  const chat = Number(getMeta(`checkin_chat:${slotId}`) ?? 0);
  if (!chat) return "";
  const t = chatTurns(chat).filter((x) => x.role === "assistant");
  return t.length ? t[t.length - 1].content : "";
}

export function planPayload(now = Date.now()) {
  ensurePlan(now);
  const date = localDate(now);
  const slots = db.prepare("SELECT * FROM plan_slots WHERE date = ? AND status != 'moved' ORDER BY start").all(date) as unknown as Slot[];
  const day = db.prepare("SELECT * FROM plan_days WHERE date = ?").get(date) as any;
  const show = (s: Slot) => ({
    id: s.id, ref: s.ref, kind: s.kind, title: s.title, action: s.action, url: s.url, start: s.start, end: s.end, why: s.why,
    status: s.status === "planned" ? (s.start <= now && now < s.end ? "now" : s.end <= now ? "asking" : "next") : s.status,
  });
  const list = slots.map(show);
  // what you're asked about: ended slots without an answer yet (today's and yesterday's)
  const asking = (db.prepare("SELECT * FROM plan_slots WHERE status = 'asking' ORDER BY end DESC LIMIT 3").all() as unknown as Slot[])
    .map((s) => ({ ...show(s), status: "asking", ask: lastAsk(s.id) || `¿Terminaste «${s.title}»?` }));
  // the five that matter right now: what's on now, then what's next today, then the most
  // important unplanned things if the day has room
  const planned = new Set(slots.map((s) => s.ref));
  const dayEnd = addDays(now, 1);
  const fixed = commitmentsBetween(now, dayEnd).map((c) => ({
    id: 0, ref: `commit:${c.id}`, kind: "commitment", title: c.title, action: "commitment", url: null, start: c.start, end: c.end,
    why: `${c.source === "email" ? "por correo" : "por WhatsApp"}${c.location ? ` · ${c.location}` : ""}`, status: c.start <= now ? "now" : "fixed",
  }));
  const top = [
    ...fixed.filter((c) => c.status === "now"),
    ...list.filter((s) => s.status === "now"),
    ...fixed.filter((c) => c.status === "fixed"),
    ...list.filter((s) => s.status === "next"),
    ...candidates(now, planned).slice(0, 5).map((c) => ({
      id: 0, ref: c.ref, kind: c.kind, title: c.title, action: c.action, url: c.url || null, start: 0, end: 0,
      why: "si te sobra un hueco", status: "spare",
    })),
  ].slice(0, 5);
  const ask = (db.prepare("SELECT key, value FROM meta WHERE key LIKE 'plan_miss:%' AND CAST(value AS INTEGER) >= 2").all() as any[])
    .map((m) => String(m.key).slice("plan_miss:".length))
    .map((ref) => {
      const it = db.prepare("SELECT title, raw, state, tags FROM items WHERE id = ?").get(ref) as any;
      if (it) return (it.state === "active" || it.state === "inbox") && !String(it.tags ?? "").startsWith("goal:") ? { ref, title: it.title || it.raw } : null;
      const i = ref.indexOf(":");
      const t = db.prepare("SELECT task, title, state FROM todos WHERE source = ? AND ref = ?").get(ref.slice(0, i), ref.slice(i + 1)) as any;
      return t && t.state === "needs-reply" ? { ref, title: t.task || `Responder a ${t.title}` } : null;
    })
    .filter(Boolean)
    .slice(0, 3);
  const tomorrow = db.prepare("SELECT title, start FROM plan_slots WHERE date = ? AND status = 'planned' ORDER BY start LIMIT 1").get(localDate(now + DAY)) as any;
  return {
    date,
    note: day?.note ?? "",
    review: day?.review ?? "",
    planning: isPlanning() && !day,
    slots: list,
    top,
    asking,
    now: list.find((s) => s.status === "now") ?? null,
    next: list.find((s) => s.status === "next") ?? null,
    ask,
    tomorrowFirst: tomorrow ? { title: tomorrow.title, start: tomorrow.start } : null,
    upcoming: upcoming(now).slice(0, 8),
  };
}
