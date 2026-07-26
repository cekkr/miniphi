import test from "node:test";
import assert from "node:assert/strict";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("native v1 inventory uses /api/v1/models and redacts API tokens from instrumentation", async () => {
  const requests = [];
  const events = [];
  const client = new LMStudioRestClient({
    baseUrl: "http://lmstudio.test:1234",
    apiToken: "secret-token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ models: [] });
    },
  });
  client.setExecutionRegister({
    async record(event) {
      events.push(event);
    },
  });

  await client.listModelsNativeV1();

  assert.equal(requests[0].url, "http://lmstudio.test:1234/api/v1/models");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, "Bearer secret-token");
  assert.equal(events[0].request.headers.Authorization, "[redacted]");
});

test("native v1 lifecycle methods target exact load and unload contracts", async () => {
  const requests = [];
  const client = new LMStudioRestClient({
    baseUrl: "http://lmstudio.test:1234",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/load")) {
        return jsonResponse({ status: "loaded", instance_id: "coder-instance" });
      }
      return jsonResponse({ instance_id: "coder-instance" });
    },
  });

  const loaded = await client.loadModelV1({
    model: "coder-model",
    context_length: 16384,
    echo_load_config: true,
  });
  const unloaded = await client.unloadModelV1({
    instance_id: "coder-instance",
  });

  assert.equal(loaded.instance_id, "coder-instance");
  assert.equal(unloaded.instance_id, "coder-instance");
  assert.equal(requests[0].url, "http://lmstudio.test:1234/api/v1/models/load");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: "coder-model",
    context_length: 16384,
    echo_load_config: true,
  });
  assert.equal(requests[1].url, "http://lmstudio.test:1234/api/v1/models/unload");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    instance_id: "coder-instance",
  });
});

test("native v1 lifecycle methods reject broad or missing targets", async () => {
  const client = new LMStudioRestClient({
    fetchImpl: async () => jsonResponse({}),
  });
  await assert.rejects(() => client.loadModelV1({}), /model is required/);
  await assert.rejects(() => client.unloadModelV1({}), /instance_id is required/);
});
