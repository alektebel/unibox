import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** systemd and other non-login launches don't source ~/.bashrc; read an exported var from it directly. */
function fromBashrc(name: string): string {
  try {
    const rc = fs.readFileSync(path.join(os.homedir(), ".bashrc"), "utf8");
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`, "m").exec(rc);
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, "$2") : "";
  } catch {
    return "";
  }
}

export const config = {
  root,
  dataDir: process.env.UNIBOX_DATA_DIR ?? path.join(root, "data"),
  mediaDir: process.env.UNIBOX_MEDIA_DIR ?? path.join(root, "data", "media"),
  sessionDir: process.env.UNIBOX_SESSION_DIR ?? path.join(root, "session"),
  digestsDir: process.env.UNIBOX_DIGESTS_DIR ?? path.join(root, "digests"),
  linkedinInbound: process.env.UNIBOX_LINKEDIN_DIR ?? path.join(root, "inbound", "linkedin"),
  whatsappInbound: process.env.UNIBOX_WHATSAPP_DIR ?? path.join(root, "inbound", "whatsapp"),
  notesInbound: process.env.UNIBOX_NOTES_DIR ?? path.join(root, "inbound", "notes"),
  mailosDb: process.env.MAILOS_DB ?? path.join(root, "..", "mailos", "mailos.db"),
  nanBaseUrl: process.env.NAN_BASE_URL ?? "https://api.nan.builders/v1",
  nanApiKey: process.env.NAN_API_KEY || fromBashrc("NAN_API_KEY"),
  llmModel: process.env.LLM_MODEL ?? "qwen3.6",
  // language for text the model writes for you (task, reason, title, summary)
  lang: process.env.UNIBOX_LANG ?? "es",
  llmThinking: (process.env.LLM_THINKING ?? "0") === "1",
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 90_000),
  whisperModel: process.env.UNIBOX_WHISPER_MODEL ?? "whisper",
  digestWindowHours: Number(process.env.DIGEST_WINDOW_HOURS ?? 48),
  maxCharsPerSource: Number(process.env.MAX_CHARS_PER_SOURCE ?? 24000),
  classifyBatch: Number(process.env.CLASSIFY_BATCH ?? 15),
  classifyMinutes: Number(process.env.CLASSIFY_MINUTES ?? 2),
  digestHour: Number(process.env.DIGEST_HOUR ?? 8),
  /** your WhatsApp number, so linking only asks for the code */
  mePhone: process.env.UNIBOX_ME_PHONE ?? "",
  /** daily phone reminder to exercise; empty turns it off */
  exerciseAt: process.env.UNIBOX_EXERCISE_AT ?? "19:00",
  /** when goal-session reminders fire on their planned days */
  sessionAt: process.env.UNIBOX_SESSION_AT ?? "18:00",
  /** launcher enforcement: "HH:MM-HH:MM" windows (weekdays for work); empty turns one off */
  workHours: process.env.UNIBOX_WORK_HOURS ?? "09:00-17:00",
  nightHours: process.env.UNIBOX_NIGHT_HOURS ?? "23:30-07:00",
  /** from this hour the AI goes over the day with you (assistant.ts) */
  wrapAt: process.env.UNIBOX_WRAP_AT ?? "21:00",
  // the journal's reminder, after the day's review
  journalAt: process.env.UNIBOX_JOURNAL_AT ?? "22:00",
  /** day planner: the part of the day it plans, and how much it puts in */
  planDayStart: process.env.UNIBOX_PLAN_START ?? "07:30",
  // no alarm on weekends: nothing planned before this
  planWeekendStart: process.env.UNIBOX_PLAN_WEEKEND_START ?? "09:30",
  planDayEnd: process.env.UNIBOX_PLAN_END ?? "23:00",
  planMaxSlots: Number(process.env.UNIBOX_PLAN_MAX ?? 8),
  planWorkSlots: Number(process.env.UNIBOX_PLAN_WORK_SLOTS ?? 4),
  planFreeSlots: Number(process.env.UNIBOX_PLAN_FREE_SLOTS ?? 3),
  frictionSeconds: Number(process.env.UNIBOX_FRICTION_SECONDS ?? 60),
  hardFrictionSeconds: Number(process.env.UNIBOX_HARD_FRICTION_SECONDS ?? 300),
  passMinutes: Number(process.env.UNIBOX_PASS_MINUTES ?? 10),
  // more apps to treat as feeds (comma-separated package names), on top of the built-in list
  extraDistractions: (process.env.UNIBOX_EXTRA_DISTRACTIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // a day's worth of feeds (passes add up) and of games (real time on screen); past it, no way through until tomorrow
  feedBudgetMinutes: Number(process.env.UNIBOX_FEED_BUDGET_MINUTES ?? 30),
  gameBudgetMinutes: Number(process.env.UNIBOX_GAME_BUDGET_MINUTES ?? 45),
  syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES ?? 15),
  meName: process.env.UNIBOX_ME_NAME ?? "",
  meFirst: (process.env.UNIBOX_ME_NAME ?? "").trim().split(/\s+/)[0] || "",
  // apps that are never blocked, on top of the built-in essentials (comma-separated package names)
  alwaysAllow: (process.env.UNIBOX_ALWAYS_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  quietHoursStart: Number(process.env.UNIBOX_QUIET_START ?? 22),
  quietHoursEnd: Number(process.env.UNIBOX_QUIET_END ?? 8),
  nudgeIntervalMinutes: Number(process.env.UNIBOX_NUDGE_MINUTES ?? 10),
  nudgeCooldownMinutes: Number(process.env.UNIBOX_NUDGE_COOLDOWN ?? 180),
  nudgeBudgetMinutes: Number(process.env.UNIBOX_NUDGE_BUDGET ?? 25),
  nudgeMinGapMinutes: Number(process.env.UNIBOX_NUDGE_GAP ?? 60),
  selfChatNudges: (process.env.UNIBOX_SELFCHAT_NUDGES ?? "1") !== "0",
  linkTimeoutMs: Number(process.env.UNIBOX_LINK_TIMEOUT ?? 8000),
  host: process.env.UNIBOX_HOST ?? "127.0.0.1",
  token: process.env.UNIBOX_TOKEN ?? "",
  vapidPublic: process.env.UNIBOX_VAPID_PUBLIC ?? "",
  vapidPrivate: process.env.UNIBOX_VAPID_PRIVATE ?? "",
  publicUrl: (process.env.UNIBOX_PUBLIC_URL ?? (process.env.UNIBOX_DOMAIN ? `https://${process.env.UNIBOX_DOMAIN}` : "")).replace(/\/+$/, ""),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleAllowedEmail: process.env.GOOGLE_ALLOWED_EMAIL ?? "",
  googleLogin: (process.env.UNIBOX_GOOGLE_LOGIN ?? "1") !== "0",
  gmailDays: Number(process.env.GMAIL_DAYS ?? 14),
  gmailMaxThreads: Number(process.env.GMAIL_MAX_THREADS ?? 100),
  /** the gh CLI's token: lets the assistant read and edit your repos */
  // sha-256 of the guardian's code (the code itself is never stored): uninstalling Unibox or
  // turning off its protection asks for it
  guardHash: process.env.UNIBOX_GUARD_HASH ?? "",
  // the private repo with your next steps (created if missing)
  nextRepo: process.env.UNIBOX_NEXT_REPO ?? "siguientes-pasos",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  calendarDays: Number(process.env.CALENDAR_DAYS ?? 7),
  vapidSubject: process.env.UNIBOX_VAPID_SUBJECT ?? "mailto:unibox@localhost",
};

for (const dir of [config.dataDir, config.digestsDir, config.mediaDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
