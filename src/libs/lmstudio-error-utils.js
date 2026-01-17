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
  /invalid response/i,
  /json parse/i,
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
  let reason = "REST failure";
  if (isConnection) {
    code = "connection";
    reason = "connection error";
  } else if (isTimeout) {
    code = "timeout";
    reason = "timeout";
  } else if (isNetwork) {
    code = "network";
    reason = "network error";
  } else if (isInvalidResponse) {
    code = "invalid-response";
    reason = "invalid-response";
  } else if (isProtocol) {
    code = "protocol";
    reason = "protocol";
  } else if (isContextOverflow) {
    code = "context-overflow";
    reason = "context-overflow";
  }

  return {
    message,
    code,
    reason,
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

export function isContextOverflowError(error) {
  return classifyLmStudioError(error).isContextOverflow;
}

export function isProtocolWarningError(error) {
  return classifyLmStudioError(error).isProtocol;
}

export function isStreamingHangError(error) {
  return classifyLmStudioError(error).isStreamingHang;
}
