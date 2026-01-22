import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace, runCli } from "./cli-test-utils.js";

test("CLI prompt-template workspace scan skips ignored dirs and skip files", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".miniphi"), { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "Hello workspace", "utf8");
    await fs.writeFile(path.join(workspace, "src", "index.js"), "console.log('hi');", "utf8");
    await fs.writeFile(path.join(workspace, "docs", "guide.md"), "# Guide", "utf8");
    await fs.writeFile(path.join(workspace, ".gitkeep"), "", "utf8");
    await fs.writeFile(path.join(workspace, ".git", "config"), "ignored", "utf8");
    await fs.writeFile(path.join(workspace, ".miniphi", "ignored.txt"), "ignored", "utf8");

    const outputPath = path.join(workspace, "prompt-template.txt");
    const result = runCli(
      [
        "prompt-template",
        "--baseline",
        "truncation",
        "--task",
        "Scan workspace",
        "--schema-id",
        "log-analysis",
        "--output",
        outputPath,
      ],
      { cwd: workspace },
    );
    assert.equal(result.code, 0, result.stderr);

    const promptText = await fs.readFile(outputPath, "utf8");
    const manifestMatch = promptText.match(
      /File manifest[^\n]*:\n([\s\S]*?)(?:\nREADME excerpt:|\n```)/,
    );
    assert.ok(manifestMatch, "Workspace manifest block missing.");
    const manifestText = manifestMatch[1];
    assert.match(manifestText, /README\.md/);
    assert.match(manifestText, /src\/index\.js/);
    assert.match(manifestText, /docs\/guide\.md/);
    assert.ok(!manifestText.includes(".gitkeep"));
    assert.ok(!manifestText.includes(".git/config"));
    assert.ok(!manifestText.includes(".miniphi"));
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("CLI prompt-template --no-workspace omits workspace context block", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "Hello workspace", "utf8");
    await fs.writeFile(path.join(workspace, "src", "index.js"), "console.log('hi');", "utf8");

    const outputPath = path.join(workspace, "prompt-template-no-workspace.txt");
    const result = runCli(
      [
        "prompt-template",
        "--baseline",
        "truncation",
        "--task",
        "Skip workspace scan",
        "--schema-id",
        "log-analysis",
        "--no-workspace",
        "--output",
        outputPath,
      ],
      { cwd: workspace },
    );
    assert.equal(result.code, 0, result.stderr);

    const promptText = await fs.readFile(outputPath, "utf8");
    assert.ok(!promptText.includes("## Workspace Insight"));
    assert.ok(!promptText.includes("File manifest"));
    assert.ok(!promptText.includes("README excerpt"));
  } finally {
    await removeTempWorkspace(workspace);
  }
});
