import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  copySampleToWorkspace,
  createTempWorkspace,
  removeTempWorkspace,
  runCli,
} from "./cli-test-utils.js";

test("CLI benchmark plan scaffold and analyze run without LM Studio", async () => {
  const workspace = await createTempWorkspace();
  try {
    const samplePath = await copySampleToWorkspace(
      path.join("samples", "recompose", "hello-flow"),
      workspace,
    );
    const planPath = path.join(workspace, "benchmark-plan.yml");
    const scaffoldResult = runCli(
      ["benchmark", "plan", "scaffold", "--sample", samplePath, "--output", planPath],
      { cwd: workspace },
    );
    assert.equal(scaffoldResult.code, 0, scaffoldResult.stderr);
    const planText = await fs.readFile(planPath, "utf8");
    assert.match(planText, /sampleDir:/);
    assert.match(planText, /runs:/);

    const runDir = path.join(workspace, "benchmark-runs");
    await fs.mkdir(runDir, { recursive: true });
    const runPayload = {
      direction: "roundtrip",
      sampleDir: samplePath,
      generatedAt: new Date().toISOString(),
      steps: [
        { phase: "code-to-markdown", durationMs: 12, discovered: 2, converted: 2, skipped: 0 },
        { phase: "markdown-to-code", durationMs: 18, processed: 2, converted: 2, warnings: [] },
        { phase: "comparison", durationMs: 5, matches: 2, mismatches: [], missing: [], extras: [] },
      ],
    };
    await fs.writeFile(path.join(runDir, "RUN-001.json"), JSON.stringify(runPayload, null, 2), "utf8");

    const analyzeResult = runCli(["benchmark", "analyze", "--path", runDir], { cwd: workspace });
    assert.equal(analyzeResult.code, 0, analyzeResult.stderr);
    await fs.stat(path.join(runDir, "SUMMARY.json"));
    await fs.stat(path.join(runDir, "SUMMARY.md"));
    await fs.stat(path.join(runDir, "SUMMARY.html"));
  } finally {
    await removeTempWorkspace(workspace);
  }
});
