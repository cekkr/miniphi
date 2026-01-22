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

function sanitizeJournalId(raw) {
  if (!raw) {
    return "";
  }
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

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
      // ignore missing dirs
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return path.join(startDir, ".miniphi");
}

async function loadPromptExchangePath(workspaceRoot, promptJournalId) {
  const safeId = sanitizeJournalId(promptJournalId);
  const miniPhiRoot = await findMiniPhiRoot(workspaceRoot);
  const sessionDir = path.join(miniPhiRoot, "prompt-exchanges", "stepwise", safeId);
  const sessionPath = path.join(sessionDir, "session.json");
  const session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  const stepsDir = path.join(sessionDir, "steps");
  const steps = session.steps ?? 0;
  assert.ok(steps > 0, "Prompt journal has no recorded steps.");

  for (let sequence = steps; sequence >= 1; sequence -= 1) {
    const stepPath = path.join(stepsDir, `step-${String(sequence).padStart(3, "0")}.json`);
    const step = JSON.parse(await fs.readFile(stepPath, "utf8"));
    if (typeof step.label === "string" && step.label.startsWith("analyze-file:")) {
      const link = step.links?.promptExchangePath ?? null;
      assert.ok(link, "Prompt exchange link missing from journal step.");
      return path.isAbsolute(link) ? link : path.join(miniPhiRoot, link);
    }
  }

  throw new Error("No analyze-file step found in prompt journal.");
}

test(
  "MiniPhi RL router annotates prompt exchanges with routing metadata",
  { timeout: 12 * 60 * 1000 },
  async () => {
    const workspace = await createTempWorkspace();
    try {
      const samplePath = path.resolve("samples", "txt", "romeoAndJuliet-part1.txt");
      const filePath = path.join(workspace, "romeo.txt");
      await fs.copyFile(samplePath, filePath);

      const journalId = `rl-routing-${Date.now()}`;
      const result = runCli(
        [
          "analyze-file",
          "--file",
          filePath,
          "--task",
          "Summarize the romeo sample in JSON.",
          "--summary-levels",
          "1",
          "--no-stream",
          "--no-summary",
          "--prompt-journal",
          journalId,
          "--prompt-journal-status",
          "paused",
          "--session-timeout",
          "600",
          "--rl-router",
        ],
        { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024 },
      );
      assert.equal(result.code, 0, result.stderr);

      const exchangePath = await loadPromptExchangePath(workspace, journalId);
      const exchange = JSON.parse(await fs.readFile(exchangePath, "utf8"));
      assert.ok(exchange.metadata?.routing, "Routing metadata missing from prompt exchange.");
      assert.ok(
        typeof exchange.metadata.routing.model === "string" &&
          exchange.metadata.routing.model.length > 0,
        "Routing model metadata missing.",
      );
      assert.ok(
        typeof exchange.metadata.routing.action === "string" &&
          exchange.metadata.routing.action.length > 0,
        "Routing action metadata missing.",
      );
      assert.equal(
        typeof exchange.response?.schemaValidation?.valid,
        "boolean",
        "Schema validation metadata missing.",
      );
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);
