import { buildStopReasonInfo } from "./lmstudio-error-utils.js";

function selectArrayValue(...candidates) {
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

export function normalizeToolMetadataPayload(payload = undefined) {
  if (!payload || typeof payload !== "object") {
    return {
      tool_calls: null,
      tool_definitions: null,
    };
  }
  return {
    tool_calls: selectArrayValue(payload.tool_calls, payload.toolCalls),
    tool_definitions: selectArrayValue(payload.tool_definitions, payload.toolDefinitions),
  };
}

function normalizeStopReasonPayload(payload = undefined) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const rawReason = payload.stop_reason ?? payload.stopReason ?? null;
  const rawCode = payload.stop_reason_code ?? payload.stopReasonCode ?? null;
  const rawDetail = payload.stop_reason_detail ?? payload.stopReasonDetail ?? null;
  if (!rawReason && !rawCode && !rawDetail) {
    delete payload.stopReason;
    delete payload.stopReasonCode;
    delete payload.stopReasonDetail;
    return payload;
  }
  const stopInfo = buildStopReasonInfo({
    error: rawDetail,
    fallbackReason: rawReason,
    fallbackCode: rawCode,
    fallbackDetail: rawDetail,
  });
  payload.stop_reason = stopInfo.reason ?? null;
  payload.stop_reason_code = stopInfo.code ?? null;
  payload.stop_reason_detail = stopInfo.detail ?? null;
  delete payload.stopReason;
  delete payload.stopReasonCode;
  delete payload.stopReasonDetail;
  return payload;
}

export function normalizePromptErrorPayload(error = undefined) {
  if (error === null || error === undefined) {
    return null;
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed) {
      return null;
    }
    const stopInfo = buildStopReasonInfo({
      error: trimmed,
      fallbackDetail: trimmed,
    });
    return {
      message: trimmed,
      reason: stopInfo.reason ?? null,
      code: stopInfo.code ?? null,
      reasonLabel: stopInfo.reasonLabel ?? null,
      stop_reason: stopInfo.reason ?? null,
      stop_reason_code: stopInfo.code ?? null,
      stop_reason_detail: stopInfo.detail ?? null,
    };
  }
  if (typeof error !== "object" || Array.isArray(error)) {
    return {
      message: String(error),
    };
  }
  const normalized = { ...error };
  const rawReason = normalized.stop_reason ?? normalized.stopReason ?? normalized.reason ?? null;
  const rawCode = normalized.stop_reason_code ?? normalized.stopReasonCode ?? normalized.code ?? null;
  const rawDetail =
    normalized.stop_reason_detail ??
    normalized.stopReasonDetail ??
    normalized.message ??
    null;
  const stopInfo = buildStopReasonInfo({
    error: rawDetail,
    fallbackReason: rawReason,
    fallbackCode: rawCode,
    fallbackDetail: rawDetail,
  });
  normalized.reason = stopInfo.reason ?? null;
  normalized.code = stopInfo.code ?? null;
  normalized.reasonLabel = stopInfo.reasonLabel ?? normalized.reasonLabel ?? null;
  normalized.stop_reason = stopInfo.reason ?? null;
  normalized.stop_reason_code = stopInfo.code ?? null;
  normalized.stop_reason_detail = stopInfo.detail ?? null;
  delete normalized.stopReason;
  delete normalized.stopReasonCode;
  delete normalized.stopReasonDetail;
  return normalized;
}

export function normalizePromptRequestPayload(request = undefined) {
  if (!request || typeof request !== "object") {
    return request;
  }
  const normalized = { ...request };
  if (normalized.responseFormat && !normalized.response_format) {
    normalized.response_format = normalized.responseFormat;
  }
  if (normalized.response_format && normalized.responseFormat) {
    delete normalized.responseFormat;
  }
  if (typeof normalized.promptText === "string" && Array.isArray(normalized.messages)) {
    const last = normalized.messages[normalized.messages.length - 1];
    if (last?.role === "user" && typeof last.content === "string") {
      const promptText = normalized.promptText.trim();
      const lastText = last.content.trim();
      if (promptText && promptText === lastText) {
        delete normalized.promptText;
      }
    }
  }
  const toolMetadata = normalizeToolMetadataPayload(normalized);
  normalized.tool_definitions = toolMetadata.tool_definitions;
  delete normalized.toolDefinitions;
  if (!normalized.tool_definitions) {
    delete normalized.tool_definitions;
  }
  return normalized;
}

export function normalizePromptResponsePayload(response = undefined) {
  if (!response || typeof response !== "object") {
    return response;
  }
  const normalized = { ...response };
  const toolMetadata = normalizeToolMetadataPayload(normalized);
  normalized.tool_calls = toolMetadata.tool_calls;
  normalized.tool_definitions = toolMetadata.tool_definitions;
  delete normalized.toolCalls;
  delete normalized.toolDefinitions;

  const raw =
    typeof normalized.rawResponseText === "string" ? normalized.rawResponseText : null;
  const text = typeof normalized.text === "string" ? normalized.text : null;
  if (!raw && text) {
    normalized.rawResponseText = text;
  }
  if (normalized.rawResponseText && text && normalized.rawResponseText === text) {
    delete normalized.text;
  }

  if (
    normalized.schemaId &&
    (!normalized.schemaValidation ||
      typeof normalized.schemaValidation.valid !== "boolean")
  ) {
    normalized.schemaValidation = {
      valid: false,
      errors: Array.isArray(normalized.schemaValidation?.errors)
        ? normalized.schemaValidation.errors
        : ["Schema validation missing."],
    };
  }
  normalizeStopReasonPayload(normalized);
  if (!normalized.tool_calls) {
    delete normalized.tool_calls;
  }
  if (!normalized.tool_definitions) {
    delete normalized.tool_definitions;
  }
  return normalized;
}

export function normalizeJournalResponseValue(response = undefined) {
  if (response === null || response === undefined) {
    return null;
  }
  if (typeof response === "string") {
    return response;
  }
  if (typeof response === "object") {
    return JSON.stringify(normalizePromptResponsePayload(response), null, 2);
  }
  return String(response);
}
