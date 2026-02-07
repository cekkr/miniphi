import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import { resolveDurationMs } from "../libs/cli-utils.js";
import { buildRestClientOptions } from "../libs/lmstudio-client-options.js";
import { LMStudioRestClient } from "../libs/lmstudio-api.js";
import { buildStopReasonInfo } from "../libs/lmstudio-error-utils.js";

function extractStatusPayload(status) {
  if (!status || typeof status !== "object") {
    return null;
  }
  return status.status ?? status;
}

function extractModel(status) {
  const payload = extractStatusPayload(status);
  return (
    payload?.loaded_model ??
    payload?.model ??
    payload?.model_key ??
    payload?.modelKey ??
    payload?.defaultModel ??
    null
  );
}

export function extractContextLength(status) {
  const payload = extractStatusPayload(status);
  return (
    payload?.context_length ??
    payload?.contextLength ??
    payload?.context_length_limit ??
    payload?.context_length_max ??
    null
  );
}

function extractGpu(status) {
  const payload = extractStatusPayload(status);
  return payload?.gpu ?? payload?.device ?? payload?.hardware ?? null;
}

function countModels(payload) {
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

function isStatusEndpointUnsupported(status) {
  const error = status?.error ?? status?.status?.error ?? null;
  return typeof error === "string" && /unexpected endpoint/i.test(error);
}

export async function probeLmStudioHealth({
  configData,
  modelSelection,
  restBaseUrl,
  timeoutMs,
  restClient: providedClient = null,
}) {
  const overrides = {};
  if (restBaseUrl) {
    overrides.baseUrl = restBaseUrl;
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    overrides.timeoutMs = timeoutMs;
  }
  const restOptions = buildRestClientOptions(configData, modelSelection, overrides);
  const restClient = providedClient ?? new LMStudioRestClient(restOptions);

  let status = null;
  let ok = false;
  let warning = null;
  let error = null;
  let stopInfo = null;
  let modelsFallback = null;

  try {
    status = await restClient.getStatus();
    if (status?.ok === false && isStatusEndpointUnsupported(status)) {
      warning = status.error ?? "Status endpoint unsupported";
      try {
        modelsFallback = await restClient.listModels();
        ok = true;
      } catch (modelError) {
        error = modelError;
      }
    } else if (status?.ok === false) {
      try {
        modelsFallback = await restClient.listModels();
        ok = true;
        warning = status?.error ?? "Status endpoint unavailable; /models succeeded.";
      } catch (modelError) {
        error = modelError;
      }
    } else {
      ok = true;
    }
  } catch (caught) {
    error = caught;
  }

  if (error) {
    stopInfo = buildStopReasonInfo({ error });
  }

  const snapshot = {
    status: status ?? (error ? { ok: false, error: error instanceof Error ? error.message : String(error) } : null),
    baseUrl: restClient.baseUrl ?? restBaseUrl ?? null,
    transport: "rest",
    stopReason: stopInfo?.reason ?? (ok ? null : "lmstudio-health"),
    stopReasonCode: stopInfo?.code ?? null,
    stopReasonDetail: stopInfo?.detail ?? null,
    error: error ? (error instanceof Error ? error.message : String(error)) : null,
    warning,
    modelsFallback,
  };

  return {
    ok,
    status,
    warning,
    error,
    stopInfo,
    modelsFallback,
    restClient,
    snapshot,
  };
}

export async function handleLmStudioHealthCommand({
  options,
  verbose,
  configData,
  modelSelection,
  restBaseUrl,
}) {
  const timeoutMs =
    resolveDurationMs({
      secondsValue: options.timeout ?? options["timeout-seconds"],
      secondsLabel: "--timeout",
      millisValue: options["timeout-ms"],
      millisLabel: "--timeout-ms",
    }) ??
    (Number.isFinite(configData?.lmStudio?.health?.timeoutMs)
      ? configData.lmStudio.health.timeoutMs
      : undefined);
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const memory = new MiniPhiMemory(cwd);
  await memory.prepare();
  const shouldSave = !options["no-save"];
  const label = typeof options.label === "string" && options.label.trim() ? options.label.trim() : null;

  const health = await probeLmStudioHealth({
    configData,
    modelSelection,
    restBaseUrl,
    timeoutMs,
  });

  let record = null;
  if (shouldSave) {
    record = await memory.recordLmStudioStatus(health.snapshot, { label: label ?? "health-check" });
  }

  const model = extractModel(health.status);
  const contextLength = extractContextLength(health.status);
  const gpu = extractGpu(health.status);
  const modelCount = countModels(health.modelsFallback);
  const jsonOutput = Boolean(options.json);

  if (health.ok) {
    const baseLabel = health.snapshot.baseUrl ?? "unknown";
    const statusBits = [
      model ? `model=${model}` : null,
      contextLength ? `ctx=${contextLength}` : null,
      gpu ? `gpu=${gpu}` : null,
      Number.isFinite(modelCount) ? `models=${modelCount}` : null,
    ].filter(Boolean);
    const statusLine = statusBits.length ? ` (${statusBits.join(" | ")})` : "";
    if (!jsonOutput) {
      console.log(`[MiniPhi][Health] LM Studio REST OK: ${baseLabel}${statusLine}`);
      if (health.warning) {
        console.warn(`[MiniPhi][Health] Warning: ${health.warning}`);
      }
    }
  } else {
    const reason = health.stopInfo?.reason ?? "lmstudio-health";
    const detail = health.stopInfo?.detail ?? health.snapshot.error ?? "Unknown error";
    if (!jsonOutput) {
      console.error(`[MiniPhi][Health] LM Studio REST failed (${reason}): ${detail}`);
    }
    process.exitCode = 1;
  }

  if (record?.path && verbose) {
    const rel = path.relative(process.cwd(), record.path) || record.path;
    console.log(`[MiniPhi][Health] Snapshot saved to ${rel}`);
  }

  if (jsonOutput) {
    const payload = {
      ok: health.ok,
      base_url: health.snapshot.baseUrl ?? null,
      transport: health.snapshot.transport ?? "rest",
      model: model ?? null,
      context_length: contextLength ?? null,
      gpu: gpu ?? null,
      model_count: Number.isFinite(modelCount) ? modelCount : null,
      warning: health.warning ?? null,
      stop_reason: health.stopInfo?.reason ?? (health.ok ? null : "lmstudio-health"),
      stop_reason_code: health.stopInfo?.code ?? null,
      stop_reason_detail: health.stopInfo?.detail ?? null,
      error: health.snapshot.error ?? null,
      recorded_at: record?.entry?.recordedAt ?? null,
      snapshot_path: record?.path ?? null,
    };
    console.log(JSON.stringify(payload, null, 2));
  }
}
