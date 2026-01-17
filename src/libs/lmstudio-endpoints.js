import { normalizeLmStudioHttpUrl, normalizeLmStudioWsUrl } from "./lmstudio-api.js";
import { isLocalLmStudioBaseUrl, resolveLmStudioHttpBaseUrl } from "./core-utils.js";

function resolveWsBaseUrl(configData, restBaseUrl) {
  const explicit =
    configData?.lmStudio?.clientOptions?.baseUrl ??
    configData?.lmStudio?.ws?.baseUrl ??
    null;
  const candidate = explicit ?? restBaseUrl ?? null;
  return normalizeLmStudioWsUrl(candidate ?? undefined);
}

export function resolveLmStudioEndpoints(configData, env = process.env) {
  const restBaseUrl = resolveLmStudioHttpBaseUrl(configData, env);
  const wsBaseUrl = resolveWsBaseUrl(configData, restBaseUrl);
  const normalizedRestBaseUrl =
    restBaseUrl ?? (wsBaseUrl ? normalizeLmStudioHttpUrl(wsBaseUrl) : null);
  const isLocal = isLocalLmStudioBaseUrl(normalizedRestBaseUrl ?? wsBaseUrl ?? null);
  return {
    restBaseUrl: normalizedRestBaseUrl,
    wsBaseUrl,
    isLocal,
  };
}
