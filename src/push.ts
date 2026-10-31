import webpush from "web-push";
import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";

export interface StoredSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

let vapid: { publicKey: string; privateKey: string } | null = null;
let started = false;

/** Resolve VAPID keys from env, then meta, else generate and persist. */
function init(): void {
  if (started) return;
  started = true;
  let pub = config.vapidPublic || getMeta("vapid_public") || "";
  let priv = config.vapidPrivate || getMeta("vapid_private") || "";
  if (!pub || !priv) {
    try {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      setMeta("vapid_public", pub);
      setMeta("vapid_private", priv);
    } catch {
      return;
    }
  }
  try {
    webpush.setVapidDetails(config.vapidSubject, pub, priv);
    vapid = { publicKey: pub, privateKey: priv };
  } catch {
  }
}

export function pushPublicKey(): string | null {
  init();
  return vapid?.publicKey ?? null;
}

export function pushConfigured(): boolean {
  init();
  return vapid !== null;
}

export function subscriptionCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM push_subscriptions").get() as { n: number }).n;
}

export function saveSubscription(sub: {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}): boolean {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
  return true;
}

export function removeSubscription(endpoint: string): void {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

/** Fan out a phone notification to every registered device. */
export async function sendPush(
  title: string,
  body: string,
  url = "/?screen=dump"
): Promise<number> {
  init();
  if (!vapid) return 0;
  const subs = db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as unknown as StoredSub[];
  const payload = JSON.stringify({ title, body, url, tag: "unibox" });
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) removeSubscription(s.endpoint);
      }
    })
  );
  return sent;
}
