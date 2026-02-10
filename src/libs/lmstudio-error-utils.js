const PROTOCOL_PATTERNS = [
  /channel.*unknown.*send/i,
  /communication warning/i,
  /protocol.*incompat/i,
];

const TIMEOUT_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /prompt session exceeded/i,
  /no .* tokens emitted/i,
];

const STREAM_HANG_PATTERNS = [
  /tokens emitted/i,
  /prompt session exceeded/i,
  /stream.*timeout/i,
];

const CONTEXT_OVERFLOW_PATTERNS = [
  /context length/i,
  /context.*overflow/i,
  /maximum context/i,
];

const INVALID_RESPONSE_PATTERNS = [
  /schema validation/i,
  /not valid json/i,
  /no valid json/i,
  /invalid response/i,
  /json parse/i,
  /empty response/i,
  /response body was empty/i,
  /returned an empty/i,
];

const CONNECTION_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /ETIMEDOUT/i,
  /connect.*timeout/i,
  /socket hang up/i,
];

const NETWORK_PATTERNS = [/network/i];
const SESSION_TIMEOUT_PATTERNS = [/session[- ]timeout/i, /session deadline exceeded/i];
const STOP_REASON_LABELS = new Map([
  ["rest-failure", "REST failure"],
  ["connection", "Connection error"],
  ["timeout", "Timeout"],
  ["network", "Network error"],
  ["invalid-response", "Invalid response"],
  ["protocol", "Protocol error"],
  ["context-overflow", "Context overflow"],
  ["session-timeout", "Session timeout"],
  ["analysis-error", "Analysis error"],
  ["cached-fallback", "Cached fallback"],
  ["preamble_detected", "Preamble detected"],
  ["preamble-detected", "Preamble detected"],
]);

const STOP_REASON_ALIASES = new Map([
  ["rest failure", "rest-failure"],
  ["connection error", "connection"],
  ["network error", "network"],
  ["invalid response", "invalid-response"],
  ["invalid-json", "invalid-response"],
  ["protocol warning", "protocol"],
  ["protocol-error", "protocol"],
  ["context overflow", "context-overflow"],
  ["session timeout", "session-timeout"],
  ["analysis error", "analysis-error"],
  ["cached fallback", "cached-fallback"],
  ["fallback", "analysis-error"],
  ["partial-fallback", "analysis-error"],
  ["offline-fallback", "analysis-error"],
  ["error", "analysis-error"],
  ["unknown", "analysis-error"],
  ["unknown-error", "analysis-error"],
  ["command-denied", "analysis-error"],
  ["command-failed", "analysis-error"],
  ["cancelled", "analysis-error"],
  ["canceled", "analysis-error"],
  ["no-token-timeout", "timeout"],
  ["lmstudio-health", "rest-failure"],
  ["lmstudio-protocol", "protocol"],
  ["preamble detected", "preamble_detected"],
  ["preamble-detected", "preamble_detected"],
]);
const STOP_REASON_SUCCESS_TOKENS = new Set([
  "completed",
  "complete",
  "ok",
  "success",
  "none",
  "null",
]);

function matchesAny(patterns, value) {
  if (!value) {
    return false;
  }
  return patterns.some((pattern) => pattern.test(value));
}

export function normalizeLmStudioErrorMessage(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

export function normalizeStopReasonCode(value) {
  if (!value && value !== 0) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const compact = normalized.replace(/[_\s]+/g, "-");
  if (STOP_REASON_SUCCESS_TOKENS.has(compact)) {
    return null;
  }
  const mapped =
    STOP_REASON_ALIASES.get(normalized) ?? STOP_REASON_ALIASES.get(compact) ?? compact;
  if (STOP_REASON_SUCCESS_TOKENS.has(mapped)) {
    return null;
  }
  return STOP_REASON_LABELS.has(mapped) ? mapped : "analysis-error";
}

export function getLmStudioStopReasonLabel(value) {
  const normalized = normalizeStopReasonCode(value);
  if (!normalized) {
    return null;
  }
  return STOP_REASON_LABELS.get(normalized) ?? normalized;
}

export function isSessionTimeoutMessage(error) {
  const message = normalizeLmStudioErrorMessage(error);
  return matchesAny(SESSION_TIMEOUT_PATTERNS, message);
}

export function classifyLmStudioError(error) {
  const message = normalizeLmStudioErrorMessage(error);
  const isProtocol = matchesAny(PROTOCOL_PATTERNS, message);
  const isConnection = matchesAny(CONNECTION_PATTERNS, message);
  const isTimeout = !isConnection && matchesAny(TIMEOUT_PATTERNS, message);
  const isStreamingHang = matchesAny(STREAM_HANG_PATTERNS, message);
  const isContextOverflow = matchesAny(CONTEXT_OVERFLOW_PATTERNS, message);
  const isInvalidResponse = matchesAny(INVALID_RESPONSE_PATTERNS, message);
  const isNetwork = matchesAny(NETWORK_PATTERNS, message);

  let code = "rest-failure";
  if (isConnection) {
    code = "connection";
  } else if (isTimeout) {
    code = "timeout";
  } else if (isNetwork) {
    code = "network";
  } else if (isInvalidResponse) {
    code = "invalid-response";
  } else if (isProtocol) {
    code = "protocol";
  } else if (isContextOverflow) {
    code = "context-overflow";
  }
  const reason = code;
  const reasonLabel = getLmStudioStopReasonLabel(code) ?? "REST failure";

  return {
    message,
    code,
    reason,
    reasonLabel,
    isTimeout,
    isConnection,
    isNetwork,
    isInvalidResponse,
    isProtocol,
    isContextOverflow,
    isStreamingHang,
    shouldDisable: isTimeout || isConnection || isNetwork,
  };
}

export function buildStopReasonInfo(options = {}) {
  const message = normalizeLmStudioErrorMessage(options.error);
  const messageText =
    typeof message === "string" && message.trim().length > 0 ? message.trim() : null;
  const sessionTimeout = isSessionTimeoutMessage(messageText);
  const classified = messageText ? classifyLmStudioError(messageText) : null;
  const normalizedFallbackReason = normalizeStopReasonCode(options.fallbackReason);
  const normalizedFallbackCode = normalizeStopReasonCode(options.fallbackCode);
  const reason =
    normalizedFallbackReason ??
    (sessionTimeout ? "session-timeout" : classified?.reason) ??
    normalizeStopReasonCode(messageText);
  const code =
    normalizedFallbackCode ??
    normalizedFallbackReason ??
    (sessionTimeout ? "session-timeout" : classified?.code) ??
    normalizeStopReasonCode(reason) ??
    null;
  const canonicalCode =
    reason && code && reason !== code ? normalizeStopReasonCode(reason) ?? code : code;
  const reasonLabel =
    options.fallbackReasonLabel ??
    getLmStudioStopReasonLabel(canonicalCode ?? reason) ??
    classified?.reasonLabel ??
    null;
  const fallbackDetailText =
    typeof options.fallbackDetail === "string" && options.fallbackDetail.trim().length > 0
      ? options.fallbackDetail.trim()
      : null;
  const fallbackDetailCode = normalizeStopReasonCode(fallbackDetailText);
  const detailReasonCode = normalizeStopReasonCode(canonicalCode ?? reason);
  const fallbackDetailIsPlaceholder = Boolean(
    fallbackDetailText &&
      fallbackDetailCode &&
      (fallbackDetailCode === detailReasonCode ||
        fallbackDetailCode === normalizeStopReasonCode(normalizedFallbackReason) ||
        fallbackDetailCode === normalizeStopReasonCode(normalizedFallbackCode) ||
        fallbackDetailCode === "analysis-error"),
  );
  const detail =
    (fallbackDetailIsPlaceholder ? null : fallbackDetailText) ??
    (sessionTimeout ? messageText || "session-timeout" : classified?.message ?? messageText) ??
    null;
  return {
    reason,
    code: canonicalCode,
    reasonLabel,
    detail,
    classified,
    message: messageText,
    sessionTimeout,
  };
}

export function isContextOverflowError(error) {
  return classifyLmStudioError(error).isContextOverflow;
}

export function isProtocolWarningError(error) {
  return classifyLmStudioError(error).isProtocol;
}

export function isStreamingHangError(error) {
  return classifyLmStudioError(error).isStreamingHang;
}
