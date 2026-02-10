import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempWorkspace,
  removeTempWorkspace,
  runCli,
} from "./cli-test-utils.js";

const REPO_ROOT = path.resolve(process.cwd());

test("CLI migrate-stop-reasons command supports dry-run and apply modes", async () => {
  const workspace = await createTempWorkspace("miniphi-cli-migrate-stop-");
  try {
    const miniPhiRoot = path.join(workspace, ".miniphi");
    const executionDir = path.join(miniPhiRoot, "executions", "legacy-demo");
    await fs.mkdir(executionDir, { recursive: true });
    const executionPath = path.join(executionDir, "execution.json");
    const payload = {
      mode: "run",
      task: "legacy stop reason",
      stopReason: "session-timeout",
      stopReasonCode: "analysis-error",
      stopReasonDetail: "analysis-error",
      error: "session-timeout: session deadline exceeded.",
    };
    await fs.writeFile(executionPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const dryRun = runCli(
      [
        "migrate-stop-reasons",
        "--history-root",
        workspace,
        "--dry-run",
        "--json",
      ],
      { cwd: REPO_ROOT },
    );
    assert.equal(dryRun.code, 0, `Dry-run failed: ${dryRun.stderr}`);
    const drySummary = JSON.parse(dryRun.stdout);
    assert.equal(drySummary.totals.filesChanged >= 1, true);
    let persisted = JSON.parse(await fs.readFile(executionPath, "utf8"));
    assert.equal(persisted.stopReasonCode, "analysis-error");

    const apply = runCli(
      [
        "migrate-stop-reasons",
        "--history-root",
        workspace,
        "--json",
      ],
      { cwd: REPO_ROOT },
    );
    assert.equal(apply.code, 0, `Apply run failed: ${apply.stderr}`);
    const applySummary = JSON.parse(apply.stdout);
    assert.equal(applySummary.totals.filesChanged >= 1, true);
    persisted = JSON.parse(await fs.readFile(executionPath, "utf8"));
    assert.equal(persisted.stopReason, "session-timeout");
    assert.equal(persisted.stopReasonCode, "session-timeout");
    assert.equal(persisted.stopReasonDetail, "session-timeout: session deadline exceeded.");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("CLI migrate-stop-reasons strict mode fails on malformed JSON and reports paths in JSON output", async () => {
  const workspace = await createTempWorkspace("miniphi-cli-migrate-stop-strict-");
  try {
    const miniPhiRoot = path.join(workspace, ".miniphi");
    await fs.mkdir(path.join(miniPhiRoot, "indices"), { recursive: true });
    await fs.writeFile(path.join(miniPhiRoot, "indices", "bad.json"), "{ malformed", "utf8");

    const strictRun = runCli(
      [
        "migrate-stop-reasons",
        "--history-root",
        workspace,
        "--strict",
        "--parse-error-report",
        "--json",
      ],
      { cwd: REPO_ROOT },
    );
    assert.equal(strictRun.code, 1, "Strict mode must fail on parse errors.");
    const summary = JSON.parse(strictRun.stdout);
    assert.equal(summary.strict, true);
    assert.equal(summary.totals.parseErrors, 1);
    assert.equal(Array.isArray(summary.parseErrorFiles), true);
    assert.equal(
      summary.parseErrorFiles.some((entry) =>
        entry.replace(/\\/g, "/").endsWith("/.miniphi/indices/bad.json"),
      ),
      true,
      `Missing malformed path in parseErrorFiles: ${strictRun.stdout}`,
    );
    assert.match(strictRun.stderr, /strict mode failed/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("CLI migrate-stop-reasons parse-error-report prints malformed JSON paths in human output", async () => {
  const workspace = await createTempWorkspace("miniphi-cli-migrate-stop-report-");
  try {
    const miniPhiRoot = path.join(workspace, ".miniphi");
    await fs.mkdir(path.join(miniPhiRoot, "indices"), { recursive: true });
    await fs.writeFile(path.join(miniPhiRoot, "indices", "broken.json"), "{ malformed", "utf8");

    const reportRun = runCli(
      [
        "migrate-stop-reasons",
        "--history-root",
        workspace,
        "--parse-error-report",
      ],
      { cwd: REPO_ROOT },
    );
    assert.equal(reportRun.code, 0, `Report run failed: ${reportRun.stderr}`);
    assert.match(reportRun.stdout, /malformed JSON files/i);
    assert.match(reportRun.stdout.replace(/\\/g, "/"), /\/\.miniphi\/indices\/broken\.json/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
