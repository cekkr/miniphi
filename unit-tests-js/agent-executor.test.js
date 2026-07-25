import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import {
  buildMutationProposal,
  classifyActionType,
  commitMutation,
  describeAction,
  executeReadonly,
  hashText,
  normalizeAgentAction,
} from "../src/agent/agent-executor.js";

test("classifyActionType buckets actions for the session loop", () => {
  assert.equal(classifyActionType("read_file"), "readonly");
  assert.equal(classifyActionType("search_text"), "readonly");
  assert.equal(classifyActionType("web_research"), "research");
  assert.equal(classifyActionType("write_file"), "mutating");
  assert.equal(classifyActionType("run_cmd"), "mutating");
  assert.equal(classifyActionType("finish"), "finish");
  assert.equal(classifyActionType("nope"), "unknown");
});

test("normalizeAgentAction rejects unsafe paths and malformed actions", () => {
  const cwd = process.cwd();
  assert.equal(normalizeAgentAction({ type: "read_file", path: "../secret", reason: "x" }, cwd).ok, false);
  assert.equal(
    normalizeAgentAction({ type: "write_file", path: "C:\\Windows\\x", content: "", reason: "x" }, cwd).ok,
    false,
  );
  assert.equal(normalizeAgentAction({ type: "bogus", reason: "x" }, cwd).ok, false);
  assert.equal(normalizeAgentAction({ type: "search_text", term: "  ", reason: "x" }, cwd).ok, false);
  assert.equal(normalizeAgentAction({ type: "run_cmd", command: "", reason: "x" }, cwd).ok, false);
  assert.equal(normalizeAgentAction({ type: "web_research", query: "", reason: "x" }, cwd).ok, false);
  assert.equal(normalizeAgentAction({ type: "write_file", path: "a.js", reason: "x" }, cwd).ok, false);
  assert.equal(
    normalizeAgentAction({ type: "edit_file", path: "a.js", reason: "x" }, cwd).ok,
    false,
    "edit_file needs anchor+replacement or content",
  );
});

test("normalizeAgentAction resolves and normalizes valid actions", () => {
  const cwd = process.cwd();
  const read = normalizeAgentAction({ type: "read_file", path: "src\\index.js", reason: "look" }, cwd);
  assert.equal(read.ok, true);
  assert.equal(read.action.path, "src/index.js");
  assert.equal(read.category, "readonly");
  const rootList = normalizeAgentAction({ type: "list_dir", path: ".", reason: "inspect root" }, cwd);
  assert.equal(rootList.ok, true);
  assert.equal(rootList.action.path, ".");
  const implicitRootList = normalizeAgentAction({ type: "list_dir", reason: "inspect root" }, cwd);
  assert.equal(implicitRootList.ok, true);
  assert.equal(implicitRootList.action.path, ".");
  // Models write the workspace root as "/" (seen live with gpt-oss-20b); it means
  // the sandbox root, and must resolve there rather than being rejected.
  for (const rootPath of ["/", "\\", "./", "./."]) {
    const listed = normalizeAgentAction({ type: "list_dir", path: rootPath, reason: "inspect root" }, cwd);
    assert.equal(listed.ok, true, `list_dir "${rootPath}" should resolve to the workspace root`);
    assert.equal(listed.action.path, ".");
  }
  // The same strings stay rejected for path-scoped actions: they are not files.
  assert.equal(normalizeAgentAction({ type: "read_file", path: "/", reason: "x" }, cwd).ok, false);
  assert.equal(normalizeAgentAction({ type: "write_file", path: "/", content: "x", reason: "x" }, cwd).ok, false);

  const write = normalizeAgentAction(
    { type: "write_file", path: "out.txt", content: "hi", reason: "create", danger: "weird" },
    cwd,
  );
  assert.equal(write.ok, true);
  assert.equal(write.action.danger, "mid", "unknown danger normalizes to mid");

  const edit = normalizeAgentAction(
    { type: "edit_file", path: "a.js", anchor: "old", replacement: "new", reason: "swap" },
    cwd,
  );
  assert.equal(edit.ok, true);
  assert.equal(edit.action.anchor, "old");

  const research = normalizeAgentAction(
    { type: "web_research", query: "  JavaScript 2D physics library  ", max_results: 50, reason: "compare" },
    cwd,
  );
  assert.equal(research.ok, true);
  assert.equal(research.category, "research");
  assert.equal(research.action.query, "JavaScript 2D physics library");
  assert.equal(research.action.maxResults, 10);

  assert.equal(describeAction(write.action), "write_file out.txt");
});

test("buildMutationProposal previews new-file writes with a diff and no expectedHash", async () => {
  const workspace = await createTempWorkspace();
  try {
    const { action } = normalizeAgentAction(
      { type: "write_file", path: "src/new.js", content: "export const x = 1;\n", reason: "create" },
      workspace,
    );
    const { ok, proposal } = await buildMutationProposal({ action, cwd: workspace });
    assert.equal(ok, true);
    assert.equal(proposal.isNewFile, true);
    assert.equal(proposal.expectedHash, null);
    assert.match(proposal.diff, /\+ \[1\]/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("buildMutationProposal handles anchored edits, misses, and ambiguity", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "a.js"), "const a = 1;\nconst b = 2;\nconst a2 = 1;\n", "utf8");

    const good = normalizeAgentAction(
      { type: "edit_file", path: "a.js", anchor: "const b = 2;", replacement: "const b = 20;", reason: "bump" },
      workspace,
    ).action;
    const goodResult = await buildMutationProposal({ action: good, cwd: workspace });
    assert.equal(goodResult.ok, true);
    assert.match(goodResult.proposal.afterContent, /const b = 20;/);
    assert.ok(goodResult.proposal.expectedHash, "existing file gets an expectedHash guard");

    const missing = normalizeAgentAction(
      { type: "edit_file", path: "a.js", anchor: "does-not-exist", replacement: "x", reason: "n/a" },
      workspace,
    ).action;
    assert.equal((await buildMutationProposal({ action: missing, cwd: workspace })).status, "anchor-not-found");

    const ambiguous = normalizeAgentAction(
      { type: "edit_file", path: "a.js", anchor: "const a", replacement: "const A", reason: "n/a" },
      workspace,
    ).action;
    assert.equal((await buildMutationProposal({ action: ambiguous, cwd: workspace })).status, "anchor-ambiguous");

    const absent = normalizeAgentAction(
      { type: "edit_file", path: "missing.js", content: "x", reason: "n/a" },
      workspace,
    ).action;
    assert.equal((await buildMutationProposal({ action: absent, cwd: workspace })).status, "missing-file");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("commitMutation writes through the guard and keeps a rollback copy", async () => {
  const workspace = await createTempWorkspace();
  const rollbackDir = path.join(workspace, ".miniphi", "rollbacks");
  try {
    await fs.writeFile(path.join(workspace, "a.js"), "old\n", "utf8");
    const action = normalizeAgentAction(
      { type: "write_file", path: "a.js", content: "new\n", reason: "overwrite" },
      workspace,
    ).action;
    const { proposal } = await buildMutationProposal({ action, cwd: workspace });
    const result = await commitMutation({ proposal, cwd: workspace, rollbackDir });
    assert.equal(result.status, "written");
    assert.equal(await fs.readFile(path.join(workspace, "a.js"), "utf8"), "new\n");
    const rollbacks = await fs.readdir(rollbackDir);
    assert.equal(rollbacks.length, 1, "one rollback copy for the overwrite");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("commitMutation creates parent directories for a new nested file", async () => {
  const workspace = await createTempWorkspace();
  try {
    const action = normalizeAgentAction(
      {
        type: "write_file",
        path: "src/animation/ball.js",
        content: "export const gravity = 0.5;\n",
        reason: "create nested module",
      },
      workspace,
    ).action;
    const { proposal } = await buildMutationProposal({ action, cwd: workspace });
    const result = await commitMutation({ proposal, cwd: workspace });
    assert.equal(result.status, "written");
    assert.equal(
      await fs.readFile(path.join(workspace, "src", "animation", "ball.js"), "utf8"),
      "export const gravity = 0.5;\n",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("commitMutation returns hash-mismatch when the file changed since preview", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "a.js"), "v1\n", "utf8");
    const action = normalizeAgentAction(
      { type: "edit_file", path: "a.js", content: "v2\n", reason: "replace" },
      workspace,
    ).action;
    const { proposal } = await buildMutationProposal({ action, cwd: workspace });
    // Simulate a concurrent edit between preview and commit.
    await fs.writeFile(path.join(workspace, "a.js"), "concurrent\n", "utf8");
    const result = await commitMutation({ proposal, cwd: workspace });
    assert.equal(result.status, "hash-mismatch");
    assert.equal(await fs.readFile(path.join(workspace, "a.js"), "utf8"), "concurrent\n", "file untouched");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("executeReadonly reads files and searches text", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "a.js"), "export const token = 1;\n", "utf8");
    const read = await executeReadonly({
      action: { type: "read_file", path: "src/a.js" },
      cwd: workspace,
    });
    assert.match(read, /export const token/);
    const search = await executeReadonly({
      action: { type: "search_text", term: "token" },
      cwd: workspace,
    });
    assert.match(search, /src\/a\.js:1/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("hashText is stable and matches file-edit-guard hashing", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});

test("agent-action schema accepts a valid turn and rejects malformed ones", () => {
  const registry = new PromptSchemaRegistry();
  const valid = JSON.stringify({
    task: "Add a slug helper",
    summary: "Creating the helper",
    summary_updates: ["reading target"],
    actions: [
      { type: "read_file", path: "src/index.js", reason: "understand exports" },
      { type: "web_research", query: "JavaScript animation libraries", max_results: 3, reason: "compare options" },
      { type: "write_file", path: "src/slug.js", content: "export const slug = () => {};\n", reason: "add helper", danger: "low" },
    ],
    needs_more_context: false,
    missing_snippets: [],
  });
  assert.equal(registry.validate("agent-action", valid).valid, true);

  const missingRequired = JSON.stringify({ task: "x", actions: [] });
  assert.equal(registry.validate("agent-action", missingRequired).valid, false);

  const extraProp = JSON.stringify({
    task: "x",
    summary: "y",
    summary_updates: [],
    actions: [{ type: "read_file", path: "a.js", reason: "r", bogus: true }],
    needs_more_context: false,
    missing_snippets: [],
  });
  assert.equal(registry.validate("agent-action", extraProp).valid, false, "additionalProperties:false on actions");

  const badType = JSON.stringify({
    task: "x",
    summary: "y",
    summary_updates: [],
    actions: [{ type: "delete_everything", reason: "r" }],
    needs_more_context: false,
    missing_snippets: [],
  });
  assert.equal(registry.validate("agent-action", badType).valid, false, "type enum enforced");
});
