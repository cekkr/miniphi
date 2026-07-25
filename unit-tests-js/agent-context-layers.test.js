import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

/** Stub LM Studio client that replays scripted turns and records its prompts. */
function scriptedClient(turns) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async createChatCompletion({ messages }) {
      calls.push(messages);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return { choices: [{ message: { content: typeof turn === "string" ? turn : JSON.stringify(turn) } }] };
    },
  };
}

const turn = (actions, extra = {}) => ({
  task: "demo",
  summary: extra.summary ?? "working",
  summary_updates: [],
  actions,
  needs_more_context: extra.needs_more_context ?? false,
  missing_snippets: extra.missing_snippets ?? [],
  ...(extra.context_ops ? { context_ops: extra.context_ops } : {}),
  ...(extra.context_sufficient === undefined ? {} : { context_sufficient: extra.context_sufficient }),
  ...(extra.context_gap === undefined ? {} : { context_gap: extra.context_gap }),
});

const userMessage = (client, callIndex) => client.calls[callIndex][1].content;

test("the agent-action schema accepts context ops and rejects unknown ops", () => {
  const registry = new PromptSchemaRegistry();
  const base = turn([{ type: "finish", reason: "done" }]);

  const valid = registry.validate(
    "agent-action",
    JSON.stringify({
      ...base,
      context_sufficient: false,
      context_gap: "need the parseNumericSetting signature",
      context_ops: [
        { op: "expand", node: "c4", reason: "need the full file" },
        { op: "open_subtask", label: "add validation", text: "harden the parser" },
        { op: "note", label: "decision", text: "use Matter.js", layer: "plan", importance: 0.9 },
        { op: "link", from: "c4", to: "c2", relation: "supports" },
      ],
    }),
  );
  assert.equal(valid.valid, true, valid.error ?? "context ops must validate");

  const badOp = registry.validate(
    "agent-action",
    JSON.stringify({ ...base, context_ops: [{ op: "teleport", node: "c4" }] }),
  );
  assert.equal(badOp.valid, false);

  const badLayer = registry.validate(
    "agent-action",
    JSON.stringify({ ...base, context_ops: [{ op: "note", text: "x", layer: "mission" }] }),
  );
  assert.equal(badLayer.valid, false, "the model cannot claim a runtime-owned layer");

  // Omitting the new fields entirely stays valid (they are additive).
  assert.equal(registry.validate("agent-action", JSON.stringify(base)).valid, true);
});

test("AgentSession renders a layered context block instead of a flat transcript", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "a.js"), "export const a = 1;\n", "utf8");
    const client = scriptedClient([
      turn([{ type: "read_file", path: "a.js", reason: "inspect" }]),
      turn([{ type: "finish", reason: "done" }], { summary: "looked at a.js" }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: path.join(workspace, ".miniphi"),
      sessionId: "layers",
      approver: createHeadlessApprover({ policy: "allow" }),
    });

    const result = await session.submitTask("Inspect a.js", []);
    assert.equal(result.status, "completed");

    const first = userMessage(client, 0);
    assert.match(first, /## Context \(revision \d+ \| budget \d+ tokens/);
    assert.match(first, /### Mission\n\[c\d+\] operator task/);
    assert.match(first, /Task: Inspect a\.js/);
    assert.match(first, /### Contract/);
    assert.match(first, /Respond with the next turn as JSON\./);

    // The read output arrives as an evidence node with a stable id.
    const second = userMessage(client, 1);
    assert.match(second, /### Evidence/);
    assert.match(second, /\[c\d+\] read_file a\.js \(L0\)/);
    assert.match(second, /export const a = 1;/);

    // The context language is taught in the system prompt.
    assert.match(client.calls[0][0].content, /Context graph language \(field "context_ops"\)/);
    assert.match(client.calls[0][0].content, /{"op":"expand","node":"c7"}/);

    assert.equal(result.context.nodes >= 3, true);
    assert.equal(result.context.byLayer.mission, 1);
    assert.equal(result.context.byLayer.contract, 1);

    const graph = JSON.parse(
      await fs.readFile(
        path.join(workspace, ".miniphi", "agent-sessions", "layers", "context-graph.json"),
        "utf8",
      ),
    );
    assert.ok(graph.nodes.some((node) => node.layer === "mission" && node.pinned));
    assert.ok(graph.nodes.some((node) => node.kind === "readonly"));
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a tight context budget demotes bulky evidence but keeps the mission and the task", async () => {
  const workspace = await createTempWorkspace();
  try {
    // Two files far larger than the budget: they cannot both travel in full.
    await fs.writeFile(path.join(workspace, "big-a.js"), `// A\n${"a".repeat(6000)}\n`, "utf8");
    await fs.writeFile(path.join(workspace, "big-b.js"), `// B\n${"b".repeat(6000)}\n`, "utf8");
    const client = scriptedClient([
      turn([
        { type: "read_file", path: "big-a.js", reason: "inspect a" },
        { type: "read_file", path: "big-b.js", reason: "inspect b" },
      ]),
      turn([{ type: "finish", reason: "done" }], { summary: "read both" }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      contextBudgetTokens: 220,
      approver: createHeadlessApprover({ policy: "allow" }),
    });

    const result = await session.submitTask("Summarize the two big files", []);
    assert.equal(result.status, "completed");

    const second = userMessage(client, 1);
    assert.match(second, /Task: Summarize the two big files/, "the mission always survives");
    assert.match(second, /Context pressure: \d+ node\(s\) digested, \d+ unloaded/);
    // The prompt stays near the budget instead of growing with the transcript.
    assert.ok(second.length < 6000, `context block should stay bounded, got ${second.length} chars`);
    assert.ok(
      /digest: \d+ more chars available/.test(second) || /Context index \(not loaded/.test(second),
      "bulky evidence is demoted to a digest or a stub",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("AgentSession applies model context ops and feeds rejections back", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "a.js"), "export const a = 1;\n", "utf8");
    const client = scriptedClient([
      turn([{ type: "read_file", path: "a.js", reason: "inspect" }]),
      turn([{ type: "list_dir", path: ".", reason: "look around" }], {
        context_ops: [
          { op: "note", label: "decision", text: "keep a.js as the entry point", layer: "plan" },
          { op: "open_subtask", label: "document a.js", text: "write the docstring" },
          { op: "pin", node: "does-not-exist" },
        ],
      }),
      turn([{ type: "finish", reason: "done" }], { summary: "documented" }),
    ]);
    const events = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("context-ops", (payload) => events.push(payload));

    const result = await session.submitTask("Document a.js", []);
    assert.equal(result.status, "completed");
    assert.equal(events.length, 1);
    assert.deepEqual(
      events[0].applied.map((entry) => entry.op),
      ["note", "open_subtask"],
    );
    assert.equal(events[0].rejected.length, 1);
    assert.equal(result.context.opsApplied, 2);
    assert.equal(result.context.opsRejected, 1);

    const third = userMessage(client, 2);
    assert.match(third, /keep a\.js as the entry point/, "a model note becomes durable context");
    assert.match(third, /### Subtask\n\[s1\] document a\.js/);
    assert.match(third, /focus \[s1\] document a\.js \(subtask level 0\)/);
    assert.match(third, /These context ops changed nothing:\n- pin: node "does-not-exist" not found/);
    // Evidence gathered inside the subtask is scoped to it.
    assert.match(third, /\[c\d+\] list_dir \. \(L1\)/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("repeated no-op context ops are reported back instead of silently applied", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "a.js"), `// a\n${"a".repeat(4000)}\n`, "utf8");
    const expand = { op: "expand", node: "c3", reason: "need the body" };
    const client = scriptedClient([
      turn([{ type: "read_file", path: "a.js", reason: "inspect" }]),
      // The model re-sends the same expand it already got (seen live with gpt-oss-20b).
      turn([{ type: "list_dir", path: ".", reason: "look" }], { context_ops: [expand] }),
      turn([{ type: "search_text", term: "aaa", reason: "look again" }], { context_ops: [expand] }),
      turn([{ type: "finish", reason: "done" }], { summary: "done" }),
    ]);
    const events = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      contextBudgetTokens: 400,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("context-ops", (payload) => events.push(payload));

    const result = await session.submitTask("Inspect a.js", []);
    assert.equal(result.status, "completed");
    assert.equal(events[0].applied.length, 1, "the first expand applies");
    assert.equal(events[1].applied.length, 0, "the repeat changes nothing");
    assert.equal(events[1].noops.length, 1);
    assert.match(events[1].noops[0].error, /already expanded/);
    assert.equal(result.context.opsNoop, 1);
    assert.match(userMessage(client, 3), /These context ops changed nothing:[\s\S]*already expanded/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a turn that only reshapes the context earns a bounded re-prompt", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "a.js"), `// a\n${"a".repeat(4000)}\n`, "utf8");
    const client = scriptedClient([
      turn([{ type: "read_file", path: "a.js", reason: "inspect" }]),
      // No actions, only context work: this must not end the session.
      turn([], { context_ops: [{ op: "expand", node: "c3", reason: "need the body" }] }),
      turn([{ type: "finish", reason: "done" }], { summary: "used the expanded file" }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      contextBudgetTokens: 400,
      maxTurns: 6,
      approver: createHeadlessApprover({ policy: "allow" }),
    });

    const result = await session.submitTask("Inspect a.js", []);
    assert.equal(result.stopReason, "completed");
    assert.equal(result.context.contextOnlyTurns, 1);
    assert.match(userMessage(client, 2), /only reshaped the context \(1\/3 allowed\)/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("context-only turns are capped so reshaping cannot replace working", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(workspace, "a.js"), "// a\n", "utf8");
    await fs.writeFile(path.join(workspace, "b.js"), "// b\n", "utf8");
    // Every turn only pins another node; nothing is ever done.
    const client = scriptedClient([
      turn([{ type: "read_file", path: "a.js", reason: "inspect" }]),
      turn([], { context_ops: [{ op: "pin", node: "c3" }] }),
      turn([], { context_ops: [{ op: "boost", node: "c3", importance: 0.95 }] }),
      turn([], { context_ops: [{ op: "collapse", node: "c3", text: "gist" }] }),
      turn([], { context_ops: [{ op: "note", label: "n", text: "another note" }] }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      maxTurns: 10,
      maxContextOnlyTurns: 2,
    });

    const result = await session.submitTask("Never finish", []);
    assert.equal(result.stopReason, "no-actions");
    assert.equal(result.context.contextOnlyTurns, 2);
    assert.ok(result.turns <= 5, `stops promptly, used ${result.turns} turns`);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("a declared context gap triggers a bounded reform and a re-prompt", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.writeFile(
      path.join(workspace, "parser.js"),
      `// parser\n${"p".repeat(4000)}\nexport function parseNumericSetting() {}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(workspace, "notes.md"), `# notes\n${"n".repeat(4000)}\n`, "utf8");
    const client = scriptedClient([
      // Turn 1: read both files (they will not both fit in the budget).
      turn([
        { type: "read_file", path: "parser.js", reason: "inspect the parser" },
        { type: "read_file", path: "notes.md", reason: "inspect the notes" },
      ]),
      // Turn 2: report the context as imprecise, with no actions.
      turn([], { context_sufficient: false, context_gap: "need the full parser.js parseNumericSetting body" }),
      // Turn 3: after the reform, finish.
      turn([{ type: "finish", reason: "context was enough after the reform" }], { summary: "done" }),
    ]);
    const reforms = [];
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      contextBudgetTokens: 400,
      maxTurns: 6,
      approver: createHeadlessApprover({ policy: "allow" }),
    });
    session.on("context-reform", (payload) => reforms.push(payload));

    const result = await session.submitTask("Harden parseNumericSetting", []);

    assert.equal(result.status, "completed");
    assert.equal(reforms.length, 1);
    assert.equal(reforms[0].gap, "need the full parser.js parseNumericSetting body");
    assert.ok(reforms[0].expanded.length >= 1, "the reform expanded the matching node");
    assert.equal(result.context.reforms, 1);
    // The re-prompt carries the gap and the expanded parser evidence.
    const third = userMessage(client, 2);
    assert.match(third, /Reported context gap: need the full parser\.js/);
    assert.match(third, /parseNumericSetting/);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("context reforms are capped so an unhelpful gap loop cannot spin", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([], { context_sufficient: false, context_gap: "still not enough" }),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      maxTurns: 10,
      maxContextReforms: 2,
    });
    const reforms = [];
    session.on("context-reform", (payload) => reforms.push(payload));

    const result = await session.submitTask("Impossible task", []);

    assert.equal(reforms.length, 2, "reform budget is enforced");
    // Once the budget is spent a turn with no actions is a stop, not a re-prompt.
    assert.equal(result.stopReason, "no-actions");
    assert.equal(result.context.reforms, 2);
    assert.ok(result.turns <= 4, `stops promptly, used ${result.turns} turns`);
    assert.ok(
      [...session.context.nodes.values()].some((node) =>
        /Context reform budget exhausted \(2\)/.test(node.text),
      ),
      "the exhausted budget is recorded in the graph for the audit trail",
    );
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("validation issues stay pinned through budget pressure until they pass", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([
      turn([{ type: "write_file", path: "index.html", content: "<canvas></canvas>", reason: "draft" }]),
      turn([
        { type: "write_file", path: "index.html", content: "<canvas>gravity</canvas>", reason: "fix" },
      ]),
    ]);
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      // Small enough that ordinary evidence must be demoted.
      contextBudgetTokens: 260,
      approver: createHeadlessApprover({ policy: "allow" }),
      validateWorkspace: async ({ cwd }) => {
        const content = await fs.readFile(path.join(cwd, "index.html"), "utf8").catch(() => "");
        const issues = content.includes("gravity") ? [] : ["add gravity"];
        return {
          valid: issues.length === 0,
          summary: issues.length ? "Checks failed." : "Checks passed.",
          issues,
        };
      },
    });

    const result = await session.submitTask("Create a bouncing ball page", []);
    assert.equal(result.status, "completed");
    assert.equal(result.validation.valid, true);
    // The pinned validation JSON reached the model even under a tight budget.
    assert.match(userMessage(client, 1), /add gravity/);
    // Once validation passes the pin is released so it stops costing budget.
    const validationNodes = [...session.context.nodes.values()].filter((node) => node.kind === "validation");
    assert.ok(validationNodes.length >= 1);
    assert.ok(validationNodes.every((node) => node.pinned === false));
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("the context budget follows the loaded LM Studio window", async () => {
  const workspace = await createTempWorkspace();
  try {
    const client = scriptedClient([turn([{ type: "finish", reason: "done" }])]);
    const small = new AgentSession({ client, cwd: workspace, baseDir: null, contextLength: 8192 });
    const large = new AgentSession({ client, cwd: workspace, baseDir: null, contextLength: 131072 });
    const unknown = new AgentSession({ client, cwd: workspace, baseDir: null });

    assert.ok(small.contextBudgetTokens < large.contextBudgetTokens);
    assert.ok(small.contextBudgetTokens < 8192, "the budget leaves room for the reply");
    assert.equal(unknown.contextBudgetTokens, 4000, "an unknown window keeps the conservative default");
    assert.equal(small.context.budgetTokens, small.contextBudgetTokens);

    const explicit = new AgentSession({
      client,
      cwd: workspace,
      baseDir: null,
      contextLength: 8192,
      contextBudgetTokens: 1500,
    });
    assert.equal(explicit.contextBudgetTokens, 1500, "an explicit budget wins");
  } finally {
    await removeTempWorkspace(workspace);
  }
});
