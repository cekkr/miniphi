import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { KnowledgeRuntime, createKnowledgeRuntime, resolveKnowledgeConfig } from "../src/libs/knowledge-runtime.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import { buildLmStudioHandler } from "../src/libs/cheetah-model-handler.js";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import { normalizeAgentAction } from "../src/agent/agent-executor.js";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";

const schemaRegistry = new PromptSchemaRegistry();
const encode = data => ({ ok: true, fields: { payload: Buffer.from(JSON.stringify(data)).toString("base64"), next_cursor: "*" } });
function graphClient() {
  const nodes = new Map(), edges = new Map(), calls = [];
  const field = (line, key) => line.match(new RegExp(`(?:^| )${key}=([^ ]+)`))?.[1];
  const json = (line, key) => JSON.parse(Buffer.from(field(line, key), "base64").toString());
  const edgeKey = e => JSON.stringify([e.from, e.to, e.type]);
  return { nodes, edges, calls, database: "runtime_test", closed: false,
    async putValue() { return 1; },
    async close() { this.closed = true; },
    async execute(commands) { return commands.map(line => {
      calls.push(line);
      if (line.startsWith("GRAPH_NODE_GET")) return nodes.has(field(line, "id")) ? encode(nodes.get(field(line, "id"))) : { ok: false, raw: "ERROR,node_not_found" };
      if (line.startsWith("GRAPH_NODE_SET")) {
        const id = field(line, "id");
        nodes.set(id, { id, props: field(line, "props") ? json(line, "props") : {}, references: field(line, "references") ? json(line, "references") : [] });
      }
      if (line.startsWith("GRAPH_EDGE_GET")) {
        const e = edges.get(edgeKey({ from: field(line, "from"), to: field(line, "to"), type: field(line, "type") }));
        return e ? encode(e) : { ok: false, raw: "ERROR,edge_not_found" };
      }
      if (line.startsWith("GRAPH_EDGE_SET")) {
        const items = line.startsWith("GRAPH_EDGE_SET_BATCH") ? json(line, "items") : [{ from: field(line, "from"), to: field(line, "to"), type: field(line, "type"), props: field(line, "props") ? json(line, "props") : {} }];
        for (const item of items) edges.set(edgeKey(item), { ...item, id: edgeKey(item) });
        return { ok: true, fields: { applied: String(items.length), failed: "0" } };
      }
      if (line.startsWith("GRAPH_QUERY")) {
        const id = line.match(/id='([^']+)'/)?.[1];
        return encode([...edges.values()].filter(e => (line.includes("<-[") ? e.to : e.from) === id));
      }
      if (line.startsWith("GRAPH_NEIGHBORS")) return encode([...edges.values()].filter(e => e.from === field(line, "id") && e.type === field(line, "type")));
      return { ok: true, fields: {} };
    }); },
  };
}
const question = "Where is North Corp located?";
const fact = { subject: "North Corp", relation: "located_in", object: "Rome", quote: "North Corp is located in Rome." };
const extract = { facts: [fact], needs_more_context: false, missing_snippets: [], stop_reason: "completed" };
const assessment = { concepts: [{ id: "c1", entity: "North Corp", aspect: "location", question, prior_answer: "Paris", self_confidence: 0.8, basis: "Unverified memory" }], needs_more_context: true, missing_snippets: [], stop_reason: "completed" };
const lookup = { lookups: [{ entity: "focus", direction: "out", relation: "" }], needs_more_context: true, missing_snippets: [], stop_reason: "completed" };
const answer = { self_confidence: 0.95, reasoning_summary: "The source names Rome.", lookups: [], answer_entity: "Rome", evidence_ids: ["e1"], needs_more_context: false, missing_snippets: [], stop_reason: "completed" };
function modelClient(turns) {
  return { calls: [], async createChatCompletion(request) {
    this.calls.push(request);
    const response = turns.shift();
    assert.notEqual(response, undefined, "unexpected model call");
    return { choices: [{ finish_reason: "stop", message: { content: typeof response === "string" ? response : JSON.stringify(response), tool_calls: [] } }] };
  } };
}
function runtime(turns, options = {}) {
  return new KnowledgeRuntime({ client: modelClient(turns), cheetahClient: graphClient(),
    model: "arbitrary-model-A", contextLength: 16384, schemaRegistry,
    config: resolveKnowledgeConfig({ knowledge: { enabled: true } }, {}), ...options });
}

test("knowledge is opt-in; unhealthy probes close the client without advertising a capability", async () => {
  assert.equal(resolveKnowledgeConfig({}, {}).enabled, false);
  assert.equal(resolveKnowledgeConfig({}, { MINIPHI_KNOWLEDGE: "1" }).enabled, true);
  assert.equal(resolveKnowledgeConfig({}, {}).database, "miniphi_webnlg");
  const graph = graphClient();
  assert.equal(await createKnowledgeRuntime({ client: modelClient([]), cheetahClient: graph, env: {} }), null);
  assert.equal(graph.calls.length, 0);
  graph.execute = async () => [{ ok: false }];
  assert.equal(await createKnowledgeRuntime({ client: modelClient([]), cheetahClient: graph, env: { MINIPHI_KNOWLEDGE: "1" } }), null);
  assert.equal(graph.closed, true);
});

test("learns observed sources, checks and repairs with any model; priors never become facts", async () => {
  const root = await createTempWorkspace();
  try {
    const rt = runtime([extract, assessment, lookup, answer, assessment, lookup, answer], { baseDir: root });
    const [source] = rt.observe({ text: fact.quote, source: "README.md", kind: "workspace" });
    assert.equal((await rt.learn({ sourceId: "invented" })).ok, false);
    assert.equal(rt.client.calls.length, 0);
    assert.equal((await rt.learn({ sourceId: source.source_id })).written, 1);
    const checked = await rt.check({ question });
    assert.equal(checked.concepts[0].answer, "Rome");
    assert.equal(checked.concepts[0].correction, true);
    assert.equal(checked.concepts[0].evidence[0].quote, fact.quote);
    assert.equal(checked.needs_more_context, false);
    assert.equal(checked.stop_reason_code, null);
    const closedBook = JSON.parse(rt.client.calls[1].messages.at(-1).content);
    assert.equal(closedBook.evidence, undefined);
    rt.configure({ model: "arbitrary-model-B", contextLength: 16384 });
    const next = await rt.check({ question });
    assert.equal(next.concepts[0].grounded, true);
    assert(rt.client.calls.slice(4).every(call => call.model === "arbitrary-model-B"));
    assert(rt.client.calls.every(call => call.response_format.type === "json_schema"));
    assert([...rt.cheetahClient.nodes.values()].filter(n => n.id.startsWith("model-limit:")).every(n => n.props.factual === false));
    assert.equal([...rt.cheetahClient.edges.values()].filter(e => e.type === "located_in").length, 1);
    const exchangeFiles = (await fs.readdir(path.join(root, "prompt-exchanges"))).filter(file => file !== "index.json");
    assert.equal(exchangeFiles.length, rt.client.calls.length);
    for (const file of exchangeFiles) {
      const exchange = JSON.parse(await fs.readFile(path.join(root, "prompt-exchanges", file)));
      assert(Object.hasOwn(exchange.request, "tool_definitions"));
      assert(Object.hasOwn(exchange.response, "tool_calls"));
      assert(Object.hasOwn(exchange.response, "tool_definitions"));
      assert.equal(exchange.request.response_format.type, "json_schema");
      assert(exchange.response.rawResponseText);
    }
    const persisted = JSON.parse(await fs.readFile(path.join(root, "knowledge", "knowledge", "runtime.json")));
    assert.equal(persisted.records.filter(r => r.operation === "check").length, 2);
    assert.equal((await rt.learn({ sourceId: source.source_id })).duplicate, true);
  } finally { await removeTempWorkspace(root); }
});

test("invalid model JSON is repaired once and never written; deadlines and action caps persist stop codes", async () => {
  const rt = runtime(["not json", "not json"]);
  const [source] = rt.observe({ text: fact.quote, source: "README.md", kind: "workspace" });
  const learned = await rt.learn({ sourceId: source.source_id });
  assert.equal(learned.ok, false);
  assert.equal(learned.stop_reason_code, "invalid-response");
  assert.equal(rt.client.calls.length, 2);
  assert.equal(rt.cheetahClient.edges.size, 0);
  assert(JSON.parse(rt.client.calls[1].messages.at(-1).content).response_correction);
  assert.equal((await rt.check({ question, sessionDeadline: Date.now() - 1 })).stop_reason_code, "session-timeout");
  rt.actions = rt.config.maxActions;
  const capped = await rt.check({ question });
  assert.equal(capped.stop_reason_detail, "max-actions");
  assert.equal(capped.stop_reason_code, "analysis-error");
});

test("source pages preserve UTF-8 bounds and reject model-authored evidence", () => {
  const rt = runtime([]);
  assert.deepEqual(rt.observe({ text: "I remember Rome", source: "prior", kind: "model" }), []);
  const entries = rt.observe({ text: "😀".repeat(2400), source: "fixture", kind: "workspace" });
  assert.equal(entries.length, 3);
  assert.equal([...rt.sources.values()].map(s => s.text).join(""), "😀".repeat(2400));
  assert(entries.every(s => s.bytes <= 4000));
});

test("headless prompt enrichment preserves schemas and does not recursively enrich graph calls", async () => {
  const rt = runtime([extract, assessment, lookup, answer, { facts: [], needs_more_context: false, missing_snippets: [], stop_reason: "completed" }]);
  const [source] = rt.observe({ text: fact.quote, source: "README.md", kind: "workspace" });
  await rt.learn({ sourceId: source.source_id });
  const handler = buildLmStudioHandler({ restClient: rt.client, schemaRegistry, modelKey: rt.model });
  handler.knowledgeRuntime = rt;
  const original = { task: question, response_schema: schemaRegistry.getSchema("cheetah-graph-extract").definition };
  await handler.chatStream(JSON.stringify(original), undefined, undefined, undefined, { schemaId: "cheetah-graph-extract" });
  const enriched = JSON.parse(rt.client.calls.at(-1).messages.at(-1).content);
  assert.deepEqual(enriched.response_schema, original.response_schema);
  assert.equal(enriched.knowledge_context.concepts[0].answer, "Rome");
  assert.equal(enriched.knowledge_context.concepts[0].prior_answer, undefined);
  assert.equal(rt.client.calls.length, 5);
});

test("agent actions expose observed sources and re-inject knowledge as temporary corrective context", async () => {
  const root = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(root, "README.md"), fact.quote);
    const rt = runtime([extract, assessment, lookup, answer]);
    const turns = [];
    const client = { async createChatCompletion({ messages }) {
      turns.push(messages);
      let actions;
      if (turns.length === 1) actions = [{ type: "read_file", path: "README.md", reason: "read source" }];
      else if (turns.length === 2) actions = [{ type: "knowledge_learn", source_id: [...rt.sources.keys()][0], reason: "learn observed fact" }];
      else if (turns.length === 3) actions = [{ type: "knowledge_check", question, reason: "check remembered answer" }];
      else if (turns.length === 4) actions = [{ type: "write_file", path: "answer.json", content: JSON.stringify({ location: "Rome" }), reason: "apply checked answer" }];
      else actions = [{ type: "finish", reason: "checked" }];
      return { choices: [{ message: { content: JSON.stringify({ task: question, summary: "checking", summary_updates: [], actions, needs_more_context: false, missing_snippets: [] }) } }] };
    } };
    const session = new AgentSession({ client, model: rt.model, cwd: root, baseDir: root, contextLength: 16384, knowledgeRuntime: rt, approver: createHeadlessApprover({ policy: "allow" }) });
    session.configureModel({ model: "model-selected-in-picker", contextLength: 16384 });
    const result = await session.submitTask(question);
    assert(rt.client.calls.every(call => call.model === "model-selected-in-picker"));
    assert.equal(result.status, "completed");
    assert.match(JSON.stringify(turns[1]), /knowledge_sources/);
    assert.match(JSON.stringify(turns[3]), /Rome/);
    assert([...session.context.nodes.values()].some(n => n.layer === "contract" && n.kind === "knowledge"));
    assert.equal(result.knowledge.learned, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, "answer.json"))).location, "Rome");
    assert.equal(normalizeAgentAction({ type: "knowledge_learn", source_id: "invented", reason: "x" }, root).ok, false);
  } finally { await removeTempWorkspace(root); }
});

test("unknowns remain open, later source-backed checks resolve the exact question", async () => {
  const decline = { ...answer, answer_entity: "", evidence_ids: [], needs_more_context: true, self_confidence: 0, reasoning_summary: "No evidence" };
  const rt = runtime([assessment, lookup, decline, extract, assessment, lookup, answer]);
  const unknown = await rt.check({ question });
  assert(unknown.needs_more_context);
  assert.equal(unknown.concepts[0].answer, null);
  assert((await rt.questions()).items.some(item => item.question === question));
  const [source] = rt.observe({ text: fact.quote, source: "README.md", kind: "workspace" });
  assert.equal((await rt.learn({ sourceId: source.source_id })).written, 1);
  assert.equal((await rt.check({ question })).concepts[0].answer, "Rome");
  assert.equal((await rt.questions()).items.length, 0);
});

test("headless analyzer input is learned before context repair, and cached for its graph revision", async () => {
  const rt = runtime([extract, assessment, lookup, answer]);
  const prompt = JSON.stringify({ payload: { task: question, data: fact.quote, dataset: { source: "README.md" } } });
  const first = await rt.enrichPrompt(prompt, { question });
  assert.equal(JSON.parse(first).knowledge_context.concepts[0].answer, "Rome");
  assert.equal(rt.learned.size, 1);
  assert.equal(await rt.enrichPrompt(prompt, { question }), first);
  assert.equal(rt.client.calls.length, 4);
  assert.equal(await rt.enrichPrompt(prompt, { question, maxTokens: 100 }), prompt);
});

test("model diagnostic rules stay isolated from another model and from factual evidence", async () => {
  const rt = runtime([]);
  await rt.recordLesson({ kind: "runtime", detail: "North Corp build errors", rule: "Inspect the runtime before retrying" });
  assert.equal((await rt.limits(rt.model, "North Corp")).length, 1);
  assert.equal((await rt.limits("unrelated-model", "North Corp")).length, 0);
  assert([...rt.cheetahClient.nodes.keys()].every(id => !id.startsWith("knowledge:")));
});
