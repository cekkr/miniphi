import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MODEL_BENCHMARK_TRIAL_SCHEMA,
  ModelBenchmarkRunner,
  loadFreshModelBenchmarkIndex,
  modelBenchmarkTableRows,
} from "../src/libs/model-benchmarks.js";
import {
  normalizeModelCatalog,
  rankModelsForTask,
} from "../src/libs/model-catalog.js";
import {
  createTempWorkspace,
  removeTempWorkspace,
} from "./cli-test-utils.js";

const TEST_TRIALS = [
  {
    id: "reasoning-test",
    category: "reasoning",
    prompt: "Return 42.",
    matches: (answer) => answer === "42",
  },
  {
    id: "coding-test",
    category: "coding",
    prompt: "Return 6.",
    matches: (answer) => answer === "6",
  },
];

test("published model benchmark schema matches the runtime response format", async () => {
  const published = JSON.parse(
    await fs.readFile(
      path.resolve("docs", "prompts", "model-benchmark-trial.schema.json"),
      "utf8",
    ),
  );
  assert.deepEqual(published, MODEL_BENCHMARK_TRIAL_SCHEMA);
});

function nativeModel({
  id = "bench-model",
  loaded = true,
  instanceId = "bench-model-instance",
} = {}) {
  return {
    models: [
      {
        type: "llm",
        key: id,
        architecture: "llama",
        quantization: { name: "Q4_K_M" },
        params_string: "7B",
        size_bytes: 4_000_000_000,
        max_context_length: 32768,
        loaded_instances: loaded
          ? [{ id: instanceId, config: { context_length: 4096 } }]
          : [],
        capabilities: {
          vision: false,
          trained_for_tool_use: false,
        },
      },
    ],
  };
}

function validTrial(trialId, answer) {
  return JSON.stringify({
    schema_version: "model-benchmark-trial@v1",
    trial_id: trialId,
    answer,
    evidence: [],
    needs_more_context: false,
    missing_snippets: [],
  });
}

test("model benchmark scores strict JSON and reuses an unchanged cache", async () => {
  const workspace = await createTempWorkspace("miniphi-model-bench-");
  let calls = 0;
  let invalidSent = false;
  const payloads = [];
  const restClient = {
    baseUrl: "http://benchmark-host.test:1234",
    async getStatus() {
      return { ok: true, hardware: { gpu: "fixture-gpu" } };
    },
    async listModelsNativeV1() {
      return nativeModel();
    },
    async createChatCompletion(payload) {
      calls += 1;
      payloads.push(payload);
      const trialId = payload.messages[0].content.match(/Trial id: ([^\n]+)/)?.[1];
      if (trialId === "reasoning-test" && !invalidSent) {
        invalidSent = true;
        return { choices: [{ message: { content: "not json" } }] };
      }
      const answer = trialId === "reasoning-test" ? "42" : "6";
      return {
        choices: [{ message: { content: validTrial(trialId, answer) } }],
        usage: { completion_tokens: 12 },
      };
    },
  };
  try {
    const runner = new ModelBenchmarkRunner({
      restClient,
      cwd: workspace,
      trials: TEST_TRIALS,
    });
    const first = await runner.run();
    assert.equal(first.results[0].status, "completed");
    assert.equal(first.results[0].scores.reasoning, 100);
    assert.equal(first.results[0].scores.coding, 100);
    assert.equal(first.results[0].scores.resources, null);
    assert.equal(first.results[0].resourceMeasurement.status, "unavailable");
    assert.equal(first.results[0].trials[0].attempts.length, 2);
    assert.equal(calls, 3);
    assert.equal(
      payloads.every(
        (payload) =>
          payload.response_format?.type === "json_schema" &&
          payload.response_format.json_schema.schema.additionalProperties ===
            false,
      ),
      true,
    );

    const second = await runner.run();
    assert.equal(second.results[0].cacheHit, true);
    assert.equal(calls, 3, "cache hit must perform zero new prompt calls");
    assert.equal(modelBenchmarkTableRows(second.index)[0].modelId, "bench-model");
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("model benchmark unloads only the temporary instance it created", async () => {
  const workspace = await createTempWorkspace("miniphi-model-load-");
  let loaded = false;
  const unloaded = [];
  const restClient = {
    baseUrl: "http://benchmark-host.test:1234",
    async getStatus() {
      return { ok: true, hardware: "fixture-gpu" };
    },
    async listModelsNativeV1() {
      return nativeModel({
        id: "cold-model",
        loaded,
        instanceId: "temporary-instance",
      });
    },
    async loadModelV1(payload) {
      assert.equal(payload.model, "cold-model");
      loaded = true;
      return { instance_id: "temporary-instance" };
    },
    async unloadModelV1(payload) {
      unloaded.push(payload.instance_id);
      loaded = false;
      return { ok: true };
    },
    async createChatCompletion(payload) {
      const trialId = payload.messages[0].content.match(/Trial id: ([^\n]+)/)?.[1];
      return {
        choices: [{ message: { content: validTrial(trialId, "42") } }],
      };
    },
  };
  try {
    const runner = new ModelBenchmarkRunner({
      restClient,
      cwd: workspace,
      trials: [TEST_TRIALS[0]],
    });
    const result = await runner.run();
    assert.equal(result.results[0].status, "completed");
    assert.deepEqual(unloaded, ["temporary-instance"]);
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("fresh benchmark category score becomes primary model ranking evidence", () => {
  const models = [
    {
      id: "coder-by-name",
      type: "llm",
      arch: "qwen",
      state: "loaded",
      maxContextLength: 131072,
      capabilities: [],
    },
    {
      id: "plain-model",
      type: "llm",
      arch: "llama",
      state: "not-loaded",
      maxContextLength: 32768,
      capabilities: [],
    },
  ];
  const ranked = rankModelsForTask(models, {
    intent: "coding",
    availableMemoryGb: 64,
    benchmarkResults: {
      "coder-by-name": {
        status: "completed",
        revision: "fixture@v1",
        completedAt: "2026-07-26T00:00:00.000Z",
        scores: { coding: 40, overall: 50 },
      },
      "plain-model": {
        status: "completed",
        revision: "fixture@v1",
        completedAt: "2026-07-26T00:00:00.000Z",
        scores: { coding: 95, overall: 90 },
      },
    },
  });
  assert.equal(ranked[0].model.id, "plain-model");
  assert.equal(ranked[0].benchmark.category, "coding");
  assert.match(ranked[0].reasons[0], /benchmark coding score 95/);
});

test("partial benchmark coverage gives untested models a neutral prior", () => {
  const models = [
    {
      id: "tested-but-poor",
      type: "llm",
      arch: "llama",
      state: "loaded",
      maxContextLength: 32768,
      capabilities: [],
    },
    {
      id: "not-tested",
      type: "llm",
      arch: "llama",
      state: "not-loaded",
      maxContextLength: 32768,
      capabilities: [],
    },
  ];
  const ranked = rankModelsForTask(models, {
    intent: "coding",
    availableMemoryGb: 64,
    benchmarkResults: {
      "tested-but-poor": {
        status: "completed",
        revision: "fixture@v1",
        scores: { coding: 20, overall: 20 },
      },
    },
  });
  assert.equal(ranked[0].model.id, "not-tested");
  assert.match(ranked[0].reasons[0], /neutral benchmark prior/);
});

test("hardware or benchmark definition changes make cached scores stale", async () => {
  const workspace = await createTempWorkspace("miniphi-model-stale-");
  const baseClient = {
    baseUrl: "http://benchmark-host.test:1234",
    async getStatus() {
      return { ok: true, hardware: "fixture-a" };
    },
    async listModelsNativeV1() {
      return nativeModel();
    },
    async createChatCompletion(payload) {
      const trialId = payload.messages[0].content.match(/Trial id: ([^\n]+)/)?.[1];
      return {
        choices: [{ message: { content: validTrial(trialId, "42") } }],
      };
    },
  };
  try {
    await new ModelBenchmarkRunner({
      restClient: baseClient,
      cwd: workspace,
      trials: [TEST_TRIALS[0]],
    }).run();
    const changedHardware = {
      ...baseClient,
      async getStatus() {
        return { ok: true, hardware: "fixture-b" };
      },
    };
    const stale = await loadFreshModelBenchmarkIndex({
      cwd: workspace,
      restClient: changedHardware,
      models: normalizeModelCatalog(nativeModel()),
      trials: [TEST_TRIALS[0]],
    });
    assert.equal(Object.keys(stale.results).length, 0);
    assert.equal(stale.staleCount, 1);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
