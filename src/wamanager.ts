import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  Browsers,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { config } from "./config.js";
import { capture, mediaKind } from "./capture/ingest.js";

const logger = pino({ level: "silent" });
const SELF_MARKER = "\u25c8 unibox";

export type WaState = "idle" | "pairing" | "connecting" | "connected";

let sock: WASocket | null = null;
let state: WaState = "idle";
let latestQr: string | null = null;
let stopping = false;
let reconnectTimer: NodeJS.Timeout | undefined;
let meJid: string | null = null;

function baseUser(jid: string | null | undefined): string {
  return String(jid ?? "").split("@")[0].split(":")[0];
}

/** True when the chat is your own "Message yourself" thread. */
export function isSelfChat(jid: string | null | undefined): boolean {
  if (!jid || !meJid) return false;
  if (!jid.endsWith("@s.whatsapp.net")) return false;
  return baseUser(jid) === baseUser(meJid);
}

export function ownJid(): string | null {
  return meJid;
}


function extractText(message: proto.IMessage | null | undefined): string {
  if (!message) return "";
  const m =
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.viewOnceMessageV2Extension?.message ??
    message;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    ""
  );
}

function unwrapMessage(message: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!message) return null;
  return (
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.viewOnceMessageV2Extension?.message ??
    message
  );
}

function extFor(mimetype: string | null | undefined, fallback: string): string {
  const mt = (mimetype ?? "").toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/3gpp": ".3gp",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
  };
  return map[mt] ?? fallback;
}

async function downloadMedia(
  message: proto.IMessage | null | undefined
): Promise<{ file: string; mimetype: string | null; kind: string } | null> {
  const m = unwrapMessage(message);
  if (!m) return null;
  const entry = m.imageMessage
    ? (["image", m.imageMessage] as const)
    : m.videoMessage
      ? (["video", m.videoMessage] as const)
      : m.audioMessage
        ? (["audio", m.audioMessage] as const)
        : m.documentMessage
          ? (["document", m.documentMessage] as const)
          : null;
  if (!entry) return null;
  const [type, content] = entry;
  try {
    const stream = await downloadContentFromMessage(content, type);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    if (!chunks.length) return null;
    const mimetype = (content as { mimetype?: string }).mimetype ?? null;
    const fallback = (content as { fileName?: string }).fileName
      ? path.extname((content as { fileName?: string }).fileName!).toLowerCase()
      : ".bin";
    const ext = extFor(mimetype, fallback);
    const file = path.join(
      config.mediaDir,
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`
    );
    fs.writeFileSync(file, Buffer.concat(chunks));
    return { file, mimetype, kind: type === "document" ? mediaKind(mimetype, file) : type };
  } catch (e) {
    console.error(`media download failed: ${e}`);
    return null;
  }
}

function saveText(m: proto.IWebMessageInfo, text: string): void {
  const jid = m.key.remoteJid;
  if (!jid) return;
  const id = `${jid}:${m.key.id}`;
  const ts = Number(m.messageTimestamp) * 1000;
  db.prepare(
    `INSERT OR IGNORE INTO wa_messages (id, chat_jid, sender, sender_name, text, ts, from_me)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    jid,
    m.key.participant ?? null,
    m.pushName ?? null,
    text,
    ts,
    m.key.fromMe ? 1 : 0
  );
}

async function storeSelfMessage(m: proto.IWebMessageInfo): Promise<void> {
  const text = extractText(m.message);
  if (text.trim().startsWith(SELF_MARKER)) return; // our own nudge echoing back
  const ts = Number(m.messageTimestamp) * 1000;
  const media = await downloadMedia(m.message);
  if (!text.trim() && !media) return;
  capture(text.trim(), {
    source: "self-chat",
    kind: media?.kind,
    mediaPath: media?.file,
    waMsgId: m.key.id ?? undefined,
    createdAt: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
  });
}

function storeMessage(m: proto.IWebMessageInfo): void {
  const jid = m.key.remoteJid;
  if (!jid || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;
  if (isSelfChat(jid)) {
    void storeSelfMessage(m);
    return;
  }
  const text = extractText(m.message);
  if (!text.trim()) return;
  saveText(m, text);
}

/** Send a message into the user's own "Message yourself" chat. */
export async function sendToSelf(text: string): Promise<boolean> {
  if (!sock || !meJid) return false;
  await sock.sendMessage(meJid, { text: `${SELF_MARKER}\n${text}` });
  return true;
}


export function hasWaSession(): boolean {
  return fs.existsSync(path.join(config.sessionDir, "creds.json"));
}

export function waStatus(): { state: WaState; hasSession: boolean; qr: string | null } {
  return { state, hasSession: hasWaSession(), qr: latestQr };
}

async function makeSocket(): Promise<void> {
  const { state: auth, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  meJid = auth.creds.me?.id ?? meJid;
  const { version } = await fetchLatestBaileysVersion();
  const s = makeWASocket({
    version,
    auth: auth,
    browser: Browsers.ubuntu("unibox"),
    logger,
  });
  sock = s;
  s.ev.on("creds.update", saveCreds);
  s.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQr = qr;
      state = "pairing";
    }
    if (connection === "open") {
      state = "connected";
      latestQr = null;
      meJid = s.user?.id ?? meJid;
    }
    if (connection === "close") {
      sock = null;
      if (stopping) {
        state = "idle";
        return;
      }
      const code = (
        lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(config.sessionDir, { recursive: true, force: true });
        state = "idle";
        latestQr = null;
        return;
      }
      state = latestQr ? "pairing" : "connecting";
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (!stopping && !sock) void makeSocket();
      }, 3000);
    }
  });
  s.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) storeMessage(m);
  });
}

export async function waStart(): Promise<void> {
  if (sock) return;
  stopping = false;
  state = hasWaSession() ? "connecting" : "pairing";
  await makeSocket();
}

/**
 * Link by phone number instead of QR, for when the only screen at hand is the phone itself:
 * WhatsApp → Dispositivos vinculados → Vincular con número de teléfono, then type this code.
 */
export async function waPairCode(phone: string): Promise<string> {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) throw new Error("número de teléfono incompleto");
  if (hasWaSession() && state === "connected") throw new Error("WhatsApp ya está vinculado");
  await waStart();
  // the socket can only ask for a code once it's talking to WhatsApp, which the first QR signals
  for (let i = 0; i < 30 && !latestQr; i++) await new Promise((r) => setTimeout(r, 500));
  if (!sock) throw new Error("no se pudo abrir la conexión con WhatsApp");
  const code = await sock.requestPairingCode(digits);
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function waStop(): void {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    sock?.end(undefined);
  } catch {
  }
  sock = null;
  state = "idle";
  latestQr = null;
}
