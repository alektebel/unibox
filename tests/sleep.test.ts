import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { record, sleepPayload } from "../src/sleep.js";

const H = 3_600_000;

test("a night is kept under the day you woke up, and the same night twice replaces it", () => {
  db.prepare("DELETE FROM sleep").run();
  const wake = Date.now() - H;
  assert.ok(record(wake - 7 * H, wake));
  assert.ok(record(wake - 6 * H, wake));
  const z = sleepPayload();
  assert.equal(z.nights.length, 1);
  assert.equal(z.nights[0].minutes, 360);
});

test("what can't be a night's sleep is refused", () => {
  const now = Date.now();
  assert.equal(record(now - 2 * H, now - H), false, "an hour is a nap");
  assert.equal(record(now - 20 * H, now - H), false, "twenty hours is a phone left alone");
  assert.equal(record(now + H, now + 8 * H), false, "the future");
  assert.equal(record(NaN, now), false);
});

test("the averages and the shortest and longest night", () => {
  db.prepare("DELETE FROM sleep").run();
  const day = 24 * H;
  const wake = Date.now() - H;
  for (const [i, h] of [[0, 8], [1, 5], [2, 7]] as const) record(wake - i * day - h * H, wake - i * day);
  const z = sleepPayload();
  assert.equal(z.avg7, 400);
  assert.equal(z.shortest!.minutes, 300);
  assert.equal(z.longest!.minutes, 480);
});
