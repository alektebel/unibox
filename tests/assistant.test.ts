import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { syncQuestions, pending, messages, reply, askAbout } from "../src/assistant.js";
import { localDate } from "../src/planner.js";
import { addItems } from "../src/slate.js";

test("when a planned thing ends, the AI asks about it once, in the one conversation", () => {
  const [ref] = addItems([{ title: "Leer el post de Mastra", action: "read" }]);
  const now = Date.now();
  const id = Number(db.prepare(
    "INSERT INTO plan_slots (date, start, end, ref, kind, title, action, status, created_at) VALUES (?, ?, ?, ?, 'item', 'Leer el post de Mastra', 'read', 'asking', ?)"
  ).run(localDate(now), now - 3_600_000, now - 1_800_000, ref, now).lastInsertRowid);
  assert.equal(syncQuestions(), 1);
  assert.equal(syncQuestions(), 0, "asked once");
  assert.ok(pending().some((p) => p.slotId === id));
  assert.match(messages().at(-1)!.content, /¿Cómo ha ido «Leer el post de Mastra»\?/);
});

test("without the model, your message is kept and nothing is closed by guesswork", async () => {
  const before = pending().length;
  const r = await reply("Leí lo de Mastra, va de agentes en TypeScript");
  assert.equal(r.updates.length, 0);
  assert.equal(pending().length, before);
  const last = messages().slice(-2);
  assert.equal(last[0].role, "user");
  assert.equal(last[1].role, "assistant");
});

test("tapping something makes the AI ask about it", () => {
  const [ref] = addItems([{ title: "Llamar a IMDEA", action: "do" }]);
  askAbout(null, ref);
  assert.match(messages().at(-1)!.content, /«Llamar a IMDEA»/);
});
