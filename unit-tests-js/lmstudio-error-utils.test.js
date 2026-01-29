import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStopReasonInfo,
  classifyLmStudioError,
  isSessionTimeoutMessage,
} from "../src/libs/lmstudio-error-utils.js";

test("isSessionTimeoutMessage detects session timeout variants", () => {
  assert.equal(isSessionTimeoutMessage("session-timeout: session deadline exceeded."), true);
  assert.equal(isSessionTimeoutMessage("Session timeout while waiting for model."), true);
  assert.equal(isSessionTimeoutMessage("timeout"), false);
});

test("buildStopReasonInfo preserves fallback reason and populates detail", () => {
  const info = buildStopReasonInfo({
    error: "no valid JSON returned",
    fallbackReason: "invalid-response",
  });
  assert.equal(info.reason, "invalid-response");
  assert.equal(info.code, "invalid-response");
  assert.ok(info.detail);
});

test("buildStopReasonInfo prefers session-timeout classification", () => {
  const info = buildStopReasonInfo({
    error: "session-timeout: session deadline exceeded.",
  });
  assert.equal(info.reason, "session-timeout");
  assert.equal(info.code, "session-timeout");
});

test("classifyLmStudioError flags invalid-response variants", () => {
  const info = classifyLmStudioError("response body was empty");
  assert.equal(info.code, "invalid-response");
  assert.equal(info.isInvalidResponse, true);
});
