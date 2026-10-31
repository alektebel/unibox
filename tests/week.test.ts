import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { spots, schedule, upcoming, planDay, localDate } from "../src/planner.js";
import { addItems } from "../src/slate.js";

const DAY = 86_400_000;

test("the week has named free spots: after work, weekend mornings", () => {
  const s = spots(Date.now(), 7);
  assert.ok(s.length > 5);
  assert.ok(s.some((x) => /después del trabajo|por la mañana|por la tarde/.test(x.label)));
});

test("scheduling puts a thing in the week and replanning that day leaves it there", async () => {
  const [ref] = addItems([{ title: "Diseñar el sistema de colas", action: "do", context: "desk", effort: 90, priority: 95 }]);
  const now = Date.now();
  const sat = spots(now, 8).find((x) => new Date(x.start).getDay() === 6 && new Date(x.start).getHours() < 13)!;
  assert.ok(sat, "a Saturday morning spot");
  const slot = schedule(ref, now, { from: sat.start, to: sat.end })!;
  assert.ok(slot && slot.start >= sat.start && slot.end <= sat.end);
  assert.ok(upcoming(now).some((u) => u.ref === ref) || localDate(slot.start) === localDate(now));
  // a second thing in the same spot goes after it, not on top
  const [ref2] = addItems([{ title: "Leer sobre Kafka", action: "read", effort: 30, priority: 80 }]);
  const slot2 = schedule(ref2, now, { from: sat.start, to: sat.end })!;
  assert.ok(slot2.start >= slot.end);
  const day = new Date(slot.start); day.setHours(0, 0, 0, 0);
  await planDay(day.getTime(), now, true);
  const still = db.prepare("SELECT status FROM plan_slots WHERE id = ?").get(slot.id) as any;
  assert.equal(still.status, "planned");
  const dup = db.prepare("SELECT COUNT(*) n FROM plan_slots WHERE ref = ? AND status = 'planned'").get(ref) as any;
  assert.equal(dup.n, 1, "not planned twice");
});

test("rescheduling moves it instead of copying it", () => {
  const [ref] = addItems([{ title: "Revisar el PR de infra", action: "do", effort: 30 }]);
  const now = Date.now();
  schedule(ref, now);
  const later = spots(now + 3 * DAY, 3)[0];
  schedule(ref, now, { from: later.start, to: later.end });
  const n = db.prepare("SELECT COUNT(*) n FROM plan_slots WHERE ref = ? AND status = 'planned'").get(ref) as any;
  assert.equal(n.n, 1);
});

test("a priority you set survives the worker's aging formula", async () => {
  const { refreshPriorities } = await import("../src/capture/process.js");
  const [ref] = addItems([{ title: "Etapa 1 del proyecto", action: "do", priority: 99 }]);
  refreshPriorities();
  assert.equal((db.prepare("SELECT priority FROM items WHERE id = ?").get(ref) as any).priority, 99);
});

test("the chat's own guesses at times are dropped when the system says where things went", async () => {
  const { withoutTimes } = await import("../src/assistant.js");
  assert.equal(
    withoutTimes("Hecho, va antes que lo demás. La he puesto de 15:00 a 17:00. ¿Te parece bien?"),
    "Hecho, va antes que lo demás."
  );
});

test("a file name with a dot doesn't split the sentence", async () => {
  const { withoutTimes } = await import("../src/assistant.js");
  assert.equal(withoutTimes("Descarto la etapa de rate_limiter.py. La pongo a las 18:00."), "Descarto la etapa de rate_limiter.py.");
});

test("a reply claiming it scheduled something, when nothing was, loses that claim", async () => {
  const { withoutClaims } = await import("../src/assistant.js");
  assert.equal(withoutClaims("Entendido, no toco nada. Mientras tanto, he programado las lecturas para mañana."), "Entendido, no toco nada.");
});

test("the week's days are calendar days, also across the night the clocks change", async () => {
  const { addDays } = await import("../src/days.js");
  // 2026-10-25: clocks go back an hour in Europe/Madrid (25-hour day)
  const sat = new Date(2026, 9, 24, 10, 0).getTime();
  const dates = [0, 1, 2, 3].map((i) => new Date(addDays(sat, i)).getDate());
  assert.deepEqual(dates, [24, 25, 26, 27]);
});

test("'cap. 5' doesn't end a sentence when the chat's times are taken out", async () => {
  const { withoutTimes } = await import("../src/assistant.js");
  assert.equal(withoutTimes("Vale, primero el cap. 5 del libro. Lo pongo a las 16:15."), "Vale, primero el cap. 5 del libro.");
});
