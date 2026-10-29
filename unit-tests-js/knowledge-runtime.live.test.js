import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import fs from "node:fs/promises";
import { startCheetahServer } from "../src/libs/cheetah-binder.js";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";
import { createKnowledgeRuntime } from "../src/libs/knowledge-runtime.js";

const enabled = process.env.MINIPHI_LMSTUDIO_INTEGRATION === "1" && process.env.MINIPHI_CHEETAH_INTEGRATION === "1";
const models = (process.env.MINIPHI_LIVE_MODELS ?? "qwen3-4b-thinking-2507-mlx,gpt-oss-20b").split(",").filter(Boolean);
test("optional knowledge learns and retrieves a cited fact across selected LM Studio models", { skip: !enabled, timeout: 900000 }, async t => {
  const root = path.resolve(".miniphi/knowledge", `live-${Date.now()}`);
  await fs.mkdir(root, { recursive: true });
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const server = await startCheetahServer({ port, dataDir: path.join(root, "data"), binaryPath: path.resolve("thirds/cheetah/cheetah-server"), build: false });
  t.after(() => server.stop());
  for (const model of models) await t.test(model, { timeout: 420000 }, async () => {
    const client = new LMStudioRestClient({ baseUrl: process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234", defaultModel: model, timeoutMs: 60000 });
    const runtime = await createKnowledgeRuntime({ client, model, baseDir: root, sessionId: model,
      configData: { knowledge: { enabled: true, timeoutMs: 180000, cheetah: { port, database: "general_knowledge_live" } } } });
    assert(runtime);
    try {
      const [source] = runtime.observe({ text: "North Corp ZQ7419 is located in Rome.", source: "operator-fixture", kind: "workspace" });
      const learned = await runtime.learn({ sourceId: source.source_id });
      assert(learned.ok, JSON.stringify(learned));
      assert(learned.written + learned.known >= 1, JSON.stringify(learned));
      const checked = await runtime.check({ question: "Where is North Corp ZQ7419 located?" });
      assert(checked.ok, JSON.stringify(checked));
      assert.equal(checked.concepts[0]?.answer, "Rome", JSON.stringify(checked));
      assert(checked.concepts[0].grounded);
      assert(checked.concepts[0].evidence.length >= 1);
      const control = await runtime.check({ question: "Where is NeverTaught Company ZX8291 located?" });
      assert.equal(control.needs_more_context, true);
      assert(control.concepts.every(c => !c.grounded));
      const open = await runtime.questions();
      assert(open.items.some(item => item.question.includes("NeverTaught")));
      t.diagnostic(`${model}: learned=${learned.written}, known=${learned.known}, answer=${checked.concepts[0].answer}; audit=${root}`);
    } finally { await runtime.close(); }
  });
});

test("knowledge runtime uses the real Cheetah protocol with a schema-scripted model", { skip: process.env.MINIPHI_CHEETAH_INTEGRATION !== "1", timeout: 30000 }, async t => {
  const root = path.resolve(".miniphi/knowledge", `protocol-${Date.now()}`);
  await fs.mkdir(root, { recursive: true });
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const server = await startCheetahServer({ port, dataDir: path.join(root, "data"), binaryPath: path.resolve("thirds/cheetah/cheetah-server"), build: false });
  t.after(() => server.stop());
  const question = "Where is North Corp ZQ7419 located?";
  const common = { missing_snippets: [], stop_reason: "completed" };
  const turns = [
    { ...common, needs_more_context: false, facts: [{ subject: "North Corp ZQ7419", relation: "located_in", object: "Rome", quote: "North Corp ZQ7419 is located in Rome." }] },
    { ...common, needs_more_context: true, concepts: [{ id: "c1", entity: "North Corp ZQ7419", aspect: "location", question, prior_answer: "Paris", self_confidence: 0.8, basis: "Unverified recollection" }] },
    { ...common, needs_more_context: true, lookups: [{ entity: "focus", direction: "out", relation: "" }] },
    { ...common, needs_more_context: false, lookups: [], answer_entity: "Rome", evidence_ids: ["e1"], self_confidence: 1, reasoning_summary: "Source names Rome" },
  ];
  const client = { async createChatCompletion(request) {
    assert.equal(request.model, "schema-scripted-model");
    assert.equal(request.response_format.type, "json_schema");
    assert(turns.length, "Unexpected model call");
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(turns.shift()), tool_calls: [] } }] };
  } };
  const runtime = await createKnowledgeRuntime({ client, model: "schema-scripted-model", contextLength: 16384,
    baseDir: root, sessionId: "protocol", env: {}, configData: { knowledge: { enabled: true, cheetah: { port, database: "runtime_protocol" } } } });
  assert(runtime);
  try {
    const [source] = runtime.observe({ text: "North Corp ZQ7419 is located in Rome.", source: "FACTS.md", kind: "workspace" });
    assert.equal((await runtime.learn({ sourceId: source.source_id })).written, 1);
    const result = await runtime.check({ question });
    assert.equal(result.concepts[0].answer, "Rome", JSON.stringify(result));
    assert(result.concepts[0].correction);
    assert.equal(result.model_limits[0]?.factual, false);
    assert.equal(turns.length, 0);
    t.diagnostic(`Cheetah protocol audit: ${root}`);
  } finally { await runtime.close(); }
});
