function normalizeTransport(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return null;
  }
  if (normalized === "rest" || normalized === "ws" || normalized === "websocket") {
    return normalized === "websocket" ? "ws" : normalized;
  }
  return null;
}

function resolveLmStudioTransportPreference(configData, env = process.env) {
  const raw =
    configData?.lmStudio?.transport ??
    configData?.lmStudio?.protocol ??
    configData?.lmStudio?.mode ??
    null;
  const mode = normalizeTransport(raw);
  const forceRestEnv = env?.MINIPHI_FORCE_REST === "1";
  const preferRestFlag =
    typeof configData?.lmStudio?.preferRest === "boolean"
      ? configData.lmStudio.preferRest
      : typeof configData?.lmStudio?.preferRestTransport === "boolean"
        ? configData.lmStudio.preferRestTransport
        : null;
  let preferRest = preferRestFlag === true;
  if (mode === "rest") {
    preferRest = true;
  } else if (mode === "ws") {
    preferRest = false;
  }
  if (forceRestEnv) {
    preferRest = true;
  }
  const forceRest = forceRestEnv || mode === "rest";
  const reason = forceRestEnv
    ? "MINIPHI_FORCE_REST=1"
    : mode === "rest"
      ? "config.lmStudio.transport=rest"
      : null;
  return {
    mode,
    preferRest,
    forceRest,
    reason,
  };
}

export { resolveLmStudioTransportPreference };
