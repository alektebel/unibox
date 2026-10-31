#!/usr/bin/env node
import fs from "node:fs";
import { digest } from "./digest.js";
import { ingestLinkedin } from "./sources/linkedin.js";
import { classifyTodos, digestCounts } from "./classify.js";
import { captureBlob, splitCaptures } from "./capture/ingest.js";
import { processItems } from "./capture/process.js";
import { ingestWhatsappExports } from "./sources/whatsapp-export.js";
import { ingestNotes } from "./capture/notes.js";
import { sendNudge, nudgeStatus, setAvailable } from "./nudge.js";
import { db } from "./db.js";

const cmd = process.argv[2];

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function listItems(limit = 40): void {
  const rows = db
    .prepare(
      `SELECT action, context, effort_min, kind, state, title, raw, url, batch_key
       FROM items ORDER BY COALESCE(priority, 0) DESC, created_at DESC LIMIT ?`
    )
    .all(limit) as {
    action: string | null;
    context: string | null;
    effort_min: number | null;
    kind: string;
    state: string;
    title: string | null;
    raw: string | null;
    url: string | null;
    batch_key: string | null;
  }[];
  if (!rows.length) {
    console.log("(nothing dumped yet)");
    return;
  }
  for (const r of rows) {
    const meta = [r.action, r.context, r.effort_min != null ? `${r.effort_min}m` : "", r.state]
      .filter(Boolean)
      .join(" · ");
    console.log(`[${meta}] ${r.title ?? r.raw ?? r.url ?? r.kind}`);
  }
}

async function main() {
  switch (cmd) {
    case "link":
      await (await import("./sources/whatsapp.js")).link();
      break;
    case "watch": {
      const durIdx = process.argv.indexOf("--duration");
      const dur = durIdx !== -1 ? Number(process.argv[durIdx + 1]) : undefined;
      const { startWorker } = await import("./worker.js");
      startWorker();
      await (await import("./sources/whatsapp.js")).watch(dur);
      break;
    }
    case "classify": {
      const n = await classifyTodos();
      console.log(`classified ${n} chats`);
      const c = digestCounts();
      console.log(
        `${c.needsReply} need replies (${c.overdue} over 7d), ${c.waiting} awaiting their answer`
      );
      break;
    }
    case "digest":
      process.stdout.write(await digest());
      process.stdout.write("\n");
      break;
    case "serve": {
      const { serve } = await import("./web.js");
      const { startWorker } = await import("./worker.js");
      startWorker();
      serve();
      await new Promise(() => {});
      break;
    }
    case "ingest": {
      const n = ingestLinkedin();
      console.log(`LinkedIn: ${n} new messages ingested.`);
      break;
    }
    case "dump": {
      const fileIdx = process.argv.indexOf("--file");
      const text =
        fileIdx !== -1
          ? fs.readFileSync(process.argv[fileIdx + 1], "utf8")
          : process.argv.slice(3).join(" ") || readStdin();
      if (!text.trim()) {
        console.log("nothing to dump");
        break;
      }
      const chunks = splitCaptures(text);
      const added = captureBlob(text, "cli");
      console.log(`dumped ${added} item${added === 1 ? "" : "s"} (${chunks.length} chunk${chunks.length === 1 ? "" : "s"})`);
      const processed = await processItems();
      if (processed) console.log(`processed ${processed}`);
      break;
    }
    case "check": {
      const { llmCheck } = await import("./llm.js");
      const { config } = await import("./config.js");
      const r = await llmCheck();
      console.log(r.ok ? `LLM  ok   ${r.model} via ${config.nanBaseUrl} (${r.ms} ms)` : `LLM  FAIL ${r.model}: ${r.error}`);
      const g = await import("./google.js");
      if (!g.googleConfigured()) console.log("Google  not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)");
      else if (!g.googleConnected()) console.log("Google  configured, not signed in — open the web UI and sign in");
      else {
        const s = await g.syncGoogle();
        console.log(s.error ? `Google  FAIL ${s.error}` : `Google  ok   ${g.googleAccount()} · ${s.threads} threads changed, ${s.events} events`);
      }
      break;
    }
    case "items":
      listItems(Number(process.argv[3]) || 40);
      break;
    case "import-wa": {
      const n = ingestWhatsappExports();
      console.log(`WhatsApp export: ${n} new items.`);
      const processed = await processItems();
      if (processed) console.log(`processed ${processed}`);
      break;
    }
    case "import-notes": {
      const n = ingestNotes();
      console.log(`Notes: ${n} new items.`);
      break;
    }
    case "process": {
      const n = await processItems();
      console.log(`processed ${n} items`);
      break;
    }
    case "nudge": {
      const res = await sendNudge(process.argv.includes("--force"));
      console.log(res.sent ? `sent: ${res.text}` : `not sent (${res.reason})`);
      break;
    }
    case "available": {
      const v = process.argv[3];
      if (v === "on" || v === "off") {
        setAvailable(v === "on");
        console.log(`available: ${v}`);
      } else {
        const st = nudgeStatus();
        console.log(`available=${st.available} quiet=${st.quiet} pending=${st.pending}`);
        for (const g of st.groups) console.log(`  ${g.key}: ${g.count} (${g.minutes}m)`);
      }
      break;
    }
    default:
      console.log(`usage: unibox <check|link|watch|serve|digest|classify|ingest|dump|items|import-wa|import-notes|process|nudge|available>

  check         verify the nan LLM and Google connections
  link          pair WhatsApp (scan QR once)
  watch         stay connected, capture + classify + process + nudges
  serve         web UI on http://127.0.0.1:8124 + background worker
  digest        generate today's digest (email + WhatsApp + LinkedIn)
  classify      one-shot todo triage of WhatsApp/LinkedIn chats
  ingest        import LinkedIn GDPR export CSVs from inbound/linkedin/
  dump          dump text/links from args or stdin into the inbox
                (use --file <path> to read a file)
  items         list processed inbox items
  import-wa     import a WhatsApp chat export from inbound/whatsapp/
  import-notes  import .txt/.md drops from inbound/notes/
  process       enrich + classify any unprocessed dumps
  nudge         send the next nudge now (--force ignores focus/quiet)
  available     show or set availability (available on|off)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
