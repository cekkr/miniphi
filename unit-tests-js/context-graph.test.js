import test from "node:test";
import assert from "node:assert/strict";
import ContextGraph, {
  CONTEXT_LAYERS,
  CONTEXT_OP_TYPES,
  CONTEXT_RELATIONS,
  autoDigest,
  deriveContextBudget,
  estimateTokens,
} from "../src/libs/context-graph.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

const filler = (label, chars) => `${label}: ${"x".repeat(Math.max(0, chars - label.length - 2))}`;

test("the published schemas match the implemented context language", () => {
  // Guards against drift between the code, the standalone `context-ops` schema,
  // and the copy inlined in `agent-action` (the validator has no $ref support).
  const registry = new PromptSchemaRegistry();
  const standalone = registry.getSchema("context-ops");
  const agentAction = registry.getSchema("agent-action");
  assert.ok(standalone, "docs/prompts/context-ops.schema.json must exist");

  const opProperties = standalone.definition.properties.context_ops.items.properties;
  assert.deepEqual([...opProperties.op.enum].sort(), [...CONTEXT_OP_TYPES].sort());
  assert.deepEqual(
    opProperties.relation.enum.filter(Boolean).sort(),
    [...CONTEXT_RELATIONS].sort(),
  );
  // Model-writable layers exclude the runtime-owned invariants.
  assert.deepEqual(
    opProperties.layer.enum.filter(Boolean).sort(),
    Object.entries(CONTEXT_LAYERS)
      .filter(([, layer]) => !layer.retained)
      .map(([name]) => name)
      .sort(),
  );

  const inlined = agentAction.definition.properties.context_ops.items.properties;
  assert.deepEqual(inlined.op.enum, opProperties.op.enum, "inlined op enum must match the standalone schema");
  // The new fields stay optional so older turns keep validating.
  for (const field of ["context_ops", "context_sufficient", "context_gap"]) {
    assert.ok(agentAction.definition.properties[field], `agent-action must expose ${field}`);
    assert.equal(agentAction.definition.required.includes(field), false, `${field} must stay optional`);
  }
});

test("deriveContextBudget sizes the budget from the loaded window and reserves output", () => {
  // 8192 loaded * 0.85 = 6963, minus 1024 output and 500 fixed prompt tokens.
  assert.equal(
    deriveContextBudget({ contextLength: 8192, reservedTokens: 500, reservedOutputTokens: 1024 }),
    Math.floor(8192 * 0.85) - 1524,
  );
  // Unknown window: stay on the conservative default instead of guessing large.
  assert.equal(deriveContextBudget({ contextLength: null, fallbackBudgetTokens: 4000 }), 4000);
  assert.equal(deriveContextBudget({ contextLength: 0 }), 4000);
  // Never return a budget too small to hold the invariants.
  assert.equal(deriveContextBudget({ contextLength: 512, reservedOutputTokens: 1024 }), 512);
});

test("estimateTokens and autoDigest bound context text", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(401)), 101);

  const long = "line one\n" + "y".repeat(500);
  const digest = autoDigest(long, 120);
  assert.ok(digest.length < long.length);
  assert.match(digest, /digest: \d+ more chars available/);
  assert.equal(autoDigest("short", 120), "short");
});

test("select keeps mission and contract while demoting low-priority evidence", () => {
  const graph = new ContextGraph({ budgetTokens: 200 });
  graph.add({ layer: "mission", label: "operator task", text: "Task: add validation", pinned: true });
  graph.add({ layer: "contract", label: "policies", text: "Respond with JSON only." });
  graph.add({ layer: "evidence", label: "read_file big.js", text: filler("big", 3000) });
  graph.add({ layer: "scratch", label: "nudge", text: filler("nudge", 2000) });

  const selection = graph.select();
  const labels = selection.included.map((entry) => entry.node.label);
  assert.ok(labels.includes("operator task"), "mission survives any budget");
  assert.ok(labels.includes("policies"), "contract survives any budget");
  // The oversized evidence/scratch nodes cannot fit in full at 200 tokens.
  const forms = new Map(selection.included.map((entry) => [entry.node.label, entry.form]));
  assert.notEqual(forms.get("read_file big.js"), "full");
  assert.ok(selection.digested.length + selection.stubs.length >= 1);
  assert.ok(selection.usedTokens <= selection.budgetTokens + 200);
});

test("higher priority layers win the budget over lower ones", () => {
  const graph = new ContextGraph({ budgetTokens: 400 });
  graph.add({ layer: "plan", label: "plan step", text: filler("plan", 1200), importance: 0.5 });
  graph.add({ layer: "evidence", label: "evidence", text: filler("evidence", 1200), importance: 0.9 });
  graph.add({ layer: "scratch", label: "scratch", text: filler("scratch", 1200), importance: 0.9 });

  const selection = graph.select();
  const full = selection.included.filter((entry) => entry.form === "full").map((entry) => entry.node.label);
  assert.deepEqual(full, ["plan step"], "the plan layer outranks evidence and scratch at equal size");
});

test("pinned nodes are never demoted and cannot be dropped when retained", () => {
  const graph = new ContextGraph({ budgetTokens: 120 });
  graph.add({ layer: "evidence", label: "pinned validation", text: filler("validation", 2000), pinned: true });
  graph.add({ layer: "evidence", label: "other", text: filler("other", 2000) });

  const selection = graph.select();
  const pinned = selection.included.find((entry) => entry.node.label === "pinned validation");
  assert.ok(pinned, "pinned evidence is always included");
  assert.ok(["full", "truncated"].includes(pinned.form));

  const mission = graph.add({ layer: "mission", label: "task", text: "Task: x" });
  const outcome = graph.applyOps([{ op: "drop", node: mission.id }]);
  assert.equal(outcome.applied.length, 0);
  assert.match(outcome.rejected[0].error, /retained/);
});

test("subtask level focuses the sub-conversation and penalizes sibling branches", () => {
  const graph = new ContextGraph({ budgetTokens: 10000 });
  graph.add({ layer: "mission", label: "task", text: "Task: two branches" });
  const first = graph.openSubtask({ label: "branch one", text: "goal one" });
  const firstEvidence = graph.add({ layer: "evidence", label: "one evidence", text: "aaa" });
  assert.equal(firstEvidence.level, 1);
  assert.equal(firstEvidence.subtaskId, first.id);
  graph.closeSubtask({ text: "branch one done" });
  assert.equal(graph.focusId, null);

  const second = graph.openSubtask({ label: "branch two", text: "goal two" });
  const secondEvidence = graph.add({ layer: "evidence", label: "two evidence", text: "bbb" });

  const focusScore = graph.scoreNode(secondEvidence);
  const siblingScore = graph.scoreNode(firstEvidence);
  assert.ok(focusScore > siblingScore, "focused-subtask evidence outranks a closed sibling branch");
  assert.equal(graph.focusId, second.id);
  assert.deepEqual(graph.focusPath(), [second.id]);
});

test("closing a subtask collapses its evidence into one parent-level outcome", () => {
  const graph = new ContextGraph({ budgetTokens: 10000 });
  const subtask = graph.openSubtask({ label: "gather", text: "read the parser" });
  graph.add({ layer: "evidence", label: "read_file a.js", text: filler("a", 900) });
  graph.add({ layer: "evidence", label: "read_file b.js", text: filler("b", 900) });

  const summary = graph.closeSubtask({ text: "parser uses parseNumericSetting in two places" });
  assert.equal(summary.layer, "plan");
  assert.match(summary.text, /parseNumericSetting/);
  const children = [...graph.nodes.values()].filter((node) => node.subtaskId === subtask.id && node.id !== subtask.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.state, "digested");
    assert.ok(child.digest, "closed-subtask evidence keeps a digest, not the full text");
  }
  const rendered = graph.render();
  assert.match(rendered, /outcome: gather/);
});

test("render exposes node ids, a stub index, and the pressure hint", () => {
  // A budget below even the digest size forces the node into the stub index.
  const graph = new ContextGraph({ budgetTokens: 40, digestChars: 320 });
  graph.add({ layer: "mission", label: "task", text: "Task: render" });
  const unloaded = graph.add({ layer: "evidence", label: "web_research physics", text: filler("research", 4000) });

  const rendered = graph.render();
  assert.match(rendered, /## Context \(revision \d+ \| budget 40 tokens/);
  assert.match(rendered, /### Mission/);
  assert.match(rendered, /focus: root task/);
  assert.match(rendered, /Context index \(not loaded/);
  assert.match(rendered, new RegExp(`- \\[${unloaded.id}\\] web_research physics \\(evidence, L0, ~1000 tokens\\)`));
  assert.match(rendered, /Context pressure: 0 node\(s\) digested, 1 unloaded/);

  // With room for the digest the same node is rendered, marked as a digest.
  const roomy = new ContextGraph({ budgetTokens: 150, digestChars: 320 });
  const node = roomy.add({ layer: "evidence", label: "web_research physics", text: filler("research", 4000) });
  const digestRender = roomy.render();
  assert.match(digestRender, new RegExp(`\\[${node.id}\\] web_research physics \\(L0, digest\\)`));
  assert.match(digestRender, /Context pressure: 1 node\(s\) digested, 0 unloaded/);
});

test("expand reloads a stub in full on the next selection", () => {
  const graph = new ContextGraph({ budgetTokens: 260 });
  graph.add({ layer: "mission", label: "task", text: "Task: expand" });
  const a = graph.add({ layer: "evidence", label: "first", text: filler("first", 800) });
  const b = graph.add({ layer: "evidence", label: "second", text: filler("second", 800) });

  const before = graph.select();
  assert.ok(before.stubs.length + before.digested.length >= 1);

  const outcome = graph.applyOps([{ op: "expand", node: b.id, reason: "need the details" }]);
  assert.equal(outcome.applied[0].op, "expand");
  const after = graph.select();
  const expanded = after.included.find((entry) => entry.node.id === b.id);
  assert.ok(expanded, "the expanded node is loaded");
  assert.equal(expanded.form, "full");
  assert.ok(
    graph.scoreNode(graph.get(b.id)) > graph.scoreNode(graph.get(a.id)),
    "an explicitly expanded node outranks its untouched sibling",
  );
});

test("an expand that cannot fit yields the largest window the budget allows", () => {
  // Live finding (gpt-oss-20b, 2026-07-25): the model expanded a node far larger
  // than the budget; a silent fallback to the small default digest made the op
  // useless, so an expand now always yields strictly more content.
  const graph = new ContextGraph({ budgetTokens: 300, digestChars: 320 });
  graph.add({ layer: "mission", label: "task", text: "Task: window" });
  const huge = graph.add({ layer: "evidence", label: "read_file huge.js", text: filler("huge", 6000) });

  const digestForm = graph.select().included.find((entry) => entry.node.id === huge.id);
  assert.equal(digestForm.form, "digest");

  graph.applyOps([{ op: "expand", node: huge.id }]);
  const selection = graph.select();
  const windowed = selection.included.find((entry) => entry.node.id === huge.id);
  assert.equal(windowed.form, "partial");
  assert.ok(windowed.tokens > digestForm.tokens, "the window is larger than the digest it replaced");
  assert.ok(selection.usedTokens <= selection.budgetTokens, "the window still respects the budget");
  assert.match(windowed.text, /\[window: \d+ more chars; collapse or drop other nodes to load them\]/);
  assert.match(graph.render(), /read_file huge\.js \(L0, window\)/);
});

test("applyOps covers the context language and reports rejections", () => {
  const graph = new ContextGraph({ budgetTokens: 4000 });
  const target = graph.add({ layer: "evidence", label: "target", text: filler("target", 900) });
  const other = graph.add({ layer: "evidence", label: "other", text: "other" });

  const outcome = graph.applyOps(
    [
      { op: "pin", node: target.id },
      { op: "boost", node: other.id, importance: 0.95 },
      { op: "collapse", node: target.id, text: "three-line gist" },
      { op: "note", label: "decision", text: "chose Matter.js", layer: "plan" },
      { op: "link", from: target.id, to: other.id, relation: "supports" },
      { op: "open_subtask", label: "write the page", text: "produce index.html" },
      { op: "note", label: "sub note", text: "inside the subtask" },
      { op: "close_subtask", text: "page written" },
      { op: "teleport", node: target.id },
      { op: "pin", node: "nope" },
      { op: "note", label: "empty" },
    ],
    { turn: 2 },
  );

  assert.equal(outcome.applied.filter((entry) => entry.op === "pin").length, 1);
  assert.equal(graph.get(target.id).pinned, true);
  assert.equal(graph.get(target.id).digest, "three-line gist");
  assert.equal(graph.get(other.id).importance, 0.95);
  assert.equal(graph.edges.length, 2, "the model link plus the close_subtask derivation edge");

  const noteNode = [...graph.nodes.values()].find((node) => node.label === "decision");
  assert.equal(noteNode.layer, "plan");
  assert.equal(noteNode.source, "model");
  assert.equal(noteNode.turn, 2);

  const subNote = [...graph.nodes.values()].find((node) => node.label === "sub note");
  assert.equal(subNote.level, 1, "notes attach to the open subtask level");
  assert.equal(graph.focusId, null, "close_subtask pops the stack");

  const rejectedOps = outcome.rejected.map((entry) => entry.op);
  assert.deepEqual(rejectedOps, ["teleport", "pin", "note"]);
  assert.match(outcome.rejected[0].error, /unknown context op/);
  assert.match(outcome.rejected[1].error, /not found/);
  assert.match(outcome.rejected[2].error, /requires text/);
});

test("close_subtask refuses nodes that are not subtasks", () => {
  const graph = new ContextGraph({ budgetTokens: 4000 });
  const evidence = graph.add({ layer: "evidence", label: "read_file a.js", text: "content" });
  const outcome = graph.applyOps([{ op: "close_subtask", node: evidence.id, text: "pretend outcome" }]);
  assert.equal(outcome.applied.length, 0);
  assert.match(outcome.rejected[0].error, /is not an open subtask/);
  assert.equal(graph.get(evidence.id).state, "active", "the evidence node is untouched");
  assert.equal([...graph.nodes.values()].some((node) => node.kind === "subtask-outcome"), false);

  const noOpen = graph.applyOps([{ op: "close_subtask", text: "nothing open" }]);
  assert.match(noOpen.rejected[0].error, /no open subtask to close/);
});

test("applyOps refuses model notes in the runtime-owned layers and caps op count", () => {
  const graph = new ContextGraph({ budgetTokens: 4000, maxOpsPerTurn: 2 });
  const outcome = graph.applyOps([
    { op: "note", label: "sneaky", text: "pretend policy", layer: "mission" },
    { op: "note", label: "second", text: "ok" },
    { op: "note", label: "third", text: "dropped by the cap" },
  ]);
  assert.equal(outcome.applied.length, 2);
  const sneaky = [...graph.nodes.values()].find((node) => node.label === "sneaky");
  assert.equal(sneaky.layer, "plan", "model notes cannot claim the mission layer");
  assert.ok(outcome.rejected.some((entry) => /only 2 context ops/.test(entry.error)));
  assert.equal([...graph.nodes.values()].some((node) => node.label === "third"), false);
});

test("reform expands nodes matching the reported gap and records the gap", () => {
  const graph = new ContextGraph({ budgetTokens: 300 });
  graph.add({ layer: "mission", label: "task", text: "Task: validate input" });
  const parser = graph.add({
    layer: "evidence",
    label: "read_file src/libs/cli-utils.js",
    text: `${filler("parser", 1200)}\nparseNumericSetting implementation`,
  });
  graph.add({ layer: "evidence", label: "read_file README.md", text: filler("readme", 1200) });

  const reform = graph.reform({ gap: "need the parseNumericSetting signature in cli-utils.js", turn: 3 });
  assert.ok(reform.expanded.includes(parser.id));
  assert.equal(graph.get(parser.id).expandRequested, true);
  const note = graph.get(reform.noteId);
  assert.equal(note.layer, "scratch");
  assert.match(note.text, /Reported context gap/);
  assert.match(note.text, /Expanded/);

  const empty = new ContextGraph({ budgetTokens: 300 });
  empty.add({ layer: "evidence", label: "unrelated", text: "nothing to match" });
  const missed = empty.reform({ gap: "some totally absent symbol", turn: 1 });
  assert.deepEqual(missed.expanded, []);
  assert.match(empty.get(missed.noteId).text, /No stored node matched/);
});

test("decay ages evidence but never the invariant layers", () => {
  const graph = new ContextGraph({ budgetTokens: 4000, decayFactor: 0.5 });
  const mission = graph.add({ layer: "mission", label: "task", text: "Task: decay", importance: 1 });
  const evidence = graph.add({ layer: "evidence", label: "old", text: "old", importance: 0.8 });
  const pinned = graph.add({ layer: "evidence", label: "pinned", text: "pinned", importance: 0.8, pinned: true });

  graph.decay({ turn: 1 });
  graph.decay({ turn: 2 });

  assert.equal(graph.get(mission.id).importance, 1);
  assert.equal(graph.get(pinned.id).importance, 0.8);
  assert.equal(graph.get(evidence.id).importance, 0.2);
  assert.equal(graph.turn, 2);
});

test("TTL nodes survive the turn they apply to, then expire", () => {
  // Live finding (2026-07-25): corrective feedback placed in the scratch layer was
  // demoted to a stub under budget pressure, so the model never saw it. It now
  // lives in a retained layer with a TTL instead of accumulating forever.
  const graph = new ContextGraph({ budgetTokens: 120 });
  graph.add({ layer: "mission", label: "task", text: "Task: ttl" });
  graph.add({ layer: "evidence", label: "bulk", text: filler("bulk", 4000) });
  graph.turn = 1;
  const nudge = graph.add({
    layer: "contract",
    label: "duplicate action",
    text: "read_file a.js -> already gathered (skipped); use it or emit finish.",
    ttlTurns: 1,
    turn: 1,
  });

  // Turn 2: the nudge is loaded despite the bulky evidence competing for budget.
  graph.decay({ turn: 2 });
  assert.ok(graph.get(nudge.id), "the nudge survives into the turn it applies to");
  const loaded = graph.select().included.map((entry) => entry.node.id);
  assert.ok(loaded.includes(nudge.id), "a retained nudge cannot be demoted to a stub");

  // Turn 3: it has had its turn and is gone.
  graph.decay({ turn: 3 });
  assert.equal(graph.get(nudge.id), null, "the nudge expires instead of accumulating");
});

test("retained layers cannot grow without bound", () => {
  const graph = new ContextGraph({ budgetTokens: 4000 });
  const policy = graph.add({ layer: "contract", label: "session policies", text: "standing rule" });
  for (let i = 0; i < 10; i += 1) {
    graph.turn = i;
    graph.add({ layer: "contract", label: `nudge ${i}`, text: `nudge ${i}`, ttlTurns: 1, turn: i });
  }
  const contractNodes = [...graph.nodes.values()].filter((node) => node.layer === "contract");
  assert.ok(contractNodes.length <= 6, `contract layer capped, got ${contractNodes.length}`);
  assert.ok(graph.get(policy.id), "the standing rule outlives the expiring nudges");
  assert.ok(
    contractNodes.some((node) => node.label === "nudge 9"),
    "the newest correction is always kept",
  );
});

test("buildSubConversation carries invariants plus the ancestor spine only", () => {
  const graph = new ContextGraph({ budgetTokens: 4000 });
  graph.add({ layer: "mission", label: "task", text: "Task: nested work" });
  const outer = graph.openSubtask({ label: "outer", text: "outer goal" });
  const outerEvidence = graph.add({ layer: "evidence", label: "outer evidence", text: "outer data" });
  const inner = graph.openSubtask({ label: "inner", text: "inner goal" });
  const innerEvidence = graph.add({ layer: "evidence", label: "inner evidence", text: "inner data" });
  graph.closeSubtask({ id: inner.id, text: "inner done" });
  const sibling = graph.openSubtask({ label: "sibling", text: "sibling goal" });
  graph.add({ layer: "evidence", label: "sibling evidence", text: "sibling data" });

  const scoped = graph.buildSubConversation(inner.id);
  const ids = [...scoped.nodes.keys()];
  assert.ok(ids.includes(outer.id) && ids.includes(inner.id), "spine subtasks are kept");
  assert.ok(ids.includes(innerEvidence.id), "the subtask's own evidence is kept");
  assert.ok(ids.includes(outerEvidence.id), "ancestor evidence is kept");
  assert.equal(ids.includes(sibling.id), false, "sibling branches are excluded, not just deprioritized");
  const rendered = scoped.render();
  assert.match(rendered, /Task: nested work/);
  assert.doesNotMatch(rendered, /sibling evidence/);
});

test("the graph round-trips through JSON with focus and edges intact", () => {
  const graph = new ContextGraph({ budgetTokens: 1234, digestChars: 200 });
  graph.add({ layer: "mission", label: "task", text: "Task: persist" });
  const subtask = graph.openSubtask({ label: "phase one", text: "goal" });
  const evidence = graph.add({ layer: "evidence", label: "read_file a.js", text: "content" });
  graph.link(evidence.id, subtask.id, "supports");
  graph.decay({ turn: 4 });

  const restored = ContextGraph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())));
  assert.equal(restored.budgetTokens, 1234);
  assert.equal(restored.turn, 4);
  assert.equal(restored.focusId, subtask.id);
  assert.deepEqual(restored.focusPath(), [subtask.id]);
  assert.equal(restored.nodes.size, graph.nodes.size);
  assert.deepEqual(restored.edges, graph.edges);
  // Ids keep incrementing after a resume instead of colliding.
  assert.notEqual(restored.add({ layer: "evidence", label: "new", text: "x" }).id, evidence.id);
  assert.equal(restored.render().includes("phase one"), true);
});

test("the node cap evicts the weakest nodes and keeps invariants", () => {
  const graph = new ContextGraph({ budgetTokens: 4000, maxNodes: 6 });
  graph.add({ layer: "mission", label: "task", text: "Task: cap" });
  graph.add({ layer: "contract", label: "policy", text: "JSON only" });
  const keeper = graph.add({ layer: "evidence", label: "keeper", text: "keep me", pinned: true });
  for (let i = 0; i < 20; i += 1) {
    graph.add({ layer: "scratch", label: `noise ${i}`, text: `noise ${i}` });
  }
  assert.equal(graph.nodes.size, 6);
  assert.ok(graph.get(keeper.id), "pinned nodes survive eviction");
  const layers = [...graph.nodes.values()].map((node) => node.layer);
  assert.ok(layers.includes("mission") && layers.includes("contract"));
  assert.equal(Object.keys(CONTEXT_LAYERS).length, 6);
});
