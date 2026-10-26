import test from "node:test";
import assert from "node:assert/strict";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import { buildGraphResponseContract, graphSourceSentences } from "../src/libs/cheetah-prompt-contract.js";
import LMStudioHandler from "../src/libs/lmstudio-handler.js";
import { runGraphPrompt } from "../src/libs/cheetah-graph-learning.js";

const registry = new PromptSchemaRegistry();

test("response contracts validate every template, reject schema drift and avoid mutating schemas", () => {
  const schema = registry.getSchema("cheetah-graph-query");
  const before = JSON.stringify(schema.definition);
  const contract = buildGraphResponseContract(registry, schema.id, {});
  assert.equal(contract.response_templates.length, 1);
  contract.response_schema.properties.lookups.minItems = 99;
  assert.equal(JSON.stringify(schema.definition), before);
  assert.throws(() => registry.buildResponseContract(schema.id, { templates: [{ when: "bad", response: { lookups: [] } }] }), /Invalid response template/);
  assert.throws(() => registry.buildResponseContract(schema.id, { templates: [] }), /1\.\.3/);
  assert.throws(() => registry.buildResponseContract("missing", { templates: [] }), /Missing schema/);
});

test("extraction template capacity follows source sentences without copying facts or splitting decimals", () => {
  const source = "The diameter is 1.524. The number of stages is 2.";
  assert.equal(graphSourceSentences(source).length, 2);
  const contract = buildGraphResponseContract(registry, "cheetah-graph-extract", { source_text: source });
  assert.equal(contract.response_templates[0].response.facts.length, 2);
  assert(!JSON.stringify(contract.response_templates).includes("1.524"));
  const many = buildGraphResponseContract(registry, "cheetah-graph-extract", { source_text: "A grows. B grows. C grows. D grows. E grows." });
  assert.equal(many.response_templates[0].response.facts.length, 4);
});

test("assessment, extraction, focused lookup and reasoning templates follow their current context", () => {
  const pair = buildGraphResponseContract(registry, "cheetah-knowledge-assessment-pair", { requested_concept_count: 2 });
  assert.equal(pair.response_templates[0].response.concepts.length, 2);
  assert.equal(pair.response_templates[0].response.concepts[1].id, "c2");
  assert.equal(pair.response_templates[0].response.concepts[0].prior_answer, "");
  const extract = buildGraphResponseContract(registry, "cheetah-graph-extract", {});
  assert(extract.response_templates[0].response.facts[0].quote.includes("<"));
  const lookup = buildGraphResponseContract(registry, "cheetah-focused-query", { entity_candidates: [{ id: "focus", name: "Alice" }] });
  assert.equal(lookup.response_templates[0].response.lookups[0].entity, "focus");
  assert(!("answer_entity" in lookup.response_templates[0].response));
  const repair = buildGraphResponseContract(registry, "cheetah-focused-query", { entity_candidates: [{ id: "focus", name: "Alice" }, { id: "e1_object", name: "North Corp" }],
    next_lookup: { entity: "e1_object", relation: "", direction: "out" } });
  assert.equal(repair.response_templates[0].response.lookups[0].entity, "e1_object");
  const reason = buildGraphResponseContract(registry, "cheetah-concept-reason", { evidence: [{ object: "GOLD_DO_NOT_PREFILL" }] });
  assert.equal(reason.response_templates.length, 3);
  assert(!JSON.stringify(reason).includes("GOLD_DO_NOT_PREFILL"));
  assert(reason.response_templates.every(t => registry.validateOutcome("cheetah-concept-reason", JSON.stringify(t.response)).status === "ok"));
  assert(reason.response_templates.every(t => !(t.response.lookups.length && t.response.answer_entity)));
});

test("schema retries preserve the JSON envelope and its response templates on the actual wire", async () => {
  const requests = [];
  const exchanges = [];
  const contract = buildGraphResponseContract(registry, "cheetah-graph-extract", {});
  const valid = { facts: [], needs_more_context: false, missing_snippets: [], stop_reason: "completed" };
  const handler = new LMStudioHandler(undefined, { schemaRegistry: registry, preferRestTransport: true,
    promptRecorder: { async record(value) { exchanges.push(value); return { id: `exchange-${exchanges.length}` }; } },
    restClient: { async createChatCompletion(request) {
      requests.push(request);
      return { choices: [{ message: { content: requests.length === 1 ? "Please use this answer." : JSON.stringify(valid) }, finish_reason: "stop" }] };
    } },
  });
  const result = await handler.chatStream(JSON.stringify({ source_text: "SOURCE_SENTINEL", ...contract }), undefined, undefined, undefined, { schemaId: "cheetah-graph-extract" });
  assert.deepEqual(JSON.parse(result), valid);
  assert.equal(requests.length, 2);
  const messages = requests[1].messages.filter(m => m.role === "user").map(m => JSON.parse(m.content));
  assert.equal(messages.at(-1).response_correction.code, "schema-invalid");
  assert.equal(messages.at(-1).source_text, "SOURCE_SENTINEL");
  assert.deepEqual(messages.at(-1).response_templates, contract.response_templates);
  assert(requests.every(r => r.response_format.type === "json_schema"));
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].response.rawResponseText, "Please use this answer.");
  assert.equal(exchanges[0].response.schemaValidation.valid, false);
});

test("repeated schema drift stops after one repair instead of switching transports", async () => {
  let calls = 0;
  const handler = new LMStudioHandler(undefined, { schemaRegistry: registry, preferRestTransport: true,
    restClient: { async createChatCompletion() { calls += 1; return { choices: [{ message: { content: "Still not JSON" }, finish_reason: "stop" }] }; } },
  });
  await assert.rejects(() => handler.chatStream(JSON.stringify({ task: "Assess", ...buildGraphResponseContract(registry, "cheetah-graph-extract", {}) }), undefined, undefined, undefined, { schemaId: "cheetah-graph-extract" }), /schema validation/);
  assert.equal(calls, 2);
  assert.equal(handler.preferRestTransport, true);
});

test("context enum constraints narrow the actual response schema and survive a JSON repair", async () => {
  const requests = [];
  const lookup = entity => ({ lookups: [{ entity, relation: "", direction: "out" }], needs_more_context: true, missing_snippets: [], stop_reason: "completed" });
  const handler = new LMStudioHandler(undefined, { schemaRegistry: registry, preferRestTransport: true,
    restClient: { async createChatCompletion(request) {
      requests.push(request);
      return { choices: [{ message: { content: JSON.stringify(lookup(requests.length === 1 ? "Aarhus Airport" : "Tirstrup")) }, finish_reason: "stop" }] };
    } },
  });
  const result = await runGraphPrompt({ handler, schemaRegistry: registry, schemaId: "cheetah-graph-query", trace: [], deadline: Date.now() + 30000,
    payload: { question: "In which country is Aarhus Airport located?", next_lookup: lookup("Tirstrup").lookups[0], required_lookup: lookup("Tirstrup").lookups[0] },
  });
  assert.equal(result.lookups[0].entity, "Tirstrup");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.response_format.json_schema.schema.properties.lookups.items.properties.entity.enum, ["Tirstrup"]);
    const p = JSON.parse(request.messages.filter(m => m.role === "user").at(-1).content);
    assert.deepEqual(p.response_schema.properties.lookups.items.properties.entity.enum, ["Tirstrup"]);
  }
  assert.throws(() => registry.buildResponseContract("cheetah-graph-query", { templates: [], enumConstraints: [{ path: ["__proto__"], values: ["x"] }] }), /Unknown response enum/);
});
