import crypto from "node:crypto";
import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";

// One Google grant does three jobs: signs you into the web UI, reads Gmail,
// reads Calendar. Tokens live in the local meta table, never in the browser.
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  // write: the AI puts appointments in your calendar itself (aitasks.ts)
  "https://www.googleapis.com/auth/calendar.events",
];

db.exec(`
CREATE TABLE IF NOT EXISTS gm_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_name TEXT,
  from_addr TEXT,
  subject TEXT,
  snippet TEXT,
  ts INTEGER NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gm_thread ON gm_messages (thread_id);
CREATE INDEX IF NOT EXISTS idx_gm_ts ON gm_messages (ts);

CREATE TABLE IF NOT EXISTS gm_threads (
  id TEXT PRIMARY KEY,
  history_id TEXT
);

CREATE TABLE IF NOT EXISTS cal_events (
  id TEXT PRIMARY KEY,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  location TEXT,
  link TEXT
);
CREATE INDEX IF NOT EXISTS idx_cal_start ON cal_events (start_ts);
`);

export function googleConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

export function googleConnected(): boolean {
  return Boolean(getMeta("google_refresh_token"));
}

export function googleAccount(): string {
  return getMeta("google_email") ?? "";
}

/** Login gates the UI only once Google is set up; the owner is the first account to sign in. */
export function googleLoginEnabled(): boolean {
  return googleConfigured() && config.googleLogin;
}

export function redirectUri(origin: string): string {
  return `${config.publicUrl || origin}/auth/google/callback`;
}

export function authUrl(origin: string, state: string): string {
  const q = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // consent every time guarantees a refresh_token comes back
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  const hint = getMeta("google_email");
  if (hint) q.set("login_hint", hint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      ...params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`google token ${res.status}: ${data.error_description ?? data.error}`);
  return data;
}

function saveTokens(t: { access_token: string; expires_in: number; refresh_token?: string }): void {
  setMeta("google_access_token", t.access_token);
  setMeta("google_access_expires", String(Date.now() + (t.expires_in - 60) * 1000));
  if (t.refresh_token) setMeta("google_refresh_token", t.refresh_token);
}

/** Finish the OAuth dance. Returns the signed-in email, or throws if it isn't the owner. */
export async function handleCallback(code: string, origin: string): Promise<string> {
  const t = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(origin),
  });
  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${t.access_token}` },
  }).then((r) => r.json());
  const email = String(info.email ?? "").toLowerCase();
  if (!email || info.email_verified === false) throw new Error("Google didn't return a verified email");
  const owner = (config.googleAllowedEmail || getMeta("google_email") || "").toLowerCase();
  if (owner && owner !== email) throw new Error(`${email} is not allowed here (owner: ${owner})`);
  setMeta("google_email", email);
  saveTokens(t);
  return email;
}

async function accessToken(): Promise<string> {
  const cached = getMeta("google_access_token");
  if (cached && Number(getMeta("google_access_expires") ?? 0) > Date.now()) return cached;
  const refresh = getMeta("google_refresh_token");
  if (!refresh) throw new Error("Google not connected");
  try {
    const t = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
    saveTokens(t);
    return t.access_token;
  } catch (e) {
    // invalid_grant = revoked or expired (Testing-mode apps expire refresh tokens after 7 days)
    if (String(e).includes("invalid_grant") || String(e).includes("expired")) {
      setMeta("google_refresh_token", "");
      setMeta("google_error", "Google access expired — sign in again");
    }
    throw e;
  }
}

async function gapi(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`google ${res.status} ${url.split("?")[0]}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function googleSignOut(): void {
  const token = getMeta("google_refresh_token");
  if (token) {
    void fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
  }
  for (const k of ["google_refresh_token", "google_access_token", "google_access_expires", "google_error"]) setMeta(k, "");
}

// --- sessions for the web UI (cookie → random id stored hashed) ---

export function newSession(): string {
  const id = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(id).digest("hex");
  setMeta(`session:${hash}`, String(Date.now() + 365 * 86_400_000));
  return id;
}

export function validSession(id: string | undefined): boolean {
  if (!id) return false;
  const hash = crypto.createHash("sha256").update(id).digest("hex");
  return Number(getMeta(`session:${hash}`) ?? 0) > Date.now();
}

export function dropSession(id: string | undefined): void {
  if (!id) return;
  db.prepare("DELETE FROM meta WHERE key = ?").run(`session:${crypto.createHash("sha256").update(id).digest("hex")}`);
}

// --- Gmail ---

function header(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseFrom(v: string): { name: string; addr: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(v);
  return m ? { name: m[1].trim() || m[2], addr: m[2].toLowerCase() } : { name: v.trim(), addr: v.trim().toLowerCase() };
}

function decodeEntities(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Pull recent inbox threads (skipping promotions/social), refetching only threads whose history moved. */
export async function syncGmail(): Promise<number> {
  const q = `in:inbox newer_than:${config.gmailDays}d -category:promotions -category:social -category:forums`;
  const list = await gapi(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=${config.gmailMaxThreads}&q=${encodeURIComponent(q)}`
  );
  const seen = db.prepare("SELECT history_id FROM gm_threads WHERE id = ?");
  const upsertThread = db.prepare(
    "INSERT INTO gm_threads (id, history_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET history_id = excluded.history_id"
  );
  const insert = db.prepare(
    `INSERT OR REPLACE INTO gm_messages (id, thread_id, from_name, from_addr, subject, snippet, ts, from_me)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let changed = 0;
  for (const t of (list.threads ?? []) as { id: string; historyId: string }[]) {
    const prev = seen.get(t.id) as { history_id: string } | undefined;
    if (prev?.history_id === t.historyId) continue;
    const full = await gapi(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`
    );
    for (const m of full.messages ?? []) {
      const headers = m.payload?.headers ?? [];
      const from = parseFrom(header(headers, "From"));
      insert.run(
        m.id,
        t.id,
        from.name,
        from.addr,
        header(headers, "Subject"),
        decodeEntities(m.snippet ?? ""),
        Number(m.internalDate),
        (m.labelIds ?? []).includes("SENT") ? 1 : 0
      );
    }
    upsertThread.run(t.id, t.historyId);
    changed++;
  }
  return changed;
}

// --- Calendar ---

/** Mirror today + the next CALENDAR_DAYS days of the primary calendar. */
export async function syncCalendar(): Promise<number> {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + config.calendarDays * 86_400_000);
  const data = await gapi(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=250` +
      `&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}`
  );
  const insert = db.prepare(
    "INSERT INTO cal_events (id, start_ts, end_ts, all_day, title, location, link) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM cal_events WHERE start_ts >= ?").run(from.getTime());
    for (const e of data.items ?? []) {
      if (e.status === "cancelled") continue;
      const allDay = Boolean(e.start?.date);
      const start = Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00`);
      const end = Date.parse(e.end?.dateTime ?? `${e.end?.date}T00:00:00`);
      insert.run(e.id, start, Number.isFinite(end) ? end : null, allDay ? 1 : 0, e.summary ?? "(busy)", e.location ?? null, e.htmlLink ?? null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return (data.items ?? []).length;
}

export interface CalEvent {
  id: string;
  start_ts: number;
  end_ts: number | null;
  all_day: number;
  title: string;
  location: string | null;
  link: string | null;
}

export function upcomingEvents(days = 1): CalEvent[] {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  return db
    .prepare("SELECT * FROM cal_events WHERE start_ts >= ? AND start_ts < ? ORDER BY start_ts")
    .all(from.getTime(), from.getTime() + days * 86_400_000) as unknown as CalEvent[];
}

/** Gmail + Calendar refresh used by the worker and the Sessions tab. Never throws. */
export async function syncGoogle(): Promise<{ threads: number; events: number; error?: string }> {
  if (!googleConfigured() || !googleConnected()) return { threads: 0, events: 0 };
  try {
    const threads = await syncGmail();
    const events = await syncCalendar();
    setMeta("google_synced_at", String(Date.now()));
    setMeta("google_error", "");
    return { threads, events };
  } catch (e) {
    setMeta("google_error", String(e).slice(0, 300));
    return { threads: 0, events: 0, error: String(e) };
  }
}

/** Create an event in your primary calendar; returns its link. */
export async function createCalendarEvent(title: string, start: number, end: number, location = ""): Promise<string> {
  const token = await accessToken();
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: title,
      location: location || undefined,
      start: { dateTime: new Date(start).toISOString(), timeZone: "Europe/Madrid" },
      end: { dateTime: new Date(end).toISOString(), timeZone: "Europe/Madrid" },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Calendar ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).htmlLink ?? "";
}

