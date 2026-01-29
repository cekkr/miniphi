import test from "node:test";
import assert from "node:assert/strict";
import { shouldForceFastMode } from "../src/libs/core-utils.js";

test("shouldForceFastMode returns true when session timeout is <= prompt timeout", () => {
  assert.equal(
    shouldForceFastMode({
      sessionTimeoutMs: 300000,
      promptTimeoutMs: 300000,
      mode: "run",
    }),
    true,
  );
});

test("shouldForceFastMode returns false when session timeout exceeds prompt timeout", () => {
  assert.equal(
    shouldForceFastMode({
      sessionTimeoutMs: 600000,
      promptTimeoutMs: 300000,
      mode: "analyze-file",
    }),
    false,
  );
});

test("shouldForceFastMode ignores unsupported modes", () => {
  assert.equal(
    shouldForceFastMode({
      sessionTimeoutMs: 300000,
      promptTimeoutMs: 300000,
      mode: "recompose",
    }),
    false,
  );
});

test("shouldForceFastMode returns false when inputs are missing", () => {
  assert.equal(shouldForceFastMode({ sessionTimeoutMs: null, promptTimeoutMs: 300000 }), false);
  assert.equal(shouldForceFastMode({ sessionTimeoutMs: 300000, promptTimeoutMs: null }), false);
});
