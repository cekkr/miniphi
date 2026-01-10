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

test("CLI recompose runs offline against a copied sample", async () => {
  const workspace = await createTempWorkspace();
  try {
    const samplePath = await copySampleToWorkspace(
      path.join("samples", "recompose", "hello-flow"),
      workspace,
    );
    const reportPath = path.join(workspace, "recompose-report.json");
    const result = runCli(
      [
        "recompose",
        "--sample",
        samplePath,
        "--direction",
        "roundtrip",
        "--clean",
        "--report",
        reportPath,
      ],
      { cwd: workspace },
    );
    assert.equal(result.code, 0, result.stderr);

    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(report.direction, "roundtrip");
    assert.ok(Array.isArray(report.steps));
    const phases = report.steps.map((step) => step.phase);
    assert.ok(phases.includes("code-to-markdown"));
    assert.ok(phases.includes("markdown-to-code"));
    assert.ok(phases.includes("comparison"));
  } finally {
    await removeTempWorkspace(workspace);
  }
});
