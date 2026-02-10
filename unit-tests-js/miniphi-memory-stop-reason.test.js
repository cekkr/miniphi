import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import MiniPhiMemory from "../src/libs/miniphi-memory.js";

test("MiniPhiMemory canonicalizes stop reasons in persisted writers", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-stop-memory-"));
  try {
    const memory = new MiniPhiMemory(workspace);
    await memory.prepare();

    const execution = await memory.persistExecutionStop({
      mode: "run",
      task: "Stop reason normalization test",
      status: "failed",
      stopReason: "partial-fallback",
      stopReasonCode: "fallback",
      stopReasonDetail: "legacy fallback marker",
    });
    const executionPayload = JSON.parse(
      await fs.readFile(path.join(execution.path, "execution.json"), "utf8"),
    );
    assert.equal(executionPayload.stopReason, "analysis-error");
    assert.equal(executionPayload.stopReasonCode, "analysis-error");
    assert.equal(executionPayload.stopReasonDetail, "legacy fallback marker");

    const normalizedFromError = await memory.persistExecutionStop({
      mode: "run",
      task: "Stop reason detail should prefer explicit error text",
      status: "failed",
      stopReason: "session-timeout",
      stopReasonCode: "analysis-error",
      stopReasonDetail: "analysis-error",
      error: "session-timeout: session deadline exceeded.",
    });
    const normalizedPayload = JSON.parse(
      await fs.readFile(path.join(normalizedFromError.path, "execution.json"), "utf8"),
    );
    assert.equal(normalizedPayload.stopReason, "session-timeout");
    assert.equal(normalizedPayload.stopReasonCode, "session-timeout");
    assert.equal(
      normalizedPayload.stopReasonDetail,
      "session-timeout: session deadline exceeded.",
    );

    const nitpick = await memory.saveNitpickSession({
      task: "Nitpick stop reason normalization",
      mode: "nitpick",
      finalText: "Draft output",
      stopReason: "partial-fallback",
      stopReasonCode: "fallback",
      stopReasonDetail: "legacy fallback marker",
    });
    const nitpickPayload = JSON.parse(await fs.readFile(nitpick.path, "utf8"));
    assert.equal(nitpickPayload.stopReason, "analysis-error");
    assert.equal(nitpickPayload.stopReasonCode, "analysis-error");
    assert.equal(nitpickPayload.stopReasonDetail, "legacy fallback marker");

    await memory.saveFallbackSummary({
      datasetHash: "dataset-hash-1",
      analysis: '{"summary":"fallback"}',
      reason: "Phi fallback",
    });
    const fallback = await memory.loadFallbackSummary({ datasetHash: "dataset-hash-1" });
    assert.equal(fallback.reason, "analysis-error");
    assert.equal(fallback.reasonCode, "analysis-error");
    assert.equal(fallback.reasonDetail, "Phi fallback");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
