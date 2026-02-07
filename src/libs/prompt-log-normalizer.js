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

