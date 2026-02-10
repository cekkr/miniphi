import test from "node:test";
import assert from "node:assert/strict";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";

test("LMStudioRestClient.getStatus returns ok=false when status and fallback both fail", async () => {
  const client = new LMStudioRestClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 10 });
  client._request = async () => {
    throw new Error("fetch failed");
  };
  client.listModels = async () => {
    throw new Error("fetch failed");
  };

  const status = await client.getStatus();
  assert.equal(status.ok, false);
  assert.equal(typeof status.error, "string");
  assert.match(status.error, /fetch failed/i);
  assert.equal(status.fallback, null);
});

test("LMStudioRestClient.getStatus recovers via models fallback when available", async () => {
  const client = new LMStudioRestClient({ baseUrl: "http://127.0.0.1:1234", timeoutMs: 10 });
  client._request = async () => {
    throw new Error("temporary status failure");
  };
  client.listModels = async () => ({ data: [{ id: "model-a" }] });

  const status = await client.getStatus();
  assert.equal(status.ok, true);
  assert.deepEqual(status.fallback, { data: [{ id: "model-a" }] });
});

test("LMStudioRestClient.getStatus keeps unsupported endpoint as non-fatal warning payload", async () => {
  const client = new LMStudioRestClient({ baseUrl: "http://127.0.0.1:1234", timeoutMs: 10 });
  client._request = async () => {
    throw Object.assign(new Error("Unexpected endpoint or method. (GET /api/v0/status)"), {
      status: 404,
    });
  };
  let listCalled = false;
  client.listModels = async () => {
    listCalled = true;
    return { data: [] };
  };

  const status = await client.getStatus();
  assert.equal(status.ok, false);
  assert.equal(listCalled, false);
  assert.match(status.error, /unexpected endpoint/i);
});
