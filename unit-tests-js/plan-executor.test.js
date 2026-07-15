import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";
import MiniPhiMemory from "../src/libs/miniphi-memory.js";
import {
  buildExecutedActionsBlock,
  buildPlanProgress,
  buildSnippetContextBlock,
  executeFocusedBranchActions,
  mapSegmentToAction,
  resolveMissingSnippets,
  resolveWorkspacePath,
} from "../src/libs/plan-executor.js";

async function seedWorkspace(root) {
  await fs.mkdir(path.join(root, "src", "libs"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "parser.js"),
    "export function parseArgs(tokens) {\n  return { tokens };\n}\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "src", "libs", "utils.js"),
    "export function parseArgsHelper() {\n  return null;\n}\n",
    "utf8",
  );
  await fs.writeFile(path.join(root, "README.md"), "# Sample\nUses parseArgs everywhere.\n", "utf8");
}

test("resolveWorkspacePath only accepts paths inside the workspace", () => {
  const cwd = process.cwd();
  assert.equal(resolveWorkspacePath("src/index.js", cwd), "src/index.js");
  assert.equal(resolveWorkspacePath("src\\libs\\core-utils.js", cwd), "src/libs/core-utils.js");
  assert.equal(resolveWorkspacePath("'src/index.js'", cwd), "src/index.js");
  assert.equal(resolveWorkspacePath("../outside.js", cwd), null);
  assert.equal(resolveWorkspacePath("C:\\Windows\\system32\\cmd.exe", cwd), null);
  assert.equal(resolveWorkspacePath("/etc/passwd", cwd), null);
  assert.equal(resolveWorkspacePath("https://example.com/x.js", cwd), null);
  assert.equal(resolveWorkspacePath("", cwd), null);
});

test("resolveMissingSnippets reads repo-relative files and reports the rest", async () => {
  const workspace = await createTempWorkspace();
  try {
    await seedWorkspace(workspace);
    const { resolved, unresolved } = await resolveMissingSnippets({
      snippets: [
        "src/parser.js",
        "Current argument handling in src/libs/utils.js",
        "Example of how arguments are used in the codebase",
        "does/not/exist.js",
      ],
      cwd: workspace,
    });
    assert.deepEqual(
      resolved.map((entry) => entry.path),
      ["src/parser.js", "src/libs/utils.js"],
    );
    assert.match(resolved[0].content, /parseArgs/);
    assert.equal(resolved[0].truncated, false);
    assert.equal(unresolved.length, 2);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("resolveMissingSnippets enforces size and count caps", async () => {
  const workspace = await createTempWorkspace();
  try {
    await seedWorkspace(workspace);
    await fs.writeFile(path.join(workspace, "big.txt"), "x".repeat(9000), "utf8");
    const { resolved } = await resolveMissingSnippets({
      snippets: ["big.txt", "src/parser.js", "README.md"],
      cwd: workspace,
      maxCount: 2,
      maxBytes: 100,
    });
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].truncated, true);
    assert.equal(resolved[0].content.length, 100);
    const block = buildSnippetContextBlock(resolved);
    assert.match(block, /Requested snippets \(auto-fetched\):/);
    assert.match(block, /--- big\.txt \(9000 bytes, truncated\) ---/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("mapSegmentToAction maps recommendations, paths, and search phrases", async () => {
  const workspace = await createTempWorkspace();
  try {
    await seedWorkspace(workspace);
    const cases = [
      [{ id: "1", title: "Run tests", recommendation: "npm test" }, { type: "run_cmd" }],
      [
        { id: "2", title: "Inspect parser", description: "Examine src/parser.js for validation." },
        { type: "read_file", target: "src/parser.js" },
      ],
      [
        { id: "3", title: "Scan libs", description: "List the files in src/libs to find helpers." },
        { type: "list_dir", target: "src/libs" },
      ],
      [
        { id: "4", title: "Find usages", description: "Search for usages of parseArgs across the project." },
        { type: "search_text", term: "parseArgs" },
      ],
      [
        { id: "5", title: "Design refactor", description: "Decide on module layout.", requiresSubprompt: true },
        { type: "sub-prompt" },
      ],
      [{ id: "6", title: "Think about naming", description: "Pick good names." }, { type: "unmapped" }],
    ];
    for (const [segment, expected] of cases) {
      const action = await mapSegmentToAction(segment, { cwd: workspace });
      assert.equal(action.type, expected.type, `segment ${segment.id}`);
      if (expected.target) {
        assert.equal(action.target, expected.target);
      }
      if (expected.term) {
        assert.equal(action.term, expected.term);
      }
    }
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("executeFocusedBranchActions runs read/search natively and defers commands", async () => {
  const workspace = await createTempWorkspace();
  try {
    await seedWorkspace(workspace);
    const segments = [
      { id: "1.1", title: "Read parser", description: "Check src/parser.js" },
      { id: "1.2", title: "Find callers", description: "Search for usages of parseArgs" },
      { id: "1.3", title: "Run tests", recommendation: "npm test" },
      { id: "1.4", title: "Ponder", description: "Reflect deeply." },
    ];
    const { results, executedCount } = await executeFocusedBranchActions({
      segments,
      cwd: workspace,
    });
    assert.equal(executedCount, 2);
    const byBranch = Object.fromEntries(results.map((entry) => [entry.branch, entry]));
    assert.equal(byBranch["1.1"].status, "executed");
    assert.match(byBranch["1.1"].output, /parseArgs/);
    assert.equal(byBranch["1.2"].status, "executed");
    assert.match(byBranch["1.2"].output, /src\/parser\.js:1/);
    assert.equal(byBranch["1.3"].status, "deferred-command");
    assert.equal(byBranch["1.4"].status, "unmapped");

    const block = buildExecutedActionsBlock(results);
    assert.match(block, /Executed plan actions:/);
    assert.match(block, /step 1\.1: read_file src\/parser\.js/);
    assert.doesNotMatch(block, /1\.3/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("executeFocusedBranchActions honors the action budget and runCommand injection", async () => {
  const workspace = await createTempWorkspace();
  try {
    await seedWorkspace(workspace);
    const segments = [
      { id: "1", title: "Read parser", description: "Check src/parser.js" },
      { id: "2", title: "Read readme", description: "Check README.md" },
      { id: "3", title: "Run tests", recommendation: "npm test" },
    ];
    const commands = [];
    const { results, executedCount } = await executeFocusedBranchActions({
      segments,
      cwd: workspace,
      maxActions: 1,
      runCommand: async (command) => {
        commands.push(command);
        return "ok";
      },
    });
    assert.equal(executedCount, 1);
    const statuses = results.map((entry) => entry.status);
    assert.deepEqual(statuses, ["executed", "skipped-budget", "skipped-budget"]);
    assert.equal(commands.length, 0, "budget must apply before runCommand");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("duplicate actions across sibling branches execute once and skip the rest", async () => {
  const workspace = await createTempWorkspace();
  try {
    await seedWorkspace(workspace);
    const segments = [
      { id: "3", title: "Find usages", description: "Search for usages of parseArgs" },
      { id: "3.1", title: "Find usages again", description: "Search for usages of parseArgs" },
      { id: "3.2", title: "Read parser", description: "Check src/parser.js" },
    ];
    const { results, executedCount } = await executeFocusedBranchActions({
      segments,
      cwd: workspace,
      maxActions: 2,
    });
    assert.equal(executedCount, 2, "duplicate must not consume budget");
    const statuses = results.map((entry) => entry.status);
    assert.deepEqual(statuses, ["executed", "duplicate", "executed"]);
    const progress = buildPlanProgress({ planId: "p", focusBranch: "3", results });
    assert.equal(progress.firstIncompleteBranch, null, "duplicates count as complete");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("buildPlanProgress tracks branch statuses and the first incomplete branch", () => {
  const progress = buildPlanProgress({
    planId: "plan-x",
    focusBranch: "1",
    results: [
      { branch: "1.1", action: { type: "read_file", target: "src/a.js" }, status: "executed" },
      { branch: "1.2", action: { type: "run_cmd", command: "npm test" }, status: "deferred-command" },
      { branch: "1.3", action: { type: "unmapped" }, status: "unmapped" },
    ],
  });
  assert.equal(progress.planId, "plan-x");
  assert.equal(progress.branches["1.1"].status, "executed");
  assert.equal(progress.firstIncompleteBranch, "1.2");

  const updated = buildPlanProgress({
    planId: "plan-x",
    focusBranch: "1",
    previous: progress,
    results: [{ branch: "1.2", action: { type: "run_cmd", command: "npm test" }, status: "executed" }],
  });
  assert.equal(updated.branches["1.2"].status, "executed");
  assert.equal(updated.branches["1.1"].status, "executed", "previous entries survive merges");
  assert.equal(updated.firstIncompleteBranch, null);
});

test("MiniPhiMemory persists and reloads plan progress next to decompositions", async () => {
  const workspace = await createTempWorkspace();
  try {
    const memory = new MiniPhiMemory(workspace);
    await memory.prepare();
    const progress = buildPlanProgress({
      planId: "plan-persist",
      focusBranch: "2",
      results: [{ branch: "2.1", action: { type: "read_file", target: "a.js" }, status: "failed" }],
    });
    const saved = await memory.savePlanProgress("plan-persist", progress);
    assert.ok(saved?.path.includes("decompositions"));
    const loaded = await memory.loadPlanProgress("plan-persist");
    assert.equal(loaded.branches["2.1"].status, "failed");
    assert.equal(loaded.firstIncompleteBranch, "2.1");
    assert.equal(await memory.loadPlanProgress("missing-plan"), null);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
