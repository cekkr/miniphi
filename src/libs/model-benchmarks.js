import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildJsonSchemaResponseFormat,
  validateJsonObjectAgainstSchema,
} from "./json-schema-utils.js";
import { estimateModelParams, fetchModelCatalog } from "./model-catalog.js";

export const MODEL_BENCHMARK_REVISION = "model-benchmarks@v1";
export const MODEL_BENCHMARK_SCHEMA_VERSION = "model-benchmark-trial@v1";
export const DEFAULT_MODEL_BENCHMARK_CONTEXT_LENGTH = 4096;
export const DEFAULT_MODEL_BENCHMARK_TIMEOUT_MS = 30000;
const MODEL_BENCHMARK_MAX_TOKENS = 220;
const MODEL_BENCHMARK_MAX_ATTEMPTS = 2;

export const MODEL_BENCHMARK_TRIAL_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: MODEL_BENCHMARK_SCHEMA_VERSION,
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "trial_id",
    "answer",
    "evidence",
    "needs_more_context",
    "missing_snippets",
  ],
  properties: {
    schema_version: { const: MODEL_BENCHMARK_SCHEMA_VERSION },
    trial_id: { type: "string", minLength: 1 },
    answer: { type: "string" },
    evidence: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
    needs_more_context: { type: "boolean" },
    missing_snippets: {
      type: "array",
      items: { type: "string" },
    },
    stop_reason: { type: "string" },
  },
};

const exact = (expected) => (value) =>
  String(value ?? "").trim().toLowerCase() === expected.toLowerCase();

export const EASY_MODEL_BENCHMARK_TRIALS = Object.freeze([
  {
    id: "reasoning-sequence",
    category: "reasoning",
    prompt:
      "Continue the sequence 2, 6, 12, 20, 30. Return only the next integer in answer.",
    matches: exact("42"),
  },
  {
    id: "coding-execution",
    category: "coding",
    prompt:
      "Evaluate this JavaScript expression without running tools: [1,2,4,7].filter((n) => n % 2 === 0).reduce((a, n) => a + n, 0). Return only the resulting integer in answer.",
    matches: exact("6"),
  },
  {
    id: "context-retrieval",
    category: "context",
    prompt: [
      "Read the records and return only the access token belonging to record C in answer.",
      "Record A: owner=Delta, token=amber-field-118.",
      "Record B: owner=Echo, token=silver-branch-204.",
      "Record C: owner=Foxtrot, token=violet-orbit-731.",
      "Record D: owner=Golf, token=green-river-992.",
    ].join("\n"),
    matches: exact("violet-orbit-731"),
  },
  {
    id: "writing-constraints",
    category: "writing",
    prompt:
      'Write exactly four words in answer. The words, in order, must be: "Calm tools build trust."',
    matches: (value) =>
      String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase() ===
      "calm tools build trust.",
  },
  {
    id: "research-source-choice",
    category: "research",
    prompt:
      'For a claim about a software API, choose the strongest source from "primary-source", "blog-summary", or "forum-post". Return only the chosen label in answer.',
    matches: exact("primary-source"),
  },
  {
    id: "tool-planning",
    category: "tool_use",
    prompt:
      'You must inspect an existing local file without changing it. Choose one tool from "read_file", "write_file", or "run_cmd". Return only the tool name in answer; do not invoke it.',
    matches: exact("read_file"),
    toolDefinitions: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a local workspace file without changing it.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: { path: { type: "string" } },
          },
        },
      },
    ],
  },
]);

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function slug(value) {
  const normalized = String(value ?? "model")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "model";
}

export function getModelBenchmarkDefinitionHash(
  trials = EASY_MODEL_BENCHMARK_TRIALS,
) {
  return sha256(
    stableJson({
      revision: MODEL_BENCHMARK_REVISION,
      schema: MODEL_BENCHMARK_TRIAL_SCHEMA,
      trials: trials.map(({ id, category, prompt, toolDefinitions }) => ({
        id,
        category,
        prompt,
        toolDefinitions: toolDefinitions ?? [],
      })),
    }),
  );
}

export function getModelArtifactFingerprint(model) {
  return sha256(
    stableJson({
      id: model?.id ?? null,
      type: model?.type ?? null,
      arch: model?.arch ?? null,
      quantization: model?.quantization ?? null,
      sizeBytes: model?.sizeBytes ?? null,
      paramsString: model?.paramsString ?? null,
      maxContextLength: model?.maxContextLength ?? null,
      capabilities: [...(model?.capabilities ?? [])].sort(),
    }),
  );
}

function isLoopbackUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function compactServerHardware(status) {
  if (!status || typeof status !== "object") {
    return null;
  }
  return status.gpu ?? status.hardware ?? status.device ?? status.status?.gpu ?? null;
}

export async function resolveBenchmarkHardware({
  restClient = null,
  includeLocal = undefined,
} = {}) {
  const baseUrl = restClient?.baseUrl ?? null;
  const local = includeLocal ?? isLoopbackUrl(baseUrl);
  let status = null;
  if (restClient && typeof restClient.getStatus === "function") {
    status = await restClient.getStatus().catch(() => null);
  }
  const descriptor = {
    endpoint: baseUrl,
    scope: local ? "local" : "remote",
    serverHardware: compactServerHardware(status),
    serverRuntime:
      status?.version ??
      status?.build ??
      status?.runtime_version ??
      status?.status?.version ??
      null,
    local:
      local
        ? {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            cpu: os.cpus()?.[0]?.model ?? null,
            logicalCores: os.cpus()?.length ?? 0,
            totalMemoryBytes: os.totalmem(),
          }
        : null,
  };
  return {
    descriptor,
    fingerprint: sha256(stableJson(descriptor)),
    verifiable: local || descriptor.serverHardware !== null,
  };
}

export class ModelBenchmarkStore {
  constructor({ cwd = process.cwd(), baseDir = null } = {}) {
    this.baseDir = path.resolve(
      baseDir ?? path.join(cwd, ".miniphi", "benchmarks", "models"),
    );
    this.indexPath = path.join(this.baseDir, "index.json");
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath, "utf8"));
      return {
        schemaVersion: parsed.schemaVersion ?? "model-benchmark-index@v1",
        updatedAt: parsed.updatedAt ?? null,
        hardware: parsed.hardware ?? null,
        definitionHash: parsed.definitionHash ?? null,
        results:
          parsed.results && typeof parsed.results === "object"
            ? parsed.results
            : {},
      };
    } catch {
      return {
        schemaVersion: "model-benchmark-index@v1",
        updatedAt: null,
        hardware: null,
        definitionHash: null,
        results: {},
      };
    }
  }

  async saveResult(result) {
    const index = await this.load();
    index.updatedAt = new Date().toISOString();
    index.hardware = result.hardware;
    index.definitionHash = result.definitionHash;
    index.results[result.modelId] = result;
    await fs.mkdir(this.baseDir, { recursive: true });
    const resultPath = path.join(
      this.baseDir,
      `${slug(result.modelId)}-${result.cacheKey.slice(0, 12)}.json`,
    );
    await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await fs.writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    return { index, resultPath, indexPath: this.indexPath };
  }
}

export async function loadFreshModelBenchmarkIndex({
  cwd = process.cwd(),
  baseDir = null,
  restClient = null,
  models = null,
  hardware = null,
  trials = EASY_MODEL_BENCHMARK_TRIALS,
} = {}) {
  const store = new ModelBenchmarkStore({ cwd, baseDir });
  const index = await store.load();
  const resolvedHardware =
    hardware ?? (await resolveBenchmarkHardware({ restClient }));
  const definitionHash = getModelBenchmarkDefinitionHash(trials);
  const modelMap = new Map((models ?? []).map((model) => [model.id, model]));
  const enforceInventory = Array.isArray(models);
  const results = {};
  for (const [modelId, result] of Object.entries(index.results ?? {})) {
    const model = modelMap.get(modelId);
    const artifactMatches =
      (!enforceInventory && !model) ||
      (Boolean(model) &&
        result.modelFingerprint === getModelArtifactFingerprint(model));
    if (
      result.status === "completed" &&
      result.definitionHash === definitionHash &&
      result.hardware?.fingerprint === resolvedHardware.fingerprint &&
      artifactMatches
    ) {
      results[modelId] = result;
    }
  }
  return {
    ...index,
    definitionHash,
    hardware: resolvedHardware,
    results,
    staleCount: Object.keys(index.results ?? {}).length - Object.keys(results).length,
    path: store.indexPath,
  };
}

function responseTextFromCompletion(completion) {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function speedScore(latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(100, Math.round(100 - Math.max(0, Math.log10(latencyMs / 500)) * 45)),
  );
}

function resourceScore(model, hardware) {
  if (hardware?.descriptor?.scope !== "local") {
    return null;
  }
  const params = estimateModelParams(model?.id, model?.paramsString);
  if (!Number.isFinite(params.totalB)) {
    return null;
  }
  const estimatedGb = params.totalB * 0.75;
  const availableGb = os.totalmem() / 1024 ** 3;
  return Math.max(0, Math.min(100, Math.round(100 - (estimatedGb / availableGb) * 100)));
}

function calculateScores(trials, model, hardware) {
  const categoryBuckets = {};
  for (const trial of trials) {
    if (!categoryBuckets[trial.category]) {
      categoryBuckets[trial.category] = [];
    }
    categoryBuckets[trial.category].push(trial.score);
  }
  const categories = Object.fromEntries(
    Object.entries(categoryBuckets).map(([category, values]) => [
      category,
      Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    ]),
  );
  const qualityValues = Object.values(categories);
  const quality = qualityValues.length
    ? qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length
    : 0;
  const averageLatencyMs = trials.length
    ? trials.reduce((sum, trial) => sum + trial.latencyMs, 0) / trials.length
    : null;
  const speed = speedScore(averageLatencyMs);
  const resources = resourceScore(model, hardware);
  const overall = Math.round(
    quality * 0.85 + speed * 0.15,
  );
  return {
    ...categories,
    quality: Math.round(quality),
    speed,
    resources,
    overall,
    averageLatencyMs: Number.isFinite(averageLatencyMs)
      ? Math.round(averageLatencyMs)
      : null,
  };
}

function loadInstanceId(response) {
  return (
    response?.instance_id ??
    response?.instanceId ??
    response?.loaded_instance?.id ??
    response?.loadedInstance?.id ??
    null
  );
}

async function ensureModelLoaded(restClient, model, contextLength) {
  if (model.loadedInstances?.length) {
    return { created: false, instanceId: model.loadedInstances[0].id ?? null };
  }
  const beforeIds = new Set(
    (model.loadedInstances ?? []).map((instance) => instance.id).filter(Boolean),
  );
  const response = await restClient.loadModelV1({
    model: model.id,
    context_length: Math.min(
      contextLength,
      model.maxContextLength ?? contextLength,
    ),
    echo_load_config: true,
  });
  let instanceId = loadInstanceId(response);
  if (!instanceId) {
    const refreshed = await fetchModelCatalog({ restClient });
    const current = refreshed.models.find((entry) => entry.id === model.id);
    instanceId =
      current?.loadedInstances?.find(
        (instance) => instance.id && !beforeIds.has(instance.id),
      )?.id ?? current?.loadedInstanceId ?? null;
  }
  if (!instanceId) {
    throw new Error(`LM Studio loaded ${model.id} but returned no instance id.`);
  }
  return { created: true, instanceId };
}

function buildTrialPrompt(trial, retryError = null) {
  return [
    "You are running a deterministic MiniPhi model benchmark.",
    `Trial id: ${trial.id}`,
    `Task: ${trial.prompt}`,
    retryError
      ? `Your previous response was rejected (${retryError}). Return a fresh response.`
      : null,
    "Return exactly one JSON object and no prose.",
    `Exact JSON schema: ${JSON.stringify(MODEL_BENCHMARK_TRIAL_SCHEMA)}`,
    `Set schema_version to "${MODEL_BENCHMARK_SCHEMA_VERSION}" and trial_id to "${trial.id}".`,
    "Set needs_more_context to false and missing_snippets to [].",
  ]
    .filter(Boolean)
    .join("\n");
}

async function runTrial({
  restClient,
  model,
  trial,
  timeoutMs,
  onProgress,
}) {
  const attempts = [];
  let retryError = null;
  for (
    let attempt = 1;
    attempt <= MODEL_BENCHMARK_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const payload = {
      model: model.id,
      messages: [
        {
          role: "user",
          content: buildTrialPrompt(trial, retryError),
        },
      ],
      temperature: 0,
      max_tokens: MODEL_BENCHMARK_MAX_TOKENS,
      timeoutMs,
      response_format: buildJsonSchemaResponseFormat(
        MODEL_BENCHMARK_TRIAL_SCHEMA,
        `model-benchmark-${trial.id}`,
      ),
      ...(trial.toolDefinitions?.length
        ? {
            tools: trial.toolDefinitions,
            tool_choice: "none",
          }
        : {}),
    };
    const startedAt = Date.now();
    let completion;
    let error = null;
    try {
      completion = await restClient.createChatCompletion(payload);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const latencyMs = Date.now() - startedAt;
    const responseText = responseTextFromCompletion(completion);
    const reasoningText =
      completion?.choices?.[0]?.message?.reasoning ??
      completion?.choices?.[0]?.message?.reasoning_content ??
      "";
    const finishReason = completion?.choices?.[0]?.finish_reason ?? null;
    const validation = error
      ? null
      : validateJsonObjectAgainstSchema(
          MODEL_BENCHMARK_TRIAL_SCHEMA,
          responseText,
        );
    const parsed = validation?.status === "ok" ? validation.parsed : null;
    const reasoningTokens = Number(
      completion?.usage?.completion_tokens_details?.reasoning_tokens,
    );
    const reasoningBudgetExhausted =
      !error &&
      !responseText &&
      finishReason === "length" &&
      Number.isFinite(reasoningTokens) &&
      reasoningTokens > 0;
    const attemptRecord = {
      attempt,
      latencyMs,
      status: error
        ? "request_failed"
        : reasoningBudgetExhausted
          ? "reasoning_budget_exhausted"
          : validation?.status === "ok"
            ? "valid"
            : validation?.status ?? "invalid_json",
      error:
        error ??
        (reasoningBudgetExhausted
          ? `model used all ${reasoningTokens} output tokens for reasoning and returned no JSON content`
          : validation?.error ?? null),
      responseText,
      reasoningText,
      finishReason,
      toolCalls: completion?.choices?.[0]?.message?.tool_calls ?? [],
      toolDefinitions: trial.toolDefinitions ?? [],
      usage: completion?.usage ?? null,
    };
    attempts.push(attemptRecord);
    onProgress?.({
      type: "attempt",
      modelId: model.id,
      trialId: trial.id,
      attempt,
      status: attemptRecord.status,
    });
    if (parsed) {
      const correct =
        parsed.trial_id === trial.id &&
        parsed.needs_more_context === false &&
        parsed.missing_snippets.length === 0 &&
        trial.matches(parsed.answer);
      return {
        id: trial.id,
        category: trial.category,
        status: correct ? "passed" : "incorrect",
        score: correct ? 100 : 35,
        answer: parsed.answer,
        latencyMs,
        attempts,
      };
    }
    retryError = attemptRecord.error ?? attemptRecord.status;
  }
  return {
    id: trial.id,
    category: trial.category,
    status: "invalid-response",
    score: 0,
    answer: null,
    latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
    attempts,
    fallback: {
      schema_version: MODEL_BENCHMARK_SCHEMA_VERSION,
      trial_id: trial.id,
      answer: "",
      evidence: [],
      needs_more_context: false,
      missing_snippets: [],
      stop_reason: "invalid-response",
    },
  };
}

export class ModelBenchmarkRunner {
  constructor({
    restClient,
    cwd = process.cwd(),
    baseDir = null,
    contextLength = DEFAULT_MODEL_BENCHMARK_CONTEXT_LENGTH,
    timeoutMs = DEFAULT_MODEL_BENCHMARK_TIMEOUT_MS,
    trials = EASY_MODEL_BENCHMARK_TRIALS,
    store = null,
  } = {}) {
    if (!restClient) {
      throw new Error("restClient is required for model benchmarks.");
    }
    this.restClient = restClient;
    this.contextLength = contextLength;
    this.timeoutMs = timeoutMs;
    this.trials = trials;
    this.store = store ?? new ModelBenchmarkStore({ cwd, baseDir });
  }

  async run({
    modelIds = null,
    refresh = false,
    onProgress = null,
  } = {}) {
    const catalog = await fetchModelCatalog({ restClient: this.restClient });
    const requested = Array.isArray(modelIds)
      ? new Set(modelIds.map((id) => String(id).trim()).filter(Boolean))
      : null;
    const models = catalog.models.filter(
      (model) => !requested || requested.has(model.id),
    );
    if (requested) {
      const missing = [...requested].filter(
        (id) => !models.some((model) => model.id === id),
      );
      if (missing.length) {
        throw new Error(`Unknown LM Studio model(s): ${missing.join(", ")}`);
      }
    }
    const hardware = await resolveBenchmarkHardware({
      restClient: this.restClient,
    });
    const definitionHash = getModelBenchmarkDefinitionHash(this.trials);
    const current = await this.store.load();
    const results = [];
    for (const model of models) {
      const modelFingerprint = getModelArtifactFingerprint(model);
      const resolvedLoadConfig =
        model.loadedInstances?.[0]?.config ?? {
          context_length: Math.min(
            this.contextLength,
            model.maxContextLength ?? this.contextLength,
          ),
        };
      const cacheKey = sha256(
        stableJson({
          revision: MODEL_BENCHMARK_REVISION,
          definitionHash,
          hardware: hardware.fingerprint,
          model: modelFingerprint,
          loadConfig: resolvedLoadConfig,
          timeoutMs: this.timeoutMs,
        }),
      );
      const cached = current.results?.[model.id];
      if (
        !refresh &&
        cached?.status === "completed" &&
        cached.cacheKey === cacheKey
      ) {
        onProgress?.({ type: "cache-hit", modelId: model.id });
        results.push({ ...cached, cacheHit: true });
        continue;
      }

      onProgress?.({ type: "model-start", modelId: model.id });
      let loaded = null;
      let result;
      try {
        loaded = await ensureModelLoaded(
          this.restClient,
          model,
          this.contextLength,
        );
        const trialResults = [];
        for (const trial of this.trials) {
          onProgress?.({
            type: "trial-start",
            modelId: model.id,
            trialId: trial.id,
          });
          trialResults.push(
            await runTrial({
              restClient: this.restClient,
              model,
              trial,
              timeoutMs: this.timeoutMs,
              onProgress,
            }),
          );
        }
        result = {
          schemaVersion: "model-benchmark-result@v1",
          revision: MODEL_BENCHMARK_REVISION,
          definitionHash,
          cacheKey,
          status: "completed",
          stopReason: null,
          modelId: model.id,
          modelFingerprint,
          model: {
            id: model.id,
            type: model.type,
            arch: model.arch,
            quantization: model.quantization,
            sizeBytes: model.sizeBytes,
            paramsString: model.paramsString,
            maxContextLength: model.maxContextLength,
            capabilities: model.capabilities,
          },
          loadConfig: resolvedLoadConfig,
          hardware,
          scores: calculateScores(trialResults, model, hardware),
          resourceMeasurement: {
            status:
              hardware.descriptor.scope === "local"
                ? "estimated"
                : "unavailable",
            reason:
              hardware.descriptor.scope === "local"
                ? "Estimated from normalized parameter count and local system memory; server telemetry was not exposed."
                : "Remote LM Studio did not expose CPU/RAM/GPU/VRAM telemetry.",
          },
          trials: trialResults,
          completedAt: new Date().toISOString(),
        };
      } catch (error) {
        result = {
          schemaVersion: "model-benchmark-result@v1",
          revision: MODEL_BENCHMARK_REVISION,
          definitionHash,
          cacheKey,
          status: "failed",
          stopReason: "benchmark-runtime-error",
          error: error instanceof Error ? error.message : String(error),
          modelId: model.id,
          modelFingerprint,
          hardware,
          scores: null,
          trials: [],
          completedAt: new Date().toISOString(),
        };
      } finally {
        if (loaded?.created && loaded.instanceId) {
          try {
            await this.restClient.unloadModelV1({
              instance_id: loaded.instanceId,
            });
          } catch (error) {
            onProgress?.({
              type: "restore-warning",
              modelId: model.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      await this.store.saveResult(result);
      onProgress?.({
        type: "model-done",
        modelId: model.id,
        status: result.status,
      });
      results.push({ ...result, cacheHit: false });
    }
    const freshIndex = await loadFreshModelBenchmarkIndex({
      baseDir: this.store.baseDir,
      restClient: this.restClient,
      models: catalog.models,
      hardware,
      trials: this.trials,
    });
    return {
      schemaVersion: "model-benchmark-run@v1",
      catalogSource: catalog.source,
      modelCount: models.length,
      results,
      index: freshIndex,
    };
  }
}

export function modelBenchmarkTableRows(index) {
  return Object.values(index?.results ?? {})
    .filter((result) => result?.status === "completed" && result.scores)
    .map((result) => ({
      modelId: result.modelId,
      overall: result.scores.overall,
      coding: result.scores.coding ?? null,
      reasoning: result.scores.reasoning ?? null,
      context: result.scores.context ?? null,
      writing: result.scores.writing ?? null,
      research: result.scores.research ?? null,
      toolUse: result.scores.tool_use ?? null,
      speed: result.scores.speed ?? null,
      resources: result.scores.resources ?? null,
      latencyMs: result.scores.averageLatencyMs ?? null,
      completedAt: result.completedAt,
    }))
    .sort((a, b) =>
      b.overall === a.overall
        ? a.modelId.localeCompare(b.modelId)
        : b.overall - a.overall,
    );
}
