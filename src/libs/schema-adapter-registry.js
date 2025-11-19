export default class SchemaAdapterRegistry {
  constructor(options = undefined) {
    this.adapters = new Map();
    if (Array.isArray(options?.adapters)) {
      for (const adapter of options.adapters) {
        this.registerAdapter(adapter);
      }
    }
  }

  #buildKey(type, version) {
    const normalizedType = (type ?? "default").toString().toLowerCase();
    const normalizedVersion = (version ?? "default").toString().toLowerCase();
    return `${normalizedType}:${normalizedVersion}`;
  }

  registerAdapter(definition) {
    if (!definition?.type || !definition?.version) {
      throw new Error("SchemaAdapterRegistry.registerAdapter expects type and version.");
    }
    const key = this.#buildKey(definition.type, definition.version);
    this.adapters.set(key, {
      normalizeResponse:
        typeof definition.normalizeResponse === "function" ? definition.normalizeResponse : null,
      normalizeRequest:
        typeof definition.normalizeRequest === "function" ? definition.normalizeRequest : null,
    });
  }

  normalizeResponse(type, version, payload) {
    if (!payload) {
      return payload;
    }
    const key = this.#buildKey(type, version);
    const adapter = this.adapters.get(key);
    if (!adapter?.normalizeResponse) {
      return payload;
    }
    try {
      return adapter.normalizeResponse(payload);
    } catch (error) {
      console.warn(
        `[SchemaAdapterRegistry] Failed to normalize schema ${type}@${version}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return payload;
    }
  }
}
