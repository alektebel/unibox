import { execFileSync } from "node:child_process";
import { config } from "./config.js";
import { getMeta, setMeta } from "./db.js";
import { classifyTodos, digestCounts } from "./classify.js";
import { digest, localDate } from "./digest.js";
import { processItems, refreshPriorities } from "./capture/process.js";
import { syncNextRepo } from "./nextrepo.js";
import { ingestWhatsappExports } from "./sources/whatsapp-export.js";
import { ingestNotes } from "./capture/notes.js";
import { sendNudge } from "./nudge.js";
import { syncGoogle } from "./google.js";

let busy = false;
let morningTimer: NodeJS.Timeout | undefined;
let nextTimer: ReturnType<typeof setInterval> | null = null;
let nudgeTimer: NodeJS.Timeout | undefined;

function morningNotify(): void {
  const now = new Date();
  const today = localDate(now);
  if (now.getHours() !== config.digestHour) return;
  if (getMeta("last_notify_date") === today) return;
  setMeta("last_notify_date", today);
  (async () => {
    try {
      await digest();
      const c = digestCounts();
      try {
        execFileSync(
          "notify-send",
          [
            "-u",
            "normal",
            "unibox",
            `${c.needsReply} need replies (${c.overdue} over 7d), ${c.waiting} awaiting their answer → digests/${today}.md`,
          ]
        );
      } catch {
      }
    } catch (e) {
      console.error(`morning digest failed: ${e}`);
    }
  })();
}

export function startWorker(): void {
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      ingestNotes();
      ingestWhatsappExports();
      const g = await syncGoogle();
      if (g.threads || g.events) console.log(`google: ${g.threads} threads, ${g.events} events`);
      if (g.error) console.error(`google sync failed: ${g.error}`);
      const n = await classifyTodos();
      if (n) console.log(`classified ${n} chats`);
      refreshPriorities();
      const p = await processItems();
      if (p) console.log(`processed ${p} dumped items`);
    } catch (e) {
      console.error(`classify tick failed: ${e}`);
    } finally {
      busy = false;
    }
  };
  const nudgeTick = async () => {
    try {
      const res = await sendNudge();
      if (res.sent) console.log(`nudged: ${res.text}`);
    } catch (e) {
      console.error(`nudge tick failed: ${e}`);
    }
  };
  setInterval(tick, config.syncIntervalMinutes * 60_000);
  morningTimer = setInterval(morningNotify, 60_000);
  nudgeTimer = setInterval(nudgeTick, config.nudgeIntervalMinutes * 60_000);
  // the next-steps repo, rewritten when something changed (checked every five minutes)
  nextTimer = setInterval(() => void syncNextRepo(), 5 * 60_000);
  setTimeout(() => void syncNextRepo(), 30_000);
  void tick();
}

export function stopWorker(): void {
  if (morningTimer) clearInterval(morningTimer);
  if (nudgeTimer) clearInterval(nudgeTimer);
  if (nextTimer) clearInterval(nextTimer);
}
