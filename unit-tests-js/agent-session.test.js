import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";

/**
 * Builds a stub LM Studio client that returns each scripted turn's JSON in
 * order. Records the messages it was called with for assertions.
 */
function scriptedClient(turns) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async createChatCompletion({ messages }) {
      calls.push(messages);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      const content = typeof turn === "string" ? turn : JSON.stringify(turn);
      return { choices: [{ message: { content } }] };
    },
  };
}

const turn = (actions, extra = {}) => ({
  task: "demo",
  summary: extra.summary ?? "working",
  summary_updates: extra.summary_updates ?? [],
  actions,
  needs_more_context: extra.needs_more_context ?? false,
  missing_snippets: extra.missing_snippets ?? [],
});

test("AgentSession runs read -> approved write -> finish and applies the edit", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "a.js"), "export const a = 1;\n", "utf8");

    const client = scriptedClient([
      turn([{ type: "read_file", path: "src/a.js", reason: "inspect" }]),
      turn([
        {
          type: "write_file",
          path: "src/b.js",
          content: "export const b = 2;\n",
          reason: "add module",
          danger: "low",
        },
      ]),
      turn([{ type: "finish", reason: "done" }], { summary: "Added src/b.js" }),
    ]);

    const events = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: path.join(workspace, ".miniphi"),
      sessionId: "test-write",
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    for (const name of ["status", "action-start", "action-result", "edit-proposed", "done"]) {
      session.on(name, (payload) => events.push({ name, payload }));
    }

    const result = await session.submitTask("Add a b module", ["src/a.js"]);

    assert.equal(result.status, "completed");
    assert.equal(result.stopReason, "completed");
    assert.equal(await fs.readFile(path.join(workspace, "src", "b.js"), "utf8"), "export const b = 2;\n");
    assert.equal(result.edits.length, 1);
    assert.equal(result.edits[0].status, "written");

    assert.ok(events.some((e) => e.name === "edit-proposed"));
    assert.ok(events.some((e) => e.name === "action-result" && e.payload.status === "written"));

    // Transcript + result persisted under the session dir.
    const sessionDir = path.join(workspace, ".miniphi", "agent-sessions", "test-write");
    const transcript = await fs.readFile(path.join(sessionDir, "transcript.jsonl"), "utf8");
    assert.match(transcript, /"kind":"edit"/);
    const persisted = JSON.parse(await fs.readFile(path.join(sessionDir, "result.json"), "utf8"));
    assert.equal(persisted.stopReason, "completed");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession replaces stale file context with the guarded post-edit source", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "src", "state.js"),
      "export const state = \"old\";\n",
      "utf8",
    );
    const client = scriptedClient([
      turn([{ type: "read_file", path: "src/state.js", reason: "inspect" }]),
      turn([
        {
          type: "edit_file",
          path: "src/state.js",
          content: "export const state = \"current\";\n",
          reason: "update state",
        },
      ]),
      turn([{ type: "read_file", path: "src/state.js", reason: "verify current source" }]),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const actionResults = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("action-result", (entry) => actionResults.push(entry));

    const result = await session.submitTask("Update the state");

    assert.equal(result.status, "completed");
    assert.match(
      client.calls[2][1].content,
      /Current src\/state\.js after the guarded write:/,
    );
    assert.match(client.calls[3][1].content, /state = "current"/);
    const fileReads = [...session.context.nodes.values()].filter(
      (node) => node.label === "read_file src/state.js",
    );
    assert.equal(fileReads.filter((node) => node.state === "dropped").length, 1);
    assert.equal(fileReads.filter((node) => node.state === "active").length, 1);
    assert.equal(
      actionResults.filter(
        (entry) =>
          entry.action?.type === "read_file" && entry.status === "executed",
      ).length,
      2,
      "a successful write must invalidate the cached pre-edit read",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession forwards corrective-feedback TTLs into the context graph", () => {
  const session = new AgentSession({
    client: scriptedClient([]),
    baseDir: null,
  });
  const node = session._remember({
    layer: "contract",
    label: "bounded correction",
    text: "Use the validation result on the next turn.",
    ttlTurns: 2,
  });
  assert.equal(node.ttlTurns, 2);
});

test("AgentSession feeds structured web research into the next model turn", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([
        {
          type: "web_research",
          query: "best lightweight JavaScript 2D physics library",
          max_results: 3,
          reason: "compare current options",
        },
      ]),
      turn(
        [{ type: "finish", reason: "research complete" }],
        { summary: "Selected Matter.js after research" },
      ),
    ]);
    const researchCalls = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: path.join(workspace, ".miniphi"),
      sessionId: "test-research",
      approver: createHeadlessApprover({ policy: "allow" }),
      webResearch: async (query, options) => {
        researchCalls.push({ query, options });
        return {
          query,
          provider: "test",
          fetchedAt: "2026-07-25T00:00:00.000Z",
          results: [
            {
              title: "Matter.js",
              url: "https://brm.io/matter-js/",
              snippet: "A 2D physics engine for the web.",
              source: "brm.io",
              rank: 1,
            },
          ],
        };
      },
    });

    const result = await session.submitTask("Choose a library");

    assert.equal(result.status, "completed");
    assert.equal(researchCalls.length, 1);
    assert.equal(researchCalls[0].options.maxResults, 3);
    assert.match(client.calls[1][1].content, /Matter\.js/);
    assert.match(client.calls[1][1].content, /"provider": "test"/);
    const transcript = await fs.readFile(
      path.join(workspace, ".miniphi", "agent-sessions", "test-research", "transcript.jsonl"),
      "utf8",
    );
    assert.match(transcript, /"kind":"research"/);
    assert.match(transcript, /best lightweight JavaScript 2D physics library/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession can prefetch structured research before the first model turn", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([{ type: "finish", reason: "done" }], { summary: "Used preflight research" }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      requireWebResearch: true,
      maxWebResearchActions: 1,
      initialResearchQueries: ["best browser 2D physics library"],
      webResearch: async (query) => ({
        query,
        provider: "test",
        results: [{ title: "Matter.js", url: "https://brm.io/matter-js/" }],
      }),
    });

    const result = await session.submitTask("Create an animation");

    assert.equal(result.status, "completed");
    assert.match(client.calls[0][1].content, /Matter\.js/);
    assert.match(client.calls[0][1].content, /research budget exhausted/i);
    assert.doesNotMatch(client.calls[0][1].content, /perform at least one successful web_research/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession can require research before allowing project mutations", async () => {
  const workspace = await createTempWorkspace();
  try {
    const write = {
      type: "write_file",
      path: "index.html",
      content: "<canvas></canvas>\n",
      reason: "create page",
      danger: "low",
    };
    const client = scriptedClient([
      turn([write]),
      turn([
        {
          type: "web_research",
          query: "JavaScript 2D physics libraries",
          max_results: 3,
          reason: "compare libraries",
        },
      ]),
      turn([write]),
      turn([{ type: "finish", reason: "done" }], { summary: "Created page after research" }),
    ]);
    const statuses = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      requireWebResearch: true,
      approver: createHeadlessApprover({ policy: "allow" }),
      webResearch: async (query) => ({
        query,
        provider: "test",
        results: [{ title: "Matter.js", url: "https://brm.io/matter-js/" }],
      }),
    });
    session.on("action-result", (result) => statuses.push(result.status));

    const result = await session.submitTask("Create a researched animation");

    assert.equal(result.status, "completed");
    assert.ok(statuses.includes("research-required"));
    assert.equal(result.edits.filter((edit) => edit.status === "written").length, 1);
    assert.equal(await fs.readFile(path.join(workspace, "index.html"), "utf8"), "<canvas></canvas>\n");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession caps web research loops and tells the model to implement", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([{ type: "web_research", query: "first query", reason: "compare" }]),
      turn([{ type: "web_research", query: "second query", reason: "keep comparing" }]),
      turn([{ type: "finish", reason: "done" }], { summary: "Used the available research" }),
    ]);
    const statuses = [];
    let researchCalls = 0;
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      maxWebResearchActions: 1,
      webResearch: async (query) => {
        researchCalls += 1;
        return { query, provider: "test", results: [] };
      },
    });
    session.on("action-result", (result) => statuses.push(result.status));

    const result = await session.submitTask("Research briefly");

    assert.equal(result.status, "completed");
    assert.equal(researchCalls, 1);
    assert.ok(statuses.includes("skipped-budget"));
    assert.match(client.calls[2][1].content, /research budget exhausted/i);
    assert.match(client.calls[2][1].content, /implement.*now/i);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession records a rejection and leaves files untouched", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([{ type: "write_file", path: "danger.js", content: "boom\n", reason: "risky", danger: "high" }]),
      turn([{ type: "finish", reason: "stopped after rejection" }], { summary: "no changes" }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      approver: createHeadlessApprover({ policy: "deny" }),
    });
    const results = [];
    session.on("action-result", (p) => results.push(p));

    const result = await session.submitTask("Try a risky write");
    assert.equal(result.edits.length, 0);
    assert.equal(await fileExists(path.join(workspace, "danger.js")), false);
    assert.ok(results.some((r) => r.status === "rejected"));
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession dedupes repeated identical writes and finishes as completed", async () => {
  const workspace = await createTempWorkspace();
  try {
    // The model keeps re-proposing the same write and never emits `finish`
    // (the exact behavior seen in the live proof run).
    const client = scriptedClient([
      turn([{ type: "write_file", path: "slug.js", content: "export const s = 1;\n", reason: "add" }]),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      maxTurns: 8,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    const statuses = [];
    session.on("action-result", (p) => statuses.push(p.status));

    const result = await session.submitTask("Add slug.js");
    assert.equal(result.status, "completed");
    assert.equal(result.stopReason, "completed");
    // Written exactly once; later identical proposals are deduped, not re-applied.
    assert.equal(result.edits.filter((e) => e.status === "written").length, 1);
    assert.ok(statuses.includes("duplicate"), "repeated identical write is deduped");
    assert.ok(result.turns < 8, "stops well before the turn budget");
    assert.equal(await fs.readFile(path.join(workspace, "slug.js"), "utf8"), "export const s = 1;\n");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession does not report completion after repeated no-op reads", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([{ type: "list_dir", path: ".", reason: "inspect" }]),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      maxTurns: 8,
    });

    const result = await session.submitTask("Create something");
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, "no-progress");
    assert.ok(result.turns < 8);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession feeds workspace validation issues back and auto-finishes when valid", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([
        {
          type: "write_file",
          path: "index.html",
          content: "<canvas></canvas>",
          reason: "first draft",
        },
      ]),
      turn([]),
      turn([
        {
          type: "write_file",
          path: "index.html",
          content: "<canvas>basketball gravity</canvas>",
          reason: "address validation",
        },
      ]),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      approver: createHeadlessApprover({ policy: "allow" }),
      validateWorkspace: async ({ cwd }) => {
        const content = await fs.readFile(path.join(cwd, "index.html"), "utf8").catch(() => "");
        const issues = [];
        if (!content.includes("basketball")) issues.push("identify the ball as a basketball");
        if (!content.includes("gravity")) issues.push("add gravity");
        return {
          valid: issues.length === 0,
          summary: issues.length ? "Basketball checks failed." : "Basketball checks passed.",
          issues,
        };
      },
    });

    const result = await session.submitTask("Create a basketball page");

    assert.equal(result.status, "completed");
    assert.equal(result.turns, 3);
    assert.equal(result.validation.valid, true);
    assert.match(
      client.calls[0][1].content,
      /summary describing intended changes is not progress/i,
    );
    assert.match(client.calls[1][1].content, /identify the ball as a basketball/);
    assert.match(client.calls[1][1].content, /add gravity/);
    assert.match(client.calls[2][1].content, /MUST contain concrete write_file\/edit_file fixes/);
    assert.ok(
      [...session.context.nodes.values()]
        .filter((node) => node.kind === "validation")
        .every((node) => node.state === "dropped"),
      "a passing validation must retire every obsolete validation failure",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession rejects same-path conflicts without starving later independent actions", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([
        { type: "write_file", path: "index.html", content: "first\n", reason: "create" },
        { type: "write_file", path: "index.html", content: "second\n", reason: "style" },
        { type: "write_file", path: "notes.txt", content: "kept\n", reason: "document" },
      ]),
      turn([{ type: "finish", reason: "done" }], { summary: "Kept one coherent write" }),
    ]);
    const statuses = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      maxActionsPerTurn: 2,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("action-result", (result) => statuses.push(result.status));

    const result = await session.submitTask("Create one file");
    assert.equal(result.status, "completed");
    assert.ok(statuses.includes("conflicting-action"));
    assert.equal(await fs.readFile(path.join(workspace, "index.html"), "utf8"), "first\n");
    assert.equal(await fs.readFile(path.join(workspace, "notes.txt"), "utf8"), "kept\n");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession falls back to a stop reason when the model drifts off-schema", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient(["I refuse to output JSON, here is prose instead."]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      maxTurns: 3,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    const result = await session.submitTask("Do something");
    assert.equal(result.status, "stopped");
    assert.match(result.stopReason, /invalid-response/);
    // Two model calls: the initial attempt plus one compact nudge.
    assert.equal(client.calls.length, 2);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession retries one transient model request failure", async () => {
  const workspace = await createTempWorkspace();
  try {
    let calls = 0;
    const client = {
      async createChatCompletion() {
        calls += 1;
        if (calls === 1) {
          throw new Error("fetch failed");
        }
        return {
          choices: [
            {
              message: {
                content: JSON.stringify(
                  turn([{ type: "finish", reason: "done" }], { summary: "Recovered" }),
                ),
              },
            },
          ],
        };
      },
    };
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      approver: createHeadlessApprover({ policy: "allow" }),
    });

    const result = await session.submitTask("Recover from one transport error");
    assert.equal(result.status, "completed");
    assert.equal(result.summary, "Recovered");
    assert.equal(calls, 2);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
