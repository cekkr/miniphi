import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyModelPurpose,
  estimateModelParams,
  fetchModelCatalog,
  normalizeModelCatalog,
  rankModelsForTask,
  resolveAutoModel,
  selectBestModelForTask,
} from "../src/libs/model-catalog.js";

// Trimmed copy of a real /api/v0/models response so normalization tracks the
// actual LM Studio payload shape.
const NATIVE_MODELS_PAYLOAD = {
  object: "list",
  data: [
    {
      id: "qwen3-coder-30b-a3b-instruct",
      object: "model",
      type: "llm",
      publisher: "Qwen",
      arch: "qwen3moe",
      compatibility_type: "gguf",
      quantization: "Q4_K_M",
      state: "not-loaded",
      max_context_length: 262144,
      capabilities: ["tool_use"],
    },
    {
      id: "qwen2.5-coder-7b-instruct",
      object: "model",
      type: "llm",
      publisher: "Qwen",
      arch: "qwen2",
      compatibility_type: "gguf",
      quantization: "Q4_K_M",
      state: "loaded",
      max_context_length: 131072,
    },
    {
      id: "phi-4-reasoning-plus",
      object: "model",
      type: "llm",
      publisher: "Microsoft",
      arch: "phi3",
      compatibility_type: "gguf",
      quantization: "Q4_K_M",
      state: "not-loaded",
      max_context_length: 32768,
    },
    {
      id: "gemma-4-26b-a4b-it",
      object: "model",
      type: "vlm",
      publisher: "Generals",
      arch: "gemma4",
      compatibility_type: "gguf",
      quantization: "Q4_K_M",
      state: "not-loaded",
      max_context_length: 262144,
      capabilities: ["tool_use"],
    },
    {
      id: "text-embedding-nomic-embed-text-v1.5",
      object: "model",
      type: "embeddings",
      publisher: "nomic-ai",
      arch: "nomic-bert",
      compatibility_type: "gguf",
      quantization: "Q4_K_M",
      state: "not-loaded",
      max_context_length: 2048,
    },
  ],
};

const NATIVE_V1_MODELS_PAYLOAD = {
  models: [
    {
      type: "llm",
      publisher: "Generals",
      key: "glm-4.7-flash",
      display_name: "GLM 4.7 Flash",
      architecture: "deepseek2",
      quantization: {
        name: "Q4_K_M",
        bits_per_weight: 4,
      },
      size_bytes: 18132721120,
      params_string: "30B",
      loaded_instances: [
        {
          id: "glm-4.7-flash",
          config: {
            context_length: 16384,
            flash_attention: false,
            num_experts: 4,
            prompt_template: {
              type: "jinja",
              template: "x".repeat(1000),
            },
          },
          remaining_ttl_seconds: 2100,
        },
      ],
      max_context_length: 202752,
      format: "gguf",
      capabilities: {
        vision: false,
        trained_for_tool_use: true,
        reasoning: {
          allowed_options: ["off", "on"],
          default: "on",
        },
      },
    },
    {
      type: "embedding",
      publisher: "nomic-ai",
      key: "text-embedding-nomic",
      loaded_instances: [],
      max_context_length: 2048,
      quantization: {
        name: "Q4_K_M",
        bits_per_weight: 4,
      },
    },
  ],
};

const SCORE_OPTS = { availableMemoryGb: 64 };

test("normalizeModelCatalog keeps chat models and drops embeddings", () => {
  const models = normalizeModelCatalog(NATIVE_MODELS_PAYLOAD);
  assert.equal(models.length, 4);
  assert.ok(models.every((model) => model.type !== "embeddings"));
  const coder = models.find((model) => model.id === "qwen3-coder-30b-a3b-instruct");
  assert.equal(coder.maxContextLength, 262144);
  assert.deepEqual(coder.capabilities, ["tool_use"]);
  assert.equal(coder.state, "not-loaded");
});

test("normalizeModelCatalog tolerates OpenAI-compat lists with minimal fields", () => {
  const models = normalizeModelCatalog({ data: [{ id: "some-model", object: "model" }] });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "some-model");
  assert.equal(models[0].maxContextLength, null);
  assert.equal(models[0].state, "unknown");
});

test("normalizeModelCatalog preserves native v1 identity, load config, and capabilities", () => {
  const models = normalizeModelCatalog(NATIVE_V1_MODELS_PAYLOAD);
  assert.equal(models.length, 1);
  const model = models[0];
  assert.equal(model.id, "glm-4.7-flash");
  assert.equal(model.displayName, "GLM 4.7 Flash");
  assert.equal(model.arch, "deepseek2");
  assert.equal(model.quantization, "Q4_K_M");
  assert.equal(model.quantizationBits, 4);
  assert.equal(model.sizeBytes, 18132721120);
  assert.equal(model.state, "loaded");
  assert.equal(model.loadedContextLength, 16384);
  assert.equal(model.loadedInstanceId, "glm-4.7-flash");
  assert.equal(model.loadedInstances[0].config.num_experts, 4);
  assert.equal(model.loadedInstances[0].config.prompt_template, undefined);
  assert.deepEqual(model.capabilities, ["tool_use", "reasoning"]);
  assert.deepEqual(model.capabilityDetails.reasoning, {
    allowedOptions: ["off", "on"],
    default: "on",
  });
});

test("estimateModelParams parses plain and MoE parameter counts", () => {
  assert.deepEqual(estimateModelParams("qwen3-coder-30b-a3b-instruct"), {
    totalB: 30,
    activeB: 3,
  });
  assert.deepEqual(estimateModelParams("qwen2.5-coder-7b-instruct"), { totalB: 7, activeB: 7 });
  assert.deepEqual(estimateModelParams("gpt-oss-20b"), { totalB: 20, activeB: 20 });
  assert.deepEqual(estimateModelParams("glm-4.7-flash"), { totalB: null, activeB: null });
  assert.deepEqual(estimateModelParams("glm-4.7-flash", "30B"), {
    totalB: 30,
    activeB: 30,
  });
});

test("classifyModelPurpose recognizes coding and reasoning families", () => {
  assert.equal(classifyModelPurpose({ id: "qwen2.5-coder-7b-instruct" }), "coding");
  assert.equal(classifyModelPurpose({ id: "devstral-small-2-24b-instruct-2512" }), "coding");
  assert.equal(classifyModelPurpose({ id: "granite-4.0-h-tiny" }), "coding");
  assert.equal(classifyModelPurpose({ id: "phi-4-reasoning-plus" }), "reasoning");
  assert.equal(classifyModelPurpose({ id: "gemma-4-26b-a4b-it" }), "general");
});

test("coding intent ranks coder models above general models", () => {
  const models = normalizeModelCatalog(NATIVE_MODELS_PAYLOAD);
  const ranked = rankModelsForTask(models, { intent: "coding", ...SCORE_OPTS });
  const ids = ranked.map((entry) => entry.model.id);
  assert.ok(
    ids.indexOf("qwen3-coder-30b-a3b-instruct") < ids.indexOf("gemma-4-26b-a4b-it"),
    `coder should outrank general model: ${ids.join(", ")}`,
  );
  assert.ok(
    ids.indexOf("qwen2.5-coder-7b-instruct") < ids.indexOf("gemma-4-26b-a4b-it"),
    `small coder should outrank general model: ${ids.join(", ")}`,
  );
});

test("writing intent prefers general models over coders", () => {
  const models = normalizeModelCatalog(NATIVE_MODELS_PAYLOAD);
  const best = selectBestModelForTask(models, { intent: "writing", ...SCORE_OPTS });
  assert.equal(best.model.id, "gemma-4-26b-a4b-it");
});

test("already-loaded models earn a bonus that breaks near-ties", () => {
  const base = {
    type: "llm",
    arch: "qwen2",
    quantization: "Q4_K_M",
    maxContextLength: 131072,
    capabilities: [],
  };
  const loaded = { ...base, id: "coder-a-7b", state: "loaded" };
  const unloaded = { ...base, id: "coder-b-7b", state: "not-loaded" };
  const best = selectBestModelForTask([unloaded, loaded], { intent: "coding", ...SCORE_OPTS });
  assert.equal(best.model.id, "coder-a-7b");
  assert.ok(best.reasons.includes("already loaded in LM Studio"));
});

test("models that exceed local memory are penalized below smaller peers", () => {
  const base = {
    type: "llm",
    arch: "llama",
    quantization: "Q4_K_M",
    state: "not-loaded",
    maxContextLength: 131072,
    capabilities: [],
  };
  const huge = { ...base, id: "mega-coder-70b" };
  const small = { ...base, id: "tiny-coder-7b" };
  const best = selectBestModelForTask([huge, small], {
    intent: "coding",
    availableMemoryGb: 16,
  });
  assert.equal(best.model.id, "tiny-coder-7b");
  const hugeEntry = best.ranked.find((entry) => entry.model.id === "mega-coder-70b");
  assert.ok(hugeEntry.reasons.some((reason) => reason.includes("exceed local memory")));
});

test("fetchModelCatalog falls back to the OpenAI-compat list", async () => {
  const restClient = {
    async listModels() {
      throw new Error("Unexpected endpoint /api/v0/models");
    },
    async listModelsV1() {
      return { data: [{ id: "compat-model", object: "model" }] };
    },
  };
  const catalog = await fetchModelCatalog({ restClient });
  assert.equal(catalog.source, "openai-compat");
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].id, "compat-model");
});

test("fetchModelCatalog prefers the current native v1 inventory", async () => {
  const calls = [];
  const restClient = {
    async listModelsNativeV1() {
      calls.push("native-v1");
      return NATIVE_V1_MODELS_PAYLOAD;
    },
    async listModels() {
      calls.push("native-v0");
      return NATIVE_MODELS_PAYLOAD;
    },
    async listModelsV1() {
      calls.push("openai-compat");
      return { data: [] };
    },
  };
  const catalog = await fetchModelCatalog({ restClient });
  assert.equal(catalog.source, "native-v1");
  assert.deepEqual(calls, ["native-v1"]);
  assert.equal(catalog.models[0].id, "glm-4.7-flash");
});

test("fetchModelCatalog surfaces the native error when both endpoints fail", async () => {
  const restClient = {
    async listModels() {
      throw new Error("ECONNREFUSED 127.0.0.1:1234");
    },
    async listModelsV1() {
      throw new Error("also down");
    },
  };
  await assert.rejects(() => fetchModelCatalog({ restClient }), /ECONNREFUSED/);
});

test("resolveAutoModel classifies the task and returns the best live model", async () => {
  const restClient = {
    async listModels() {
      return NATIVE_MODELS_PAYLOAD;
    },
  };
  const resolved = await resolveAutoModel({
    restClient,
    task: "Refactor the parser module and fix the failing tests",
    availableMemoryGb: 64,
  });
  assert.ok(resolved);
  assert.equal(resolved.intent, "coding");
  // The 7B coder is already loaded, so it edges out the unloaded 30B coder.
  assert.equal(resolved.modelKey, "qwen2.5-coder-7b-instruct");
  assert.equal(resolved.ranked[1].model.id, "qwen3-coder-30b-a3b-instruct");
  assert.ok(Array.isArray(resolved.ranked) && resolved.ranked.length === 4);
});

test("resolveAutoModel returns null when LM Studio is unreachable", async () => {
  const logs = [];
  const restClient = {
    async listModels() {
      throw new Error("ECONNREFUSED 127.0.0.1:1234");
    },
    async listModelsV1() {
      throw new Error("ECONNREFUSED 127.0.0.1:1234");
    },
  };
  const resolved = await resolveAutoModel({
    restClient,
    task: "anything",
    logger: (message) => logs.push(message),
  });
  assert.equal(resolved, null);
  assert.ok(logs.some((line) => line.includes("Unable to list LM Studio models")));
});
