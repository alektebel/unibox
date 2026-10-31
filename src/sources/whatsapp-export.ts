import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { capture, mediaKind } from "../capture/ingest.js";

const START_RE =
  /^\[?(\d{1,4}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([APap]\.?[Mm]\.?)?\]?\s*[-–—]?\s*(.*)$/;

const MEDIA_RES = [
  /^<attached:\s*(.+?)>$/i,
  /^<adjunto:\s*(.+?)>$/i,
  /^(.+?)\s*\((?:file attached|archivo adjunto)\)$/i,
  /^<Media omitted>$/i,
  /^<Multimedia omitido>$/i,
];

const MEDIA_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".mp4", ".mov", ".3gp", ".mkv", ".webm",
  ".opus", ".ogg", ".mp3", ".m4a", ".wav", ".aac",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".vcf",
]);

interface ParsedMsg {
  ts: number;
  sender: string;
  body: string;
}

function parseTimestamp(dateStr: string, timeStr: string, ap?: string): number {
  const parts = dateStr.split(/[./-]/);
  let year: number, a: number, b: number;
  if (parts[0].length === 4) {
    year = Number(parts[0]);
    a = Number(parts[1]);
    b = Number(parts[2]);
  } else {
    a = Number(parts[0]);
    b = Number(parts[1]);
    year = Number(parts[2]);
    if (year < 100) year += 2000;
  }
  let month: number, day: number;
  if (a > 12) {
    day = a;
    month = b;
  } else if (b > 12) {
    month = a;
    day = b;
  } else {
    day = a; // day-first elsewhere (e.g. Spanish exports)
    month = b;
  }
  const [hStr, mStr, sStr] = timeStr.split(":");
  let hour = Number(hStr);
  const min = Number(mStr ?? 0);
  const sec = Number(sStr ?? 0);
  const isPm = /p/i.test(ap ?? "");
  const isAm = /a/i.test(ap ?? "");
  if (isPm && hour < 12) hour += 12;
  if (isAm && hour === 12) hour = 0;
  const d = new Date(year, month - 1, day, hour, min, sec);
  return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}

export function parseWhatsappExport(text: string): ParsedMsg[] {
  const out: ParsedMsg[] = [];
  let current: ParsedMsg | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(START_RE);
    if (m) {
      const ts = parseTimestamp(m[1], m[2], m[3]);
      const rest = m[4] ?? "";
      const senderMatch = rest.match(/^([^:\n]{1,80}):\s?([\s\S]*)$/);
      if (!senderMatch) {
        current = null; // system message
        continue;
      }
      current = { ts, sender: senderMatch[1].trim(), body: senderMatch[2] ?? "" };
      out.push(current);
    } else if (current && line.trim()) {
      current.body += `\n${line}`;
    }
  }
  return out;
}

function indexFiles(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(dir)) return map;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else map.set(e.name.toLowerCase(), p);
    }
  };
  walk(dir);
  return map;
}

function copyToMedia(src: string): string {
  const ext = path.extname(src).toLowerCase();
  const dest = path.join(
    config.mediaDir,
    `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}${ext}`
  );
  fs.copyFileSync(src, dest);
  return dest;
}

function mediaName(body: string): string | null {
  const t = body.trim();
  for (const re of MEDIA_RES) {
    const m = t.match(re);
    if (!m) continue;
    if (m[1]) return m[1].trim();
    return null; // "<Media omitted>" — media not in export
  }
  return null;
}

// Messages typed back-to-back (a "burst") are one thought, not five.
const BURST_GAP_MS = 5 * 60 * 1000;

function isOmitted(body: string): boolean {
  return /^<(?:Media omitted|Multimedia omitido)>$/i.test(body.trim());
}

const isBareUrl = (body: string) => /^https?:\/\/\S+$/i.test(body.trim());

function isStandalone(body: string): boolean {
  const t = body.trim();
  return /^https?:\/\/\S+$/i.test(t) || mediaName(t) !== null;
}

// what a burst is, whatever file it came in: exporting the same chat again adds nothing twice
function burstId(burst: ParsedMsg[]): string {
  const basis = burst.map((m) => m.body).join("\u0000");
  const hash = crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12);
  return `wa:${burst[0].sender}:${burst[0].ts}:${hash}`;
}

// how bursts were named before (by file): still checked, so older imports aren't redone
function fileBurstId(file: string, burst: ParsedMsg[]): string {
  const basis = burst.map((m) => m.body).join("\u0000");
  const hash = crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12);
  return `${path.basename(file)}:${burst[0].ts}:${hash}`;
}

export function groupBursts(msgs: ParsedMsg[]): ParsedMsg[][] {
  const bursts: ParsedMsg[][] = [];
  let cur: ParsedMsg[] = [];
  for (const m of msgs) {
    const prev = cur[cur.length - 1];
    const close = prev !== undefined && prev.sender === m.sender && m.ts - prev.ts >= 0 && m.ts - prev.ts <= BURST_GAP_MS;
    // a bare link followed by a line about it ("leer esto con calma") is one thing: the link and your note
    const linkNote = close && cur.length === 1 && isBareUrl(prev!.body) && !isStandalone(m.body);
    const joinable = linkNote || (close && !isStandalone(m.body) && !isStandalone(prev!.body) && !isBareUrl(cur[0].body));
    if (joinable) cur.push(m);
    else {
      if (cur.length) bursts.push(cur);
      cur = [m];
    }
  }
  if (cur.length) bursts.push(cur);
  return bursts;
}

/** A WhatsApp chat export: most of its first lines start with a date and a time. */
export function looksLikeExport(text: string): boolean {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  return lines.length >= 2 && lines.filter((l) => START_RE.test(l)).length >= Math.ceil(lines.length / 2);
}

export function ingestWhatsappExports(): number {
  const dir = config.whatsappInbound;
  if (!fs.existsSync(dir)) return 0;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith(".txt")) files.push(p);
    }
  };
  walk(dir);
  const fileIndex = indexFiles(dir);
  let added = 0;
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    // drop "<Media omitted>" placeholders — the file isn't in the export anyway
    const msgs = parseWhatsappExport(raw).filter((m) => !isOmitted(m.body));
    for (const burst of groupBursts(msgs)) {
      const waMsgId = burstId(burst);
      if (db.prepare("SELECT 1 FROM items WHERE wa_msg_id IN (?, ?)").get(waMsgId, fileBurstId(file, burst))) continue;
      // a link and its note imported before as two items stay as they were
      if (burst.length > 1 && burst.some((m) => db.prepare("SELECT 1 FROM items WHERE wa_msg_id IN (?, ?)").get(burstId([m]), fileBurstId(file, [m])))) continue;
      const first = burst[0];
      const body = burst.map((m) => m.body.trim()).filter(Boolean).join("\n").trim();
      if (!body) continue;

      const name = burst.length === 1 ? mediaName(body) : null;
      if (name) {
        const found = fileIndex.get(name.toLowerCase());
        if (found && MEDIA_EXT.has(path.extname(found).toLowerCase())) {
          const mediaPath = copyToMedia(found);
          if (capture(name, {
            source: "whatsapp-export",
            kind: mediaKind(null, found),
            mediaPath,
            waMsgId,
            createdAt: first.ts,
          }).added) {
            added++;
          }
        } else {
          // media referenced but not present — keep a pointer
          if (capture(`[media: ${name}]`, {
            source: "whatsapp-export",
            kind: "file",
            waMsgId,
            createdAt: first.ts,
          }).added) {
            added++;
          }
        }
        continue;
      }

      const linked = isBareUrl(first.body);
      const kind = linked ? "link" : undefined;
      if (capture(body, { source: "whatsapp-export", kind, url: linked ? first.body.trim() : undefined, waMsgId, createdAt: first.ts }).added) added++;
    }
  }
  return added;
}
