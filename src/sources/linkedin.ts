import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function findLinkedinCsvs(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.toLowerCase().endsWith(".csv")) found.push(p);
    }
  };
  walk(dir);
  return found;
}

function parseMessagesCsv(file: string): {
  convId: string;
  fromName: string;
  toName: string;
  content: string;
  date: string;
}[] {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (/conversation.?id/i.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];
  const headers = parseCsvLine(lines[headerIdx]).map((h) =>
    h.trim().toLowerCase().replace(/\s+/g, "_")
  );
  const idx = (name: string) => headers.indexOf(name);
  const iConv = idx("conversation_id");
  const iFrom = idx("from");
  const iTo = idx("to");
  const iContent = idx("content");
  const iDate = idx("date");
  if (iFrom === -1 || iDate === -1) return [];
  const rows: {
    convId: string;
    fromName: string;
    toName: string;
    content: string;
    date: string;
  }[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = parseCsvLine(lines[i]);
    rows.push({
      convId: iConv !== -1 ? (cols[iConv] ?? "") : "",
      fromName: (cols[iFrom] ?? "").trim(),
      toName: iTo !== -1 ? (cols[iTo] ?? "").trim() : "",
      content: iContent !== -1 ? (cols[iContent] ?? "").trim() : "",
      date: (cols[iDate] ?? "").trim(),
    });
  }
  return rows;
}

function cleanName(v: string): string {
  return v.replace(/\s*\(Profile URL:.*$/s, "").trim();
}

export function ingestLinkedin(): number {
  if (!fs.existsSync(config.linkedinInbound)) return 0;
  const files = findLinkedinCsvs(config.linkedinInbound);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO li_messages (id, conv_id, from_name, to_name, content, date)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  for (const file of files) {
    for (const r of parseMessagesCsv(file)) {
      if (!r.date) continue;
      const id = crypto
        .createHash("sha1")
        .update(`${r.convId}|${r.date}|${r.fromName}|${r.content}`)
        .digest("hex");
      const res =       insert.run(
        id,
        r.convId,
        cleanName(r.fromName),
        cleanName(r.toName),
        r.content,
        r.date
      );
      added += Number(res.changes);
    }
  }
  return added;
}
