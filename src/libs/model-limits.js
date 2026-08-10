import { fetchModelCatalog, resolveContextWindow } from "./model-catalog.js";

/**
 * What the *live* API will actually accept, resolved before the first prompt.
 *
 * MiniPhi already refuses to size a prompt from `max_context_length` (a
 * JIT-loaded instance gets a much smaller window, and overshooting it is a 400).
 * The other half of that rule was missing: nothing ever *asked* for a bigger
 * window, so a 262144-capable model was driven at whatever LM Studio happened to
 * JIT-load — 4096 on a cold host — and every prompt, every file the model could
 * be shown, and every file it could emit were cut to fit a window nobody chose.
 *
 * This module resolves the real numbers (loaded window, hard maximum, output
 * headroom) and, when the operator asks for it, loads the model at the window
 * the run needs before any prompting starts.
 */

// Tokens held back from the loaded window for the parts of a request that are
// not the selected context: the system prompt is measured separately, this
// covers chat-template overhead and the model's own tokenizer disagreeing with
// a 4-chars-per-token estimate.
const SAFETY_TOKENS = 512;

// LM Studio's own default when a request omits `context_length` on a cold model.
export const COLD_JIT_CONTEXT_LENGTH = 4096;

const clampPositiveInt = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/**
 * Reads everything the API says about one model: the window it is loaded with
 * right now, the window it *could* be loaded with, and its capabilities.
 *
 * @returns {Promise<{
 *   model: string,
 *   loadedContextLength: number|null,
 *   maxContextLength: number|null,
 *   effectiveContextLength: number,
 *   loaded: boolean,
 *   instanceId: string|null,
 *   parallel: number|null,
 *   vision: boolean,
 *   toolUse: boolean,
 *   reasoningOptions: string[],
 *   source: string,
 * }>}
 */
export async function inspectModelLimits({ restClient, modelId } = {}) {
  const result = {
    model: modelId ?? null,
    loadedContextLength: null,
    maxContextLength: null,
    effectiveContextLength: COLD_JIT_CONTEXT_LENGTH,
    loaded: false,
    instanceId: null,
    parallel: null,
    vision: false,
    toolUse: false,
    reasoningOptions: [],
    source: "default",
  };
  if (!restClient || !modelId) {
    return result;
  }

  const catalog = await fetchModelCatalog({ restClient }).catch(() => null);
  const entry = (catalog?.models ?? []).find((model) => model?.id === modelId) ?? null;
  const instance = entry?.loadedInstances?.[0] ?? null;

  result.maxContextLength = clampPositiveInt(entry?.maxContextLength);
  result.loadedContextLength = clampPositiveInt(entry?.loadedContextLength);
  result.loaded = entry?.state === "loaded";
  result.instanceId = entry?.loadedInstanceId ?? null;
  result.parallel = clampPositiveInt(instance?.config?.parallel);
  result.vision = Boolean(entry?.capabilityDetails?.vision);
  result.toolUse = Boolean(entry?.capabilityDetails?.trainedForToolUse);
  result.reasoningOptions = Array.isArray(entry?.capabilityDetails?.reasoning?.allowedOptions)
    ? entry.capabilityDetails.reasoning.allowedOptions.slice()
    : [];
  result.source = entry ? "catalog" : "unavailable";

  if (!result.loadedContextLength) {
    // Second opinion from the shared resolver, which also understands the v0
    // shape used by hosts that do not expose native v1.
    const window = await resolveContextWindow({ restClient, modelId }).catch(() => null);
    result.loadedContextLength = clampPositiveInt(window?.loadedContextLength);
    result.maxContextLength = result.maxContextLength ?? clampPositiveInt(window?.maxContextLength);
    if (result.loadedContextLength) {
      result.source = "context-window-probe";
    }
  }

  result.effectiveContextLength =
    result.loadedContextLength ?? COLD_JIT_CONTEXT_LENGTH;
  return result;
}

/**
 * Makes sure the model is loaded with at least `desiredContextLength`.
 *
 * Reloading is *explicit operator intent only*: MiniPhi never implicitly
 * unloads an instance the operator loaded (see AGENTS.md), so a smaller-than-
 * requested instance is reported and left alone unless `allowReload` is set.
 *
 * @returns {Promise<{action:string, limits:object, error:string|null}>}
 */
export async function ensureModelLoaded({
  restClient,
  modelId,
  desiredContextLength,
  allowReload = false,
  // Recycle the instance even when its window is already large enough. This is
  // the *recovery* path: a wedged LM Studio engine answers `400 Engine protocol
  // predict request failed` on every request until the model is unloaded and
  // reloaded, and its advertised context length is unchanged by being wedged.
  // Without this flag the recovery inspected a healthy-looking 32768-token
  // instance, returned `already-loaded`, and cleared nothing.
  force = false,
  logger = null,
} = {}) {
  const log = typeof logger === "function" ? logger : () => {};
  let limits = await inspectModelLimits({ restClient, modelId });
  const desired = clampPositiveInt(desiredContextLength);
  if (!restClient || !modelId || !desired) {
    return { action: "skipped", limits, error: null };
  }
  const target = limits.maxContextLength ? Math.min(desired, limits.maxContextLength) : desired;

  if (!force && limits.loaded && (limits.loadedContextLength ?? 0) >= target) {
    return { action: "already-loaded", limits, error: null };
  }

  if (limits.loaded && !allowReload && !force) {
    log(
      `[model-limits] ${modelId} is loaded with ${limits.loadedContextLength} tokens, below the ${target} this run wants. Pass the reload flag to reload it.`,
    );
    return { action: "kept-operator-instance", limits, error: null };
  }

  try {
    if (limits.loaded && limits.instanceId) {
      log(`[model-limits] unloading ${limits.instanceId} to reload it at ${target} tokens`);
      await restClient.unloadModelV1({ instance_id: limits.instanceId });
    }
    log(`[model-limits] loading ${modelId} with context_length=${target}`);
    await restClient.loadModelV1({ model: modelId, context_length: target });
    limits = await inspectModelLimits({ restClient, modelId });
    return { action: limits.loaded ? "loaded" : "load-unconfirmed", limits, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[model-limits] load failed, continuing with the existing instance: ${message}`);
    limits = await inspectModelLimits({ restClient, modelId });
    return { action: "load-failed", limits, error: message };
  }
}

/**
 * The wall-clock ceiling a single completion must finish inside.
 *
 * Measured on the reference host 2026-08-10: every request that ran past
 * ~305 seconds failed with `400 Engine protocol predict request failed: fetch
 * failed` — LM Studio's own API-server-to-engine call gives out at 300s, and no
 * client-side timeout can change that. Six benchmark attempts failed at exactly
 * 305.6s while every attempt under 300s succeeded. So a request is not just
 * bounded by the context window; it is bounded by *time*, and on a slow local
 * model that is the tighter of the two by an order of magnitude.
 */
export const MAX_REQUEST_SECONDS = 240;

/** Conservative default for an unmeasured local model. */
export const DEFAULT_TOKENS_PER_SECOND = 7;

/**
 * Sizes one request's `max_tokens` to everything the loaded window has left.
 *
 * `max_tokens: -1` (MiniPhi's old default) means "the rest of the window", which
 * is right in principle and wrong in practice on a slow local model: one turn
 * then generates for an hour inside a single HTTP request. A fixed 4000 is the
 * opposite mistake — it truncated whole-file writes against a 27B model that had
 * far more room. This computes the real headroom and then applies the caller's
 * pacing cap, so the cap is a deliberate choice measured against what was
 * actually available rather than a number standing in for it.
 *
 * @param {{
 *   contextLength: number|null,
 *   promptTokens: number,
 *   hardCap?: number|null,
 *   minTokens?: number,
 *   safetyTokens?: number,
 *   tokensPerSecond?: number|null,  measured throughput; enables the time cap
 *   maxSeconds?: number,            wall-clock ceiling for one request
 * }} options
 * @returns {{maxTokens:number, headroom:number, capped:boolean, contextLength:number, timeCap:number|null, limitedBy:string}}
 */
export function planOutputTokens({
  contextLength,
  promptTokens,
  hardCap = null,
  minTokens = 256,
  safetyTokens = SAFETY_TOKENS,
  tokensPerSecond = null,
  maxSeconds = MAX_REQUEST_SECONDS,
} = {}) {
  const window = clampPositiveInt(contextLength, COLD_JIT_CONTEXT_LENGTH);
  const used = Math.max(0, Math.floor(Number(promptTokens) || 0));
  const headroom = Math.max(minTokens, window - used - safetyTokens);
  const cap = clampPositiveInt(hardCap);
  // The time cap is not a nicety on a slow host: a request that would take
  // longer than the server's engine ceiling does not return a truncated answer,
  // it returns a 400 and the turn is lost entirely.
  const rate = Number(tokensPerSecond);
  const timeCap =
    Number.isFinite(rate) && rate > 0 && Number.isFinite(maxSeconds) && maxSeconds > 0
      ? Math.max(minTokens, Math.floor(rate * maxSeconds))
      : null;

  let maxTokens = headroom;
  let limitedBy = "context";
  if (cap && cap < maxTokens) {
    maxTokens = cap;
    limitedBy = "pacing-cap";
  }
  if (timeCap !== null && timeCap < maxTokens) {
    maxTokens = timeCap;
    limitedBy = "request-time";
  }
  return {
    maxTokens: Math.max(minTokens, maxTokens),
    headroom,
    capped: Boolean(cap && cap < headroom),
    contextLength: window,
    timeCap,
    limitedBy,
  };
}

export default { inspectModelLimits, ensureModelLoaded, planOutputTokens };
