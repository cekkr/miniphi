import test from "node:test";
import assert from "node:assert/strict";
import { probeLmStudioHealth } from "../src/commands/lmstudio-health.js";

test("probeLmStudioHealth falls back to /models when /status is unsupported", async () => {
  const fakeClient = {
    baseUrl: "http://127.0.0.1:1234",
    async getStatus() {
      return { ok: false, error: "Unexpected endpoint /api/v0/status" };
    },
    async listModels() {
      return [{ id: "model-a" }, { id: "model-b" }];
    },
  };

  const health = await probeLmStudioHealth({
    configData: {},
    modelSelection: null,
    restClient: fakeClient,
  });

  assert.equal(health.ok, true);
  assert.equal(health.error, null);
  assert.ok(typeof health.warning === "string" && health.warning.length > 0);
  assert.equal(Array.isArray(health.modelsFallback), true);
  assert.equal(health.snapshot.stopReason, null);
});

test("probeLmStudioHealth emits deterministic stop info on REST failure", async () => {
  const fakeClient = {
    baseUrl: "http://127.0.0.1:1234",
    async getStatus() {
      throw new Error("ECONNREFUSED 127.0.0.1:1234");
    },
  };

  const health = await probeLmStudioHealth({
    configData: {},
    modelSelection: null,
    restClient: fakeClient,
  });

  assert.equal(health.ok, false);
  assert.ok(health.stopInfo);
  assert.equal(health.stopInfo.code, "connection");
  assert.equal(health.snapshot.stopReasonCode, "connection");
  assert.ok(typeof health.snapshot.stopReasonDetail === "string");
});
