import test from "node:test";
import assert from "node:assert/strict";
import { resolveSessionCappedTimeoutMs } from "../src/libs/runtime-defaults.js";

test("resolveSessionCappedTimeoutMs returns base timeout without session deadline", () => {
  const timeout = resolveSessionCappedTimeoutMs({
    baseTimeoutMs: 15000,
    sessionDeadline: null,
  });
  assert.equal(timeout, 15000);
});

test("resolveSessionCappedTimeoutMs caps timeout by session budget", () => {
  const now = Date.now();
  const timeout = resolveSessionCappedTimeoutMs({
    baseTimeoutMs: 60000,
    sessionDeadline: now + 20000,
    budgetRatio: 0.4,
    capMs: 120000,
    minTimeoutMs: 1000,
  });
  assert.ok(timeout <= 8000 && timeout >= 1000);
});

test("resolveSessionCappedTimeoutMs throws on expired session deadline", () => {
  assert.throws(
    () =>
      resolveSessionCappedTimeoutMs({
        baseTimeoutMs: 10000,
        sessionDeadline: Date.now() - 1,
      }),
    /session-timeout/i,
  );
});
