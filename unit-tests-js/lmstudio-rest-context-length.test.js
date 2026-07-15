import test from "node:test";
import assert from "node:assert/strict";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";

function captureFetch(bodies) {
  return async (url, init) => {
    bodies.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "{}" } }] };
      },
      async text() {
        return JSON.stringify({ choices: [{ message: { content: "{}" } }] });
      },
      headers: { get: () => "application/json" },
    };
  };
}

const MESSAGES = [{ role: "user", content: "ping" }];

test("createChatCompletion omits context_length when none was configured", async () => {
  const bodies = [];
  const client = new LMStudioRestClient({ fetchImpl: captureFetch(bodies) });
  await client.createChatCompletion({ messages: MESSAGES });
  assert.equal(bodies.length, 1);
  // A JIT-loaded model may run with a smaller context than the static default;
  // advertising 16384 unconditionally makes LM Studio reject the request.
  assert.ok(!("context_length" in bodies[0].body), "context_length must not be sent");
});

test("createChatCompletion sends an explicitly configured default context_length", async () => {
  const bodies = [];
  const client = new LMStudioRestClient({
    fetchImpl: captureFetch(bodies),
    defaultContextLength: 8192,
  });
  await client.createChatCompletion({ messages: MESSAGES });
  assert.equal(bodies[0].body.context_length, 8192);
});

test("per-request context_length always wins", async () => {
  const bodies = [];
  const client = new LMStudioRestClient({
    fetchImpl: captureFetch(bodies),
    defaultContextLength: 8192,
  });
  await client.createChatCompletion({ messages: MESSAGES, context_length: 4096 });
  assert.equal(bodies[0].body.context_length, 4096);
});

test("setDefaultModel updates the explicit context flag", async () => {
  const bodies = [];
  const client = new LMStudioRestClient({ fetchImpl: captureFetch(bodies) });
  client.setDefaultModel("some-model", 2048);
  await client.createChatCompletion({ messages: MESSAGES });
  assert.equal(bodies[0].body.context_length, 2048);
  assert.equal(bodies[0].body.model, "some-model");

  client.setDefaultModel("other-model");
  await client.createChatCompletion({ messages: MESSAGES });
  assert.ok(!("context_length" in bodies[1].body));
});
