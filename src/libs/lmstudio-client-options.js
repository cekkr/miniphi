import { normalizeLmStudioHttpUrl } from "./lmstudio-api.js";

function buildRestClientOptions(configData, modelSelection = undefined) {
  const overrides = configData?.lmStudio?.rest ?? configData?.rest ?? null;
  const options = overrides && typeof overrides === "object" ? { ...overrides } : {};
  const explicitBase =
    typeof options.baseUrl === "string" && options.baseUrl.trim().length
      ? options.baseUrl
      : null;
  const candidateBase = explicitBase ?? configData?.lmStudio?.clientOptions?.baseUrl ?? null;
  if (candidateBase) {
    options.baseUrl = normalizeLmStudioHttpUrl(candidateBase);
  }
  if (typeof options.timeoutMs === "undefined") {
    const promptTimeoutSeconds =
      configData?.lmStudio?.prompt?.timeoutSeconds ??
      configData?.prompt?.timeoutSeconds ??
      null;
    const promptTimeoutMs = Number(promptTimeoutSeconds) * 1000;
    if (Number.isFinite(promptTimeoutMs) && promptTimeoutMs > 0) {
      options.timeoutMs = Math.floor(promptTimeoutMs);
    }
  }
  if (modelSelection?.modelKey) {
    options.defaultModel = modelSelection.modelKey;
  }
  if (Number.isFinite(modelSelection?.contextLength)) {
    options.defaultContextLength = modelSelection.contextLength;
  }
  return Object.keys(options).length ? options : undefined;
}

export { buildRestClientOptions };
