import test from "node:test";
import assert from "node:assert/strict";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";

const MESSAGES = [{ role: "user", content: "Return JSON." }];

function response(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return {
    ok,
    status,
    statusText,
    async text() {
      return JSON.stringify(body);
    },
    headers: { get: () => "application/json" },
  };
}

test("REST chat sends the advertised reasoning effort beside response_format", async () => {
  const bodies = [];
  const client = new LMStudioRestClient({
    defaultModel: "reasoner",
    defaultReasoning: {
      profile: "medium",
      model: { requested: "medium", resolved: "medium" },
    },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return response({ choices: [{ message: { content: "{}" } }] });
    },
  });
  const completion = await client.createChatCompletion({
    messages: MESSAGES,
    response_format: { type: "json_schema", json_schema: { name: "fixture" } },
  });
  assert.equal(bodies[0].reasoning, "medium");
  assert.equal(bodies[0].response_format.type, "json_schema");
  assert.equal(completion.miniphi_reasoning.sent, "medium");
  assert.equal(completion.miniphi_reasoning.supported, true);
});

test("unsupported reasoning retries exactly once without the setting and caches it", async () => {
  const bodies = [];
  const client = new LMStudioRestClient({
    defaultModel: "plain",
    defaultReasoning: {
      profile: "high",
      model: { requested: "high", resolved: "high" },
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ("reasoning" in body) {
        return response(
          { error: { message: "Unsupported reasoning option" } },
          { ok: false, status: 400, statusText: "Bad Request" },
        );
      }
      return response({ choices: [{ message: { content: "{}" } }] });
    },
  });

  const first = await client.createChatCompletion({ messages: MESSAGES });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning, "high");
  assert.equal("reasoning" in bodies[1], false);
  assert.equal(first.miniphi_reasoning.fallback, true);
  assert.equal(client.getReasoningSupport("plain"), false);

  await client.createChatCompletion({ messages: MESSAGES });
  assert.equal(bodies.length, 3);
  assert.equal("reasoning" in bodies[2], false);
});

test("reasoning=off detects a silently ignored setting from usage", async () => {
  const client = new LMStudioRestClient({
    defaultModel: "binary-reasoner",
    fetchImpl: async () =>
      response({
        choices: [{ message: { content: "{}" } }],
        usage: { completion_tokens_details: { reasoning_tokens: 12 } },
      }),
  });
  const completion = await client.createChatCompletion({
    messages: MESSAGES,
    reasoning: "off",
  });
  assert.equal(completion.miniphi_reasoning.ignored, true);
  assert.equal(completion.miniphi_reasoning.supported, false);
  assert.equal(client.getReasoningSupport("binary-reasoner"), false);
});

test("an inventory-unsupported model sends no effort and records decomposition-only mode", async () => {
  const bodies = [];
  const client = new LMStudioRestClient({
    defaultModel: "plain",
    defaultReasoning: {
      profile: "high",
      model: { requested: "high", resolved: null, supported: false },
    },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return response({ choices: [{ message: { content: "{}" } }] });
    },
  });
  const completion = await client.createChatCompletion({ messages: MESSAGES });
  assert.equal("reasoning" in bodies[0], false);
  assert.equal(completion.miniphi_reasoning.supported, false);
  assert.equal(completion.miniphi_reasoning.sent, null);
});
