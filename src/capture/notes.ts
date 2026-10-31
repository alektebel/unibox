import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { captureBlob } from "./ingest.js";

/** Import any .txt/.md/.csv drops in inbound/notes as individual items (deduped by content). */
export function ingestNotes(): number {
  const dir = config.notesInbound;
  if (!fs.existsSync(dir)) return 0;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(txt|md|csv)$/i.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  let added = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    added += captureBlob(text, "notes");
  }
  return added;
}
