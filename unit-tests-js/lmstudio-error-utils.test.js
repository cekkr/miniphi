import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStopReasonInfo,
  classifyLmStudioError,
  getLmStudioStopReasonLabel,
  isSessionTimeoutMessage,
  normalizeStopReasonCode,
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

test("buildStopReasonInfo aligns conflicting code to canonical reason", () => {
  const info = buildStopReasonInfo({
    fallbackReason: "session-timeout",
    fallbackCode: "fallback",
    fallbackDetail: "session timeout happened",
  });
  assert.equal(info.reason, "session-timeout");
  assert.equal(info.code, "session-timeout");
});

test("buildStopReasonInfo prefers explicit error detail over placeholder fallback detail", () => {
  const info = buildStopReasonInfo({
    error: "session-timeout: session deadline exceeded.",
    fallbackReason: "session-timeout",
    fallbackCode: "analysis-error",
    fallbackDetail: "analysis-error",
  });
  assert.equal(info.reason, "session-timeout");
  assert.equal(info.code, "session-timeout");
  assert.equal(info.detail, "session-timeout: session deadline exceeded.");
});

test("classifyLmStudioError flags invalid-response variants", () => {
  const info = classifyLmStudioError("response body was empty");
  assert.equal(info.code, "invalid-response");
  assert.equal(info.reason, "invalid-response");
  assert.equal(info.reasonLabel, "Invalid response");
  assert.equal(info.isInvalidResponse, true);
});

test("classifyLmStudioError normalizes connection/network labels", () => {
  const connection = classifyLmStudioError("ECONNREFUSED 127.0.0.1");
  assert.equal(connection.code, "connection");
  assert.equal(connection.reason, "connection");
  assert.equal(connection.reasonLabel, "Connection error");
  const timeout = classifyLmStudioError("request timed out after 10s");
  assert.equal(timeout.code, "timeout");
  assert.equal(timeout.reasonLabel, "Timeout");
});

test("stop reason helpers normalize aliases", () => {
  assert.equal(normalizeStopReasonCode("connection error"), "connection");
  assert.equal(normalizeStopReasonCode("session timeout"), "session-timeout");
  assert.equal(normalizeStopReasonCode("invalid-json"), "invalid-response");
  assert.equal(normalizeStopReasonCode("partial-fallback"), "analysis-error");
  assert.equal(normalizeStopReasonCode("completed"), null);
  assert.equal(normalizeStopReasonCode("totally-unknown-reason"), "analysis-error");
  assert.equal(getLmStudioStopReasonLabel("session-timeout"), "Session timeout");
  assert.equal(getLmStudioStopReasonLabel("preamble_detected"), "Preamble detected");
});
