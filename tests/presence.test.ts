import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/mobile.js";
import { db } from "../src/db.js";
import { record, learnedHours, workHoursFor, pendingQuestion, answerQuestion, current } from "../src/presence.js";

const at = (d: Date, h: number, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
// the last few Wednesdays
function wednesdays(n: number): Date[] {
  const out: Date[] = [];
  const d = new Date(); d.setHours(12, 0, 0, 0);
  while (out.length < n) { d.setDate(d.getDate() - 1); if (d.getDay() === 3) out.push(new Date(d)); }
  return out;
}

test("a network seen on weekdays during the day gets one question, then a label", () => {
  db.exec("DELETE FROM presence");
  const now = Date.now();
  const days = [1, 2].map((k) => now - k * 86_400_000).filter((t) => [1, 2, 3, 4, 5].includes(new Date(t).getDay()));
  for (const d of days) for (const h of [10, 12, 15]) db.prepare("INSERT INTO presence (at, net, ssid) VALUES (?, 'IMDEA-WiFi', 'IMDEA-WiFi')").run(at(new Date(d), h));
  record({ net: "IMDEA-WiFi", ssid: "IMDEA-WiFi" }, now);
  const q = pendingQuestion(now);
  if (days.length) {
    assert.equal(q?.net, "IMDEA-WiFi");
    answerQuestion("IMDEA-WiFi", "work");
    assert.equal(pendingQuestion(now), null);
    assert.equal(current(now).state, "work");
  }
});

test("work hours are learned per weekday from where you were", () => {
  db.exec("DELETE FROM presence");
  answerQuestion("IMDEA-WiFi", "work");
  for (const d of wednesdays(3)) {
    for (const [h, m] of [[9, 40], [11, 0], [14, 0], [18, 10]]) db.prepare("INSERT INTO presence (at, net) VALUES (?, 'IMDEA-WiFi')").run(at(d, h, m));
  }
  const h = learnedHours(2);
  assert.ok(h, "learned something for Wednesday");
  assert.ok(Math.abs(h![0] - 9.67) < 0.1 && Math.abs(h![1] - 18.17) < 0.1, `got ${h}`);
  assert.equal(learnedHours(0), null, "nothing for Monday");
});

test("at home in the middle of work hours: the rest of today isn't work", () => {
  db.exec("DELETE FROM presence");
  answerQuestion("Casa-5G", "home");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isWeekday = [1, 2, 3, 4, 5].includes(today.getDay());
  const noon = at(today, 12);
  db.prepare("INSERT INTO presence (at, net) VALUES (?, 'Casa-5G')").run(noon);
  const wh = workHoursFor(today.getTime(), noon + 60_000);
  if (isWeekday) assert.equal(wh, "09:00-12:01");
  else assert.equal(wh, null);
});
