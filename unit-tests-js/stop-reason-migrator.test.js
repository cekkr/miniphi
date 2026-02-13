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
    await fs.mkdir(path.join(miniPhiRoot, "prompt-exchanges"), { recursive: true });

    const executionPath = path.join(miniPhiRoot, "executions", "demo", "execution.json");
    const fallbackPath = path.join(miniPhiRoot, "indices", "fallback-cache.json");
    const promptExchangePath = path.join(miniPhiRoot, "prompt-exchanges", "legacy.json");
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
    const originalPromptExchange = {
      id: "legacy",
      request: {
        messages: [{ role: "user", content: "hello" }],
      },
      response: {
        rawResponseText: "{\"ok\":true}",
      },
    };
    await fs.writeFile(executionPath, `${JSON.stringify(originalExecution, null, 2)}\n`, "utf8");
    await fs.writeFile(fallbackPath, `${JSON.stringify(originalFallback, null, 2)}\n`, "utf8");
    await fs.writeFile(
      promptExchangePath,
      `${JSON.stringify(originalPromptExchange, null, 2)}\n`,
      "utf8",
    );

    const dryRun = await migrateStopReasonArtifacts({ baseDir: miniPhiRoot, dryRun: true });
    assert.equal(dryRun.filesChanged, 3);
    assert.equal(dryRun.writeErrors, 0);
    const dryExecution = JSON.parse(await fs.readFile(executionPath, "utf8"));
    assert.equal(dryExecution.stopReasonCode, "analysis-error");
    const dryPromptExchange = JSON.parse(await fs.readFile(promptExchangePath, "utf8"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(dryPromptExchange.request, "tool_definitions"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(dryPromptExchange.response, "tool_calls"),
      false,
    );

    const applied = await migrateStopReasonArtifacts({ baseDir: miniPhiRoot, dryRun: false });
    assert.equal(applied.filesChanged, 3);
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

    const migratedPromptExchange = JSON.parse(await fs.readFile(promptExchangePath, "utf8"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(migratedPromptExchange.request, "tool_definitions"),
      true,
    );
    assert.equal(migratedPromptExchange.request.tool_definitions, null);
    assert.equal(
      Object.prototype.hasOwnProperty.call(migratedPromptExchange.response, "tool_calls"),
      true,
    );
    assert.equal(migratedPromptExchange.response.tool_calls, null);
    assert.equal(
      Object.prototype.hasOwnProperty.call(migratedPromptExchange.response, "tool_definitions"),
      true,
    );
    assert.equal(migratedPromptExchange.response.tool_definitions, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("migrateStopReasonArtifacts reports malformed JSON paths and supports parse fail-fast", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-stop-migrator-parse-"));
  try {
    const miniPhiRoot = path.join(root, ".miniphi");
    await fs.mkdir(path.join(miniPhiRoot, "indices"), { recursive: true });
    await fs.writeFile(path.join(miniPhiRoot, "indices", "01-bad.json"), "{ bad json", "utf8");
    await fs.writeFile(path.join(miniPhiRoot, "indices", "02-bad.json"), "{ also bad", "utf8");
    await fs.writeFile(
      path.join(miniPhiRoot, "indices", "03-good.json"),
      `${JSON.stringify({ status: "ok" }, null, 2)}\n`,
      "utf8",
    );

    const fullScan = await migrateStopReasonArtifacts({ baseDir: miniPhiRoot, dryRun: true });
    assert.equal(fullScan.parseErrors, 2);
    assert.deepEqual(fullScan.parseErrorFiles, ["indices/01-bad.json", "indices/02-bad.json"]);

    const strictScan = await migrateStopReasonArtifacts({
      baseDir: miniPhiRoot,
      dryRun: true,
      failFastOnParseError: true,
    });
    assert.equal(strictScan.parseErrors, 1);
    assert.deepEqual(strictScan.parseErrorFiles, ["indices/01-bad.json"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
