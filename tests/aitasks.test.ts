import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { aiKind, adoptAiItems } from "../src/aitasks.js";
import { addItems } from "../src/slate.js";
import { candidates } from "../src/planner.js";

test("what the AI does itself: calendar entries and reminders", () => {
  assert.equal(aiKind("Anotar en el calendario la cita de Adeslas: 26 abr 2027, 10:00, Alcorcón"), "calendar");
  assert.equal(aiKind("Apúntame en la agenda la cena del viernes"), "calendar");
  assert.equal(aiKind("Recuérdame llamar a mamá el domingo a las 12"), "reminder");
  assert.equal(aiKind("Leer The Future of the Professions, cap. 3"), null);
  assert.equal(aiKind("Revisar el calendario de exámenes"), null);
});

test("those leave your list for the AI's queue and are never planned", () => {
  const [id] = addItems([{ title: "Anotar en el calendario la revisión del coche el 3 de noviembre a las 9" }]);
  assert.ok(adoptAiItems() >= 1);
  assert.equal((db.prepare("SELECT state FROM items WHERE id = ?").get(id) as any).state, "ai");
  assert.ok(!candidates(Date.now()).some((c) => c.ref === id));
});
