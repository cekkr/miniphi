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

async function findMiniPhiRoot(startDir) {
  let current = path.resolve(startDir);
  const { root } = path.parse(current);
  while (true) {
    const candidate = path.join(current, ".miniphi");
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // ignore missing folders
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return path.join(startDir, ".miniphi");
}

test(
  "Implicit run routing honors free-form task + --cmd and records canonical stop reason",
  { timeout: 3 * 60 * 1000 },
  async () => {
    const workspace = await createTempWorkspace("miniphi-cli-implicit-run-");
    try {
      await fs.mkdir(path.join(workspace, ".miniphi"), { recursive: true });
      const result = runCli(
        [
          "Summarize node version output with implicit routing",
          "--cmd",
          "node -v",
          "--no-stream",
          "--no-summary",
          "--cwd",
          workspace,
          "--prompt-journal",
          `implicit-run-${Date.now()}`,
          "--prompt-journal-status",
          "paused",
          "--session-timeout",
          "1",
          "--command-policy",
          "allow",
          "--assume-yes",
        ],
        { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024 },
      );
      assert.ok(
        result.code === 0 || result.code === 1,
        `Unexpected exit code ${result.code}. stderr=${result.stderr}`,
      );

      const miniPhiRoot = await findMiniPhiRoot(workspace);
      const indexPath = path.join(miniPhiRoot, "indices", "executions-index.json");
      const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
      assert.ok(Array.isArray(index.entries) && index.entries.length > 0);
      const latest = index.entries[0];
      assert.equal(latest.mode, "run");
      assert.equal(
        latest.task,
        "Summarize node version output with implicit routing",
      );
      if (latest.stopReason !== null) {
        assert.match(
          latest.stopReason,
          /^(session-timeout|timeout|analysis-error|invalid-response|rest-failure|connection|network|protocol|context-overflow|cached-fallback|preamble_detected)$/,
        );
      }
      if (latest.stopReasonCode !== null) {
        assert.match(
          latest.stopReasonCode,
          /^(session-timeout|timeout|analysis-error|invalid-response|rest-failure|connection|network|protocol|context-overflow|cached-fallback|preamble_detected)$/,
        );
      }
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);
