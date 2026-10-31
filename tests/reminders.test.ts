import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionDays } from "../src/reminders.js";

test("sessions spread over the week, Monday = 0", () => {
  assert.deepEqual(sessionDays(3), [0, 2, 5]);
  assert.deepEqual(sessionDays(2), [1, 5]);
  assert.deepEqual(sessionDays(1), [0]);
  assert.deepEqual(sessionDays(7), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(sessionDays(0), []);
  assert.equal(sessionDays(5).length, 5);
  assert.equal(sessionDays(12).length, 7);
});
