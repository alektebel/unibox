import { test } from "node:test";
import assert from "node:assert/strict";
import { startChat, addTurn, openChat, closeChat, turns } from "../src/chats.js";

test("a goal conversation is kept turn by turn and resumes until it's closed", () => {
  const id = startChat("goal-test");
  addTurn(id, "user", "Quiero aprobar AWS antes de marzo");
  addTurn(id, "assistant", "¿Cuántas horas por semana?");
  addTurn(id, "user", "5");
  addTurn(id, "assistant", "Trabajando hacia atrás:", { plan: { name: "AWS" } });
  const open = openChat("goal-test");
  assert.equal(open?.id, id);
  assert.equal(open?.turns.length, 4);
  assert.equal(open?.turns[3].data.plan.name, "AWS");
  closeChat(id, "done", { goalId: 1 });
  assert.equal(openChat("goal-test"), null);
  // closed, but still there
  assert.equal(turns(id).length, 4);
});
