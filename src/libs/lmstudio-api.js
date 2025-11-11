import { LMStudioClient } from "@lmstudio/sdk";

const DEFAULT_LOAD_CONFIG = {
  contextLength: 8192,
  gpu: "auto",
  ttl: 300,
};

/**
 * Layer 1 manager that encapsulates LM Studio client interactions and
 * provides JIT model loading/unloading semantics.
 */
export class LMStudioManager {
  /**
   * @param {object} [clientOptions] - Optional options passed to LMStudioClient.
   */
  constructor(clientOptions = undefined) {
    this.client = new LMStudioClient(clientOptions);
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
      console.warn(
        `Model ${modelKey} was not cached by LMStudioManager; assuming it is already unloaded.`,
      );
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

    return Object.entries(requested).every(([key, value]) => cached[key] === value);
  }
}

export default LMStudioManager;
