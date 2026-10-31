import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db, setMeta, getMeta } from "../src/db.js";
import {
  freeGaps, pack, greedy, evaluate, seriesKey, capSeries, notYet, checkIn, capacityFor, candidates, planPayload, localDate, markDone, answerAsk,
  type Candidate, type Gap,
} from "../src/planner.js";

const at = (s: string) => new Date(s).getTime();
const hh = (t: number) => new Date(t).toTimeString().slice(0, 5);
const MIN = 60_000;

test("free time on a weekday: before work, work hours, evening, minus what's taken", () => {
  const day = at("2026-10-21T00:00:00"); // Wednesday
  const gaps = freeGaps(day, at("2026-10-21T06:00:00"), [{ start: at("2026-10-21T19:00:00"), end: at("2026-10-21T19:45:00") }]);
  assert.deepEqual(gaps.map((g) => `${hh(g.start)}-${hh(g.end)} ${g.tag}`), [
    "07:30-09:00 libre",
    "09:00-17:00 trabajo",
    "17:00-19:00 libre",
    "19:45-23:00 libre",
  ]);
});

test("weekends have no work hours, and the past of today is not free", () => {
  const sat = at("2026-10-24T00:00:00");
  const gaps = freeGaps(sat, at("2026-10-24T16:10:00"), []);
  assert.deepEqual(gaps.map((g) => `${hh(g.start)}-${hh(g.end)} ${g.tag}`), ["16:10-23:00 libre"]);
});

const cand = (ref: string, action: string, effort: number, context = "", score = 50): Candidate =>
  ({ ref, kind: "item", title: ref, action, context, effort, url: "", score, due: null, misses: 0 });

test("packing puts slots back to back with a break and drops what doesn't fit", () => {
  const gaps: Gap[] = [{ start: at("2026-10-21T17:00:00"), end: at("2026-10-21T18:00:00"), tag: "libre" }];
  const cands = new Map([["a", cand("a", "read", 30)], ["b", cand("b", "read", 15)], ["c", cand("c", "read", 30)]]);
  const out = pack(gaps, [{ ref: "a", gap: 0, why: "" }, { ref: "b", gap: 0, why: "" }, { ref: "c", gap: 0, why: "" }], cands, 1);
  assert.deepEqual(out.map((s) => `${s.ref} ${hh(s.start)}-${hh(s.end)}`), ["a 17:00-17:30", "b 17:40-17:55"]);
});

test("choosing: your own computer work and reading go to free time; work hours take only work", () => {
  const gaps: Gap[] = [
    { start: at("2026-10-21T09:00:00"), end: at("2026-10-21T17:00:00"), tag: "trabajo" },
    { start: at("2026-10-21T19:45:00"), end: at("2026-10-21T23:00:00"), tag: "libre" },
  ];
  const picks = greedy([cand("paper", "read", 30, "", 90), cand("code", "do", 45, "desk", 80), cand("video", "watch", 20, "", 70), cand("job", "do", 30, "work", 60)], gaps);
  const where = Object.fromEntries(picks.map((p) => [p.ref, gaps[p.gap].tag]));
  assert.deepEqual(where, { paper: "libre", code: "libre", video: "libre", job: "trabajo" });
});

test("a part of the day you rarely follow through gets fewer things", () => {
  setMeta("plan_parts", JSON.stringify({ tarde: { done: 1, total: 8 }, mañana: { done: 7, total: 8 } }));
  assert.equal(capacityFor("tarde", "libre"), 1);
  assert.equal(capacityFor("mañana", "libre"), 3);
  setMeta("plan_parts", "{}");
});

function addItem(id: string, title: string, action = "read", priority = 50) {
  db.prepare(
    "INSERT INTO items (id, source, raw, title, action, effort_min, context, priority, state, created_at, processed_at) VALUES (?, 'test', ?, ?, ?, 20, '', ?, 'active', ?, ?)"
  ).run(id, title, title, action, priority, Date.now() - 86_400_000 * 3, Date.now());
}
function addSlot(ref: string, start: number, end: number) {
  return Number(db.prepare(
    "INSERT INTO plan_slots (date, start, end, ref, kind, title, action, status, created_at) VALUES (?, ?, ?, ?, 'item', ?, 'read', 'planned', ?)"
  ).run(localDate(start), start, end, ref, ref, Date.now()).lastInsertRowid);
}
const status = (id: number) => (db.prepare("SELECT status FROM plan_slots WHERE id = ?").get(id) as any).status;

test("evaluating: done if it got done; a gap that passed unused goes back to the queue; only what you started is asked about", () => {
  addItem("ev-done", "Leer artículo A");
  addItem("ev-miss", "Leer artículo B");
  addItem("ev-started", "Leer artículo C");
  const now = Date.now();
  const a = addSlot("ev-done", now - 90 * MIN, now - 60 * MIN);
  const b = addSlot("ev-miss", now - 50 * MIN, now - 20 * MIN);
  const c = addSlot("ev-started", now - 45 * MIN, now - 15 * MIN);
  db.prepare("UPDATE items SET state = 'done' WHERE id = 'ev-done'").run();
  db.prepare("INSERT INTO focus_blocks (ref, title, started_at, planned_min) VALUES ('ev-started', 'Leer artículo C', ?, 30)").run(now - 44 * MIN);
  evaluate(now);
  assert.equal(status(a), "done");
  assert.equal(status(b), "moved", "no miss, no question");
  assert.equal(Number(getMeta("plan_miss:ev-miss") ?? 0), 0);
  assert.equal(status(c), "asking");
  assert.ok(planPayload(now).asking.some((x: any) => x.id === c));
});

test("unanswered from an earlier day counts as missed; missed twice is asked about instead of planned", () => {
  addItem("twice", "Revisar contrato del piso", "do", 99);
  const now = Date.now();
  const y = now - 86_400_000;
  db.prepare("UPDATE plan_slots SET status = 'done' WHERE status = 'asking'").run();
  const s1 = addSlot("twice", y - 300 * MIN, y - 280 * MIN);
  const s2 = addSlot("twice", y - 200 * MIN, y - 180 * MIN);
  db.prepare("UPDATE plan_slots SET status = 'asking' WHERE id IN (?, ?)").run(s1, s2);
  evaluate(now);
  assert.equal(status(s1), "missed");
  assert.ok(!candidates(now).some((c) => c.ref === "twice"));
  assert.ok(planPayload(now).ask.some((a: any) => a.ref === "twice"));
  answerAsk("twice", true);
  assert.ok(candidates(now).some((c) => c.ref === "twice"));
});

test("“aún no” is a miss and the thing comes back with less weight", () => {
  addItem("later", "Leer artículo C");
  const now = Date.now();
  const id = addSlot("later", now - 40 * MIN, now - 10 * MIN);
  notYet(id);
  assert.equal(status(id), "missed");
  assert.equal(candidates(now).find((c) => c.ref === "later")?.misses, 1);
});

test("a summary with substance closes it and is kept with the thing; a vague one doesn't", async () => {
  addItem("sum", "Leer el post de Mastra");
  const now = Date.now();
  const id = addSlot("sum", now - 40 * MIN, now - 10 * MIN);
  const vague = await checkIn(id, "ya está");
  assert.equal(vague.done, false);
  assert.equal(status(id), "planned");
  const real = await checkIn(id, "Mastra es un framework de agentes en TypeScript: workflows con pasos tipados, memoria y evals integradas; útil para Unibox.");
  assert.equal(real.done, true);
  assert.equal(status(id), "done");
  assert.match((db.prepare("SELECT summary FROM items WHERE id = 'sum'").get() as any).summary, /Tu resumen .*Mastra es un framework/);
});

test("marking a slot done from the plan completes the thing itself", () => {
  addItem("mark", "Llamar al seguro", "do");
  const now = Date.now();
  const id = addSlot("mark", now + 60 * MIN, now + 80 * MIN);
  markDone(id);
  assert.equal((db.prepare("SELECT state FROM items WHERE id = 'mark'").get() as any).state, "done");
  assert.equal(status(id), "done");
});

test("chapters of one book are a series, and a day gets at most two of them", () => {
  assert.equal(seriesKey("Leer The Future of the Professions, cap. 3"), seriesKey("Leer The Future of the Professions, cap. 4"));
  assert.equal(seriesKey("Leer Superagency, caps. 9 y 10"), "leer superagency");
  assert.notEqual(seriesKey("Leer Superagency, caps. 9 y 10"), seriesKey("Leer The Future of the Professions, cap. 3"));
  const cs = ["cap. 3", "cap. 4", "cap. 5"].map((c, i) => cand(`b${i}`, "read", 45));
  cs.forEach((c, i) => (c.title = `Leer The Future of the Professions, ${["cap. 3", "cap. 4", "cap. 5"][i]}`));
  const map = new Map(cs.map((c) => [c.ref, c]));
  const kept = capSeries(cs.map((c) => ({ ref: c.ref, gap: 0, why: "" })), map);
  assert.deepEqual(kept.map((p) => p.ref), ["b0", "b1"]);
});

test("any open thing can be closed by explaining it, without a plan slot", async () => {
  addItem("free", "Llamar a IMDEA");
  const r = await checkIn(null, "Hablé con IMDEA: la visita fue bien, me mandan la propuesta de contrato el lunes y tengo que revisarla.", "free");
  assert.equal(r.outcome, "done");
  const it = db.prepare("SELECT state, summary FROM items WHERE id = 'free'").get() as any;
  assert.equal(it.state, "done");
  assert.match(it.summary, /Tu resumen .*propuesta de contrato/);
});

test("numbered parts go one at a time: the next stage only once the one before is done", async () => {
  const { nextInSeries } = await import("../src/planner.js");
  const t = (title: string) => ({ title });
  const out = nextInSeries([
    t("A5 infrastructure-from-scratch · etapa 6/18: throttling.py (leaky bucket)"),
    t("A5 infrastructure-from-scratch · etapa 5/18: rate_limiter.py (ventana fija)"),
    t("A1 aws-from-scratch · checks 10–18"),
    t("A1 aws-from-scratch · checks 1–9"),
    t("Leer The Future of the Professions, cap. 5"),
    t("Leer The Future of the Professions, cap. 4"),
    t("Comprar 2 kilos de arroz"),
    t("Comprar 3 cuadernos"),
  ]).map((x) => x.title);
  assert.deepEqual(out, [
    "A5 infrastructure-from-scratch · etapa 5/18: rate_limiter.py (ventana fija)",
    "A1 aws-from-scratch · checks 1–9",
    "Leer The Future of the Professions, cap. 4",
    "Comprar 2 kilos de arroz",
    "Comprar 3 cuadernos",
  ]);
});

test("work hours are for your job: your own projects and reading go after work", async () => {
  const { greedy } = await import("../src/planner.js");
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const gaps = [{ start: day.getTime() + 10 * 3_600_000, end: day.getTime() + 12 * 3_600_000, tag: "trabajo" as const }];
  const c = (ref: string, context: string) => ({ ref, kind: "item" as const, title: ref, action: "do", context, effort: 30, url: "", score: 90, due: null, misses: 0 });
  assert.deepEqual(greedy([c("proyecto", "desk"), c("informe del curro", "work")], gaps).map((p) => p.ref), ["informe del curro"]);
});

test("a stage set aside holds its series: the next one isn't offered instead", async () => {
  const { candidates } = await import("../src/planner.js");
  addItem("st-5", "Proyecto X · etapa 5/9: limitador", "do", 95);
  addItem("st-6", "Proyecto X · etapa 6/9: cola", "do", 94);
  setMeta("plan_miss:st-5", "2");
  const refs = candidates(Date.now()).map((c) => c.ref);
  assert.ok(!refs.includes("st-5") && !refs.includes("st-6"));
  setMeta("plan_miss:st-5", "0");
  const again = candidates(Date.now()).map((c) => c.ref);
  assert.ok(again.includes("st-5") && !again.includes("st-6"));
});

test("a goal's parts go in order: the next only once the one before is done", async () => {
  const { candidates } = await import("../src/planner.js");
  const add = (id: string, title: string, priority: number) => db.prepare(
    "INSERT INTO items (id, source, raw, title, action, effort_min, context, priority, state, created_at, processed_at, tags) VALUES (?, 'test', ?, ?, 'do', 60, 'desk', ?, 'active', ?, ?, 'goal:77')"
  ).run(id, title, title, priority, Date.now(), Date.now());
  add("g-a1", "A1 aws-from-scratch · bloque 1", 98);
  add("g-a6", "A6 dynamo-paper · bloque 1", 97);
  let refs = candidates(Date.now()).map((c) => c.ref);
  assert.ok(refs.includes("g-a1") && !refs.includes("g-a6"));
  db.prepare("UPDATE items SET state = 'done' WHERE id = 'g-a1'").run();
  refs = candidates(Date.now()).map((c) => c.ref);
  assert.ok(refs.includes("g-a6"));
});

test("a raised later stage doesn't jump the queue: the goal offers the series' next stage", async () => {
  const { candidates } = await import("../src/planner.js");
  const add = (id: string, title: string, priority: number) => db.prepare(
    "INSERT INTO items (id, source, raw, title, action, effort_min, context, priority, state, created_at, processed_at, tags) VALUES (?, 'test', ?, ?, 'do', 60, 'desk', ?, 'active', ?, ?, 'goal:78')"
  ).run(id, title, title, priority, Date.now(), Date.now());
  add("q-2", "Infra · etapa 2/9: hash", 98.95);
  add("q-5", "Infra · etapa 5/9: limitador", 99);
  const refs = candidates(Date.now()).map((c) => c.ref);
  assert.ok(refs.includes("q-2") && !refs.includes("q-5"));
});

test("hours off: what was planned in them goes, and nothing is planned there", async () => {
  const { freeHours, freeWindow } = await import("../src/planner.js");
  const now = Date.now();
  addItem("off-1", "Algo planificado ahora", "do", 70);
  const id = Number(db.prepare(
    "INSERT INTO plan_slots (date, start, end, ref, kind, title, action, status, created_at) VALUES (?, ?, ?, 'off-1', 'item', 'Algo planificado ahora', 'do', 'planned', ?)"
  ).run(localDate(now), now + 30 * 60_000, now + 90 * 60_000, now).lastInsertRowid);
  const r = freeHours(3, now);
  assert.ok(r.moved.includes("Algo planificado ahora"));
  assert.equal((db.prepare("SELECT status FROM plan_slots WHERE id = ?").get(id) as any).status, "moved");
  assert.ok(freeWindow(now + 2 * 3_600_000) && !freeWindow(now + 4 * 3_600_000));
  setMeta("free_window", "");
});

test("outdated things stay out of sight: a passed date, or weeks with nobody choosing them", async () => {
  const { outdated } = await import("../src/planner.js");
  const now = Date.now();
  const old = now - 60 * 86_400_000;
  assert.ok(outdated({ id: "o1", title: "Entregar el formulario antes del 25 de septiembre", created_at: now - 86_400_000 * 40 }, now), "date passed");
  assert.ok(outdated({ id: "o2", title: "Mirar una herramienta", created_at: old }, now), "stale");
  assert.ok(!outdated({ id: "o3", title: "Mirar una herramienta", created_at: old, priority_set: 80 }, now), "you chose it");
  assert.ok(!outdated({ id: "o4", title: "Etapa 1", created_at: old, tags: "goal:1" }, now), "part of a goal");
  assert.ok(!outdated({ id: "o5", title: "Leer algo nuevo", created_at: now - 86_400_000 }, now));
});
