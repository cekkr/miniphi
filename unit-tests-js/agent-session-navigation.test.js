import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace } from "./cli-test-utils.js";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import PromptTrace from "../src/libs/prompt-trace.js";

/**
 * Covers the wiring added on 2026-08-10: the guidelines block, the page tools,
 * the subtask plan, the prompt trace and the error learner, all seen from the
 * session's own behaviour rather than from the modules in isolation.
 */

const turn = (actions, extra = {}) => ({
  task: "demo",
  summary: extra.summary ?? "working",
  summary_updates: [],
  actions,
  needs_more_context: false,
  missing_snippets: [],
});

function scriptedClient(turns) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async createChatCompletion(request) {
      calls.push(request);
      const scripted = turns[Math.min(index, turns.length - 1)];
      index += 1;
      const content = typeof scripted === "string" ? scripted : JSON.stringify(scripted);
      return { choices: [{ message: { content } }], usage: { completion_tokens: 10 } };
    },
  };
}

test("the guidelines and the page-tool guide only appear when they are wired", async () => {
  const workspace = await createTempWorkspace();
  const bare = new AgentSession({ client: scriptedClient([]), cwd: workspace });
  assert.doesNotMatch(bare._systemPrompt(), /page_inspect/);

  const wired = new AgentSession({
    client: scriptedClient([]),
    cwd: workspace,
    guidelines: "R1. Orient before you build.",
    pageInspect: async () => ({ ok: true, response: {} }),
  });
  const prompt = wired._systemPrompt();
  // The rules lead: a local model weights the opening of a system prompt far
  // more than a paragraph buried under a JSON schema.
  assert.ok(prompt.startsWith("R1. Orient before you build."));
  assert.match(prompt, /page_inspect returns a page's STRUCTURE/);
  assert.match(prompt, /Re-creating similar markup from memory discards the design/);
});

test("a page_inspect action runs the injected tool and keeps its report as evidence", async () => {
  const workspace = await createTempWorkspace();
  await fs.writeFile(path.join(workspace, "home.html"), "<html><body></body></html>", "utf8");
  const inspected = [];
  const client = scriptedClient([
    turn([{ type: "page_inspect", path: "home.html", mode: "source", reason: "learn the template" }]),
    turn([{ type: "finish", reason: "done" }], { summary: "inspected" }),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "page-inspect",
    approver: createHeadlessApprover({ policy: "allow" }),
    pageInspect: async (request) => {
      inspected.push(request);
      return {
        ok: true,
        response: { mode: "source", source: { title: "Home", repeatedClasses: [{ class: "card" }] } },
      };
    },
  });
  const results = [];
  session.on("action-result", (event) => results.push(event));

  await session.submitTask("Use the template", []);

  assert.equal(inspected.length, 1);
  assert.equal(inspected[0].relativePath, "home.html");
  assert.equal(inspected[0].mode, "source");
  assert.equal(results[0].status, "executed");
  const evidence = [...session.context.nodes.values()].find((node) => node.kind === "page");
  assert.ok(evidence, "the report is kept as evidence, not discarded");
  assert.match(evidence.text, /repeatedClasses/);
});

test("page_understand reports as unavailable rather than failing when it is not wired", async () => {
  const workspace = await createTempWorkspace();
  const client = scriptedClient([
    turn([{ type: "page_understand", url: "http://127.0.0.1:3117/feed", reason: "see the feed" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "no-vision",
    approver: createHeadlessApprover({ policy: "allow" }),
  });
  const results = [];
  session.on("action-result", (event) => results.push(event));
  await session.submitTask("Look at the feed", []);
  assert.equal(results[0].status, "unavailable");
  assert.match(results[0].output, /not configured/);
});

test("a non-loopback page target is refused before anything opens a browser", async () => {
  const workspace = await createTempWorkspace();
  let called = false;
  const client = scriptedClient([
    turn([{ type: "page_inspect", url: "https://example.com/", reason: "peek" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "loopback",
    approver: createHeadlessApprover({ policy: "allow" }),
    pageInspect: async () => {
      called = true;
      return { ok: true, response: {} };
    },
  });
  const results = [];
  session.on("action-result", (event) => results.push(event));
  await session.submitTask("Peek at a site", []);
  assert.equal(called, false);
  assert.equal(results[0].status, "invalid");
  assert.match(results[0].error, /loopback/);
});

test("the subtask plan is pinned into the retained contract layer and persisted", async () => {
  const workspace = await createTempWorkspace();
  const client = scriptedClient([turn([{ type: "finish", reason: "done" }])]);
  const plan = {
    schema_version: "subtask-plan@v1",
    mission_restated: "Build it",
    strategy: "inspect, then build",
    subtasks: [
      {
        id: "inspect",
        title: "Inspect",
        goal: "Know the template",
        acceptance: ["a page_inspect report exists"],
        inputs: ["home.html"],
        actions: ["page_inspect"],
        depends_on: [],
      },
    ],
    open_questions: [],
    needs_more_context: false,
    missing_snippets: [],
  };
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "planned",
    approver: createHeadlessApprover({ policy: "allow" }),
    subpromptComposer: {
      async compose() {
        return { plan, fallback: false, attempts: [] };
      },
    },
  });
  const emitted = [];
  session.on("plan", (event) => emitted.push(event));

  const result = await session.submitTask("Build it", []);

  assert.equal(emitted.length, 1);
  const node = [...session.context.nodes.values()].find((entry) => entry.kind === "plan");
  assert.ok(node, "the plan lives in the contract layer, never in droppable scratch");
  assert.equal(node.layer, "contract");
  assert.match(node.text, /\[NOW\] inspect/);
  assert.match(node.text, /done when: a page_inspect report exists/);
  assert.deepEqual(result.plan.subtasks, ["inspect"]);

  const persisted = JSON.parse(
    await fs.readFile(path.join(workspace, ".miniphi", "agent-sessions", "planned", "subtask-plan.json"), "utf8"),
  );
  assert.equal(persisted.plan.subtasks[0].id, "inspect");
});

test("every turn's exact prompt and response land in the trace", async () => {
  const workspace = await createTempWorkspace();
  const client = scriptedClient([
    turn([{ type: "list_dir", path: ".", reason: "look" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const trace = new PromptTrace({
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "traced",
  });
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "traced",
    approver: createHeadlessApprover({ policy: "allow" }),
    trace,
    guidelines: "R1. Orient before you build.",
  });
  await session.submitTask("Look around", []);

  const index = (await fs.readFile(path.join(trace.dir, "index.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(index.length >= 2);
  assert.equal(index[0].kind, "agent-turn");
  assert.equal(index[0].turn, 1);
  const first = JSON.parse(await fs.readFile(path.join(trace.dir, index[0].file), "utf8"));
  assert.match(first.request.messages[0].content, /^R1\. Orient before you build\./);
  assert.ok(first.request.max_tokens > 0, "the turn's real token budget is recorded");
  assert.equal(trace.stats().byKind["agent-turn"], index.length);
});

test("a repeated command failure becomes a lesson injected into the contract layer", async () => {
  const workspace = await createTempWorkspace();
  const client = scriptedClient([
    turn([{ type: "run_cmd", command: "npm install better-sqlite3", reason: "install" }]),
    turn([{ type: "run_cmd", command: "npm install better-sqlite3", reason: "retry" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const learned = [];
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "lessons",
    approver: createHeadlessApprover({ policy: "allow" }),
    runCommand: async () => {
      throw new Error("npm ERR! gyp failed with exit code 1");
    },
    errorLearner: {
      _seen: 0,
      observe() {
        this._seen += 1;
        return { signature: "sig", count: this._seen, shouldLearn: this._seen === 2 };
      },
      pending() {
        return [{ signature: "sig", kind: "run_cmd", count: 2, detail: "gyp failed", samples: [] }];
      },
      async learn(observation) {
        learned.push(observation);
        return {
          ok: true,
          lesson: {
            title: "Native SQLite cannot build here",
            rule: "Use node:sqlite instead of better-sqlite3.",
            cause: "Node 24 headers need a newer C++ standard than the addon's build sets.",
            verification: "node -e \"import('node:sqlite')\" exits 0",
          },
        };
      },
      stats() {
        return { lessons: learned.length };
      },
    },
  });
  const lessonEvents = [];
  session.on("lesson", (event) => lessonEvents.push(event));

  await session.submitTask("Add SQLite", []);

  assert.equal(learned.length, 1, "the first failure is a mistake; the second is a pattern");
  assert.equal(lessonEvents.length, 1);
  const node = [...session.context.nodes.values()].find((entry) =>
    entry.label?.startsWith("lesson:"),
  );
  assert.ok(node, "the lesson is visible to the very next turn");
  assert.equal(node.layer, "contract");
  assert.match(node.text, /Use node:sqlite instead of better-sqlite3\./);
});

test("a gathering subtask is closed by gathering, not left pinned forever", async () => {
  const workspace = await createTempWorkspace();
  await fs.writeFile(path.join(workspace, "home.html"), "<html></html>", "utf8");
  const plan = {
    schema_version: "subtask-plan@v1",
    mission_restated: "m",
    strategy: "s",
    subtasks: [
      {
        id: "inspect",
        title: "Inspect",
        goal: "Know the layout",
        // Read-only only: a validator can never make this pass.
        actions: ["list_dir", "read_file"],
        acceptance: ["the layout has been read"],
        depends_on: [],
      },
      { id: "build", title: "Build", goal: "Write it", actions: ["write_file"], acceptance: ["it exists"], depends_on: ["inspect"] },
    ],
    open_questions: [],
    needs_more_context: false,
    missing_snippets: [],
  };
  const client = scriptedClient([
    turn([{ type: "list_dir", path: ".", reason: "look" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "ratchet",
    approver: createHeadlessApprover({ policy: "allow" }),
    subpromptComposer: {
      async compose() {
        return { plan, fallback: false, attempts: [] };
      },
    },
  });
  const progress = [];
  session.on("plan-progress", (event) => progress.push(event));

  await session.submitTask("Build it", []);

  assert.ok(progress.length >= 1, "the plan advanced off the inspection subtask");
  assert.ok(progress[0].completed.includes("inspect"));
  assert.equal(progress[0].current, "build");
  assert.equal(progress[0].forced, false, "gathering closed it legitimately, not by exhaustion");
});

test("a subtask nobody can finish is force-closed and the model is told", async () => {
  const workspace = await createTempWorkspace();
  const plan = {
    schema_version: "subtask-plan@v1",
    mission_restated: "m",
    strategy: "s",
    subtasks: [
      // No declared actions and no way to satisfy it: the exact shape that
      // pinned a real run for ten turns.
      { id: "ponder", title: "Ponder", goal: "Think hard", acceptance: ["enlightenment"], depends_on: [] },
      { id: "build", title: "Build", goal: "Write it", acceptance: ["it exists"], depends_on: ["ponder"] },
    ],
    open_questions: [],
    needs_more_context: false,
    missing_snippets: [],
  };
  const client = scriptedClient([
    turn([{ type: "search_text", term: "anything", reason: "look" }]),
    turn([{ type: "search_text", term: "anything else", reason: "look" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "forced",
    approver: createHeadlessApprover({ policy: "allow" }),
    maxTurnsPerSubtask: 2,
    subpromptComposer: {
      async compose() {
        return { plan, fallback: false, attempts: [] };
      },
    },
  });
  const progress = [];
  session.on("plan-progress", (event) => progress.push(event));

  await session.submitTask("Build it", []);

  assert.ok(progress.length >= 1);
  assert.equal(progress[0].forced, true);
  const note = [...session.context.nodes.values()].find((node) => node.label === "plan advanced");
  assert.ok(note, "a forced advance is announced, not silent");
  assert.equal(note.layer, "contract");
  assert.match(note.text, /spent 2 turns without finishing/);
  assert.match(note.text, /now "build"/);
});

test("a workspace path written with a leading slash is accepted, not burned", async () => {
  const workspace = await createTempWorkspace();
  await fs.writeFile(path.join(workspace, "home.html"), "<html></html>", "utf8");
  const seen = [];
  const client = scriptedClient([
    turn([{ type: "page_inspect", path: "/home.html", reason: "inspect the template" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "slash",
    approver: createHeadlessApprover({ policy: "allow" }),
    pageInspect: async (request) => {
      seen.push(request.relativePath);
      return { ok: true, response: { mode: "source", source: {} } };
    },
  });
  const results = [];
  session.on("action-result", (event) => results.push(event));

  await session.submitTask("Look", []);

  assert.deepEqual(seen, ["home.html"]);
  assert.equal(results[0].status, "executed");
});

test("the turn trace records whether the response validated", async () => {
  const workspace = await createTempWorkspace();
  const client = scriptedClient([
    "this is not json",
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const trace = new PromptTrace({ baseDir: path.join(workspace, ".miniphi"), sessionId: "valid" });
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "valid",
    approver: createHeadlessApprover({ policy: "allow" }),
    trace,
  });
  await session.submitTask("Do a thing", []);

  const index = (await fs.readFile(path.join(trace.dir, "index.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(index[0].valid, false, "an unparseable turn is recorded as invalid, never as null");
  assert.ok(
    index.some((entry) => entry.valid === true),
    "a good turn is recorded as valid",
  );
});

test("a wedged engine is reloaded before the retry, and the retry gets a smaller prompt", async () => {
  const workspace = await createTempWorkspace();
  let calls = 0;
  const reloads = [];
  const client = {
    async createChatCompletion() {
      calls += 1;
      if (calls === 1) {
        // The exact shape LM Studio returns once its engine is wedged.
        throw new Error(
          "LM Studio REST request failed (400 Bad Request): Engine protocol predict request failed: fetch failed",
        );
      }
      return {
        choices: [{ message: { content: JSON.stringify(turn([{ type: "finish", reason: "done" }])) } }],
      };
    },
  };
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "wedged",
    approver: createHeadlessApprover({ policy: "allow" }),
    contextLength: 32768,
    reloadModel: async () => {
      reloads.push(Date.now());
    },
  });
  const budgetBefore = session.contextBudgetTokens;
  const events = [];
  session.on("context-budget", (event) => events.push(event));
  session.on("engine-recovered", (event) => events.push(event));

  const result = await session.submitTask("Do a thing", []);

  assert.equal(reloads.length, 1, "the engine is reloaded, not just retried into the same wall");
  assert.equal(calls, 2);
  assert.ok(
    session.contextBudgetTokens < budgetBefore,
    "the retry runs against a smaller context, or it reproduces the failure",
  );
  assert.equal(result.requests.engineRecoveries, 1);
  assert.equal(result.requests.budgetShrinks, 1);
});

test("a turn that merely runs close to the ceiling shrinks the budget before one fails", async () => {
  const workspace = await createTempWorkspace();
  const client = {
    async createChatCompletion() {
      // Slow enough to trip the alarm without failing.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        choices: [{ message: { content: JSON.stringify(turn([{ type: "finish", reason: "done" }])) } }],
      };
    },
  };
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "slow",
    approver: createHeadlessApprover({ policy: "allow" }),
    contextLength: 32768,
    requestCeilingMs: 20,
  });
  const before = session.contextBudgetTokens;
  const shrinks = [];
  session.on("context-budget", (event) => shrinks.push(event));

  await session.submitTask("Do a thing", []);

  assert.equal(shrinks.length, 1);
  assert.ok(shrinks[0].current < before);
  assert.equal(shrinks[0].failed, false, "a near-miss is acted on, not only an outright failure");
});

test("an ordinary failure does not reload the engine", async () => {
  const workspace = await createTempWorkspace();
  const reloads = [];
  let calls = 0;
  const client = {
    async createChatCompletion() {
      calls += 1;
      if (calls === 1) {
        throw new Error("read ETIMEDOUT");
      }
      return {
        choices: [{ message: { content: JSON.stringify(turn([{ type: "finish", reason: "done" }])) } }],
      };
    },
  };
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "timeout",
    approver: createHeadlessApprover({ policy: "allow" }),
    contextLength: 32768,
    reloadModel: async () => reloads.push(1),
  });
  await session.submitTask("Do a thing", []);
  assert.deepEqual(reloads, [], "unloading a healthy model would cost minutes for nothing");
});

test("a turn that breaks the app is automatically undone, and the model is told why", async () => {
  const workspace = await createTempWorkspace();
  const appFile = path.join(workspace, "app.js");
  const working = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`).join("\n");
  await fs.writeFile(appFile, working, "utf8");

  const { default: WorkspaceCheckpoints } = await import("../src/libs/workspace-checkpoints.js");
  const checkpoints = new WorkspaceCheckpoints({
    workspaceRoot: workspace,
    baseDir: path.join(workspace, ".miniphi"),
  });

  // Validation: healthy at first, broken once app.js has been gutted.
  const validate = async () => {
    const current = await fs.readFile(appFile, "utf8");
    return current.split("\n").length > 100
      ? { valid: false, issues: ["one small thing"], summary: "nearly there" }
      : { valid: false, issues: ["a", "b", "c", "d"], summary: "the app no longer starts" };
  };

  const client = scriptedClient([
    // The destructive turn: edit_file replacing the whole file with a stub.
    turn([{ type: "edit_file", path: "app.js", content: "const only = 1;\n", reason: "simplify" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "reverted",
    approver: createHeadlessApprover({ policy: "allow" }),
    checkpoints,
    validateWorkspace: validate,
  });
  const reverted = [];
  // The note carries a TTL — it is for the *next* turn, not for posterity — so
  // it is captured when it is written rather than at the end of the run.
  let note = null;
  session.on("auto-reverted", (event) => {
    reverted.push(event);
    note = [...session.context.nodes.values()].find(
      (node) => node.label === "workspace restored automatically",
    );
  });

  const result = await session.submitTask("Simplify the app", []);

  assert.equal(reverted.length, 1, "a measurable regression is undone, not repaired forward");
  // The working file is back.
  assert.equal(await fs.readFile(appFile, "utf8"), working);
  assert.ok(note, "the model is told what happened, in the layer it must read");
  assert.equal(note.layer, "contract");
  assert.match(note.text, /made the workspace worse/);
  assert.match(note.text, /smaller, more targeted change/);
  assert.ok(result.changes.checkpoints >= 2);
  assert.equal(result.changes.reverts, 1);
});

test("the model can revert on its own, and the history is shown so it can name a state", async () => {
  const workspace = await createTempWorkspace();
  const appFile = path.join(workspace, "app.js");
  await fs.writeFile(appFile, "const good = true;\n", "utf8");

  const { default: WorkspaceCheckpoints } = await import("../src/libs/workspace-checkpoints.js");
  const checkpoints = new WorkspaceCheckpoints({
    workspaceRoot: workspace,
    baseDir: path.join(workspace, ".miniphi"),
  });
  await checkpoints.prepare();
  const good = await checkpoints.record({
    label: "working",
    validation: { valid: true, issues: [] },
  });
  await fs.writeFile(appFile, "const broken = ;\n", "utf8");
  await checkpoints.record({ label: "broken", validation: null });

  const client = scriptedClient([
    turn([{ type: "revert_changes", checkpoint: good.id, reason: "my change broke it" }]),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "self-revert",
    approver: createHeadlessApprover({ policy: "allow" }),
    checkpoints,
  });
  const results = [];
  session.on("action-result", (event) => results.push(event));

  await session.submitTask("Fix it", []);

  assert.equal(results[0].status, "executed");
  assert.equal(await fs.readFile(appFile, "utf8"), "const good = true;\n");
  // The prompt has to carry the ids, or the model cannot name one.
  const prompt = client.calls[0].messages[1].content;
  assert.match(prompt, /Change history \(revert_changes can restore any of these\)/);
  assert.match(prompt, new RegExp(good.id));
  assert.match(client.calls[0].messages[0].content, /MiniPhi keeps a version history/);
});

test("a plain English subtask id cannot be closed by a summary that happens to use the word", async () => {
  const workspace = await createTempWorkspace();
  const plan = {
    schema_version: "subtask-plan@v1",
    mission_restated: "m",
    strategy: "s",
    subtasks: [
      // The exact shape of the deterministic fallback before it was slugged.
      { id: "implement", title: "Implement", goal: "Build it", actions: ["write_file"], acceptance: ["done"], depends_on: [] },
      { id: "verify", title: "Verify", goal: "Check it", actions: ["run_cmd"], acceptance: ["exit 0"], depends_on: ["implement"] },
    ],
    open_questions: [],
    needs_more_context: false,
    missing_snippets: [],
  };
  const client = scriptedClient([
    // A perfectly ordinary summary that contains the word "implement".
    turn([{ type: "search_text", term: "x", reason: "look" }], {
      summary: "Reading the code before I implement the feed",
    }),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "wordy",
    approver: createHeadlessApprover({ policy: "allow" }),
    maxTurnsPerSubtask: 99,
    subpromptComposer: {
      async compose() {
        return { plan, fallback: false, attempts: [] };
      },
    },
  });
  const progress = [];
  session.on("plan-progress", (event) => progress.push(event));

  await session.submitTask("Build it", []);

  assert.deepEqual(progress, [], "a coincidence in prose is not evidence a subtask finished");
});

test("a slug-shaped id is still closed when the model names it alongside real progress", async () => {
  const workspace = await createTempWorkspace();
  const plan = {
    schema_version: "subtask-plan@v1",
    mission_restated: "m",
    strategy: "s",
    subtasks: [
      { id: "implement-task", title: "Implement", goal: "Build it", actions: ["write_file"], acceptance: ["done"], depends_on: [] },
      { id: "verify-with-tests", title: "Verify", goal: "Check it", actions: ["run_cmd"], acceptance: ["exit 0"], depends_on: ["implement-task"] },
    ],
    open_questions: [],
    needs_more_context: false,
    missing_snippets: [],
  };
  const client = scriptedClient([
    turn([{ type: "write_file", path: "a.js", content: "export const a = 1;\n", reason: "build" }], {
      summary: "Finished implement-task: wrote the module",
    }),
    turn([{ type: "finish", reason: "done" }]),
  ]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "slugged",
    approver: createHeadlessApprover({ policy: "allow" }),
    maxTurnsPerSubtask: 99,
    subpromptComposer: {
      async compose() {
        return { plan, fallback: false, attempts: [] };
      },
    },
  });
  const progress = [];
  session.on("plan-progress", (event) => progress.push(event));

  await session.submitTask("Build it", []);

  assert.equal(progress.length, 1);
  assert.equal(progress[0].current, "verify-with-tests");
});

test("edits that never move the validation are answered with where to look", async () => {
  const workspace = await createTempWorkspace();
  await fs.writeFile(path.join(workspace, "db.js"), "export const db = 1;\n", "utf8");

  // The validator never changes its mind: the code at fault is elsewhere.
  const issue =
    'Include a non-empty "imageUrl" on every post returned by GET /api/posts. The uploaded post came back without it.';
  const validate = async () => ({ valid: false, issues: [issue], summary: "not working yet" });

  const write = (n) =>
    turn([{ type: "write_file", path: "db.js", content: `export const db = ${n};\n`, reason: "fix" }], {
      summary: "Fix the missing imageUrl by updating db.js",
    });
  const client = scriptedClient([write(2), write(3), write(4), turn([{ type: "finish", reason: "done" }])]);
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir: path.join(workspace, ".miniphi"),
    sessionId: "stalled",
    approver: createHeadlessApprover({ policy: "allow" }),
    validateWorkspace: validate,
  });

  await session.submitTask("Fix the API", []);

  const hint = [...session.context.nodes.values()].find(
    (node) => node.label === "changes are not reaching the problem",
  );
  assert.ok(hint, "a stalled validation must be named, not silently repeated");
  assert.equal(hint.layer, "contract");
  assert.match(hint.text, /word-for-word unchanged/);
  // It names the tool and the exact thing to grep for.
  assert.match(hint.text, /search_text/);
  assert.match(hint.text, /"\/api\/posts"/);
  assert.match(hint.text, /db\.js/);
});

test("a search term is only suggested when the issue offers a specific one", async () => {
  const { extractSearchTerm } = await import("../src/agent/agent-session.js");
  assert.equal(
    extractSearchTerm('Include a non-empty "imageUrl" on every post returned by GET /api/posts.'),
    "/api/posts",
  );
  assert.equal(extractSearchTerm('Include a non-empty "imageUrl" on every post.'), "imageUrl");
  assert.equal(extractSearchTerm("Rewrite `server/package.json` as valid JSON."), "server/package.json");
  assert.equal(extractSearchTerm("Something is wrong somewhere."), null);
});
