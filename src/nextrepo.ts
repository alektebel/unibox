import crypto from "node:crypto";
import { db, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";
import { githubConfigured, ensureRepo, writeFile } from "./github.js";
import { planPayload, upcoming, candidates, whoseTurn, outdated } from "./planner.js";
import { commitmentsBetween } from "./commitments.js";
import { addDays } from "./days.js";

// Your next steps as a private GitHub repo: one README with what's on now, today, the next part
// of each goal (and the whole list ticked off), the week, appointments and what's queued. The
// server rewrites it when something changes; every change is a commit, so the history is there.

const hhmm = (t: number) => new Date(t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
const day = (t: number) => new Date(t).toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Madrid" });

/** The README, without the "updated at" line (that one doesn't count as a change). */
export function render(now = Date.now()): string {
  const plan = planPayload(now);
  const out: string[] = ["# Siguientes pasos", ""];

  const nowSlot = plan.slots.find((s: any) => s.status === "now");
  const next = plan.slots.find((s: any) => s.status === "next");
  out.push("## Ahora", "");
  if (nowSlot) out.push(`**${nowSlot.title}** · hasta las ${hhmm(nowSlot.end)}`);
  else if (next) out.push(`Nada en curso. Lo siguiente: **${next.title}** a las ${hhmm(next.start)}.`);
  else out.push("Nada planificado ahora.");
  out.push("");

  const today = plan.slots.filter((s: any) => s.status !== "moved");
  if (today.length) {
    out.push("## Hoy", "");
    for (const s of today) {
      const mark = s.status === "done" ? "x" : " ";
      const note = s.status === "missed" ? " _(no hecho)_" : s.status === "asking" ? " _(¿cómo fue?)_" : "";
      out.push(`- [${mark}] ${hhmm(s.start)}–${hhmm(s.end)} ${s.title}${note}`);
    }
    out.push("");
  }

  const goals = db.prepare("SELECT id, name, due FROM goals WHERE archived = 0 ORDER BY created_at").all() as any[];
  const turn = whoseTurn();
  for (const g of goals) {
    const parts = db.prepare("SELECT id, title, raw, state FROM items WHERE tags = ? ORDER BY rowid").all(`goal:${g.id}`) as any[];
    if (!parts.length) continue;
    const done = parts.filter((p) => p.state === "done").length;
    const nextPart = parts.find((p) => (p.state === "active" || p.state === "inbox") && turn(p.id));
    const left = g.due ? Math.ceil((Date.parse(g.due) + 86_400_000 - now) / 86_400_000) : null;
    const bar = "█".repeat(Math.round((10 * done) / parts.length)).padEnd(10, "░");
    out.push(`## Meta: ${g.name}`, "", `${bar} ${done} de ${parts.length}${left != null ? ` · ${left > 0 ? `quedan ${left} días` : "fecha pasada"}` : ""}`, "");
    if (nextPart) out.push(`**Lo siguiente:** ${nextPart.title || nextPart.raw}`, "");
    out.push("<details><summary>Todas las partes</summary>", "");
    for (const p of parts) {
      if (p.state === "dropped" || p.state === "archived") continue;
      out.push(`- [${p.state === "done" ? "x" : " "}] ${p.title || p.raw}`);
    }
    out.push("", "</details>", "");
  }

  const week = upcoming(now);
  const appts = commitmentsBetween(now, addDays(now, 8));
  if (week.length || appts.length) {
    out.push("## Esta semana", "");
    const rows = [
      ...week.map((u) => ({ t: u.start, line: `${day(u.start)} ${hhmm(u.start)} · ${u.title}` })),
      ...appts.map((c) => ({ t: c.start, line: `${day(c.start)} ${hhmm(c.start)} · 📌 ${c.title}${c.location ? ` (${c.location})` : ""}` })),
    ].sort((a, b) => a.t - b.t);
    for (const r of rows) out.push(`- ${r.line}`);
    out.push("");
  }

  const planned = new Set(plan.slots.map((s: any) => s.ref));
  const queue = candidates(now, planned).slice(0, 10);
  if (queue.length) {
    out.push("## En la cola", "");
    for (const c of queue) out.push(`- ${c.title}`);
    out.push("");
  }

  // everything saved, packed by what you can do with it (a goal's parts are above, with the goal)
  const rows = (db.prepare(
    `SELECT id, title, raw, url, action, effort_min, created_at, tags, priority_set FROM items
      WHERE state IN ('active', 'inbox') AND processed_at IS NOT NULL AND COALESCE(tags, '') NOT LIKE 'goal:%'
      ORDER BY priority DESC`
  ).all() as any[]).filter((r) => !outdated(r, now));
  const packs: [string, (r: any) => boolean][] = [
    ["Rápidas (5 min o menos)", (r) => (r.effort_min ?? 99) <= 5 && r.action !== "read" && r.action !== "watch"],
    ["Para hacer", (r) => r.action === "do"],
    ["Para leer", (r) => r.action === "read"],
    ["Para ver o escuchar", (r) => r.action === "watch" || r.action === "listen"],
    ["Para comprar", (r) => r.action === "buy"],
    ["Para responder", (r) => r.action === "reply"],
  ];
  const used = new Set<any>();
  const packed = packs.map(([name, pick]) => {
    const list = rows.filter((r) => !used.has(r) && pick(r));
    list.forEach((r) => used.add(r));
    return { name, list };
  }).filter((p) => p.list.length);
  if (packed.length) {
    out.push("## Paquetes", "");
    for (const p of packed) {
      out.push(`<details><summary><b>${p.name}</b> · ${p.list.length}</summary>`, "");
      for (const r of p.list.slice(0, 25)) {
        const title = String(r.title || r.raw || r.url).replace(/\s+/g, " ").slice(0, 110);
        out.push(`- ${r.url && !String(r.title || r.raw).includes(r.url) ? `[${title}](${r.url})` : title}${r.effort_min ? ` · ${r.effort_min} min` : ""}`);
      }
      if (p.list.length > 25) out.push(`- … y ${p.list.length - 25} más`);
      out.push("", "</details>", "");
    }
  }

  if (plan.ask.length) {
    out.push("## ¿Sigue importando?", "", "Se te han pasado dos veces; dile al chat si siguen o se quitan.", "");
    for (const a of plan.ask) if (a) out.push(`- ${a.title}`);
    out.push("");
  }
  return out.join("\n");
}

let syncing = false;

/** Rewrite the repo's README if anything changed. Never throws. */
export async function syncNextRepo(now = Date.now()): Promise<string | null> {
  if (!githubConfigured() || syncing) return null;
  syncing = true;
  try {
    const body = render(now);
    const hash = crypto.createHash("sha256").update(body).digest("hex");
    const repo = getMeta("next_repo") || (await ensureRepo(config.nextRepo, "Siguientes pasos, al día: lo actualiza Unibox."));
    setMeta("next_repo", repo);
    if (getMeta("next_repo_hash") === hash) return repo;
    const stamp = new Date(now).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "full", timeStyle: "short" });
    await writeFile(repo, "README.md", body.replace("# Siguientes pasos\n", `# Siguientes pasos\n\n_Actualizado: ${stamp}_\n`), "Siguientes pasos al día");
    setMeta("next_repo_hash", hash);
    return repo;
  } catch (e) {
    console.warn("[nextrepo]", e instanceof Error ? e.message : e);
    return null;
  } finally {
    syncing = false;
  }
}
