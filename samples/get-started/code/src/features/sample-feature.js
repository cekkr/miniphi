const DEFAULT_FLAGS = Object.freeze({
  mode: "passive",
  emitTelemetry: false,
});

export function createFeatureConfig(overrides = undefined) {
  return {
    ...DEFAULT_FLAGS,
    ...(overrides ?? {}),
  };
}

export function renderFeatureMessage(config, envReport) {
  const flag = config.mode === "interactive" ? "interactive" : "passive";
  const telemetry = config.emitTelemetry ? "enabled" : "disabled";
  const toolSummary = envReport.tools
    .map((tool) => `${tool.name}:${tool.available ? "ok" : "missing"}`)
    .join(", ");

  return [
    `Feature mode: ${flag}`,
    `Telemetry: ${telemetry}`,
    `Tools: ${toolSummary}`,
  ].join(" | ");
}

export function runFeature(envReport, overrides = undefined) {
  const config = createFeatureConfig(overrides);
  const message = renderFeatureMessage(config, envReport);
  const timestamp = new Date().toISOString();
  return {
    config,
    message,
    timestamp,
  };
}
