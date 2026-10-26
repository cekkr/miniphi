import test from "node:test";
import assert from "node:assert/strict";
import LMStudioHandler from "../src/libs/lmstudio-handler.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

const schemaRegistry = new PromptSchemaRegistry();
const document = { facts: [], needs_more_context: false, missing_snippets: [], stop_reason: "completed" };
const format = { type: "json_schema", json_schema: { schema: schemaRegistry.getSchema("cheetah-graph-extract").definition } };
function client(message, finish_reason = "stop") {
  return { async createChatCompletion(request) {
    assert.equal(request.response_format.type, "json_schema");
    return { choices: [{ message, finish_reason }], usage: { completion_tokens: 30 } };
  } };
}
function handler(message, options = {}, finish = "stop") {
  return new LMStudioHandler(undefined, { schemaRegistry, restClient: client(message, finish), preferRestTransport: true, ...options });
}

test("opt-in accepts only whole schema-valid JSON misrouted into reasoning", async () => {
  const raw = JSON.stringify(document);
  const h = handler({ content: "", reasoning_content: raw, tool_calls: [] }, { acceptReasoningJson: true });
  const result = await h._invokeRestCompletion(format);
  assert.equal(result.text, raw);
  assert.equal(result.rawText, "");
  assert.equal(result.reasoning, raw);
  assert.equal(result.structuredOutputSource, "reasoning_content");
  assert.equal(result.usage.completion_tokens, 30);
});

test("rejects prose, fragments, invalid schema, truncation and tool calls", async () => {
  for (const [reasoning, finish, calls] of [
    ['Thinking... ' + JSON.stringify(document), "stop", []],
    ['{"facts":[]}', "stop", []],
    [JSON.stringify(document), "length", []],
    [JSON.stringify(document), "stop", [{ id: "tool1" }]],
  ]) {
    const result = await handler({ content: "", reasoning_content: reasoning, tool_calls: calls }, { acceptReasoningJson: true }, finish)._invokeRestCompletion(format);
    assert.equal(result.text, "");
  }
  assert.equal((await handler({ content: "", reasoning_content: JSON.stringify(document) })._invokeRestCompletion(format)).text, "");
  assert.equal((await handler({ content: "final", reasoning_content: JSON.stringify(document) }, { acceptReasoningJson: true })._invokeRestCompletion(format)).text, "final");
});

test("recording distinguishes original response, accepted JSON and reasoning", async () => {
  let exchange;
  const h = handler({ content: "", reasoning_content: JSON.stringify(document), tool_calls: [] }, {
    acceptReasoningJson: true,
    promptRecorder: { async record(value) { exchange = value; return { id: "recorded" }; } },
  });
  await h.chatStream("Return strict JSON.", undefined, undefined, undefined, { schemaId: "cheetah-graph-extract" });
  assert.equal(exchange.request.response_format.type, "json_schema");
  assert.equal(exchange.response.rawResponseText, "");
  assert.equal(exchange.response.structuredOutputSource, "reasoning_content");
  assert.deepEqual(JSON.parse(exchange.response.text), document);
  assert.equal(exchange.response.reasoning.length, 1);
  assert.deepEqual(exchange.response.tool_calls, []);
  assert.equal(exchange.response.usage.completion_tokens, 30);
});
