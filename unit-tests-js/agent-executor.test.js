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
  assert.equal(classifyActionType("visual_review"), "visual");
  assert.equal(classifyActionType("knowledge_lookup"), "knowledge");
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
  assert.equal(
    normalizeAgentAction({ type: "knowledge_lookup", subject: "   ", reason: "x" }, cwd).ok,
    false,
    "knowledge_lookup requires a non-empty subject",
  );
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

  const visual = normalizeAgentAction(
    {
      type: "visual_review",
      path: "index.html",
      focus: "  does the ball look round and orange, is it moving  ",
      reason: "check rendered quality",
    },
    cwd,
  );
  assert.equal(visual.ok, true);
  assert.equal(visual.category, "visual");
  assert.equal(visual.action.path, "index.html");
  assert.equal(visual.action.focus, "does the ball look round and orange, is it moving");

  const visualNoFocus = normalizeAgentAction(
    { type: "visual_review", path: "index.html", reason: "check rendered quality" },
    cwd,
  );
  assert.equal(visualNoFocus.ok, true);
  assert.equal(visualNoFocus.action.focus, undefined);

  assert.equal(
    normalizeAgentAction({ type: "visual_review", path: "../secret.html", reason: "x" }, cwd).ok,
    false,
    "visual_review rejects paths that escape the workspace",
  );

  // A running app can only be reviewed over http; the URL form is restricted to
  // loopback so a model-authored string cannot become an outbound request.
  const visualUrl = normalizeAgentAction(
    {
      type: "visual_review",
      url: "http://127.0.0.1:3000/feed",
      focus: "is the feed populated",
      reason: "check the running app",
    },
    cwd,
  );
  assert.equal(visualUrl.ok, true);
  assert.equal(visualUrl.category, "visual");
  assert.equal(visualUrl.action.url, "http://127.0.0.1:3000/feed");
  assert.equal(visualUrl.action.path, undefined);
  assert.equal(describeAction(visualUrl.action), "visual_review http://127.0.0.1:3000/feed");

  for (const url of [
    "https://example.com/",
    "http://10.0.0.5:3000/",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(
      normalizeAgentAction({ type: "visual_review", url, reason: "x" }, cwd).ok,
      false,
      `visual_review must reject the non-loopback target ${url}`,
    );
  }

  const knowledge = normalizeAgentAction(
    { type: "knowledge_lookup", subject: "  Springfield  ", reason: "check for recorded facts" },
    cwd,
  );
  assert.equal(knowledge.ok, true);
  assert.equal(knowledge.category, "knowledge");
  assert.equal(knowledge.action.subject, "Springfield");
  assert.equal(
    normalizeAgentAction({ type: "knowledge_lookup", subject: "x".repeat(500), reason: "x" }, cwd).action.subject
      .length,
    200,
    "subject is capped at 200 chars",
  );

  assert.equal(describeAction(write.action), "write_file out.txt");
  assert.equal(describeAction(visual.action), "visual_review index.html");
  assert.equal(describeAction(knowledge.action), "knowledge_lookup Springfield");
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

test("buildMutationProposal rejects invalid JavaScript before it can reach the write guard", async () => {
  const workspace = await createTempWorkspace();
  try {
    const target = path.join(workspace, "module.js");
    const original = [
      "export function value() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(target, original, "utf8");
    const action = normalizeAgentAction(
      {
        type: "edit_file",
        path: "module.js",
        anchor: "export function value() {",
        replacement: [
          "export function value() {",
          "  return 2;",
          "}",
        ].join("\n"),
        reason: "replace too little of the original function",
      },
      workspace,
    ).action;

    const result = await buildMutationProposal({ action, cwd: workspace });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid-content");
    assert.match(result.error, /invalid JavaScript syntax/);
    assert.equal(await fs.readFile(target, "utf8"), original);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("commitMutation writes through the guard and keeps a rollback copy", async () => {
  const workspace = await createTempWorkspace();
  const rollbackDir = path.join(workspace, ".miniphi", "rollbacks");
  try {
    await fs.writeFile(
      path.join(workspace, "a.js"),
      "export const value = \"old\";\n",
      "utf8",
    );
    const action = normalizeAgentAction(
      {
        type: "write_file",
        path: "a.js",
        content: "export const value = \"new\";\n",
        reason: "overwrite",
      },
      workspace,
    ).action;
    const { proposal } = await buildMutationProposal({ action, cwd: workspace });
    const result = await commitMutation({ proposal, cwd: workspace, rollbackDir });
    assert.equal(result.status, "written");
    assert.equal(
      await fs.readFile(path.join(workspace, "a.js"), "utf8"),
      "export const value = \"new\";\n",
    );
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
      { type: "visual_review", path: "index.html", focus: "does the ball look round", reason: "check rendered quality" },
      { type: "knowledge_lookup", subject: "Springfield", reason: "check recorded facts before asserting one" },
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

test("a write_file missing content names the mistake instead of restating the type", () => {
  const cwd = "/workspace";
  const result = normalizeAgentAction(
    {
      type: "write_file",
      path: "server/index.js",
      reason: "Creating the main server entry point with Express setup and SQLite initialization.",
    },
    cwd,
  );
  assert.equal(result.ok, false);
  // The model put the file in `reason`; the correction has to say so, or it
  // sends the identical shape again next turn.
  assert.match(result.error, /did not include a `content` field/);
  assert.match(result.error, /`reason` is only a one-line explanation/);
  assert.match(result.error, /never written to disk/);
});

test("a markdown fence inside proposed file content is named, not left as a parser riddle", async () => {
  const workspace = await createTempWorkspace();
  try {
    // The real shape a local model produced: a fence dropped into the middle of
    // the file, after which the parser reports an unrelated "Unexpected end of
    // input" at the fence's line and never mentions the fence itself.
    const fenced = [
      "export function createTables(db) {",
      "  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');",
      "```",
      "  }  ]  }, ",
    ].join("\n");
    const result = await buildMutationProposal({
      action: { type: "write_file", path: "db.js", content: fenced, reason: "x" },
      cwd: workspace,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid-content");
    assert.match(result.error, /invalid JavaScript syntax/);
    assert.match(result.error, /markdown code fence/);
    assert.match(result.error, /raw file text only/);

    // A file that is merely broken, with no fence, must not be told to remove one.
    const noFence = await buildMutationProposal({
      action: { type: "write_file", path: "broken.js", content: "export function f( {\n", reason: "x" },
      cwd: workspace,
    });
    assert.equal(noFence.ok, false);
    assert.match(noFence.error, /invalid JavaScript syntax/);
    assert.doesNotMatch(noFence.error, /markdown code fence/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("invalid JSON is refused before it reaches disk, like invalid JavaScript", async () => {
  const workspace = await createTempWorkspace();
  try {
    // Every shape this run actually produced.
    const cases = [
      ['{ "name": "app", "description": "one\ntwo" }', /literal newline inside a string/],
      ['{ "name": "app", }', /trailing comma/],
      ['{ "name": "app" } { "extra": 1 }', /text after the closing brace/],
    ];
    for (const [content, guidance] of cases) {
      const result = await buildMutationProposal({
        action: { type: "write_file", path: "package.json", content, reason: "x" },
        cwd: workspace,
      });
      assert.equal(result.ok, false, `expected ${content} to be refused`);
      assert.equal(result.status, "invalid-content");
      assert.match(result.error, /is not valid JSON/);
      assert.match(result.error, guidance);
    }
    // Nothing was written.
    await assert.rejects(fs.readFile(path.join(workspace, "package.json"), "utf8"));

    // Valid JSON still goes through.
    const ok = await buildMutationProposal({
      action: {
        type: "write_file",
        path: "package.json",
        content: JSON.stringify({ name: "app", version: "1.0.0" }, null, 2),
        reason: "x",
      },
      cwd: workspace,
    });
    assert.equal(ok.ok, true);

    // A non-JSON extension is untouched by this check.
    const text = await buildMutationProposal({
      action: { type: "write_file", path: "notes.md", content: "{ not json", reason: "x" },
      cwd: workspace,
    });
    assert.equal(text.ok, true);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("writes into installed or generated directories are refused, reads are not", () => {
  const cwd = "/workspace";
  // The exact action seen live: answering a dependency error by rewriting the
  // dependency. It corrupts the install and survives into every later run.
  const write = normalizeAgentAction(
    {
      type: "write_file",
      path: "server/node_modules/hono/package.json",
      content: "{}",
      reason: "add the missing exports field",
    },
    cwd,
  );
  assert.equal(write.ok, false);
  assert.match(write.error, /refusing to modify/);
  assert.match(write.error, /node_modules/);
  assert.match(write.error, /Fix this in your own source or in package\.json/);

  for (const target of ["dist/bundle.js", ".git/config", "server/vendor/lib.js", "build/out.js"]) {
    assert.equal(
      normalizeAgentAction({ type: "edit_file", path: target, content: "x", reason: "r" }, cwd).ok,
      false,
      `${target} must not be writable`,
    );
  }

  // Reading vendored code is legitimate research and stays allowed.
  assert.equal(
    normalizeAgentAction(
      { type: "read_file", path: "server/node_modules/hono/package.json", reason: "inspect" },
      cwd,
    ).ok,
    true,
  );
  assert.equal(
    normalizeAgentAction({ type: "list_dir", path: "server/node_modules", reason: "inspect" }, cwd).ok,
    true,
  );

  // A path that merely *contains* the word is untouched.
  assert.equal(
    normalizeAgentAction(
      { type: "write_file", path: "server/node_modules_helper.js", content: "x", reason: "r" },
      cwd,
    ).ok,
    true,
  );
});
