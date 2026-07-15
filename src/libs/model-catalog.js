import os from "os";
import { classifyTaskIntent } from "./model-selector.js";
import { DEFAULT_MODEL_KEY } from "./model-presets.js";

const CODING_ID_PATTERN = /coder|devstral|codestral|starcoder|code-?llama|deepseek-?coder|granite/i;
const REASONING_ID_PATTERN = /reasoning|phi-?4|(?:^|[-/])r1(?:$|[-.])|qwq|think/i;
const MOE_ACTIVE_PATTERN = /(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/i;
const PARAM_COUNT_PATTERN = /(\d+(?:\.\d+)?)\s*b(?:$|[-._ ])/i;
// Rough GGUF Q4 footprint: weights (~0.62 GB/B) plus KV-cache/runtime headroom.
const GB_PER_BILLION_PARAMS_Q4 = 0.75;

/**
 * Normalizes one raw model entry from /api/v0/models, /api/v1/models, or the
 * OpenAI-compat /v1/models list into a stable shape.
 */
export function normalizeCatalogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : null;
  if (!id) {
    return null;
  }
  const capabilities = Array.isArray(entry.capabilities)
    ? entry.capabilities.filter((cap) => typeof cap === "string")
    : [];
  const maxContext = Number(entry.max_context_length ?? entry.loaded_context_length);
  return {
    id,
    type: typeof entry.type === "string" ? entry.type : "llm",
    publisher: typeof entry.publisher === "string" ? entry.publisher : null,
    arch: typeof entry.arch === "string" ? entry.arch : null,
    quantization: typeof entry.quantization === "string" ? entry.quantization : null,
    state: typeof entry.state === "string" ? entry.state : "unknown",
    maxContextLength: Number.isFinite(maxContext) && maxContext > 0 ? maxContext : null,
    capabilities,
  };
}

/**
 * Normalizes a full models-list payload ({ data: [...] } or bare array).
 * Embedding models are excluded unless includeEmbeddings is set.
 */
export function normalizeModelCatalog(payload, { includeEmbeddings = false } = {}) {
  const rawList = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return rawList
    .map((entry) => normalizeCatalogEntry(entry))
    .filter((model) => model !== null)
    .filter((model) => includeEmbeddings || model.type !== "embeddings");
}

/**
 * Estimates the parameter count (billions) from a model id such as
 * "qwen3-coder-30b-a3b-instruct". For MoE ids ("30b-a3b") both total and
 * active counts are returned; memory sizing uses the total.
 */
export function estimateModelParams(id) {
  if (typeof id !== "string") {
    return { totalB: null, activeB: null };
  }
  const moe = id.match(MOE_ACTIVE_PATTERN);
  if (moe) {
    return { totalB: Number(moe[1]), activeB: Number(moe[2]) };
  }
  const plain = id.match(PARAM_COUNT_PATTERN);
  if (plain) {
    const totalB = Number(plain[1]);
    return { totalB, activeB: totalB };
  }
  return { totalB: null, activeB: null };
}

/**
 * Classifies a model's primary purpose from its id/arch.
 */
export function classifyModelPurpose(model) {
  const haystack = `${model?.id ?? ""} ${model?.arch ?? ""}`;
  if (CODING_ID_PATTERN.test(haystack)) {
    return "coding";
  }
  if (REASONING_ID_PATTERN.test(haystack)) {
    return "reasoning";
  }
  return "general";
}

const INTENT_PURPOSE_SCORES = {
  coding: { coding: 10, reasoning: 6, general: 5 },
  analysis: { reasoning: 9, coding: 8, general: 6 },
  writing: { general: 9, reasoning: 7, coding: 4 },
  research: { general: 9, reasoning: 8, coding: 4 },
  general: { general: 8, coding: 7, reasoning: 7 },
};

/**
 * Scores a normalized model for a task intent. Deterministic so unit tests can
 * assert rankings; resource limits are injectable via availableMemoryGb.
 */
export function scoreModelForTask(
  model,
  { intent = "general", requiredContextLength = null, availableMemoryGb = null } = {},
) {
  const reasons = [];
  if (!model || model.type === "embeddings") {
    return { score: -Infinity, reasons: ["not a chat-capable model"] };
  }
  const purpose = classifyModelPurpose(model);
  const matrix = INTENT_PURPOSE_SCORES[intent] ?? INTENT_PURPOSE_SCORES.general;
  let score = matrix[purpose] ?? matrix.general;
  reasons.push(`${purpose} model scored for ${intent} intent`);

  const ctx = model.maxContextLength;
  if (Number.isFinite(requiredContextLength) && requiredContextLength > 0 && ctx) {
    if (ctx < requiredContextLength) {
      score -= 4;
      reasons.push(`context ${ctx} below required ${requiredContextLength}`);
    }
  }
  if (ctx >= 131072) {
    score += 2;
    reasons.push("large context window (>=128k)");
  } else if (ctx >= 32768) {
    score += 1;
  }

  if (model.state === "loaded") {
    score += 3;
    reasons.push("already loaded in LM Studio");
  }
  if (model.capabilities.includes("tool_use")) {
    score += 1;
    reasons.push("supports tool use");
  }

  const params = estimateModelParams(model.id);
  if (Number.isFinite(params.totalB)) {
    const memoryGb = Number.isFinite(availableMemoryGb)
      ? availableMemoryGb
      : os.totalmem() / 1024 ** 3;
    const estimatedNeedGb = params.totalB * GB_PER_BILLION_PARAMS_Q4;
    if (estimatedNeedGb > memoryGb * 0.8) {
      score -= 6;
      reasons.push(
        `~${estimatedNeedGb.toFixed(0)}GB estimated footprint may exceed local memory (${memoryGb.toFixed(0)}GB)`,
      );
    } else {
      // Bigger models that still fit locally are usually more capable.
      score += Math.min(2, params.totalB / 15);
    }
  }

  const quant = (model.quantization ?? "").toLowerCase();
  if (quant.startsWith("q8")) {
    score += 0.5;
  } else if (quant.startsWith("q3") || quant.startsWith("q2")) {
    score -= 0.5;
    reasons.push(`low-bit quantization (${model.quantization})`);
  }

  return { score, reasons };
}

/**
 * Ranks the catalog for an intent; highest score first, ties broken by id for
 * deterministic output.
 */
export function rankModelsForTask(models, options = undefined) {
  const list = Array.isArray(models) ? models : [];
  return list
    .map((model) => {
      const { score, reasons } = scoreModelForTask(model, options);
      return { model, score, reasons };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => (b.score === a.score ? a.model.id.localeCompare(b.model.id) : b.score - a.score));
}

export function selectBestModelForTask(models, options = undefined) {
  const ranked = rankModelsForTask(models, options);
  if (!ranked.length) {
    return null;
  }
  return { ...ranked[0], ranked };
}

/**
 * Fetches the live model inventory through an LMStudioRestClient, preferring
 * the richer native models endpoint and falling back to the OpenAI-compat
 * /v1/models list when the native route is unavailable.
 */
export async function fetchModelCatalog({ restClient, includeEmbeddings = false } = {}) {
  if (!restClient) {
    throw new Error("restClient is required to fetch the model catalog.");
  }
  let payload = null;
  let source = "native";
  try {
    payload = await restClient.listModels();
  } catch (nativeError) {
    source = "openai-compat";
    try {
      payload = await restClient.listModelsV1();
    } catch {
      throw nativeError;
    }
  }
  return {
    source,
    models: normalizeModelCatalog(payload, { includeEmbeddings }),
  };
}

/**
 * Resolves `--model auto`: classifies the task intent, fetches the live
 * catalog, and returns the best-scoring installed model. Returns null when
 * LM Studio is unreachable or the catalog is empty so callers can fall back
 * to the static default.
 */
export async function resolveAutoModel({
  restClient,
  task = null,
  command = null,
  mode = null,
  workspaceContext = null,
  requiredContextLength = null,
  availableMemoryGb = null,
  logger = null,
} = {}) {
  const log = typeof logger === "function" ? logger : () => {};
  const { intent } = classifyTaskIntent({ task, mode, workspaceContext, command });
  let catalog;
  try {
    catalog = await fetchModelCatalog({ restClient });
  } catch (error) {
    log(
      `[ModelCatalog] Unable to list LM Studio models (${error instanceof Error ? error.message : error}); falling back to ${DEFAULT_MODEL_KEY}.`,
    );
    return null;
  }
  const best = selectBestModelForTask(catalog.models, {
    intent,
    requiredContextLength,
    availableMemoryGb,
  });
  if (!best) {
    log("[ModelCatalog] Model catalog is empty; falling back to configured default model.");
    return null;
  }
  return {
    modelKey: best.model.id,
    intent,
    score: best.score,
    reasons: best.reasons,
    model: best.model,
    ranked: best.ranked,
    source: catalog.source,
  };
}
