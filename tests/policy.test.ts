import { test } from "node:test";
import assert from "node:assert/strict";
// goals and focus_blocks tables are created by the phone module
import "../src/mobile.js";
import { policy, activeWindow, type Policy, type Window } from "../src/policy.js";

const w = (kind: Window["kind"], start: number, end: number): Window =>
  ({ key: kind, start, end, title: kind, kind, hard: false, mode: "allow", list: [] });
const p = (windows: Window[]): Policy =>
  ({ generatedAt: 0, essentials: [], distractions: [], windows, frictionSeconds: 60, hardFrictionSeconds: 300, passMinutes: 10 });

test("the most specific window wins when they overlap", () => {
  const ws = [w("work", 0, 100), w("session", 10, 20), w("focus", 15, 30)];
  assert.equal(activeWindow(p(ws), 5)?.kind, "work");
  assert.equal(activeWindow(p(ws), 12)?.kind, "session");
  assert.equal(activeWindow(p(ws), 16)?.kind, "focus");
  assert.equal(activeWindow(p(ws), 100), null);
});

test("night crosses midnight and still holds in the early morning", () => {
  const at = (s: string) => new Date(s).getTime();
  const nights = policy(at("2026-10-21T03:00:00")).windows.filter((x) => x.kind === "night");
  assert.ok(nights.some((n) => n.start <= at("2026-10-21T03:00:00") && at("2026-10-21T03:00:00") < n.end));
});

test("work hours are weekdays only", () => {
  const sat = new Date("2026-10-24T12:00:00").getTime();
  assert.equal(activeWindow(policy(sat), sat)?.kind ?? null, null);
});

test("a planned gap is a suggestion: it never becomes a window that blocks", async () => {
  const { db } = await import("../src/db.js");
  const { localDate } = await import("../src/planner.js");
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(20, 0, 0, 0);
  db.prepare("INSERT INTO plan_slots (date, start, end, ref, kind, title, action, url, status, created_at) VALUES (?, ?, ?, 'ref-sugg', 'item', 'slot read', 'read', 'https://example.org', 'planned', ?)")
    .run(localDate(d.getTime()), d.getTime(), d.getTime() + 30 * 60_000, Date.now());
  const p = policy(Date.now());
  assert.ok(!p.windows.some((w) => w.kind === "plan"));
});
