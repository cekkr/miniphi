import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import LocalContextMemory from "../src/libs/local-context-memory.js";

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

test("AgentSession runs visual_review and feeds the vision model's critique into the next turn", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "index.html"), "<canvas></canvas>\n", "utf8");
    const client = scriptedClient([
      turn([
        {
          type: "visual_review",
          path: "index.html",
          focus: "does the ball look round and orange",
          reason: "check rendered quality before finishing",
        },
      ]),
      turn([{ type: "finish", reason: "addressed feedback" }], { summary: "Fixed the ball shading" }),
    ]);
    const reviewCalls = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: path.join(workspace, ".miniphi"),
      sessionId: "test-visual",
      approver: createHeadlessApprover({ policy: "allow" }),
      visionReview: async (request) => {
        reviewCalls.push(request);
        return {
          ok: true,
          response: {
            matches_intent: false,
            quality_score: 40,
            description: "A plain gray circle with no seam detail.",
            issues: ["The ball has no orange color or seam lines."],
            suggestions: ["Fill the circle orange and add curved seam strokes."],
            page_errors: [],
          },
        };
      },
    });

    const result = await session.submitTask("Create a bouncing basketball page");

    assert.equal(result.status, "completed");
    assert.equal(reviewCalls.length, 1);
    assert.equal(reviewCalls[0].path, "index.html");
    assert.equal(reviewCalls[0].focus, "does the ball look round and orange");
    assert.match(client.calls[1][1].content, /seam lines/);
    assert.match(client.calls[1][1].content, /Fill the circle orange/);
    // The vision-review guide is only advertised when a reviewer is configured
    // (the schema itself always lists visual_review as a valid action type,
    // so this checks the guidance text rather than the enum entry).
    assert.match(client.calls[0][0].content, /vision-capable model is available/);
    const transcript = await fs.readFile(
      path.join(workspace, ".miniphi", "agent-sessions", "test-visual", "transcript.jsonl"),
      "utf8",
    );
    assert.match(transcript, /"kind":"visual"/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession reports visual_review as unavailable when no vision model is configured", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "index.html"), "<canvas></canvas>\n", "utf8");
    const client = scriptedClient([
      turn([{ type: "visual_review", path: "index.html", reason: "check rendered quality" }]),
      turn([{ type: "finish", reason: "no vision model available" }]),
    ]);
    const statuses = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
    });
    session.on("action-result", (result) => statuses.push(result.status));

    const result = await session.submitTask("Create a bouncing basketball page");

    assert.equal(result.status, "completed");
    assert.ok(statuses.includes("unavailable"));
    // Without a configured reviewer, the guide must not be advertised.
    assert.doesNotMatch(client.calls[0][0].content, /vision-capable model is available/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession runs knowledge_lookup and feeds retrieved facts into the next turn", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([
        {
          type: "knowledge_lookup",
          subject: "Springfield",
          reason: "check recorded facts before asserting one",
        },
      ]),
      turn([{ type: "finish", reason: "used the recorded fact" }], { summary: "Answered from the knowledge base" }),
    ]);
    const lookupCalls = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: path.join(workspace, ".miniphi"),
      sessionId: "test-knowledge",
      approver: createHeadlessApprover({ policy: "allow" }),
      knowledgeLookup: async (request) => {
        lookupCalls.push(request);
        return {
          ok: true,
          response: {
            resolved: true,
            nodeId: "topic:springfield",
            facts: [{ id: "place:illinois", via: [{ type: "located_in" }] }],
          },
        };
      },
    });

    const result = await session.submitTask("What do you know about Springfield?");

    assert.equal(result.status, "completed");
    assert.equal(lookupCalls.length, 1);
    assert.equal(lookupCalls[0].subject, "Springfield");
    assert.match(client.calls[1][1].content, /located_in/);
    // The knowledge_lookup guide is only advertised when a lookup function is
    // configured (the schema itself always lists knowledge_lookup as a valid
    // action type, so this checks the guidance text, not the enum entry).
    assert.match(client.calls[0][0].content, /knowledge base .* is available/);
    const transcript = await fs.readFile(
      path.join(workspace, ".miniphi", "agent-sessions", "test-knowledge", "transcript.jsonl"),
      "utf8",
    );
    assert.match(transcript, /"kind":"knowledge"/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession reports knowledge_lookup as unavailable when no knowledge base is configured", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([{ type: "knowledge_lookup", subject: "Springfield", reason: "check recorded facts" }]),
      turn([{ type: "finish", reason: "no knowledge base available" }]),
    ]);
    const statuses = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
    });
    session.on("action-result", (result) => statuses.push(result.status));

    const result = await session.submitTask("What do you know about Springfield?");

    assert.equal(result.status, "completed");
    assert.ok(statuses.includes("unavailable"));
    // Without a configured lookup function, the guide must not be advertised.
    assert.doesNotMatch(client.calls[0][0].content, /knowledge base .* is available/);
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

test("AgentSession merges durable .miniphi memory with graph recall and writes back what it learns", async () => {
  const workspace = await createTempWorkspace();
  try {
    const baseDir = path.join(workspace, ".miniphi");
    const memory = new LocalContextMemory({ baseDir });
    await memory.prepare();
    // A fact a *previous* session left behind, on disk only.
    await memory.remember({
      kind: "decision",
      title: "upload driver",
      text: "An earlier session chose better-sqlite3 as the storage driver for uploaded photos.",
      sessionId: "previous-session",
    });

    // A graph-recalled candidate, plus one that duplicates the local sentence
    // verbatim — the merged pool must pay for that sentence exactly once.
    const duplicated =
      "An earlier session chose better-sqlite3 as the storage driver for uploaded photos.";
    const contextEngine = {
      required: false,
      async select() {
        return {
          ok: true,
          engine: "cheetah",
          preferredNodeIds: ["c1"],
          referenceCandidates: [
            { id: "c1:r1", text: "The mission is to store uploaded photos.", sourceNodeId: "c1" },
            { id: "c1:r2", text: duplicated, sourceNodeId: "c1" },
          ],
        };
      },
      async sync() {
        return { ok: true };
      },
      stats() {
        return { engine: "cheetah" };
      },
    };

    let composedCandidates = null;
    const client = scriptedClient([
      turn(
        [{ type: "finish", reason: "done" }],
        { summary: "Chose the storage driver." },
      ),
    ]);

    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir,
      sessionId: "current-session",
      contextEngine,
      localMemory: memory,
      approver: createHeadlessApprover({ policy: "allow" }),
      contextReferenceComposer: {
        async compose({ candidates }) {
          composedCandidates = candidates;
          return { selected: [], audit: { fallback: null } };
        },
        render: () => "",
      },
    });

    const result = await session.submitTask(
      "Store uploaded photos for the feed using a storage driver.",
    );

    assert.ok(composedCandidates, "the composer must be asked to select from the merged pool");
    const texts = composedCandidates.map((candidate) => candidate.text);
    assert.ok(
      texts.includes("The mission is to store uploaded photos."),
      "graph-recalled candidates survive the merge",
    );
    assert.equal(
      texts.filter((text) => text === duplicated).length,
      1,
      "a sentence held in both stores is offered once, not twice",
    );
    // Local candidates must never look like a live graph node to the boost path.
    for (const candidate of composedCandidates.filter((entry) => entry.origin === "local")) {
      assert.match(candidate.id, /^local:/);
      assert.equal(candidate.sourceNodeId, null);
    }

    // The session's own verdict becomes durable memory for the next run.
    assert.equal(result.context.localMemory.enabled, true);
    const reopened = new LocalContextMemory({ baseDir });
    await reopened.prepare();
    const recap = reopened.recall({ text: "how did the session about the storage driver end?" });
    assert.ok(
      recap.referenceCandidates.some((candidate) => /current-session|stopped with reason/.test(candidate.text)),
      "a recap of this session is recallable afterwards",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("the durable-memory seed follows the run instead of repeating the mission", async () => {
  const workspace = await createTempWorkspace();
  try {
    const seeds = [];
    const memory = {
      sessionId: null,
      recall({ text }) {
        seeds.push(text);
        return { referenceCandidates: [] };
      },
      async remember() {
        return null;
      },
      stats() {
        return { engine: "local", records: 0 };
      },
    };
    const client = scriptedClient([
      turn([{ type: "list_dir", path: ".", reason: "look" }], { summary: "Inspecting the workspace layout." }),
      turn([{ type: "finish", reason: "done" }], { summary: "Chose the storage driver after the port clash." }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      sessionId: "s",
      localMemory: memory,
      approver: createHeadlessApprover({ policy: "allow" }),
      validateWorkspace: async () => ({
        valid: false,
        summary: "not yet",
        issues: ["Serve GET /health so it answers 200 with the JSON body."],
      }),
      contextReferenceComposer: {
        async compose() {
          return { selected: [], audit: { fallback: null } };
        },
        render: () => "",
      },
    });

    await session.submitTask("Build a photo social network with SQLite storage.");

    assert.ok(seeds.length >= 2, "the store is asked once per turn");
    // Every seed carries the mission, but a seed that carries *only* the mission
    // asks the same question every turn and can never follow the work.
    for (const seed of seeds) {
      assert.match(seed, /photo social network/);
    }
    assert.ok(
      seeds.some((seed) => /Serve GET \/health/.test(seed)),
      "the open validation issue must reach the seed",
    );
    assert.ok(
      seeds.some((seed) => /Inspecting the workspace layout/.test(seed)),
      "the previous turn's own summary must reach the seed",
    );
    assert.ok(
      new Set(seeds).size > 1,
      "seeds must differ between turns, or recall returns the same records forever",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a turn cut off by the token limit is reported as a length problem, not a syntax one", async () => {
  const workspace = await createTempWorkspace();
  try {
    // Turn 1 is truncated mid-`content`; turn 2 finishes normally. The model
    // must be told about the cut-off before it tries to debug the rejection.
    let index = 0;
    const client = {
      async createChatCompletion() {
        index += 1;
        if (index === 1) {
          return {
            choices: [
              {
                finish_reason: "length",
                message: { content: JSON.stringify(turn([{ type: "list_dir", path: ".", reason: "look" }])) },
              },
            ],
          };
        }
        return {
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(turn([{ type: "finish", reason: "done" }])) },
            },
          ],
        };
      },
    };

    const session = new AgentSession({
      client,
      cwd: workspace,
      maxTurnTokens: 4000,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    await session.submitTask("build something large");

    const notes = [...session.context.nodes.values()].filter(
      (node) => node.label === "response truncated",
    );
    assert.equal(notes.length, 1, "the truncation must be reported exactly once");
    // It has to land in the retained layer, or budget pressure demotes the one
    // note that explains the failure.
    assert.equal(notes[0].layer, "contract");
    assert.match(notes[0].text, /4000 tokens/);
    assert.match(notes[0].text, /length problem, not a syntax mistake/);
    assert.match(notes[0].text, /smaller modules/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a large file rejected twice is steered into smaller modules", async () => {
  const workspace = await createTempWorkspace();
  const big = (marker) => `${"const x = 1;\n".repeat(200)}function broken() { ${marker}\n`;
  const hintFor = async (proposals) => {
    const client = scriptedClient([
      ...proposals.map((marker) =>
        turn([{ type: "write_file", path: "app.js", content: big(marker), reason: "entry" }]),
      ),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    await session.submitTask("write the app");
    return [...session.context.nodes.values()]
      .filter((node) => /invalid-content/.test(node.label ?? ""))
      .map((node) => node.text)
      .join("\n");
  };

  try {
    // One bad attempt is a typo: the ordinary literal-anchor repair, nothing more.
    const once = await hintFor(["("]);
    assert.match(once, /invalid JavaScript syntax/);
    assert.doesNotMatch(
      once,
      /Split it into smaller modules/,
      "a first failure is an ordinary repair, not a restructuring order",
    );

    // Twice on the same large file is the file being too big to emit correctly,
    // and re-proposing it whole only moves the error.
    const twice = await hintFor(["(", "}}}"]);
    assert.match(twice, /proposed app\.js 2 times/);
    assert.match(twice, /178 lines long|\d+ lines long/);
    assert.match(twice, /Split it into smaller modules/);
    assert.match(twice, /write ONE small module this turn/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a short file rejected twice keeps the ordinary repair hint", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([{ type: "write_file", path: "small.js", content: "const a = (;\n", reason: "x" }]),
      turn([{ type: "write_file", path: "small.js", content: "const a = );\n", reason: "x" }]),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    await session.submitTask("write a small file");
    const hints = [...session.context.nodes.values()]
      .filter((node) => /invalid-content/.test(node.label ?? ""))
      .map((node) => node.text);
    assert.ok(hints.length >= 2);
    for (const hint of hints) {
      assert.doesNotMatch(hint, /Split it into smaller modules/);
    }
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a brand-new corrective instruction buys one turn before the idle guard trips", async () => {
  const workspace = await createTempWorkspace();
  try {
    // Two rejections of one big file issue the split instruction on turn 2.
    // Without the grace the idle guard trips on that same turn — the run would
    // stop for not yet having followed advice it had no turn to follow, which
    // is exactly what happened live.
    const big = (marker) => `${"const x = 1;\n".repeat(200)}function broken() { ${marker}\n`;
    const client = scriptedClient([
      turn([{ type: "write_file", path: "app.js", content: big("("), reason: "entry" }]),
      turn([{ type: "write_file", path: "app.js", content: big("}}}"), reason: "retry" }]),
      turn([{ type: "read_file", path: "missing.js", reason: "look" }]),
      turn([{ type: "read_file", path: "missing.js", reason: "look" }]),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      maxTurns: 8,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    const result = await session.submitTask("write the app");
    assert.equal(result.stopReason, "no-progress", "the guard must still stop an unproductive run");
    assert.equal(
      result.turns,
      3,
      "the grace is worth exactly one turn: idle on 1, excused on 2, stopped on 3",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("the same corrective instruction never buys a second grace", async () => {
  const workspace = await createTempWorkspace();
  try {
    const session = new AgentSession({ client: scriptedClient([]), cwd: workspace });
    session._grantCorrectionGrace("split:app.js");
    assert.equal(session._consumeCorrectionGrace(), true);
    session._grantCorrectionGrace("split:app.js");
    assert.equal(
      session._consumeCorrectionGrace(),
      false,
      "repeating one instruction must not keep excusing idle turns",
    );
    // Distinct instructions each get one, up to the cap.
    for (const key of ["truncated", "split:b.js", "split:c.js", "split:d.js"]) {
      session._grantCorrectionGrace(key);
      session._consumeCorrectionGrace();
    }
    session._grantCorrectionGrace("split:e.js");
    assert.equal(session._consumeCorrectionGrace(), false, "the cap must bind");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("an identical re-write of a file that is still failing validation is not called done", async () => {
  const workspace = await createTempWorkspace();
  try {
    // A plain text file, so the pre-write JSON/JS guards do not intercept it:
    // the point here is the *duplicate* path, reached only once the content is
    // written and the workspace validator is still unhappy about it.
    const content = "server: listen 0\n";
    const client = scriptedClient([
      turn([{ type: "write_file", path: "config.yml", content, reason: "create" }]),
      turn([{ type: "write_file", path: "config.yml", content, reason: "fix it" }]),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      approver: createHeadlessApprover({ policy: "allow" }),
      validateWorkspace: async () => ({
        valid: false,
        summary: "broken",
        issues: ["Set a real port in config.yml; 0 is not a valid port."],
      }),
    });
    await session.submitTask("write the config");

    const notes = [...session.context.nodes.values()]
      .filter((node) => /duplicate/.test(node.label ?? ""))
      .map((node) => node.text)
      .join("\n");
    assert.match(notes, /byte-identical content/);
    assert.match(notes, /STILL failing validation/);
    assert.match(notes, /send different content/);
    assert.doesNotMatch(
      notes,
      /MUST be a single finish action/,
      "a file that is still failing validation must never be reported as done",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("only the path the validator is currently failing on is treated as unfinished", async () => {
  const workspace = await createTempWorkspace();
  try {
    const session = new AgentSession({ client: scriptedClient([]), cwd: workspace });

    // No validation has run: a duplicate is just a duplicate.
    assert.equal(session._pathFailingValidation("server/package.json"), null);

    session._lastValidation = { valid: true, summary: "ok", issues: [] };
    assert.equal(session._pathFailingValidation("server/package.json"), null);

    session._lastValidation = {
      valid: false,
      summary: "broken",
      issues: ["Add the server entry point in server/ (app.js, server.js or index.js)."],
    };
    assert.equal(
      session._pathFailingValidation("server/package.json"),
      null,
      "an issue about another path must not mark this one unfinished",
    );

    session._lastValidation = {
      valid: false,
      summary: "broken",
      issues: ["Rewrite server/package.json as valid JSON."],
    };
    assert.match(
      session._pathFailingValidation("server/package.json"),
      /Rewrite server\/package\.json as valid JSON/,
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("the session recap records what happened, not a restatement of the task", async () => {
  const workspace = await createTempWorkspace();
  try {
    const baseDir = path.join(workspace, ".miniphi");
    const memory = new LocalContextMemory({ baseDir });
    await memory.prepare();
    // A realistic multi-line operator task: a full contract, not one sentence.
    const task = [
      "Build a real, working photo social network as a Node.js application.",
      "",
      "The following HTTP contract is verified automatically after every change:",
      "- GET /health -> 200 JSON",
      "- POST /register -> creates the user in SQLite",
      "- GET /feed -> 200 HTML listing the posts",
    ].join("\n");

    const client = scriptedClient([
      turn([{ type: "write_file", path: "app.js", content: "export const a = 1;\n", reason: "x" }]),
      turn([{ type: "finish", reason: "done" }], { summary: "Created the entry point and the schema." }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir,
      sessionId: "s1",
      localMemory: memory,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    await session.submitTask(task);

    const recap = [...memory._records.values()].find((record) => record.kind === "recap");
    assert.ok(recap, "a recap is written when the session ends");
    const text = recap.references.map((reference) => reference.text).join("\n");
    // One line of task as an anchor, and none of the contract body.
    assert.match(text, /Build a real, working photo social network/);
    assert.doesNotMatch(
      text,
      /GET \/health|POST \/register|GET \/feed/,
      "the recap must not swallow the whole task contract",
    );
    // What actually happened is what a later run needs.
    assert.match(text, /Created the entry point and the schema/);
    assert.match(text, /stopped with reason/);
    assert.match(text, /app\.js/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("each mutation failure gets the recovery instruction that matches it", async () => {
  const workspace = await createTempWorkspace();
  try {
    const session = new AgentSession({ client: scriptedClient([]), cwd: workspace });

    // A missed anchor must explain anchors. This is the case that previously
    // got no guidance at all, while the anchor lecture went to syntax errors.
    const first = session._repairHint("anchor-not-found", { path: "package.json" });
    assert.match(first, /exact literal substring/);
    assert.doesNotMatch(first, /Stop guessing anchors/);

    // Missing it twice means the model's idea of the file is wrong; guessing
    // again cannot fix that, so it is told to read and replace wholesale.
    const second = session._repairHint("anchor-not-found", { path: "package.json" });
    assert.match(second, /missed an anchor in package\.json 2 times/);
    assert.match(second, /read_file package\.json first/);
    assert.match(second, /full replacement content and no anchor at all/);
    // And it buys one turn to act on that new instruction.
    assert.equal(session._consumeCorrectionGrace(), true);

    // A syntax failure must not be answered with a lecture about anchors.
    const syntax = session._repairHint("invalid-content", { path: "a.js", content: "x" });
    assert.match(syntax, /complete, parseable text/);
    assert.doesNotMatch(syntax, /literal substring/);

    // Editing a file that does not exist has its own one-line remedy.
    assert.match(session._repairHint("missing-file", { path: "b.js" }), /Create it with write_file/);

    // A dropped same-turn edit must say the file is now *half*-changed. Without
    // that, the model sees its first edit succeed and believes the whole fix
    // landed — live, `import multer` was applied while the initialisation that
    // made it useful was discarded.
    const conflict = session._repairHint("conflicting-action", { path: "index.js" });
    assert.match(conflict, /Only the first change to this file ran/);
    assert.match(conflict, /half-changed/);
    assert.match(conflict, /SINGLE edit_file/);

    assert.equal(session._repairHint("unsupported", { path: "c.js" }), "");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("an anchored removal that strands a separator is told so", async () => {
  const workspace = await createTempWorkspace();
  try {
    const session = new AgentSession({ client: scriptedClient([]), cwd: workspace });

    // Removing the last entry of an object strands the comma before it. The
    // intention is right and the anchor is wrong, so "make the content
    // parseable" is not enough to act on.
    const anchored = session._repairHint("invalid-content", {
      path: "package.json",
      anchor: '  "node:sqlite": "^0.0.1"\n',
      replacement: "",
    });
    assert.match(anchored, /left the surrounding punctuation behind/);
    assert.match(anchored, /strands the comma/);
    assert.match(anchored, /Extend the anchor to cover that separator/);
    assert.match(anchored, /drop the anchor and send the whole corrected file/);

    // A whole-file write that is simply malformed gets no anchor advice.
    const whole = session._repairHint("invalid-content", {
      path: "package.json",
      content: "{ bad",
    });
    assert.doesNotMatch(whole, /surrounding punctuation/);
    assert.match(whole, /complete, parseable text/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a failed edit re-opens the file for reading, because the repair hint says to read it", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "app.js"), "export const a = 1;\n", "utf8");
    const client = scriptedClient([
      turn([{ type: "read_file", path: "app.js", reason: "inspect" }]),
      // Anchor that is not in the file: the edit fails and the hint tells the
      // model to read the file again before retrying.
      turn([
        {
          type: "edit_file",
          path: "app.js",
          anchor: "not in the file at all",
          replacement: "x",
          reason: "fix",
        },
      ]),
      turn([{ type: "read_file", path: "app.js", reason: "re-read for a correct anchor" }]),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const results = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("action-result", (event) => results.push(event));
    await session.submitTask("repair the module");

    const reads = results.filter((event) => event.action?.type === "read_file");
    assert.equal(reads.length, 2, "both reads are attempted");
    assert.equal(reads[0].status, "executed");
    assert.equal(
      reads[1].status,
      "executed",
      "the read after a failed edit must not be deduped away — the repair hint just asked for it",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a read is runnable again once its evidence has been dropped from context", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "app.js"), "export const a = 1;\n", "utf8");
    const client = scriptedClient([
      turn([{ type: "read_file", path: "app.js", reason: "inspect" }]),
      turn([{ type: "read_file", path: "app.js", reason: "inspect again" }]),
      turn([{ type: "read_file", path: "app.js", reason: "inspect once more" }]),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const results = [];
    let duplicateNote = null;
    const session = new AgentSession({
      client,
      cwd: workspace,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("action-result", (event) => {
      results.push(event);
      if ((event.status === "duplicate" || event.status === "reloaded") && !duplicateNote) {
        // The note carries a 1-turn TTL, so it has to be read as it is written —
        // and it is filed just *after* this event, so defer one microtask.
        queueMicrotask(() => {
          duplicateNote ??= [...session.context.nodes.values()].find((node) =>
            /^duplicate read_file/.test(node.label ?? ""),
          )?.text;
        });
      }
    });

    // Drop the evidence between turn 2 and turn 3, the way budget pressure
    // eventually does to an old read.
    let dropped = false;
    session.on("status", () => {
      if (dropped) return;
      const node = [...session.context.nodes.values()].find((n) => n.label === "read_file app.js");
      if (node && results.length >= 2) {
        session.context.update(node.id, { state: "dropped" });
        dropped = true;
      }
    });

    await session.submitTask("inspect the module");
    const reads = results.filter((event) => event.action?.type === "read_file");
    assert.equal(reads[0].status, "executed");
    assert.equal(
      reads[1].status,
      "reloaded",
      "while the evidence is live the read is answered by reloading it, not refused",
    );
    assert.equal(
      reads[2].status,
      "executed",
      "once the evidence is gone the model must be able to fetch the file again",
    );
    // And while it *is* live, the loop reloads the text rather than telling the
    // model to ask again in a different vocabulary.
    assert.ok(duplicateNote, "the refusal must say what happened to the content");
    assert.match(duplicateNote, /reloaded it in full|already loaded in full/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("re-reading a digested file reloads it instead of refusing the model", async () => {
  const workspace = await createTempWorkspace();
  try {
    // A file long enough that a tight budget renders it as a digest.
    await fs.writeFile(
      path.join(workspace, "app.js"),
      `${"// a meaningful line of source\n".repeat(400)}export const a = 1;\n`,
      "utf8",
    );
    const client = scriptedClient([
      turn([{ type: "read_file", path: "app.js", reason: "inspect" }]),
      turn([{ type: "read_file", path: "app.js", reason: "I cannot see it any more" }]),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const results = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      contextBudgetTokens: 400,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("action-result", (event) => results.push(event));
    await session.submitTask("inspect the module");

    const reads = results.filter((event) => event.action?.type === "read_file");
    assert.equal(reads[0].status, "executed");
    assert.equal(
      reads[1].status,
      "reloaded",
      "the second read must reload the node rather than dead-end as a duplicate",
    );
    const node = [...session.context.nodes.values()].find((n) => n.label === "read_file app.js");
    assert.equal(
      node.expandRequested,
      true,
      "the evidence node is expanded so its text is visible again",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a failed edit does not consume its path's same-turn slot", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "app.js"), "export const a = 1;\n", "utf8");
    // First edit is unparseable so the file is untouched; the second is the
    // model's corrective attempt and must be allowed to run.
    const client = scriptedClient([
      turn([
        { type: "write_file", path: "app.js", content: "export const a = (;\n", reason: "bad" },
        { type: "write_file", path: "app.js", content: "export const a = 2;\n", reason: "fixed" },
      ]),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const results = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("action-result", (event) => results.push(event));
    await session.submitTask("repair the module");

    const statuses = results.filter((e) => e.action?.type === "write_file").map((e) => e.status);
    assert.deepEqual(statuses, ["invalid-content", "written"]);
    assert.equal(await fs.readFile(path.join(workspace, "app.js"), "utf8"), "export const a = 2;\n");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a successful edit still blocks a second same-turn change to that path", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "app.js"), "export const a = 1;\n", "utf8");
    const client = scriptedClient([
      turn([
        { type: "write_file", path: "app.js", content: "export const a = 2;\n", reason: "one" },
        { type: "write_file", path: "app.js", content: "export const a = 3;\n", reason: "two" },
      ]),
      turn([{ type: "finish", reason: "done" }]),
    ]);
    const results = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("action-result", (event) => results.push(event));
    await session.submitTask("edit twice");

    const statuses = results.filter((e) => e.action?.type === "write_file").map((e) => e.status);
    assert.deepEqual(statuses, ["written", "conflicting-action"]);
    // The second was written against text the first already replaced.
    assert.equal(await fs.readFile(path.join(workspace, "app.js"), "utf8"), "export const a = 2;\n");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
