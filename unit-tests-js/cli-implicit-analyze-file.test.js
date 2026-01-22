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

async function stageSampleFile(workspaceRoot, sampleRoot, file, destRoot) {
  const destBase = path.join(workspaceRoot, destRoot);
  await fs.mkdir(destBase, { recursive: true });
  const source = path.join(sampleRoot, file);
  const destination = path.join(destBase, file);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return destination;
}

async function buildBundleFile(bundlePath, entries, { maxLines = 80 } = {}) {
  const blocks = [];
  for (const entry of entries) {
    const raw = await fs.readFile(entry.source, "utf8");
    const lines = raw.split(/\r?\n/).slice(0, maxLines);
    blocks.push(`=== File: ${entry.label} ===`);
    blocks.push(lines.join("\n"));
    blocks.push(`=== End File: ${entry.label} ===`);
    blocks.push("");
  }
  await fs.writeFile(bundlePath, blocks.join("\n").trimEnd(), "utf8");
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

function sanitizeJournalId(raw) {
  if (!raw) {
    return "";
  }
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function loadLatestAnalysis(workspaceRoot, promptJournalId) {
  const miniPhiRoot = await findMiniPhiRoot(workspaceRoot);
  const safeId = sanitizeJournalId(promptJournalId);
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
      assert.ok(step.response, "Prompt journal step is missing a response payload.");
      return JSON.parse(step.response);
    }
  }

  throw new Error("No analyze-file step found in prompt journal.");
}

test(
  "Implicit analyze-file routing works with a samples bundle",
  { timeout: 10 * 60 * 1000 },
  async () => {
    const workspace = await createTempWorkspace();
    try {
      await fs.mkdir(path.join(workspace, ".miniphi"), { recursive: true });
      const sampleRoot = path.resolve("samples", "txt");
      const sampleFile = "romeoAndJuliet-part1.txt";
      const stagedPath = await stageSampleFile(
        workspace,
        sampleRoot,
        sampleFile,
        "romeo",
      );
      const bundlePath = path.join(workspace, "romeo-bundle.txt");
      const bundleLabel = "romeo/romeoAndJuliet-part1.txt";
      await buildBundleFile(
        bundlePath,
        [
          {
            source: stagedPath,
            label: bundleLabel,
          },
        ],
        { maxLines: 40 },
      );

      const prompt = [
        "Analyze the bundled Romeo excerpt.",
        "Return exactly one recommended_fixes entry.",
        `Set files to ["${bundleLabel}"].`,
        "Use file paths exactly as labeled in the bundle.",
        "Do not leave recommended_fixes empty and include non-empty files arrays.",
        "Do not change the file list; keep it exactly as specified.",
      ].join(" ");

      const journalId = `implicit-romeo-${Date.now()}`;
      const result = runCli(
        [
          "Analyze Romeo sample",
          "--file",
          bundlePath,
          "--task",
          prompt,
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
        ],
        { cwd: REPO_ROOT, maxBuffer: 20 * 1024 * 1024 },
      );
      assert.equal(result.code, 0, result.stderr);
      const analysis = await loadLatestAnalysis(workspace, journalId);
      assert.ok(Array.isArray(analysis.recommended_fixes));
      assert.equal(analysis.recommended_fixes.length, 1);
      assert.deepEqual(analysis.recommended_fixes[0].files, [bundleLabel]);
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);
