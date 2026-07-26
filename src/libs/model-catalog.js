import os from "os";
import { classifyTaskIntent } from "./model-selector.js";
import { DEFAULT_MODEL_KEY } from "./model-presets.js";

const CODING_ID_PATTERN = /coder|devstral|codestral|starcoder|code-?llama|deepseek-?coder|granite/i;
const REASONING_ID_PATTERN = /reasoning|phi-?4|(?:^|[-/])r1(?:$|[-.])|qwq|think/i;
const MOE_ACTIVE_PATTERN = /(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/i;
const PARAM_COUNT_PATTERN = /(\d+(?:\.\d+)?)\s*b(?:$|[-._ ])/i;
const EMBEDDING_TYPES = new Set(["embedding", "embeddings"]);
// Rough GGUF Q4 footprint: weights (~0.62 GB/B) plus KV-cache/runtime headroom.
const GB_PER_BILLION_PARAMS_Q4 = 0.75;

function normalizeLoadConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(rawConfig).filter(([, value]) => {
      if (
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return true;
      }
      // Keep short scalar runtime identifiers/settings, but exclude nested
      // prompt templates and other unbounded server configuration blobs.
      return typeof value === "string" && value.length <= 256;
    }),
  );
}

function normalizeLoadedInstances(entry) {
  if (!Array.isArray(entry?.loaded_instances)) {
    return [];
  }
  return entry.loaded_instances
    .filter((instance) => instance && typeof instance === "object")
    .map((instance) => {
      const config = normalizeLoadConfig(instance.config);
      const contextLength = Number(config.context_length);
      return {
        id:
          typeof instance.id === "string" && instance.id.trim()
            ? instance.id.trim()
            : null,
        contextLength:
          Number.isFinite(contextLength) && contextLength > 0
            ? contextLength
            : null,
        config,
        remainingTtlSeconds: Number.isFinite(Number(instance.remaining_ttl_seconds))
          ? Number(instance.remaining_ttl_seconds)
          : null,
      };
    });
}

function normalizeCapabilities(entry) {
  const raw = entry?.capabilities;
  const legacy = Array.isArray(raw)
    ? raw.filter((capability) => typeof capability === "string")
    : [];
  const details = raw && !Array.isArray(raw) && typeof raw === "object" ? raw : {};
  const reasoning =
    details.reasoning && typeof details.reasoning === "object"
      ? {
          allowedOptions: Array.isArray(details.reasoning.allowed_options)
            ? details.reasoning.allowed_options.filter(
                (option) => typeof option === "string" && option.trim(),
              )
            : [],
          default:
            typeof details.reasoning.default === "string"
              ? details.reasoning.default
              : null,
        }
      : null;
  const capabilities = new Set(legacy);
  if (details.vision === true) {
    capabilities.add("vision");
  }
  if (details.trained_for_tool_use === true) {
    capabilities.add("tool_use");
  }
  if (reasoning) {
    capabilities.add("reasoning");
  }
  return {
    capabilities: [...capabilities],
    capabilityDetails: {
      vision: details.vision === true || capabilities.has("vision"),
      trainedForToolUse:
        details.trained_for_tool_use === true || capabilities.has("tool_use"),
      reasoning,
    },
  };
}

/**
 * Normalizes one raw model entry from /api/v0/models, /api/v1/models, or the
 * OpenAI-compat /v1/models list into a stable shape.
 */
export function normalizeCatalogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const idCandidate = entry.id ?? entry.key;
  const id =
    typeof idCandidate === "string" && idCandidate.trim()
      ? idCandidate.trim()
      : null;
  if (!id) {
    return null;
  }
  const type =
    typeof entry.type === "string" && entry.type.trim()
      ? entry.type.trim().toLowerCase()
      : "llm";
  const loadedInstances = normalizeLoadedInstances(entry);
  const loadedWindows = loadedInstances
    .map((instance) => instance.contextLength)
    .filter((value) => Number.isFinite(value) && value > 0);
  const maxContext = Number(entry.max_context_length ?? entry.loaded_context_length);
  // The *loaded* window is the real prompt limit for a JIT-loaded model; the
  // maximum only says what the model could do if it were loaded larger.
  // When several instances share a model key, use the smallest loaded window
  // so an ambiguous request cannot be budgeted above one live instance.
  const loadedContext = Number(
    entry.loaded_context_length ??
      (loadedWindows.length ? Math.min(...loadedWindows) : null),
  );
  const rawQuantization = entry.quantization;
  const quantization =
    typeof rawQuantization === "string"
      ? rawQuantization
      : typeof rawQuantization?.name === "string"
        ? rawQuantization.name
        : null;
  const { capabilities, capabilityDetails } = normalizeCapabilities(entry);
  const state =
    loadedInstances.length > 0
      ? "loaded"
      : Array.isArray(entry.loaded_instances)
        ? "not-loaded"
        : typeof entry.state === "string"
          ? entry.state
          : "unknown";
  return {
    id,
    type,
    displayName:
      typeof entry.display_name === "string" ? entry.display_name : id,
    publisher: typeof entry.publisher === "string" ? entry.publisher : null,
    arch:
      typeof entry.arch === "string"
        ? entry.arch
        : typeof entry.architecture === "string"
          ? entry.architecture
          : null,
    quantization,
    quantizationBits: Number.isFinite(Number(rawQuantization?.bits_per_weight))
      ? Number(rawQuantization.bits_per_weight)
      : null,
    sizeBytes: Number.isFinite(Number(entry.size_bytes))
      ? Number(entry.size_bytes)
      : null,
    paramsString:
      typeof entry.params_string === "string" ? entry.params_string : null,
    format: typeof entry.format === "string" ? entry.format : null,
    state,
    maxContextLength: Number.isFinite(maxContext) && maxContext > 0 ? maxContext : null,
    loadedContextLength: Number.isFinite(loadedContext) && loadedContext > 0 ? loadedContext : null,
    loadedInstanceId: loadedInstances[0]?.id ?? null,
    loadedInstances,
    capabilities,
    capabilityDetails,
    variants: Array.isArray(entry.variants)
      ? entry.variants.filter((variant) => typeof variant === "string")
      : [],
    selectedVariant:
      typeof entry.selected_variant === "string" ? entry.selected_variant : null,
    description:
      typeof entry.description === "string" ? entry.description : null,
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
    .filter((model) => includeEmbeddings || !EMBEDDING_TYPES.has(model.type));
}

/**
 * Estimates the parameter count (billions) from a model id such as
 * "qwen3-coder-30b-a3b-instruct". For MoE ids ("30b-a3b") both total and
 * active counts are returned; memory sizing uses the total.
 */
export function estimateModelParams(id, paramsString = null) {
  const source = [id, paramsString]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
  if (!source) {
    return { totalB: null, activeB: null };
  }
  const moe = source.match(MOE_ACTIVE_PATTERN);
  if (moe) {
    return { totalB: Number(moe[1]), activeB: Number(moe[2]) };
  }
  const plain = source.match(PARAM_COUNT_PATTERN);
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
  {
    intent = "general",
    requiredContextLength = null,
    availableMemoryGb = null,
    benchmarkResults = null,
  } = {},
) {
  const reasons = [];
  if (!model || EMBEDDING_TYPES.has(model.type)) {
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

  const params = estimateModelParams(model.id, model.paramsString);
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

  const benchmark = benchmarkResults?.[model.id] ?? null;
  const intentCategory = {
    coding: "coding",
    analysis: "reasoning",
    writing: "writing",
    research: "research",
    general: "overall",
  }[intent] ?? "overall";
  const benchmarkScore = Number(
    benchmark?.scores?.[intentCategory] ?? benchmark?.scores?.overall,
  );
  if (
    benchmark?.status === "completed" &&
    Number.isFinite(benchmarkScore)
  ) {
    const heuristicScore = score;
    // Fresh benchmark evidence is primary. Heuristics remain a small,
    // deterministic tie-break for load state, fit, and declared capabilities.
    score = benchmarkScore + Math.max(-10, Math.min(15, heuristicScore)) / 10;
    reasons.unshift(
      `benchmark ${intentCategory} score ${benchmarkScore}/100 (${benchmark.revision ?? "cached"})`,
    );
    return {
      score,
      reasons,
      heuristicScore,
      benchmark: {
        category: intentCategory,
        score: benchmarkScore,
        overall: benchmark.scores?.overall ?? null,
        completedAt: benchmark.completedAt ?? null,
        revision: benchmark.revision ?? null,
      },
    };
  }

  if (
    benchmarkResults &&
    typeof benchmarkResults === "object" &&
    !Array.isArray(benchmarkResults)
  ) {
    const heuristicScore = score;
    score = 50 + Math.max(-10, Math.min(15, heuristicScore)) / 10;
    reasons.unshift(
      "no fresh benchmark score; using neutral benchmark prior plus inventory heuristics",
    );
    return {
      score,
      reasons,
      heuristicScore,
      benchmark: null,
    };
  }

  return {
    score,
    reasons,
    heuristicScore: score,
    benchmark: null,
  };
}

/**
 * Ranks the catalog for an intent; highest score first, ties broken by id for
 * deterministic output.
 */
export function rankModelsForTask(models, options = undefined) {
  const list = Array.isArray(models) ? models : [];
  return list
    .map((model) => {
      const { score, reasons, heuristicScore, benchmark } =
        scoreModelForTask(model, options);
      return { model, score, reasons, heuristicScore, benchmark };
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
 * Fetches the live model inventory through an LMStudioRestClient. Current
 * native v1 is preferred, then the legacy native v0 route, then the
 * OpenAI-compatible /v1/models list.
 */
export async function fetchModelCatalog({ restClient, includeEmbeddings = false } = {}) {
  if (!restClient) {
    throw new Error("restClient is required to fetch the model catalog.");
  }
  const attempts = [];
  const routes = [
    {
      source: "native-v1",
      method: "listModelsNativeV1",
    },
    {
      source: "native-v0",
      method: "listModels",
    },
    {
      source: "openai-compat",
      method: "listModelsV1",
    },
  ];
  for (const route of routes) {
    if (typeof restClient[route.method] !== "function") {
      continue;
    }
    try {
      const payload = await restClient[route.method]();
      return {
        source: route.source,
        models: normalizeModelCatalog(payload, { includeEmbeddings }),
        attempts,
      };
    } catch (error) {
      attempts.push({
        source: route.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const firstError = attempts[0]?.error ?? "No supported LM Studio model-list route is available.";
  throw new Error(firstError);
}

/**
 * Resolves the real context window for one model id from the live inventory.
 * `loadedContextLength` is what a prompt must fit into right now; MiniPhi uses it
 * to size the context-graph budget instead of trusting a static default.
 * Returns null when LM Studio is unreachable or the model is unknown.
 */
export async function resolveContextWindow({ restClient, modelId = null } = {}) {
  if (!restClient) {
    return null;
  }
  let catalog;
  try {
    catalog = await fetchModelCatalog({ restClient, includeEmbeddings: true });
  } catch {
    return null;
  }
  const wanted = typeof modelId === "string" && modelId.trim() ? modelId.trim() : null;
  const model = wanted
    ? catalog.models.find((entry) => entry.id === wanted) ?? null
    : catalog.models.find((entry) => entry.state === "loaded") ?? null;
  if (!model) {
    return null;
  }
  return {
    modelId: model.id,
    state: model.state,
    loadedContextLength: model.loadedContextLength,
    maxContextLength: model.maxContextLength,
    loadedInstanceId: model.loadedInstanceId,
    loadedInstances: model.loadedInstances,
    // Only the loaded window is a fact. For a not-yet-loaded model LM Studio
    // picks the window at JIT-load time (often far below the maximum), so the
    // maximum must never be used as a prompt budget — callers fall back to the
    // conservative default instead.
    contextLength: model.loadedContextLength ?? null,
    jitUnknown: model.state !== "loaded" || model.loadedContextLength === null,
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
  benchmarkResults = null,
  loadBenchmarkResults = null,
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
  let effectiveBenchmarkResults = benchmarkResults;
  if (
    !effectiveBenchmarkResults &&
    typeof loadBenchmarkResults === "function"
  ) {
    try {
      effectiveBenchmarkResults = await loadBenchmarkResults(catalog.models);
    } catch (error) {
      log(
        `[ModelCatalog] Unable to load model benchmark scores (${error instanceof Error ? error.message : error}); using inventory heuristics.`,
      );
    }
  }
  const best = selectBestModelForTask(catalog.models, {
    intent,
    requiredContextLength,
    availableMemoryGb,
    benchmarkResults: effectiveBenchmarkResults,
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
    benchmarkCount: Object.keys(effectiveBenchmarkResults ?? {}).length,
  };
}
