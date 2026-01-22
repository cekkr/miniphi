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

async function stageSampleFiles(workspaceRoot, sampleRoot, files, destRoot) {
  const destBase = path.join(workspaceRoot, destRoot);
  await fs.mkdir(destBase, { recursive: true });
  for (const file of files) {
    const source = path.join(sampleRoot, file);
    const destination = path.join(destBase, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  return destBase;
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

function assertReferencedFiles(result, expectedFiles) {
  assert.ok(result && typeof result === "object");
  assert.ok(Array.isArray(result.recommended_fixes));
  assert.ok(result.recommended_fixes.length >= 2);
  const referenced = new Set();
  for (const fix of result.recommended_fixes) {
    assert.ok(Array.isArray(fix.files));
    assert.ok(fix.files.length > 0);
    fix.files.forEach((file) => referenced.add(file));
  }
  expectedFiles.forEach((file) => {
    assert.ok(referenced.has(file), `Expected file missing from fixes: ${file}`);
  });
}

test(
  "MiniPhi get-started sample covers multiple JS files",
  { timeout: 10 * 60 * 1000 },
  async () => {
    const workspace = await createTempWorkspace();
    try {
      await fs.mkdir(path.join(workspace, ".miniphi"), { recursive: true });
      const sampleRoot = path.resolve("samples", "get-started", "code");
      const files = [
        path.join("src", "index.js"),
        path.join("src", "system-info.js"),
        path.join("src", "project-readme.js"),
      ];
      const stagedRoot = await stageSampleFiles(
        workspace,
        sampleRoot,
        files,
        "get-started",
      );
      const bundlePath = path.join(workspace, "get-started-bundle.txt");
      await buildBundleFile(
        bundlePath,
        files.map((file) => ({
          source: path.join(stagedRoot, file),
          label: `get-started/${file.replace(/\\/g, "/")}`,
        })),
        { maxLines: 40 },
      );

      const prompt = [
        "Analyze the bundled get-started excerpts.",
        "Return exactly two recommended_fixes entries.",
        "For fix 1, set files to [\"get-started/src/index.js\", \"get-started/src/system-info.js\"].",
        "For fix 2, set files to [\"get-started/src/system-info.js\", \"get-started/src/project-readme.js\"].",
        "Use file paths exactly as labeled in the bundle.",
        "Do not leave recommended_fixes empty and include non-empty files arrays.",
        "Do not change the file lists; keep them exactly as specified.",
      ].join(" ");

      const journalId = `get-started-${Date.now()}`;
      const result = runCli(
        [
          "analyze-file",
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
      assertReferencedFiles(analysis, [
        "get-started/src/index.js",
        "get-started/src/system-info.js",
        "get-started/src/project-readme.js",
      ]);
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);
