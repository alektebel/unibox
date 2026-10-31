import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import "../src/mobile.js";
import { setMeta, getMeta } from "../src/db.js";
import { newLink, guardHash } from "../src/guardian.js";

test("a guardian link is one-time, and a new one needs the current code", () => {
  setMeta("guard_hash", "");
  const first = newLink(undefined, "https://x.test/");
  assert.match(first!, /^https:\/\/x\.test\/guardian\/[a-f0-9]{48}$/);
  // the guardian sets their code
  setMeta("guard_hash", crypto.createHash("sha256").update("12345678").digest("hex"));
  assert.equal(newLink(undefined, "https://x.test"), null, "the owner can't make a new link alone");
  assert.equal(newLink("00000000", "https://x.test"), null);
  assert.ok(newLink("12345678", "https://x.test"), "with the guardian's code, yes");
  assert.equal(guardHash(), getMeta("guard_hash"));
});
