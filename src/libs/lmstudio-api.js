import { LMStudioClient } from "@lmstudio/sdk";
import { createRequire } from "module";
import { DEFAULT_MODEL_KEY } from "./model-presets.js";
import { buildStopReasonInfo, classifyLmStudioError } from "./lmstudio-error-utils.js";
import {
  MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
  normalizeLmStudioRequestTimeoutMs,
} from "./runtime-defaults.js";

const DEFAULT_CONTEXT_LENGTH = 16384;
const DEFAULT_LOAD_CONFIG = {
  contextLength: DEFAULT_CONTEXT_LENGTH,
  gpu: "auto",
  ttl: 300,
};
const DEFAULT_LMSTUDIO_HTTP_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_LMSTUDIO_WS_BASE_URL = "ws://127.0.0.1:1234";
const DEFAULT_REST_TIMEOUT_MS = MIN_LMSTUDIO_REQUEST_TIMEOUT_MS;
const require = createRequire(import.meta.url);
let SDK_VERSION = null;
try {
  // Reading the SDK version lets callers warn on protocol mismatches.
  const pkg = require("@lmstudio/sdk/package.json");
  SDK_VERSION = pkg?.version ?? null;
} catch {
  SDK_VERSION = null;
}

function trimTrailingSlash(url) {
  if (!url) {
    return url;
  }
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function normalizeLmStudioWsUrl(value = DEFAULT_LMSTUDIO_WS_BASE_URL) {
  if (!value || typeof value !== "string") {
    return DEFAULT_LMSTUDIO_WS_BASE_URL;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_LMSTUDIO_WS_BASE_URL;
  }
  if (/^wss?:\/\//i.test(trimmed)) {
    return trimTrailingSlash(trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const isSecure = trimmed.toLowerCase().startsWith("https://");
    const converted = trimmed.replace(/^https?:\/\//i, isSecure ? "wss://" : "ws://");
    return trimTrailingSlash(converted);
  }
  return `ws://${trimTrailingSlash(trimmed.replace(/^\/+/, ""))}`;
}

export function normalizeLmStudioHttpUrl(value = DEFAULT_LMSTUDIO_HTTP_BASE_URL) {
  if (!value || typeof value !== "string") {
    return DEFAULT_LMSTUDIO_HTTP_BASE_URL;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_LMSTUDIO_HTTP_BASE_URL;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimTrailingSlash(trimmed);
  }
  if (/^wss?:\/\//i.test(trimmed)) {
    const isSecure = trimmed.toLowerCase().startsWith("wss://");
    const converted = trimmed.replace(/^wss?:\/\//i, isSecure ? "https://" : "http://");
    return trimTrailingSlash(converted);
  }
  return `http://${trimTrailingSlash(trimmed.replace(/^\/+/, ""))}`;
}

/**
 * Layer 1 manager that encapsulates LM Studio client interactions and
 * provides JIT model loading/unloading semantics.
 */
export class LMStudioManager {
  /**
   * @param {object} [clientOptions] - Optional options passed to LMStudioClient.
   */
  constructor(clientOptions = undefined) {
    this.client = new LMStudioClient(this._normalizeClientOptions(clientOptions));
    this.loadedModels = new Map();
    this.modelConfigs = new Map();
  }

  /**
   * Exposes the installed @lmstudio/sdk version so callers can detect mismatches with the server.
   * @returns {string | null}
   */
  getSdkVersion() {
    return SDK_VERSION;
  }

  /**
   * Returns a handle to the requested model, loading it with the supplied configuration if needed.
   * Subsequent requests reuse the cached handle until it is explicitly unloaded.
   *
   * @param {string} modelKey - Identifier of the model to load (e.g. "microsoft/Phi-4-reasoning-plus").
   * @param {import("@lmstudio/sdk").LLMLoadModelConfig} [config]
   */
  async getModel(modelKey, config = undefined) {
    if (!modelKey) {
      throw new Error("modelKey is required to load a model.");
    }

    const cachedModel = this.loadedModels.get(modelKey);
    if (cachedModel) {
      const cachedConfig = this.modelConfigs.get(modelKey);
      if (!config || this._isConfigCompatible(cachedConfig, config)) {
        return cachedModel;
      }

      // Reload with the new configuration to honor the caller's explicit request.
      await this._unload(modelKey, cachedModel);
    }

    const effectiveConfig = {
      ...DEFAULT_LOAD_CONFIG,
      ...(config ?? {}),
    };

    const modelHandle = await this.client.llm.load(modelKey, effectiveConfig);
    this.loadedModels.set(modelKey, modelHandle);
    this.modelConfigs.set(modelKey, effectiveConfig);
    return modelHandle;
  }

  /**
   * Unloads a model previously loaded via this manager.
   *
   * @param {string} modelKey
   */
  async ejectModel(modelKey) {
    const model = this.loadedModels.get(modelKey);
    if (!model) {
      if (process.env.MINIPHI_DEBUG_LM === "1") {
        console.warn(
          `Model ${modelKey} was not cached by LMStudioManager; assuming it is already unloaded.`,
        );
      }
      return;
    }

    await this._unload(modelKey, model);
  }

  /**
   * Convenience helper to eject every model tracked by this manager.
   */
  async ejectAll() {
    const unloadOperations = [];
    for (const [modelKey, model] of this.loadedModels.entries()) {
      unloadOperations.push(this._unload(modelKey, model));
    }
    await Promise.allSettled(unloadOperations);
  }

  /**
   * Internal helper to unload and de-register a model.
   *
   * @param {string} modelKey
   * @param {import("@lmstudio/sdk").LLM} model
   */
  async _unload(modelKey, model) {
    try {
      await model.unload();
    } finally {
      this.loadedModels.delete(modelKey);
      this.modelConfigs.delete(modelKey);
    }
  }

  /**
   * Performs a shallow equality check across the caller-provided config and the cached one.
   * Only compares keys provided by the caller, allowing additional cached defaults to coexist.
   *
   * @param {Record<string, unknown>} cached
   * @param {Record<string, unknown>} requested
   * @returns {boolean}
   */
  _isConfigCompatible(cached, requested) {
    if (!cached) {
      return false;
    }

    return Object.entries(requested).every(([key, value]) => {
      if (value === undefined) {
        return true;
      }
      if (key === "contextLength") {
        const cachedLength = Number(cached.contextLength);
        const requestedLength = Number(value);
        if (!Number.isFinite(requestedLength)) {
          return cached.contextLength === value;
        }
        if (!Number.isFinite(cachedLength)) {
          return false;
        }
        // Allow re-use when the cached context window is already large enough.
        return cachedLength >= requestedLength;
      }
      return cached[key] === value;
    });
  }

  /**
   * @param {object} [options]
   */
  _normalizeClientOptions(options = undefined) {
    if (!options || typeof options !== "object") {
      return { baseUrl: DEFAULT_LMSTUDIO_WS_BASE_URL };
    }
    const normalized = { ...options };
    normalized.baseUrl = normalizeLmStudioWsUrl(normalized.baseUrl);
    return normalized;
  }
}

/**
 * Lightweight REST client for LM Studio's native /api/v0 endpoints.
 * Complements the SDK-based LMStudioManager with diagnostics and non-SDK workflows.
 */
export class LMStudioRestClient {
  /**
   * @param {{
   *   baseUrl?: string,
   *   apiVersion?: string,
   *   timeoutMs?: number,
   *   defaultModel?: string,
   *   fetchImpl?: typeof fetch
   * }} [options]
   */
  constructor(options = undefined) {
    this.baseUrl = trimTrailingSlash(
      normalizeLmStudioHttpUrl(
        options?.baseUrl ?? process.env.LMSTUDIO_REST_URL ?? DEFAULT_LMSTUDIO_HTTP_BASE_URL,
      ),
    );
    this.apiVersion = this._normalizeApiVersion(options?.apiVersion ?? "v0");
    const timeoutCandidate = options?.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
    this.timeoutMs = normalizeLmStudioRequestTimeoutMs(
      timeoutCandidate,
      DEFAULT_REST_TIMEOUT_MS,
    );
    this.defaultModel = options?.defaultModel ?? DEFAULT_MODEL_KEY;
    this.defaultContextLength = options?.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    this.executionRegister = options?.executionRegister ?? null;
    this.executionContext = options?.executionContext ?? null;

    if (!this.fetchImpl) {
      throw new Error(
        "Global fetch implementation not found. Provide options.fetchImpl when constructing LMStudioRestClient.",
      );
    }
  }

  /**
   * Attaches or clears the task execution register.
   * @param {import("./task-execution-register.js").default | null} register
   * @param {Record<string, any>} [context]
   */
  setExecutionRegister(register, context = undefined) {
    this.executionRegister = register ?? null;
    this.executionContext = context ?? null;
  }

  /**
   * Lists every model (downloaded + currently loaded) known by LM Studio.
   * @returns {Promise<object>}
   */
  async listModels() {
    return this._request("/models");
  }

  /**
   * Lists models via the OpenAI-compatible /v1/models endpoint (when available).
   * Useful when /api/v0/models is disabled or trimmed for compatibility.
   * @returns {Promise<object>}
   */
  async listModelsV1() {
    const url = this._buildCompatUrl("/v1/models");
    return this._execute(url, { method: "GET" });
  }

  /**
   * Retrieves the LM Studio status snapshot (model, context length, GPU).
   * @returns {Promise<object | null>}
   */
  async getStatus() {
    try {
      const payload = await this._request("/status");
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        if (typeof payload.error === "string" && !payload.ok) {
          return { ok: false, error: payload.error, status: payload };
        }
        return { ok: true, ...payload };
      }
      return { ok: true, status: payload ?? null };
    } catch (error) {
      const statusCode = typeof error?.status === "number" ? error.status : null;
      const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
      // LM Studio servers without /status return 404/"Unexpected endpoint"; treat it as informational.
      const unsupported =
        typeof message === "string" &&
        (/unexpected endpoint/i.test(message) || (statusCode && statusCode >= 400 && statusCode < 500));
      let fallback = null;
      if (!unsupported) {
        try {
          fallback = await this.listModels();
        } catch {
          // ignore fallback failures to preserve the original error context
        }
      }
      const fallbackRecovered = Boolean(fallback);
      return {
        ok: unsupported ? false : fallbackRecovered,
        statusCode,
        error: message,
        fallback,
      };
    }
  }

  /**
   * Retrieves detailed information about a single model.
   * @param {string} modelKey
   */
  async getModel(modelKey = this.defaultModel) {
    if (!modelKey) {
      throw new Error("modelKey is required to query model details.");
    }
    const encoded = encodeURIComponent(modelKey);
    return this._request(`/models/${encoded}`);
  }

  /**
   * Calls POST /chat/completions with the provided payload.
   *
   * @param {{
   *   model?: string,
   *   messages: Array<{ role: string, content: string }>,
   *   temperature?: number,
   *   max_tokens?: number,
   *   stream?: boolean,
   *   [key: string]: unknown
   * }} payload
   */
  async createChatCompletion(payload) {
    if (!payload?.messages || payload.messages.length === 0) {
      throw new Error("messages array is required for chat completions.");
    }
    const { timeoutMs, ...restPayload } = payload;
    const body = {
      stream: false,
      max_tokens: -1,
      model: restPayload.model ?? this.defaultModel,
      context_length:
        typeof restPayload.context_length === "number"
          ? restPayload.context_length
          : this.defaultContextLength,
      ...restPayload,
    };
    return this._post("/chat/completions", body, timeoutMs);
  }

  /**
   * Calls POST /completions with the provided payload.
   *
   * @param {{
   *   model?: string,
   *   prompt: string,
   *   temperature?: number,
   *   max_tokens?: number,
   *   stream?: boolean,
   *   stop?: string | string[],
   *   [key: string]: unknown
   * }} payload
   */
  async createCompletion(payload) {
    if (!payload?.prompt) {
      throw new Error("prompt is required for text completions.");
    }
    const { timeoutMs, ...restPayload } = payload;
    const body = {
      stream: false,
      max_tokens: -1,
      model: restPayload.model ?? this.defaultModel,
      context_length:
        typeof restPayload.context_length === "number"
          ? restPayload.context_length
          : this.defaultContextLength,
      ...restPayload,
    };
    return this._post("/completions", body, timeoutMs);
  }

  /**
   * Calls POST /embeddings with the provided payload.
   *
   * @param {{
   *   model?: string,
   *   input: string | string[],
   *   [key: string]: unknown
   * }} payload
   */
  async createEmbedding(payload) {
    if (payload?.input === undefined) {
      throw new Error("input is required for embeddings.");
    }
    const { timeoutMs, ...restPayload } = payload;
    const body = {
      model: restPayload.model ?? this.defaultModel,
      ...restPayload,
    };
    return this._post("/embeddings", body, timeoutMs);
  }

  /**
   * Convenience helper to update the default model + context metadata.
   * @param {string} model
   * @param {number} [contextLength]
   */
  setDefaultModel(model, contextLength = undefined) {
    if (!model) {
      throw new Error("model is required.");
    }
    this.defaultModel = model;
    this.defaultContextLength = contextLength ?? DEFAULT_CONTEXT_LENGTH;
  }

  /**
   * @param {string} path
   * @returns {Promise<object | string | null>}
   */
  async _request(path) {
    const url = this._buildUrl(path);
    return this._execute(url, { method: "GET" });
  }

  /**
   * @param {string} path
   * @param {Record<string, unknown>} body
   */
  async _post(path, body, timeoutMs = undefined) {
    const url = this._buildUrl(path);
    return this._execute(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs,
    });
  }

  /**
   * @param {string} url
   * @param {RequestInit} init
   */
  async _execute(url, init) {
    const { timeoutMs, ...restInit } = init ?? {};
    const requestedTimeout =
      typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : this.timeoutMs;
    const minOverride =
      typeof timeoutMs === "number" && timeoutMs > 0 ? 1000 : undefined;
    const effectiveTimeout = normalizeLmStudioRequestTimeoutMs(
      requestedTimeout,
      this.timeoutMs,
      minOverride,
    );
    const controller =
      typeof AbortController !== "undefined" && effectiveTimeout > 0
        ? new AbortController()
        : undefined;
    const timeoutId =
      controller && effectiveTimeout > 0
        ? setTimeout(() => controller.abort(), effectiveTimeout)
        : undefined;
    const startedAt = Date.now();
    let recorded = false;
    const requestHeaders = {
      Accept: "application/json",
      ...(restInit.headers ?? {}),
    };
    const requestSnapshot = this._buildRequestSnapshot(
      url,
      { ...restInit, headers: requestHeaders },
      effectiveTimeout,
    );

    try {
      const response = await this.fetchImpl(url, {
        ...restInit,
        headers: requestHeaders,
        signal: controller?.signal,
      });

      const raw = await response.text();
      const data = this._parseJson(raw);
      const finishedAt = Date.now();

      if (!response.ok) {
        const message = data?.error?.message ?? data?.error ?? raw ?? "Unknown error";
        const error = new Error(
          `LM Studio REST request failed (${response.status} ${response.statusText}): ${message}`,
        );
        error.status = response.status;
        error.body = data ?? raw;
        await this._recordExecutionEvent({
          type: "lmstudio.rest",
          request: requestSnapshot,
          response: {
            status: response.status,
            statusText: response.statusText,
            body: data ?? raw ?? null,
            rawText: raw ?? null,
          },
          error: { message: error.message },
          metadata: {
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
          },
        });
        recorded = true;
        throw error;
      }

      await this._recordExecutionEvent({
        type: "lmstudio.rest",
        request: requestSnapshot,
        response: {
          status: response.status,
          statusText: response.statusText,
          body: data ?? raw ?? null,
          rawText: raw ?? null,
        },
        metadata: {
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        },
      });
      recorded = true;
      return data ?? raw;
    } catch (error) {
      if (recorded) {
        throw error;
      }
      const finishedAt = Date.now();
      if (error.name === "AbortError") {
        await this._recordExecutionEvent({
          type: "lmstudio.rest",
          request: requestSnapshot,
          response: null,
          error: {
            message: `LM Studio REST request timed out waiting for a response after ${effectiveTimeout}ms (url: ${url}).`,
          },
          metadata: {
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
          },
        });
        throw new Error(
          `LM Studio REST request timed out waiting for a response after ${effectiveTimeout}ms (url: ${url}).`,
        );
      }
      await this._recordExecutionEvent({
        type: "lmstudio.rest",
        request: requestSnapshot,
        response: null,
        error: {
          message: error instanceof Error ? error.message : String(error ?? "Unknown error"),
        },
        metadata: {
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        },
      });
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  _buildRequestSnapshot(url, init, timeoutMs) {
    if (!url) {
      return null;
    }
    const headers = init?.headers ?? null;
    const body = typeof init?.body === "string" ? init.body : init?.body ?? null;
    return {
      url,
      method: init?.method ?? "GET",
      headers,
      body,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
      createdAt: new Date().toISOString(),
    };
  }

  async _recordExecutionEvent(payload) {
    if (!this.executionRegister || typeof this.executionRegister.record !== "function") {
      return;
    }
    try {
      if (payload?.error && typeof payload.error === "object") {
        const message = payload.error.message ?? null;
        if (message && !payload.error.code) {
          const classified = classifyLmStudioError(message);
          const stopInfo = buildStopReasonInfo({ error: message });
          payload.error.code = classified.code ?? null;
          payload.error.reason = classified.reason ?? null;
          payload.error.reasonLabel = classified.reasonLabel ?? stopInfo.reasonLabel ?? null;
          payload.error.stop_reason = stopInfo.reason ?? null;
          payload.error.stop_reason_code = stopInfo.code ?? null;
          payload.error.stop_reason_detail = stopInfo.detail ?? null;
          payload.error.flags = {
            timeout: classified.isTimeout,
            connection: classified.isConnection,
            network: classified.isNetwork,
            invalidResponse: classified.isInvalidResponse,
            protocol: classified.isProtocol,
            contextOverflow: classified.isContextOverflow,
            streamHang: classified.isStreamingHang,
          };
        }
      }
      const context =
        this.executionContext && typeof this.executionContext === "object"
          ? this.executionContext
          : null;
      if (context) {
        const base =
          payload?.metadata && typeof payload.metadata === "object"
            ? { ...payload.metadata }
            : {};
        base.execution = context;
        payload.metadata = base;
      }
      if (payload) {
        await this.executionRegister.record(payload);
      }
    } catch {
      // Ignore execution register failures to avoid breaking LM Studio calls.
    }
  }

  /**
   * @param {string} maybePath
   */
  _buildUrl(maybePath) {
    if (!maybePath) {
      throw new Error("Path is required.");
    }
    if (/^https?:\/\//i.test(maybePath)) {
      return maybePath;
    }

    const relativePath = maybePath.startsWith("/") ? maybePath.slice(1) : maybePath;
    return `${this.baseUrl}/api/${this.apiVersion}/${relativePath}`;
  }

  /**
   * Builds a URL without the /api/<version> prefix (for OpenAI-compatible endpoints).
   * @param {string} maybePath
   */
  _buildCompatUrl(maybePath) {
    if (!maybePath) {
      throw new Error("Path is required.");
    }
    if (/^https?:\/\//i.test(maybePath)) {
      return maybePath;
    }
    const base = trimTrailingSlash(this.baseUrl);
    const relativePath = maybePath.startsWith("/") ? maybePath : `/${maybePath}`;
    return `${base}${relativePath}`;
  }

  /**
   * @param {string} apiVersion
   */
  _normalizeApiVersion(apiVersion) {
    return apiVersion.replace(/^\/+|\/+$/g, "");
  }

  /**
   * @param {string} text
   * @returns {any}
   */
  _parseJson(text) {
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

export default LMStudioManager;
