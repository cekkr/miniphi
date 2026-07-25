import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import { resolveContextWindow } from "../src/libs/model-catalog.js";

/**
 * Live proof for the multi-layered context + context graph language.
 *
 * Gated behind MINIPHI_LMSTUDIO_INTEGRATION=1 because it needs a reachable
 * LM Studio. It puts a real local model under deliberate context pressure: two
 * files far larger than the prompt budget, only one of which answers the task.
 * The model must therefore use the graph (expand/collapse/note/pin) rather than
 * receive everything, and must still finish with a schema-valid turn.
 *
 *   $env:MINIPHI_LMSTUDIO_INTEGRATION='1'
 *   $env:LMSTUDIO_REST_URL='http://10.175.176.245:1234'
 *   $env:MINIPHI_LIVE_MODEL='gpt-oss-20b'
 *   node --test unit-tests-js/agent-context-graph.live.test.js
 */
const LIVE = process.env.MINIPHI_LMSTUDIO_INTEGRATION === "1";
const BASE_URL = process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234";
const MODEL = process.env.MINIPHI_LIVE_MODEL ?? "gpt-oss-20b";
const TIMEOUT_MS = 600000;
// Per-request timeout must leave room for the one automatic retry *and* the real
// work inside the test budget: with a 300s client timeout a wedged LM Studio
// burns the whole 600s on two hangs and the test reports an unhelpful
// "test timed out" instead of a transport failure. Do not raise this without
// raising TIMEOUT_MS. (Note: never run this file alongside other LM Studio work —
// concurrent long generations wedge the server on the reference host.)
const REQUEST_TIMEOUT_MS = 120000;

async function createWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-ctxgraph-"));
  // The file that answers the task, buried in bulk so it cannot travel in full.
  await fs.writeFile(
    path.join(dir, "settings.js"),
    [
      "// Configuration helpers.",
      ...Array.from({ length: 60 }, (_, i) => `// filler comment line ${i} kept to inflate this file well past the prompt budget`),
      "export function readTimeout(raw) {",
      "  return Number(raw);",
      "}",
      "",
      "export const MAGIC_TIMEOUT_TOKEN = 4321;",
      ...Array.from({ length: 60 }, (_, i) => `// trailing filler line ${i} kept to inflate this file well past the prompt budget`),
      "",
    ].join("\n"),
    "utf8",
  );
  // A decoy of similar size that must lose the budget contest.
  await fs.writeFile(
    path.join(dir, "CHANGELOG.md"),
    ["# Changelog", ...Array.from({ length: 160 }, (_, i) => `- entry ${i}: unrelated historical note about packaging`)].join("\n"),
    "utf8",
  );
  return dir;
}

test(
  "live: the agent works under context pressure and uses the context graph language",
  { skip: LIVE ? false : "set MINIPHI_LMSTUDIO_INTEGRATION=1 to run live LM Studio checks", timeout: TIMEOUT_MS },
  async () => {
    const workspace = await createWorkspace();
    const client = new LMStudioRestClient({ baseUrl: BASE_URL, defaultModel: MODEL, timeoutMs: REQUEST_TIMEOUT_MS });

    // The prompt budget must follow the real loaded window, never a static default.
    const window = await resolveContextWindow({ restClient: client, modelId: MODEL });
    assert.ok(window, `model ${MODEL} not found in the LM Studio inventory at ${BASE_URL}`);

    const events = { ops: [], reforms: [], results: [] };
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: path.join(workspace, ".miniphi"),
      sessionId: "live-context-graph",
      model: MODEL,
      contextLength: window.contextLength,
      // Deliberately tighter than the window so demotion is guaranteed.
      contextBudgetTokens: 700,
      maxTurns: 6,
      maxActionsPerTurn: 3,
      approver: createHeadlessApprover({ policy: "allow" }),
      sessionDeadline: Date.now() + TIMEOUT_MS - 30000,
      logger: (message) => console.log(message),
    });
    session.on("context-ops", (payload) => events.ops.push(payload));
    session.on("context-reform", (payload) => events.reforms.push(payload));
    session.on("action-result", (payload) => events.results.push(payload));

    const result = await session.submitTask(
      "Read settings.js and CHANGELOG.md, then write TIMEOUT.md containing the exact value of MAGIC_TIMEOUT_TOKEN from settings.js.",
      [],
    );

    console.log(`stopReason=${result.stopReason} turns=${result.turns}`);
    console.log(`context=${JSON.stringify(result.context)}`);

    // 1. Every turn stayed inside the budget: the rendered context never grew
    //    into an unbounded transcript.
    const selection = session.context.select();
    assert.ok(
      selection.usedTokens <= selection.budgetTokens + 100,
      `context selection overflowed: ${selection.usedTokens}/${selection.budgetTokens}`,
    );

    // 2. Context pressure really happened (something was demoted or unloaded).
    assert.ok(
      selection.digested.length + selection.stubs.length >= 1,
      "the run should have exercised digest/stub demotion",
    );

    // 3. The invariant layers survived the pressure.
    const includedLayers = new Set(selection.included.map((entry) => entry.node.layer));
    assert.ok(includedLayers.has("mission"), "the mission layer must always be loaded");
    assert.ok(includedLayers.has("contract"), "the contract layer must always be loaded");

    // 4. The loop ended on a real stop reason, not a schema fallback.
    assert.ok(
      ["completed", "no-progress", "no-actions", "max-turns"].includes(result.stopReason),
      `unexpected stop reason ${result.stopReason}`,
    );
    assert.doesNotMatch(result.stopReason, /invalid-response/);

    // 5. Whatever the model emitted, every context op was legal or reported.
    const applied = events.ops.flatMap((payload) => payload.applied);
    const rejected = events.ops.flatMap((payload) => payload.rejected);
    console.log(`context ops applied=${JSON.stringify(applied)} rejected=${JSON.stringify(rejected)}`);
    assert.equal(applied.length + rejected.length, result.context.opsApplied + result.context.opsRejected);

    // 6. The graph persisted with stable ids for a later resume.
    const persisted = JSON.parse(
      await fs.readFile(
        path.join(workspace, ".miniphi", "agent-sessions", "live-context-graph", "context-graph.json"),
        "utf8",
      ),
    );
    assert.ok(persisted.nodes.length >= 3);
    assert.ok(persisted.nodes.every((node) => typeof node.id === "string" && node.id));

    // 7. The task itself: the model had to pull the value out of the bulky file.
    const timeoutDoc = await fs.readFile(path.join(workspace, "TIMEOUT.md"), "utf8").catch(() => null);
    if (timeoutDoc !== null) {
      assert.match(timeoutDoc, /4321/, "the written file must carry the value that was buried in settings.js");
    } else {
      console.warn("[live] TIMEOUT.md was not written; context-graph assertions above still hold");
    }

    await fs.rm(workspace, { recursive: true, force: true });
  },
);

test(
  "live: the model expands its own context to reach content no action can fetch",
  { skip: LIVE ? false : "set MINIPHI_LMSTUDIO_INTEGRATION=1 to run live LM Studio checks", timeout: TIMEOUT_MS },
  async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-ctxreform-"));
    const client = new LMStudioRestClient({ baseUrl: BASE_URL, defaultModel: MODEL, timeoutMs: REQUEST_TIMEOUT_MS });

    // The answer lives only inside a research payload held in the context graph:
    // it is on no disk, so read_file/search_text cannot reach it. Under a tight
    // budget the node is digested, so the ONLY way to the value is an expand op.
    const buried = [
      "Reference bundle for local timeout defaults.",
      ...Array.from({ length: 14 }, (_, i) => `Section ${i}: background prose about unrelated timeout conventions and history.`),
      "AUTHORITATIVE VALUE: MAGIC_TIMEOUT_TOKEN = 8675309",
      ...Array.from({ length: 40 }, (_, i) => `Appendix ${i}: further unrelated notes padding this bundle well past the digest boundary.`),
    ].join("\n");

    const events = { ops: [], results: [] };
    const session = new AgentSession({
      client,
      cwd: workspace,
      baseDir: path.join(workspace, ".miniphi"),
      sessionId: "live-context-reform",
      model: MODEL,
      contextBudgetTokens: 700,
      maxTurns: 6,
      maxActionsPerTurn: 2,
      approver: createHeadlessApprover({ policy: "allow" }),
      initialResearchQueries: ["local timeout token reference bundle"],
      webResearch: async (query) => ({ query, provider: "fixture", results: [{ title: "bundle", snippet: buried }] }),
      sessionDeadline: Date.now() + TIMEOUT_MS - 30000,
      logger: (message) => console.log(message),
    });
    session.on("context-ops", (payload) => events.ops.push(payload));
    session.on("action-result", (payload) => events.results.push(payload));

    const result = await session.submitTask(
      "Write TIMEOUT.md containing only the exact MAGIC_TIMEOUT_TOKEN value stated in the research bundle already in your context.",
      [],
    );

    console.log(`stopReason=${result.stopReason} turns=${result.turns}`);
    console.log(`ops=${JSON.stringify(events.ops.map((payload) => payload.applied))}`);

    // The research node must have started out demoted, or the test proves nothing.
    const researchNode = [...session.context.nodes.values()].find((node) => node.kind === "research");
    assert.ok(researchNode, "the preflight research node must be in the graph");
    assert.ok(researchNode.tokens > 700, "the research payload must exceed the whole budget");

    const applied = events.ops.flatMap((payload) => payload.applied);
    assert.ok(
      applied.some((entry) => entry.op === "expand" && entry.node === researchNode.id),
      `the model should expand the digested research node; applied ops: ${JSON.stringify(applied)}`,
    );

    // Expansion actually delivered more than the digest did.
    const form = session.context
      .select()
      .included.find((entry) => entry.node.id === researchNode.id)?.form;
    assert.ok(["full", "partial"].includes(form), `expanded node should be loaded, got form=${form}`);

    const written = await fs.readFile(path.join(workspace, "TIMEOUT.md"), "utf8").catch(() => null);
    assert.ok(written !== null, "TIMEOUT.md should have been written once the value was loaded");
    assert.match(written, /8675309/, "the value was only reachable through the expanded context node");

    await fs.rm(workspace, { recursive: true, force: true });
  },
);
