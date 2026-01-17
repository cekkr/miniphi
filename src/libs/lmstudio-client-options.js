import { normalizeLmStudioHttpUrl } from "./lmstudio-api.js";
import { normalizeLmStudioRequestTimeoutMs } from "./runtime-defaults.js";

function buildRestClientOptions(configData, modelSelection = undefined, overrides = undefined) {
  const configOverrides = configData?.lmStudio?.rest ?? configData?.rest ?? null;
  const options =
    configOverrides && typeof configOverrides === "object" ? { ...configOverrides } : {};
  if (overrides && typeof overrides === "object") {
    Object.assign(options, overrides);
  }
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
  if (typeof options.timeoutMs !== "undefined") {
    options.timeoutMs = normalizeLmStudioRequestTimeoutMs(options.timeoutMs);
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
