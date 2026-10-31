import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { render } from "../src/nextrepo.js";
import { addItems } from "../src/slate.js";

test("the next-steps page shows each goal's next part and ticks off what's done", () => {
  const g = Number(db.prepare("INSERT INTO goals (name, due, sessions_per_week, session_minutes, created_at) VALUES ('Semana de prueba', '2099-01-01', 0, 0, ?)").run(Date.now()).lastInsertRowid);
  addItems([
    { title: "Proyecto · etapa 1/3: base", goal: g, priority: 99, done: true },
    { title: "Proyecto · etapa 2/3: hash", goal: g, priority: 98 },
    { title: "Proyecto · etapa 3/3: cache", goal: g, priority: 97 },
  ]);
  const md = render();
  assert.match(md, /## Meta: Semana de prueba/);
  assert.match(md, /1 de 3/);
  assert.match(md, /\*\*Lo siguiente:\*\* Proyecto · etapa 2\/3: hash/);
  assert.match(md, /- \[x\] Proyecto · etapa 1\/3: base/);
  assert.match(md, /- \[ \] Proyecto · etapa 3\/3: cache/);
});
