import test from "node:test";
import assert from "node:assert/strict";
import {
  COLD_JIT_CONTEXT_LENGTH,
  ensureModelLoaded,
  inspectModelLimits,
  planOutputTokens,
} from "../src/libs/model-limits.js";

const catalogPayload = ({ loadedContext = null, maxContext = 262144 } = {}) => ({
  models: [
    {
      id: "prism-ml/bonsai-27b",
      type: "vlm",
      max_context_length: maxContext,
      capabilities: { vision: true, trained_for_tool_use: true, reasoning: { allowed_options: ["off", "on"] } },
      loaded_instances: loadedContext
        ? [{ id: "instance-1", config: { context_length: loadedContext, parallel: 4 } }]
        : [],
    },
  ],
});

const fakeRestClient = (payload, overrides = {}) => ({
  async listModelsNativeV1() {
    return payload;
  },
  async listModels() {
    return payload;
  },
  async listModelsV1() {
    return payload;
  },
  ...overrides,
});

test("the loaded window, not the advertised maximum, is what a prompt is sized against", async () => {
  const limits = await inspectModelLimits({
    restClient: fakeRestClient(catalogPayload({ loadedContext: 8192 })),
    modelId: "prism-ml/bonsai-27b",
  });
  assert.equal(limits.loaded, true);
  assert.equal(limits.loadedContextLength, 8192);
  assert.equal(limits.maxContextLength, 262144);
  assert.equal(limits.effectiveContextLength, 8192);
  assert.equal(limits.vision, true);
  assert.equal(limits.toolUse, true);
  assert.deepEqual(limits.reasoningOptions, ["off", "on"]);
});

test("a model that is not loaded falls back to the conservative cold default", async () => {
  const limits = await inspectModelLimits({
    restClient: fakeRestClient(catalogPayload({ loadedContext: null })),
    modelId: "prism-ml/bonsai-27b",
  });
  assert.equal(limits.loaded, false);
  assert.equal(limits.effectiveContextLength, COLD_JIT_CONTEXT_LENGTH);
});

test("an operator-loaded instance is never unloaded implicitly", async () => {
  const calls = [];
  const client = fakeRestClient(catalogPayload({ loadedContext: 8192 }), {
    async unloadModelV1(payload) {
      calls.push(["unload", payload]);
      return {};
    },
    async loadModelV1(payload) {
      calls.push(["load", payload]);
      return {};
    },
  });
  const outcome = await ensureModelLoaded({
    restClient: client,
    modelId: "prism-ml/bonsai-27b",
    desiredContextLength: 32768,
  });
  assert.equal(outcome.action, "kept-operator-instance");
  assert.deepEqual(calls, [], "no lifecycle call is made without explicit consent");
});

test("with explicit consent the model is reloaded at the requested window, capped by its maximum", async () => {
  const calls = [];
  let payload = catalogPayload({ loadedContext: 8192, maxContext: 16384 });
  const client = {
    async listModelsNativeV1() {
      return payload;
    },
    async listModels() {
      return payload;
    },
    async listModelsV1() {
      return payload;
    },
    async unloadModelV1(request) {
      calls.push(["unload", request.instance_id]);
      payload = catalogPayload({ loadedContext: null, maxContext: 16384 });
      return {};
    },
    async loadModelV1(request) {
      calls.push(["load", request.context_length]);
      payload = catalogPayload({ loadedContext: request.context_length, maxContext: 16384 });
      return {};
    },
  };
  const outcome = await ensureModelLoaded({
    restClient: client,
    modelId: "prism-ml/bonsai-27b",
    desiredContextLength: 32768,
    allowReload: true,
  });
  assert.deepEqual(calls, [
    ["unload", "instance-1"],
    ["load", 16384],
  ]);
  assert.equal(outcome.action, "loaded");
  assert.equal(outcome.limits.loadedContextLength, 16384);
});

test("a failed load leaves the run on the instance that already exists", async () => {
  const payload = catalogPayload({ loadedContext: 4096 });
  const client = fakeRestClient(payload, {
    async unloadModelV1() {
      throw new Error("busy");
    },
  });
  const outcome = await ensureModelLoaded({
    restClient: client,
    modelId: "prism-ml/bonsai-27b",
    desiredContextLength: 32768,
    allowReload: true,
  });
  assert.equal(outcome.action, "load-failed");
  assert.match(outcome.error, /busy/);
  assert.equal(outcome.limits.loadedContextLength, 4096);
});

test("the output budget is the window's real headroom, and the pacing cap is applied on top of it", () => {
  const generous = planOutputTokens({ contextLength: 32768, promptTokens: 6000 });
  assert.equal(generous.headroom, 32768 - 6000 - 512);
  assert.equal(generous.maxTokens, generous.headroom);
  assert.equal(generous.capped, false);

  const paced = planOutputTokens({ contextLength: 32768, promptTokens: 6000, hardCap: 4000 });
  assert.equal(paced.maxTokens, 4000);
  assert.equal(paced.capped, true, "a pacing cap is recorded as such, not confused with the limit");

  // A prompt that has eaten the window still gets a floor rather than a
  // negative or zero budget, which LM Studio would reject outright.
  const squeezed = planOutputTokens({ contextLength: 4096, promptTokens: 4096, minTokens: 512 });
  assert.equal(squeezed.maxTokens, 512);
});

test("a request is capped by wall-clock time, not only by the window", () => {
  // Measured on the reference host: ~7 tokens/second, and LM Studio's own
  // engine call dies at ~305 seconds with a 400. A turn that would take longer
  // is not truncated — it is lost — so the time cap has to win.
  const plan = planOutputTokens({
    contextLength: 32768,
    promptTokens: 6000,
    hardCap: 4000,
    tokensPerSecond: 7,
    maxSeconds: 240,
  });
  assert.equal(plan.timeCap, 1680);
  assert.equal(plan.maxTokens, 1680);
  assert.equal(plan.limitedBy, "request-time");

  // A fast host is not penalised: the time cap simply stops binding.
  const fast = planOutputTokens({
    contextLength: 32768,
    promptTokens: 6000,
    hardCap: 4000,
    tokensPerSecond: 120,
    maxSeconds: 240,
  });
  assert.equal(fast.maxTokens, 4000);
  assert.equal(fast.limitedBy, "pacing-cap");

  // And without a measured rate the behaviour is exactly what it was before.
  const unmeasured = planOutputTokens({ contextLength: 32768, promptTokens: 6000, hardCap: 4000 });
  assert.equal(unmeasured.timeCap, null);
  assert.equal(unmeasured.maxTokens, 4000);
  assert.equal(unmeasured.limitedBy, "pacing-cap");
});

test("the recovery path recycles a healthy-looking instance, because a wedged engine looks healthy", async () => {
  const calls = [];
  let payload = catalogPayload({ loadedContext: 32768 });
  const client = {
    async listModelsNativeV1() {
      return payload;
    },
    async listModels() {
      return payload;
    },
    async listModelsV1() {
      return payload;
    },
    async unloadModelV1(request) {
      calls.push(["unload", request.instance_id]);
      payload = catalogPayload({ loadedContext: null });
      return {};
    },
    async loadModelV1(request) {
      calls.push(["load", request.context_length]);
      payload = catalogPayload({ loadedContext: request.context_length });
      return {};
    },
  };

  // Without force this is a no-op: the window is already big enough.
  const noop = await ensureModelLoaded({
    restClient: client,
    modelId: "prism-ml/bonsai-27b",
    desiredContextLength: 32768,
    allowReload: true,
  });
  assert.equal(noop.action, "already-loaded");
  assert.deepEqual(calls, []);

  const forced = await ensureModelLoaded({
    restClient: client,
    modelId: "prism-ml/bonsai-27b",
    desiredContextLength: 32768,
    allowReload: true,
    force: true,
  });
  assert.equal(forced.action, "loaded");
  assert.deepEqual(calls, [
    ["unload", "instance-1"],
    ["load", 32768],
  ]);
});
