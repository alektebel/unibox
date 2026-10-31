import { db } from "../db.js";
import { config } from "../config.js";
import { llm, hasLlm, langLine } from "../llm.js";
import { enrichLink, mediaSiteKind } from "../enrich/link.js";
import { describeImage, transcribeAudio, videoThumbnail } from "../enrich/media.js";
import { addEvent } from "./ingest.js";

export interface ItemRow {
  id: string;
  source: string;
  kind: string;
  raw: string | null;
  url: string | null;
  title: string | null;
  summary: string | null;
  transcript: string | null;
  media_path: string | null;
  thumb_path: string | null;
  tags: string | null;
  action: string | null;
  effort_min: number | null;
  context: string | null;
  priority: number | null;
  urgency: number | null;
  importance: number | null;
  batch_key: string | null;
  state: string;
  created_at: number;
  processed_at: number | null;
}

const ACTIONS = ["read", "watch", "listen", "do", "buy", "reply", "reference"];
const CONTEXTS = ["quick", "focus", "phone", "commute", "desk", "errand"];

interface Classification {
  title?: string;
  summary?: string;
  action?: string;
  tags?: string[];
  effort_min?: number;
  context?: string;
  urgency?: number;
  importance?: number;
  due?: string | null;
}

function ruleDefaults(item: ItemRow): Classification {
  const base: Classification = { action: "reference", context: "quick", effort_min: 2, urgency: 0, importance: 2 };
  switch (item.kind) {
    case "link": {
      const site = item.url ? mediaSiteKind(item.url) : null;
      if (site === "video") return { action: "watch", context: "focus", effort_min: 15, urgency: 0, importance: 2 };
      if (site === "audio") return { action: "listen", context: "commute", effort_min: 20, urgency: 0, importance: 2 };
      return { action: "read", context: "focus", effort_min: 6, urgency: 0, importance: 2 };
    }
    case "image":
      return { action: "reference", context: "quick", effort_min: 1, urgency: 0, importance: 2 };
    case "audio":
      return { action: "listen", context: "commute", effort_min: 3, urgency: 1, importance: 2 };
    case "video":
      return { action: "watch", context: "focus", effort_min: 10, urgency: 0, importance: 2 };
    case "note":
      return { action: "do", context: "quick", effort_min: 2, urgency: 1, importance: 2 };
    default:
      return base;
  }
}

function batchKey(action: string | null, context: string | null, effort: number | null): string {
  if (action === "watch") return "watch";
  if (action === "listen") return "listen";
  if (effort != null && effort <= 5) return "quick";
  if (action === "read") return "read";
  if (action === "do" || action === "buy" || action === "reply") return "do";
  return "reference";
}

export function computePriority(c: Classification, createdAt: number): number {
  const importance = c.importance ?? 2;
  const urgency = c.urgency ?? 0;
  const effort = c.effort_min ?? 5;
  // Aging floats things up for a week, then stops, and never outweighs one urgency step (25):
  // uncapped, years-old imports buried every new dump.
  const aging = Math.min(MAX_AGING_DAYS, Math.max(0, (Date.now() - createdAt) / 86_400_000));
  return importance * 10 + urgency * 25 - Math.min(effort, 120) * 0.3 + aging * AGING_WEIGHT;
}

const MAX_AGING_DAYS = 7;
const AGING_WEIGHT = 2;

/** Same formula as computePriority, in SQL, so aging stays current instead of frozen at filing time; a priority you set stays. */
export function refreshPriorities(): void {
  db.prepare(
    `UPDATE items SET priority = COALESCE(priority_set,
       COALESCE(importance, 2) * 10 + COALESCE(urgency, 0) * 25
       - MIN(COALESCE(effort_min, 5), 120) * 0.3
       + MIN(?, MAX(0, (? - created_at) / 86400000.0)) * ?)
     WHERE processed_at IS NOT NULL`
  ).run(MAX_AGING_DAYS, Date.now(), AGING_WEIGHT);
}

function titleFrom(text: string): string {
  const first = text.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return first.replace(/https?:\/\/\S+/g, "").trim();
}

// Cheap, deterministic filing for the common case (short notes, enriched links).
function heuristics(item: ItemRow, defaults: Classification): Classification {
  const raw = (item.raw ?? "").trim();
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const candidate = titleFrom(raw) || item.title || item.url || item.kind;
  const title = candidate.split(/\s+/).slice(0, 12).join(" ").slice(0, 120);
  const rest = lines.slice(1).join(" ").trim();
  const summary = rest ? rest.slice(0, 200) : item.summary ?? undefined;
  return { ...defaults, ...byWords(raw, item.url), title, summary };
}

/**
 * What a short note asks for, from how it starts and what it links: "ver la charla… <youtube>"
 * is something to watch, "comprar bombillas" a purchase, "llamar a Pablo" a quick call.
 */
export function byWords(raw: string, url: string | null): Partial<Classification> {
  const t = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const link = url ?? (/(https?:\/\/\S+)/.exec(raw)?.[1] ?? null);
  if (link && /youtu\.?be|vimeo\.com|twitch\.tv/.test(link)) return { action: "watch", context: "focus", effort_min: 20 };
  if (/^(ver|mirar|echar un ojo a)\b.*\b(charla|video|peli|pelicula|serie|documental|conferencia|talk)\b/.test(t)) return { action: "watch", context: "focus", effort_min: 30 };
  if (/^(escuchar|oir)\b/.test(t) || /\bpodcast\b/.test(t)) return { action: "listen", context: "anywhere", effort_min: 30 };
  if (/^(leer|lee|repasar)\b/.test(t) || (link && !/^(comprar|llamar|escribir)/.test(t))) return { action: "read", context: "focus", effort_min: 15 };
  if (/^(comprar|pedir|encargar)\b/.test(t)) return { action: "buy", context: "errand", effort_min: 10 };
  if (/^(llamar|telefonear)\b/.test(t)) return { action: "do", context: "phone", effort_min: 10 };
  if (/^(escribir|responder|contestar)( a)?\b/.test(t)) return { action: "reply", context: "phone", effort_min: 5 };
  return {};
}

function needsLlm(item: ItemRow): boolean {
  // Enriched links already carry a page title/summary — don't spend a call.
  if (item.kind === "link") return !item.title && !item.summary;
  // A photo or voice note only has a filename until the model reads its description/transcript.
  if ((item.kind === "image" || item.kind === "audio") && (item.summary || item.transcript)) return true;
  const signal = Math.max(
    (item.raw ?? "").trim().length,
    (item.transcript ?? "").length,
    (item.summary ?? "").length
  );
  // Short notes ("comprar pan") file fine by rules; anything with a sentence or two gets read.
  return signal > 80;
}

async function classify(item: ItemRow): Promise<Classification> {
  const defaults = ruleDefaults(item);
  const fallback = heuristics(item, defaults);
  if (!hasLlm() || !needsLlm(item)) return fallback;
  const context = [
    `kind: ${item.kind}`,
    item.url ? `url: ${item.url}` : "",
    item.title ? `title: ${item.title}` : "",
    item.summary ? `summary: ${item.summary}` : "",
    item.transcript ? `transcript: ${item.transcript.slice(0, 2000)}` : "",
    item.raw ? `content: ${item.raw.slice(0, 2000)}` : "",
    item.media_path ? `media file: ${item.media_path}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const prompt =
    `You file one thing from ${config.meFirst || "the user"}'s personal inbox. Decide what it is and how to act on it.\n\n` +
    `${context}\n\n` +
    `Reply JSON only:\n` +
    `{"title":"short imperative or noun phrase, max 10 words","summary":"one sentence, max 200 chars",` +
    `"action":"read|watch|listen|do|buy|reply|reference",` +
    `"tags":["2-4 lowercase topic tags"],` +
    `"effort_min":integer minutes to consume or complete,` +
    `"context":"quick|focus|phone|commute|desk|errand",` +
    `"urgency":0-3,"importance":1-5,"due":"ISO date or null"}\n` +
    `quick = doable in a couple of minutes anywhere; focus = needs a quiet block; ` +
    `commute = listen/watch on the move; desk = needs a computer; phone = needs a call or a phone; errand = out of the house.` +
    langLine();
  try {
    const content = await llm([{ role: "user", content: prompt }], { json: true, temperature: 0 });
    const data = JSON.parse(content) as Classification;
    return {
      title: data.title?.slice(0, 120) || fallback.title,
      summary: data.summary?.slice(0, 300) || fallback.summary,
      action: ACTIONS.includes(data.action ?? "") ? data.action : defaults.action,
      tags: Array.isArray(data.tags) ? data.tags.slice(0, 5).map((t) => String(t).toLowerCase()) : [],
      effort_min: Number.isFinite(data.effort_min) ? Math.max(0, Math.round(data.effort_min as number)) : defaults.effort_min,
      context: CONTEXTS.includes(data.context ?? "") ? data.context : defaults.context,
      urgency: Number.isFinite(data.urgency) ? Math.min(3, Math.max(0, Math.round(data.urgency as number))) : defaults.urgency,
      importance: Number.isFinite(data.importance)
        ? Math.min(5, Math.max(1, Math.round(data.importance as number)))
        : defaults.importance,
      due: data.due ?? null,
    };
  } catch (e) {
    console.error(`  item classify failed for ${item.id}: ${e}`);
    return fallback;
  }
}

async function enrichContent(item: ItemRow): Promise<Partial<ItemRow>> {
  const patch: Partial<ItemRow> = {};
  if (item.kind === "link" && item.url) {
    const meta = await enrichLink(item.url);
    patch.title = meta.title ?? null;
    patch.summary = meta.description ?? null;
    patch.tags = JSON.stringify([...(meta.site ? [meta.site.toLowerCase()] : [])].slice(0, 3));
    const site = mediaSiteKind(item.url);
    if (site) patch.kind = site;
  } else if (item.kind === "image" && item.media_path) {
    const desc = await describeImage(item.media_path);
    if (desc) patch.summary = desc;
  } else if (item.kind === "audio" && item.media_path) {
    const text = await transcribeAudio(item.media_path);
    if (text) {
      patch.transcript = text;
      patch.title = text.split(/\n|\. /)[0].slice(0, 120);
    }
  } else if (item.kind === "video" && item.media_path) {
    const thumb = videoThumbnail(item.media_path);
    if (thumb) patch.thumb_path = thumb;
  }
  return patch;
}

export async function processItem(id: string): Promise<boolean> {
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as unknown as ItemRow | undefined;
  if (!item || item.processed_at) return false;
  const enrich = await enrichContent(item);
  const merged = { ...item, ...enrich } as ItemRow;
  const c = await classify(merged);
  const title = c.title ?? merged.title ?? merged.raw?.slice(0, 80) ?? merged.kind;
  const summary = c.summary ?? merged.summary ?? null;
  const tags = c.tags && c.tags.length ? c.tags : merged.tags ? JSON.parse(merged.tags) : [];
  const priority = computePriority(c, merged.created_at);
  const batch = batchKey(c.action ?? null, c.context ?? null, c.effort_min ?? null);
  db.prepare(
    `UPDATE items SET
       kind = COALESCE(?, kind), title = ?, summary = ?, transcript = COALESCE(?, transcript),
       thumb_path = COALESCE(?, thumb_path), tags = ?, action = ?, effort_min = ?, context = ?,
       priority = ?, urgency = ?, importance = ?, batch_key = ?, processed_at = ?, state = 'active'
     WHERE id = ?`
  ).run(
    (enrich.kind as string) ?? null,
    title,
    summary,
    merged.transcript ?? null,
    (enrich.thumb_path as string) ?? null,
    JSON.stringify(tags),
    c.action ?? "reference",
    c.effort_min ?? null,
    c.context ?? null,
    priority,
    c.urgency ?? null,
    c.importance ?? null,
    batch,
    Date.now(),
    id
  );
  addEvent(id, "processed", `${c.action} · ${c.context} · ${c.effort_min}m`);
  return true;
}

let processing = false;
let rerun = false;

const PROCESS_LIMIT = Number(process.env.UNIBOX_PROCESS_LIMIT ?? 60);
const PROCESS_CONCURRENCY = Math.max(1, Number(process.env.UNIBOX_PROCESS_CONCURRENCY ?? 6));

export async function processItems(): Promise<number> {
  // A call during a run (e.g. the second of two uploads) asks for one more pass instead of being dropped.
  if (processing) {
    rerun = true;
    return 0;
  }
  processing = true;
  let total = 0;
  try {
    do {
      rerun = false;
      total += await processBatch();
    } while (rerun);
    return total;
  } finally {
    processing = false;
  }
}

async function processBatch(): Promise<number> {
  const pending = db
    .prepare("SELECT id FROM items WHERE processed_at IS NULL ORDER BY created_at ASC LIMIT ?")
    .all(PROCESS_LIMIT) as { id: string }[];
  const deadline = Date.now() + 60_000;
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < pending.length && Date.now() < deadline) {
      const { id } = pending[next++];
      try {
        if (await processItem(id)) done++;
      } catch (e) {
        console.error(`  item process failed for ${id}: ${e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROCESS_CONCURRENCY, pending.length) }, worker));
  return done;
}
