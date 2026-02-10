import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateStopReasonArtifacts } from "../src/libs/stop-reason-migrator.js";

test("migrateStopReasonArtifacts normalizes legacy stop reason fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-stop-migrator-"));
  try {
    const miniPhiRoot = path.join(root, ".miniphi");
    await fs.mkdir(path.join(miniPhiRoot, "executions", "demo"), { recursive: true });
    await fs.mkdir(path.join(miniPhiRoot, "indices"), { recursive: true });

    const executionPath = path.join(miniPhiRoot, "executions", "demo", "execution.json");
    const fallbackPath = path.join(miniPhiRoot, "indices", "fallback-cache.json");
    const originalExecution = {
      stopReason: "session-timeout",
      stopReasonCode: "analysis-error",
      stopReasonDetail: "analysis-error",
      error: "session-timeout: session deadline exceeded.",
      nested: {
        error: {
          stop_reason: "partial-fallback",
          stop_reason_code: "fallback",
          stop_reason_detail: "legacy fallback marker",
        },
      },
    };
    const originalFallback = {
      entries: [
        {
          key: "dataset::journal",
          reason: "partial-fallback",
          reasonCode: "fallback",
          reasonDetail: "legacy fallback marker",
        },
      ],
    };
    await fs.writeFile(executionPath, `${JSON.stringify(originalExecution, null, 2)}\n`, "utf8");
    await fs.writeFile(fallbackPath, `${JSON.stringify(originalFallback, null, 2)}\n`, "utf8");

    const dryRun = await migrateStopReasonArtifacts({ baseDir: miniPhiRoot, dryRun: true });
    assert.equal(dryRun.filesChanged, 2);
    assert.equal(dryRun.writeErrors, 0);
    const dryExecution = JSON.parse(await fs.readFile(executionPath, "utf8"));
    assert.equal(dryExecution.stopReasonCode, "analysis-error");

    const applied = await migrateStopReasonArtifacts({ baseDir: miniPhiRoot, dryRun: false });
    assert.equal(applied.filesChanged, 2);
    assert.equal(applied.writeErrors, 0);
    assert.ok(applied.objectsUpdated >= 2);

    const migratedExecution = JSON.parse(await fs.readFile(executionPath, "utf8"));
    assert.equal(migratedExecution.stopReason, "session-timeout");
    assert.equal(migratedExecution.stopReasonCode, "session-timeout");
    assert.equal(
      migratedExecution.stopReasonDetail,
      "session-timeout: session deadline exceeded.",
    );
    assert.equal(migratedExecution.nested.error.stop_reason, "analysis-error");
    assert.equal(migratedExecution.nested.error.stop_reason_code, "analysis-error");
    assert.equal(
      migratedExecution.nested.error.stop_reason_detail,
      "legacy fallback marker",
    );

    const migratedFallback = JSON.parse(await fs.readFile(fallbackPath, "utf8"));
    assert.equal(migratedFallback.entries[0].reason, "analysis-error");
    assert.equal(migratedFallback.entries[0].reasonCode, "analysis-error");
    assert.equal(migratedFallback.entries[0].reasonDetail, "legacy fallback marker");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

