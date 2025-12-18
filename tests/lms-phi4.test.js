import test from "node:test";
import assert from "node:assert/strict";

test("lms-phi4 module exports are importable", async () => {
  const module = await import("../src/libs/lms-phi4.js");
  assert.equal(typeof module.default, "function");
  assert.equal(typeof module.LMStudioProtocolError, "function");
});

