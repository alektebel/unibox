import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";

export interface CaptureOpts {
  source?: string;
  kind?: string;
  url?: string;
  title?: string;
  mediaPath?: string;
  waMsgId?: string;
  createdAt?: number;
}

const URL_RE = /^https?:\/\/\S+$/i;

export function isUrl(s: string): boolean {
  return URL_RE.test(s.trim());
}

export function firstUrl(s: string): string | null {
  const m = s.match(/https?:\/\/[^\s<>"')]+/i);
  return m ? m[0].replace(/[.,;:]+$/, "") : null;
}

function extKind(file: string): string {
  const e = path.extname(file).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".avif", ".bmp"].includes(e)) return "image";
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(e)) return "video";
  if ([".ogg", ".opus", ".mp3", ".m4a", ".wav", ".aac", ".flac", ".webm"].includes(e)) return "audio";
  if ([".pdf", ".doc", ".docx", ".txt", ".md", ".csv"].includes(e)) return "file";
  return "file";
}

export function mediaKind(mimetype?: string | null, file?: string): string {
  const mt = (mimetype ?? "").toLowerCase();
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  if (file) return extKind(file);
  return "file";
}

export function detectKind(raw: string, mediaPath?: string): string {
  if (mediaPath) return mediaKind(null, mediaPath);
  if (isUrl(raw)) return "link";
  return "note";
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|si$|igshid)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^www\./, "");
    const q = u.searchParams.toString();
    return `${u.origin}${u.pathname}${q ? `?${q}` : ""}`.replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

function contentHash(raw: string, url: string | null, mediaPath?: string, waMsgId?: string): string {
  let basis: string;
  if (waMsgId) {
    basis = `wa:${waMsgId}`;
  } else if (url) {
    basis = `url:${normalizeUrl(url)}`;
  } else if (mediaPath) {
    let size = 0;
    try {
      size = fs.statSync(mediaPath).size;
    } catch {
    }
    basis = `media:${path.basename(mediaPath)}:${size}`;
  } else {
    basis = `text:${raw.trim()}`;
  }
  return crypto.createHash("sha1").update(basis).digest("hex");
}

export function newId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export function addEvent(itemId: string, event: string, detail?: string): void {
  db.prepare("INSERT INTO item_events (item_id, at, event, detail) VALUES (?, ?, ?, ?)").run(
    itemId,
    Date.now(),
    event,
    detail ?? null
  );
}

export interface CaptureResult {
  added: boolean;
  id: string;
}

export function capture(raw: string, opts: CaptureOpts = {}): CaptureResult {
  const text = raw.trim();
  const url = opts.url ?? (isUrl(text) ? text : firstUrl(text));
  const kind = opts.kind ?? detectKind(text, opts.mediaPath);
  const id = newId();
  const createdAt = opts.createdAt ?? Date.now();
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO items
       (id, source, wa_msg_id, kind, raw, url, title, media_path, content_hash, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?)`
    )
    .run(
      id,
      opts.source ?? "composer",
      opts.waMsgId ?? null,
      kind,
      text || null,
      url,
      opts.title ?? null,
      opts.mediaPath ?? null,
      contentHash(text, url, opts.mediaPath, opts.waMsgId),
      createdAt
    );
  const added = Number(res.changes) > 0;
  if (added) addEvent(id, "captured", opts.source ?? "composer");
  return { added, id };
}

export function splitCaptures(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
      .filter(Boolean);
    if (lines.length <= 1) {
      if (lines[0]) out.push(lines[0]);
    } else {
      out.push(...lines);
    }
  }
  return out;
}

export function captureBlob(text: string, source = "composer"): number {
  let added = 0;
  const seen = new Set<string>();
  for (const chunk of splitCaptures(text)) {
    if (seen.has(chunk)) continue;
    seen.add(chunk);
    if (capture(chunk, { source }).added) added++;
  }
  return added;
}
