function extractLmStudioStatusPayload(status) {
  if (!status || typeof status !== "object") {
    return null;
  }
  return status.status ?? status;
}

function extractLmStudioModel(status) {
  const payload = extractLmStudioStatusPayload(status);
  return (
    payload?.loaded_model ??
    payload?.model ??
    payload?.model_key ??
    payload?.modelKey ??
    payload?.defaultModel ??
    null
  );
}

function extractLmStudioContextLength(status) {
  const payload = extractLmStudioStatusPayload(status);
  return (
    payload?.context_length ??
    payload?.contextLength ??
    payload?.context_length_limit ??
    payload?.context_length_max ??
    null
  );
}

function extractLmStudioGpu(status) {
  const payload = extractLmStudioStatusPayload(status);
  return payload?.gpu ?? payload?.device ?? payload?.hardware ?? null;
}

function extractLmStudioError(status) {
  if (!status || typeof status !== "object") {
    return null;
  }
  return status.error ?? status.status?.error ?? null;
}

function isLmStudioStatusEndpointUnsupported(status) {
  const error = extractLmStudioError(status);
  return typeof error === "string" && /unexpected endpoint/i.test(error);
}

function countLmStudioModels(payload) {
  if (!payload) {
    return null;
  }
  if (Array.isArray(payload)) {
    return payload.length;
  }
  if (Array.isArray(payload.data)) {
    return payload.data.length;
  }
  if (Array.isArray(payload.models)) {
    return payload.models.length;
  }
  return null;
}

export {
  countLmStudioModels,
  extractLmStudioContextLength,
  extractLmStudioError,
  extractLmStudioGpu,
  extractLmStudioModel,
  extractLmStudioStatusPayload,
  isLmStudioStatusEndpointUnsupported,
};
