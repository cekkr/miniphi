const MIN_LMSTUDIO_REQUEST_TIMEOUT_MS = 600000;
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

function resolveSessionCappedTimeoutMs(options = undefined) {
  const baseTimeoutMs = Number(options?.baseTimeoutMs);
  const minTimeoutMs =
    Number.isFinite(options?.minTimeoutMs) && options.minTimeoutMs > 0
      ? Math.floor(options.minTimeoutMs)
      : 1000;
  const rawSessionDeadline = Number(options?.sessionDeadline);
  const hasSessionDeadline = Number.isFinite(rawSessionDeadline) && rawSessionDeadline > 0;
  if (!hasSessionDeadline) {
    return Number.isFinite(baseTimeoutMs) && baseTimeoutMs > 0 ? baseTimeoutMs : null;
  }
  const sessionDeadline = rawSessionDeadline;
  const remaining = sessionDeadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error("session-timeout: session deadline exceeded.");
  }
  const budgetRatio =
    Number.isFinite(options?.budgetRatio) && options.budgetRatio > 0
      ? options.budgetRatio
      : 0.4;
  const capMs =
    Number.isFinite(options?.capMs) && options.capMs > 0
      ? Math.floor(options.capMs)
      : Math.floor(remaining);
  const sessionCap = Math.min(
    Math.max(minTimeoutMs, Math.floor(remaining * budgetRatio)),
    capMs,
    remaining,
  );
  if (Number.isFinite(baseTimeoutMs) && baseTimeoutMs > 0) {
    return Math.min(baseTimeoutMs, sessionCap);
  }
  return sessionCap;
}

export {
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_NO_TOKEN_TIMEOUT_MS,
  MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
  normalizeLmStudioRequestTimeoutMs,
  resolveSessionCappedTimeoutMs,
  RECOMPOSE_AUTO_STATUS_TIMEOUT_MS,
};
