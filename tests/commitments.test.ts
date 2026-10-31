import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { commitmentsBetween } from "../src/commitments.js";
import { planPayload } from "../src/planner.js";

test("what a message commits you to shows in today's five at its time", () => {
  const now = Date.now();
  const start = now + 90 * 60_000;
  const end = new Date(now); end.setHours(23, 59, 0, 0);
  if (start + 60 * 60_000 > end.getTime()) return; // too late in the day to test "later today"
  db.prepare("INSERT INTO commitments (source, ref, title, start, end, location, created_at) VALUES ('whatsapp', 'ana', 'Cena con Ana', ?, ?, 'Lamucca', ?)")
    .run(start, start + 60 * 60_000, now);
  assert.equal(commitmentsBetween(now, now + 86_400_000).length, 1);
  const top = planPayload(now).top;
  const c = top.find((x: any) => x.kind === "commitment");
  assert.ok(c, "commitment among the five");
  assert.equal(c.start, start);
  assert.match(c.why, /WhatsApp · Lamucca/);
});
