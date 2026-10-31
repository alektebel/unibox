import crypto from "node:crypto";
import { db, setMeta } from "./db.js";
import { addEvent } from "./capture/ingest.js";
import { localDate } from "./planner.js";

// A clean slate: everything open goes to an archive (nothing is deleted, one call brings it
// back), so the plan and Hoy only work from what you add from now on.

export function archivedCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM items WHERE state = 'archived'").get() as { n: number }).n;
}

export function archiveAll(): number {
  const n = db.prepare("UPDATE items SET state = 'archived' WHERE state IN ('active', 'inbox')").run().changes;
  setMeta("slate_archived_at", String(Date.now()));
  clearUpcomingPlan();
  return Number(n);
}

export function restoreArchive(): number {
  const n = db.prepare("UPDATE items SET state = 'active' WHERE state = 'archived'").run().changes;
  clearUpcomingPlan();
  return Number(n);
}

/** The plan was made from the old list: drop what's still to come so it's redone. */
function clearUpcomingPlan(): void {
  const now = Date.now();
  db.prepare("DELETE FROM plan_slots WHERE status = 'planned' AND end > ?").run(now);
  db.prepare("DELETE FROM plan_days WHERE date >= ?").run(localDate(now));
}

/** A goal made of to-dos: progress is the share done, and it has no fixed session block. */
export function itemGoal(goalId: number): boolean {
  return !!db.prepare("SELECT 1 FROM items WHERE tags = ? LIMIT 1").get(`goal:${goalId}`);
}

export interface NewItem {
  title: string;
  action?: string;
  effort?: number;
  context?: string;
  priority?: number;
  url?: string;
  summary?: string;
  done?: boolean;
  source?: string;
  /** belongs to this goal (its progress) */
  goal?: number;
}

/** Add to-dos already sorted (no classification pass): title, action, effort, priority… */
export function addItems(items: NewItem[]): string[] {
  const now = Date.now();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO items (id, source, kind, raw, url, title, summary, action, effort_min, context, priority, urgency, importance, content_hash, state, created_at, processed_at, tags, priority_set)
     VALUES (?, ?, 'note', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const ids: string[] = [];
  for (const it of items) {
    const title = String(it.title ?? "").trim();
    if (!title) continue;
    const id = `${now.toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    const hash = crypto.createHash("sha256").update(`manual:${title}|${it.url ?? ""}`).digest("hex");
    const priority = Math.max(0, Math.min(100, Number(it.priority ?? 60)));
    const r = ins.run(
      id, it.source ?? "manual", title, it.url ?? null, title, it.summary ?? null, it.action ?? "do",
      Math.max(5, Number(it.effort ?? 15)), it.context ?? "", priority,
      priority >= 70 ? 2 : 1, priority >= 70 ? 4 : 3, hash, it.done ? "done" : "active", now, now, it.goal ? `goal:${it.goal}` : null,
      it.priority != null ? priority : null
    );
    if (!r.changes) continue;
    addEvent(id, "captured", it.source ?? "manual");
    if (it.done) addEvent(id, "done", it.source ?? "manual");
    ids.push(id);
  }
  return ids;
}
