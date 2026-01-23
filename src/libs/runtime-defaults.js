const MIN_LMSTUDIO_REQUEST_TIMEOUT_MS = 300000;
const DEFAULT_PROMPT_TIMEOUT_MS = MIN_LMSTUDIO_REQUEST_TIMEOUT_MS;
const DEFAULT_NO_TOKEN_TIMEOUT_MS = MIN_LMSTUDIO_REQUEST_TIMEOUT_MS;
const RECOMPOSE_AUTO_STATUS_TIMEOUT_MS = 2500;

function normalizeLmStudioRequestTimeoutMs(
  value,
  fallback = MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
  minOverride = MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
) {
  const numeric = Number(value);
  const resolved = Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  const minValue = Number.isFinite(minOverride) && minOverride > 0
    ? minOverride
    : MIN_LMSTUDIO_REQUEST_TIMEOUT_MS;
  return Math.max(resolved, minValue);
}

export {
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_NO_TOKEN_TIMEOUT_MS,
  MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
  normalizeLmStudioRequestTimeoutMs,
  RECOMPOSE_AUTO_STATUS_TIMEOUT_MS,
};
