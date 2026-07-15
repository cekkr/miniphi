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

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
