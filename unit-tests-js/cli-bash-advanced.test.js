import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempWorkspace,
  removeTempWorkspace,
  runCli,
} from "./cli-test-utils.js";

const LIVE_ENABLED = ["1", "true", "yes"].includes(
  (process.env.MINIPHI_LIVE ?? "").toLowerCase(),
);
const maybeTest = LIVE_ENABLED ? test : test.skip;

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

async function loadLatestAnalysis(workspaceRoot) {
  const indexPath = path.join(workspaceRoot, ".miniphi", "indices", "executions-index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const latest = index.entries?.[0];
  assert.ok(latest?.id, "No execution entry found in index.");
  const analysisPath = path.join(
    workspaceRoot,
    ".miniphi",
    "executions",
    latest.id,
    "analysis.json",
  );
  const analysisPayload = JSON.parse(await fs.readFile(analysisPath, "utf8"));
  assert.ok(analysisPayload?.analysis, "analysis.json missing analysis field.");
  return JSON.parse(analysisPayload.analysis);
}

function assertMultiFileFixes(result, expectedPrefixes) {
  assert.ok(result && typeof result === "object");
  assert.ok(Array.isArray(result.recommended_fixes));
  assert.ok(result.recommended_fixes.length >= 2);
  const referenced = new Set();
  for (const fix of result.recommended_fixes) {
    assert.ok(Array.isArray(fix.files));
    assert.ok(fix.files.length > 0);
    fix.files.forEach((file) => referenced.add(file));
  }
  const matches = Array.from(referenced).filter((file) =>
    expectedPrefixes.some((prefix) => file.includes(prefix)),
  );
  assert.ok(matches.length >= 2);
}

maybeTest(
  "MiniPhi advanced prompt covers multiple bash C files",
  { timeout: 12 * 60 * 1000 },
  async () => {
    const workspace = await createTempWorkspace();
    try {
      const sampleRoot = path.resolve("samples", "bash", "bash-sources");
      const files = ["array.c", "variables.c", "xmalloc.c"];
      const stagedRoot = await stageSampleFiles(
        workspace,
        sampleRoot,
        files,
        "bash-sources",
      );
      const bundlePath = path.join(workspace, "bash-sources-bundle.txt");
      await buildBundleFile(
        bundlePath,
        files.map((file) => ({
          source: path.join(stagedRoot, file),
          label: `bash-sources/${file}`,
        })),
        { maxLines: 80 },
      );

      const prompt = [
        "Analyze the bundled bash C excerpts.",
        "Return at least two recommended_fixes entries that reference multiple files.",
        "Use file paths exactly as labeled in the bundle (bash-sources/array.c, bash-sources/variables.c, bash-sources/xmalloc.c).",
        "Do not leave recommended_fixes empty and include non-empty files arrays.",
      ].join(" ");

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
          "bash-advanced-c",
          "--prompt-journal-status",
          "paused",
          "--session-timeout",
          "600",
        ],
        { cwd: workspace, maxBuffer: 20 * 1024 * 1024 },
      );
      assert.equal(result.code, 0, result.stderr);
      const analysis = await loadLatestAnalysis(workspace);
      assertMultiFileFixes(analysis, ["bash-sources/array.c", "bash-sources/variables.c", "bash-sources/xmalloc.c"]);
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);

maybeTest(
  "MiniPhi advanced prompt covers multiple bash-it scripts",
  { timeout: 12 * 60 * 1000 },
  async () => {
    const workspace = await createTempWorkspace();
    try {
      const sampleRoot = path.resolve("samples", "bash", "bash-it");
      const files = [
        "bash_it.sh",
        path.join("plugins", "available", "base.plugin.bash"),
        path.join("lib", "utilities.bash"),
      ];
      const stagedRoot = await stageSampleFiles(
        workspace,
        sampleRoot,
        files,
        "bash-it",
      );
      const bundlePath = path.join(workspace, "bash-it-bundle.txt");
      await buildBundleFile(
        bundlePath,
        files.map((file) => ({
          source: path.join(stagedRoot, file),
          label: `bash-it/${file.replace(/\\/g, "/")}`,
        })),
        { maxLines: 80 },
      );

      const prompt = [
        "Analyze the bundled bash-it excerpts.",
        "Return at least two recommended_fixes entries that touch multiple scripts.",
        "Use file paths exactly as labeled in the bundle (bash-it/bash_it.sh, bash-it/plugins/available/base.plugin.bash, bash-it/lib/utilities.bash).",
        "Do not leave recommended_fixes empty and include non-empty files arrays.",
      ].join(" ");

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
          "bash-advanced-it",
          "--prompt-journal-status",
          "paused",
          "--session-timeout",
          "600",
        ],
        { cwd: workspace, maxBuffer: 20 * 1024 * 1024 },
      );
      assert.equal(result.code, 0, result.stderr);
      const analysis = await loadLatestAnalysis(workspace);
      assertMultiFileFixes(analysis, [
        "bash-it/bash_it.sh",
        "bash-it/plugins/available/base.plugin.bash",
        "bash-it/lib/utilities.bash",
      ]);
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);
