import { LMStudioClient } from "@lmstudio/sdk";

const DEFAULT_LOAD_CONFIG = {
  contextLength: 8192,
  gpu: "auto",
  ttl: 300,
};
const DEFAULT_LMSTUDIO_HTTP_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_LMSTUDIO_WS_BASE_URL = "ws://127.0.0.1:1234";
const DEFAULT_MODEL_KEY = "microsoft/phi-4-reasoning-plus";
const DEFAULT_CONTEXT_LENGTH = 4096;
const DEFAULT_REST_TIMEOUT_MS = 30000;

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
    this.client = new LMStudioClient(this.#normalizeClientOptions(clientOptions));
    this.loadedModels = new Map();
    this.modelConfigs = new Map();
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
      if (!config || this.#isConfigCompatible(cachedConfig, config)) {
        return cachedModel;
      }

      // Reload with the new configuration to honor the caller's explicit request.
      await this.#unload(modelKey, cachedModel);
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

    await this.#unload(modelKey, model);
  }

  /**
   * Convenience helper to eject every model tracked by this manager.
   */
  async ejectAll() {
    const unloadOperations = [];
    for (const [modelKey, model] of this.loadedModels.entries()) {
      unloadOperations.push(this.#unload(modelKey, model));
    }
    await Promise.allSettled(unloadOperations);
  }

  /**
   * Internal helper to unload and de-register a model.
   *
   * @param {string} modelKey
   * @param {import("@lmstudio/sdk").LLM} model
   */
  async #unload(modelKey, model) {
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
  #isConfigCompatible(cached, requested) {
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
  #normalizeClientOptions(options = undefined) {
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
    this.apiVersion = this.#normalizeApiVersion(options?.apiVersion ?? "v0");
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
    this.defaultModel = options?.defaultModel ?? DEFAULT_MODEL_KEY;
    this.defaultContextLength = options?.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;

    if (!this.fetchImpl) {
      throw new Error(
        "Global fetch implementation not found. Provide options.fetchImpl when constructing LMStudioRestClient.",
      );
    }
  }

  /**
   * Lists every model (downloaded + currently loaded) known by LM Studio.
   * @returns {Promise<object>}
   */
  async listModels() {
    return this.#request("/models");
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
    return this.#request(`/models/${encoded}`);
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
    const body = {
      stream: false,
      max_tokens: -1,
      model: payload.model ?? this.defaultModel,
      ...payload,
    };
    return this.#post("/chat/completions", body);
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
    const body = {
      stream: false,
      max_tokens: -1,
      model: payload.model ?? this.defaultModel,
      ...payload,
    };
    return this.#post("/completions", body);
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
    const body = {
      model: payload.model ?? this.defaultModel,
      ...payload,
    };
    return this.#post("/embeddings", body);
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
  async #request(path) {
    const url = this.#buildUrl(path);
    return this.#execute(url, { method: "GET" });
  }

  /**
   * @param {string} path
   * @param {Record<string, unknown>} body
   */
  async #post(path, body) {
    const url = this.#buildUrl(path);
    return this.#execute(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * @param {string} url
   * @param {RequestInit} init
   */
  async #execute(url, init) {
    const controller =
      typeof AbortController !== "undefined" && this.timeoutMs > 0
        ? new AbortController()
        : undefined;
    const timeoutId =
      controller && this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller?.signal,
      });

      const raw = await response.text();
      const data = this.#parseJson(raw);

      if (!response.ok) {
        const message = data?.error?.message ?? data?.error ?? raw ?? "Unknown error";
        const error = new Error(
          `LM Studio REST request failed (${response.status} ${response.statusText}): ${message}`,
        );
        error.status = response.status;
        error.body = data ?? raw;
        throw error;
      }

      return data ?? raw;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          `LM Studio REST request timed out after ${this.timeoutMs}ms (url: ${url}).`,
        );
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * @param {string} maybePath
   */
  #buildUrl(maybePath) {
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
   * @param {string} apiVersion
   */
  #normalizeApiVersion(apiVersion) {
    return apiVersion.replace(/^\/+|\/+$/g, "");
  }

  /**
   * @param {string} text
   * @returns {any}
   */
  #parseJson(text) {
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
