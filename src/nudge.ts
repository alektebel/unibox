import { execFileSync } from "node:child_process";
import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";
import { addEvent } from "./capture/ingest.js";
import { sendToSelf, waStatus } from "./wamanager.js";
import { sendPush } from "./push.js";

export interface NudgeRow {
  id: string;
  kind: string;
  title: string | null;
  raw: string | null;
  action: string | null;
  effort_min: number | null;
  context: string | null;
  batch_key: string | null;
  priority: number | null;
  snooze_until: number | null;
  state: string;
}

const GROUP_LABELS: Record<string, string> = {
  quick: "Quick wins",
  read: "To read",
  watch: "To watch",
  listen: "To listen",
  do: "To do",
  reference: "Reference",
};

export function isQuiet(now = new Date()): boolean {
  const h = now.getHours();
  const s = config.quietHoursStart;
  const e = config.quietHoursEnd;
  if (s === e) return false;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

export function isAvailable(): boolean {
  return getMeta("available") !== "0";
}

export function setAvailable(v: boolean): void {
  setMeta("available", v ? "1" : "0");
}

function recentlyNudged(): Set<string> {
  const since = Date.now() - config.nudgeCooldownMinutes * 60_000;
  const rows = db
    .prepare("SELECT DISTINCT item_id FROM item_events WHERE event = 'nudged' AND at > ?")
    .all(since) as { item_id: string }[];
  return new Set(rows.map((r) => r.item_id));
}

export function pendingItems(): NudgeRow[] {
  const snoozed = Date.now();
  return db
    .prepare(
      `SELECT * FROM items
       WHERE state IN ('active', 'inbox')
         AND (snooze_until IS NULL OR snooze_until <= ?)
       ORDER BY priority DESC, created_at ASC`
    )
    .all(snoozed) as unknown as NudgeRow[];
}

function label(it: NudgeRow): string {
  return (it.title || it.raw || it.kind || "item").replace(/\s+/g, " ").slice(0, 70);
}

export interface Plan {
  key: string;
  items: NudgeRow[];
  text: string;
  others: string;
}

export function planNudge(): Plan | null {
  const all = pendingItems();
  if (!all.length) return null;
  const skip = recentlyNudged();
  const fresh = all.filter((i) => !skip.has(i.id));
  if (!fresh.length) return null;

  const groups = new Map<string, NudgeRow[]>();
  for (const it of fresh) {
    const k = it.batch_key ?? "reference";
    const arr = groups.get(k) ?? [];
    arr.push(it);
    groups.set(k, arr);
  }

  // Each group offers one sitting — its top items until ~budget minutes — and groups compete on
  // that sitting. Scoring whole groups let the biggest pile win and nudged hundreds of items at once.
  const session = (arr: NudgeRow[]): NudgeRow[] => {
    const out: NudgeRow[] = [];
    let mins = 0;
    for (const it of arr) {
      const m = it.effort_min ?? 2;
      if (out.length && (mins + m > config.nudgeBudgetMinutes || out.length >= 5)) break;
      out.push(it);
      mins += m;
    }
    return out;
  };
  let bestKey = "";
  let bestScore = -Infinity;
  let items: NudgeRow[] = [];
  for (const [k, arr] of groups) {
    const s = session(arr);
    const bonus = k === "quick" && s.length >= 2 ? 15 : 0;
    const score = s.reduce((a, i) => a + (i.priority ?? 0), 0) / s.length + bonus + s.length * 2;
    if (score > bestScore) {
      bestScore = score;
      bestKey = k;
      items = s;
    }
  }
  const mins = items.reduce((a, i) => a + (i.effort_min ?? 2), 0);
  const head =
    bestKey === "quick"
      ? `${items.length} quick win${items.length === 1 ? "" : "s"}`
      : `${GROUP_LABELS[bestKey] ?? bestKey} (${items.length})`;
  let text = `${head} · ~${mins} min: ` + items.map(label).join(" · ");
  const rest = groups.get(bestKey)!.length - items.length;
  if (rest > 0) text += ` (+${rest} more like this)`;

  const otherParts: string[] = [];
  for (const [k, arr] of groups) {
    if (k === bestKey) continue;
    otherParts.push(`${arr.length} ${k}`);
  }
  return { key: bestKey, items, text, others: otherParts.join(" · ") };
}

async function deliver(title: string, body: string): Promise<void> {
  try {
    execFileSync("notify-send", ["-u", "normal", title, body]);
  } catch {
  }
  if (config.selfChatNudges) {
    try {
      await sendToSelf(`${title}\n${body}`);
    } catch {
    }
  }
  try {
    await sendPush(title, body);
  } catch {
  }
}

export interface NudgeResult {
  sent: boolean;
  reason: string;
  text?: string;
  count?: number;
}

export async function sendNudge(force = false): Promise<NudgeResult> {
  if (!force && getMeta("tasks_paused") === "1") return { sent: false, reason: "tasks paused" };
  if (!force && !isAvailable()) return { sent: false, reason: "focus mode" };
  if (!force && isQuiet()) return { sent: false, reason: "quiet hours" };
  if (!force) {
    const last = getMeta("last_nudge_at");
    if (last && Date.now() - Number(last) < config.nudgeMinGapMinutes * 60_000) {
      return { sent: false, reason: "too soon" };
    }
  }
  const plan = planNudge();
  if (!plan) return { sent: false, reason: "nothing to nudge" };
  const body = plan.others ? `${plan.text}\nElsewhere in the box: ${plan.others}` : plan.text;
  await deliver("unibox · one go", body);
  const at = Date.now();
  const mark = db.prepare("INSERT INTO item_events (item_id, at, event, detail) VALUES (?, ?, 'nudged', ?)");
  for (const it of plan.items) mark.run(it.id, at, plan.key);
  setMeta("last_nudge_at", String(at));
  return { sent: true, reason: "sent", text: body, count: plan.items.length };
}

export function nudgeStatus(): {
  available: boolean;
  quiet: boolean;
  lastNudgeAt: number | null;
  pending: number;
  groups: { key: string; count: number; minutes: number }[];
} {
  const items = pendingItems();
  const groups = new Map<string, { count: number; minutes: number }>();
  for (const it of items) {
    const k = it.batch_key ?? "reference";
    const g = groups.get(k) ?? { count: 0, minutes: 0 };
    g.count++;
    g.minutes += it.effort_min ?? 0;
    groups.set(k, g);
  }
  const last = getMeta("last_nudge_at");
  return {
    available: isAvailable(),
    quiet: isQuiet(),
    lastNudgeAt: last ? Number(last) : null,
    pending: items.length,
    groups: [...groups.entries()].map(([key, v]) => ({ key, ...v })),
  };
}

export function selfChatReady(): boolean {
  return config.selfChatNudges && waStatus().state === "connected";
}
