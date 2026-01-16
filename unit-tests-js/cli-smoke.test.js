import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace, runCli } from "./cli-test-utils.js";

test("CLI prompt-template + library commands run without LM Studio", async () => {
  const workspace = await createTempWorkspace();
  try {
    const promptPath = path.join(workspace, "prompt-template.txt");
    const promptResult = runCli(
      [
        "prompt-template",
        "--baseline",
        "truncation",
        "--task",
        "Plan log chunking",
        "--schema-id",
        "log-analysis",
        "--no-workspace",
        "--output",
        promptPath,
      ],
      { cwd: workspace },
    );
    assert.equal(promptResult.code, 0, promptResult.stderr);
    const promptText = await fs.readFile(promptPath, "utf8");
    assert.match(promptText, /Schema requirements:/);
    assert.match(promptText, /needs_more_context/);
    assert.match(promptText, /missing_snippets/);

    const planPromptPath = path.join(workspace, "prompt-plan-template.txt");
    const planResult = runCli(
      [
        "prompt-template",
        "--baseline",
        "analysis",
        "--task",
        "Plan CLI flow",
        "--schema-id",
        "prompt-plan",
        "--no-workspace",
        "--output",
        planPromptPath,
      ],
      { cwd: workspace },
    );
    assert.equal(planResult.code, 0, planResult.stderr);
    const planText = await fs.readFile(planPromptPath, "utf8");
    assert.match(planText, /plan_id/);
    assert.match(planText, /missing_snippets/);

    const navPromptPath = path.join(workspace, "prompt-navigation-template.txt");
    const navResult = runCli(
      [
        "prompt-template",
        "--baseline",
        "analysis",
        "--task",
        "Navigator schema smoke",
        "--schema-id",
        "navigation-plan",
        "--no-workspace",
        "--output",
        navPromptPath,
      ],
      { cwd: workspace },
    );
    assert.equal(navResult.code, 0, navResult.stderr);
    const navText = await fs.readFile(navPromptPath, "utf8");
    assert.match(navText, /navigation_summary/);
    assert.match(navText, /missing_snippets/);

    const libraryResult = runCli(
      ["command-library", "--json", "--limit", "3", "--cwd", workspace],
      { cwd: workspace },
    );
    assert.equal(libraryResult.code, 0, libraryResult.stderr);
    const libraryEntries = JSON.parse(libraryResult.stdout);
    assert.ok(Array.isArray(libraryEntries));

    const helperResult = runCli(
      ["helpers", "--json", "--limit", "3", "--cwd", workspace],
      { cwd: workspace },
    );
    assert.equal(helperResult.code, 0, helperResult.stderr);
    const helpers = JSON.parse(helperResult.stdout);
    assert.ok(Array.isArray(helpers));

    const historyResult = runCli(
      ["history-notes", "--history-root", workspace, "--label", "cli-smoke"],
      { cwd: workspace },
    );
    assert.equal(historyResult.code, 0, historyResult.stderr);
    const jsonLine = historyResult.stdout
      .split(/\r?\n/)
      .find((line) => line.includes("[MiniPhi][History] JSON:"));
    assert.ok(jsonLine, "History notes did not report JSON output.");
    const match = jsonLine.match(/JSON:\s*(.+)$/);
    assert.ok(match && match[1], "History notes JSON path missing.");
    const jsonPath = path.isAbsolute(match[1].trim())
      ? match[1].trim()
      : path.join(workspace, match[1].trim());
    await fs.stat(jsonPath);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
