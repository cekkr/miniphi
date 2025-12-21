import test from "node:test";
import assert from "node:assert/strict";

test("lmstudio-handler module exports are importable", async () => {
  const module = await import("../src/libs/lmstudio-handler.js");
  assert.equal(typeof module.default, "function");
  assert.equal(typeof module.LMStudioProtocolError, "function");
});

test("lms-phi4 legacy alias exports are importable", async () => {
  const legacyModule = await import("../src/libs/lms-phi4.js");
  assert.equal(typeof legacyModule.default, "function");
  assert.equal(typeof legacyModule.LMStudioProtocolError, "function");
});
