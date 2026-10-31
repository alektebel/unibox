import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { save, entry, streak, prompts, journalPayload } from "../src/journal.js";
import { localDate } from "../src/planner.js";
import { reminders } from "../src/reminders.js";

const DAY = 86_400_000;

test("one page a day: writing again the same day replaces it, and it's kept", () => {
  const now = Date.now();
  save("Primera versión", now);
  save("Hoy cerré la etapa 1 del acortador de URLs.", now + 1000);
  assert.equal(entry(localDate(now))!.text, "Hoy cerré la etapa 1 del acortador de URLs.");
});

test("the streak counts days in a row, and the week counts days written", () => {
  const now = Date.now();
  db.prepare("DELETE FROM journal").run();
  for (const d of [1, 2, 3]) save(`día -${d}`, now - d * DAY);
  save("día -5", now - 5 * DAY);
  let s = streak(now);
  assert.deepEqual([s.run, s.week, s.today], [3, 4, false], "today not written yet: the run up to yesterday still counts");
  save("hoy", now);
  s = streak(now);
  assert.deepEqual([s.run, s.week, s.today], [4, 5, true]);
});

test("the questions ask about the goal you're on", () => {
  db.prepare("INSERT INTO goals (name, sessions_per_week, session_minutes, created_at) VALUES ('Semana A-track', 0, 0, ?)").run(Date.now());
  assert.match(prompts()[0], /Semana A-track/);
  assert.equal(journalPayload().prompts.length, 3);
});

test("the evening reminder opens the journal, and not once today's page is written", async () => {
  const list = reminders(Date.now() - 23 * 3_600_000);
  assert.ok(list.some((r: any) => r.key.startsWith("journal:") && r.open === "diario"));
  const today = reminders(Date.now()).filter((r: any) => r.key === `journal:${localDate(Date.now())}`);
  assert.equal(today.length, 0, "today is written (previous test)");
});
