import path from "path";
import LMStudioManager, { LMStudioRestClient } from "./lmstudio-api.js";
import LMStudioHandler from "./lmstudio-handler.js";
import AdaptiveLMStudioHandler from "./adaptive-lmstudio-handler.js";
import PromptPerformanceTracker from "./prompt-performance-tracker.js";
import { resolveDurationMs } from "./cli-utils.js";
import { buildRestClientOptions } from "./lmstudio-client-options.js";
import { resolveLmStudioTransportPreference } from "./lmstudio-transport.js";
import { extractLmStudioContextLength } from "./lmstudio-status-utils.js";
import {
  DEFAULT_NO_TOKEN_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  normalizeLmStudioRequestTimeoutMs,
} from "./runtime-defaults.js";

const PROMPT_SCORING_SYSTEM_PROMPT = [
  "You grade MiniPhi prompt effectiveness.",
  "Given an objective, workspace context, prompt text, and the assistant response, you must return JSON with:",
  "score (0-100), prompt_category, summary, follow_up_needed, follow_up_reason, needs_more_context, missing_snippets, tags, recommended_prompt_pattern, series_strategy.",
  "series_strategy must always be an array of short strategy strings (use [] if you have no suggestions); never return a bare string.",
  "Focus on whether the response satisfied the objective and whether another prompt is required.",
  "Return JSON only.",
].join(" ");

async function checkLmStudioCompatibility(restClient, manager, options = undefined) {
  const result = {
    ok: true,
    reason: null,
    serverVersion: null,
    statusContextLength: null,
    sdkVersion: typeof manager?.getSdkVersion === "function" ? manager.getSdkVersion() : null,
    preferRest: false,
  };
  if (!restClient) {
    return result;
  }
  let statusPayload = null;
  try {
    statusPayload = await restClient.getStatus();
    result.statusContextLength = extractLmStudioContextLength(statusPayload);
    result.serverVersion =
      statusPayload?.version ??
      statusPayload?.status?.version ??
      statusPayload?.status?.server_version ??
      statusPayload?.status?.serverVersion ??
      null;
    const statusError = statusPayload?.error ?? statusPayload?.status?.error ?? null;
    const statusUnsupported =
      typeof statusError === "string" && /unexpected endpoint/i.test(statusError);
    if (!statusPayload?.ok && !statusUnsupported) {
      result.ok = false;
      result.reason =
        statusError ??
        "LM Studio status endpoint unavailable; SDK/Server versions likely out of sync. Update LM Studio or align the SDK.";
      result.preferRest = true;
    }
  } catch (error) {
    result.ok = false;
    result.reason =
      error instanceof Error ? error.message : `LM Studio status check failed: ${String(error)}`;
    result.preferRest = true;
  }

  let modelsV0 = null;
  let modelsV1 = null;

  try {
    modelsV0 = await restClient.listModels();
  } catch (error) {
    result.ok = false;
    result.reason =
      error instanceof Error ? error.message : `LM Studio /models check failed: ${String(error)}`;
    result.preferRest = true;
  }

  if (typeof restClient.listModelsV1 === "function") {
    try {
      modelsV1 = await restClient.listModelsV1();
      if (!result.ok && modelsV1) {
        result.ok = true;
        result.reason = null;
      }
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] LM Studio /v1/models check failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  result.availableModels = {
    v0: modelsV0 ?? null,
    v1: modelsV1 ?? null,
  };

  if (!result.ok && options?.verbose) {
    const sdkLabel = result.sdkVersion ? ` (SDK ${result.sdkVersion})` : "";
    console.warn(`[MiniPhi] LM Studio compatibility warning${sdkLabel}: ${result.reason}`);
  } else if (options?.verbose && (modelsV0 || modelsV1)) {
    const sources = [];
    if (modelsV0) sources.push("/api/v0/models");
    if (modelsV1) sources.push("/v1/models");
    console.log(`[MiniPhi] LM Studio models discovered via ${sources.join(" & ")}`);
  }
  return result;
}

async function createLmStudioRuntime({
  configData,
  promptDefaults,
  resolvedSystemPrompt,
  modelSelection,
  contextLength,
  contextLengthExplicit = false,
  gpu,
  debugLm,
  verbose,
  schemaRegistry,
  promptDbPath,
  isLmStudioLocal = true,
  restBaseUrl = null,
  wsBaseUrl = null,
  routerConfig = null,
}) {
  const transportPreference = resolveLmStudioTransportPreference(configData);
  const forceRestTransport = transportPreference.forceRest;
  const transportLockedToWs = transportPreference.mode === "ws";
  const clientOptions = wsBaseUrl
    ? { ...(configData?.lmStudio?.clientOptions ?? {}), baseUrl: wsBaseUrl }
    : configData?.lmStudio?.clientOptions;
  const manager = new LMStudioManager(clientOptions);
  const resolvedPromptTimeoutMs =
    resolveDurationMs({
      secondsValue: promptDefaults.timeoutSeconds ?? promptDefaults.timeout,
      secondsLabel: "config.prompt.timeoutSeconds",
      millisValue: promptDefaults.timeoutMs,
      millisLabel: "config.prompt.timeoutMs",
    }) ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const promptTimeoutMs = normalizeLmStudioRequestTimeoutMs(
    resolvedPromptTimeoutMs,
    DEFAULT_PROMPT_TIMEOUT_MS,
  );
  const resolvedNoTokenTimeoutMs =
    resolveDurationMs({
      secondsValue: promptDefaults.noTokenTimeoutSeconds ?? promptDefaults.noTokenTimeout,
      secondsLabel: "config.prompt.noTokenTimeoutSeconds",
      millisValue: promptDefaults.noTokenTimeoutMs,
      millisLabel: "config.prompt.noTokenTimeoutMs",
    }) ?? DEFAULT_NO_TOKEN_TIMEOUT_MS;
  const noTokenTimeoutMs = normalizeLmStudioRequestTimeoutMs(
    resolvedNoTokenTimeoutMs,
    DEFAULT_NO_TOKEN_TIMEOUT_MS,
  );
  if (verbose) {
    const promptSeconds = Math.round(promptTimeoutMs / 1000);
    const noTokenSeconds = Math.round(noTokenTimeoutMs / 1000);
    const restLabel = restBaseUrl ?? "n/a";
    const wsLabel = wsBaseUrl ?? "default";
    const transportLabel = forceRestTransport
      ? "rest (forced)"
      : transportPreference.mode ?? "auto";
    console.log(
      `[MiniPhi] Prompt timeout ${promptSeconds}s | No-token timeout ${noTokenSeconds}s | LM Studio transport ${transportLabel} | WS ${wsLabel} | REST ${restLabel}`,
    );
  }
  const modelKey = modelSelection?.modelKey;
  const routerEnabled =
    Boolean(routerConfig?.enabled) && Array.isArray(routerConfig?.models) && routerConfig.models.length > 0;
  const routedModels = routerEnabled ? routerConfig.models : null;
  const phi4 = routerEnabled
    ? new AdaptiveLMStudioHandler(manager, {
        systemPrompt: resolvedSystemPrompt,
        promptTimeoutMs,
        schemaRegistry,
        noTokenTimeoutMs,
        modelKeys: routedModels,
        defaultModelKey: modelKey,
        promptProfiles: routerConfig?.promptProfiles ?? null,
        routerStatePath: routerConfig?.statePath ?? null,
        routerConfig,
        learnEnabled: routerConfig?.learnEnabled !== false,
        maxSteps: routerConfig?.maxSteps,
        saveIntervalMs: routerConfig?.saveIntervalMs,
      })
    : new LMStudioHandler(manager, {
        systemPrompt: resolvedSystemPrompt,
        promptTimeoutMs,
        schemaRegistry,
        noTokenTimeoutMs,
        modelKey,
      });
  if (forceRestTransport && typeof phi4.setTransportPreference === "function") {
    phi4.setTransportPreference({
      forceRest: true,
      preferRestTransport: true,
      reason: transportPreference.reason ?? "config.lmStudio.transport=rest",
    });
  }

  let restClient = null;
  let restInitError = null;
  let lmStudioCompatibility = { ok: true, preferRest: !isLmStudioLocal };
  let preferRestTransport = !isLmStudioLocal;
  if (transportLockedToWs) {
    preferRestTransport = false;
  } else if (transportPreference.preferRest) {
    preferRestTransport = true;
  }
  try {
    const restOverrides = restBaseUrl ? { baseUrl: restBaseUrl } : undefined;
    restClient = new LMStudioRestClient(
      buildRestClientOptions(configData, modelSelection, restOverrides),
    );
    lmStudioCompatibility = await checkLmStudioCompatibility(restClient, manager, { verbose });
    if (!transportLockedToWs && typeof lmStudioCompatibility?.preferRest === "boolean") {
      preferRestTransport = lmStudioCompatibility.preferRest || preferRestTransport;
    }
  } catch (error) {
    restInitError = error;
    if (verbose) {
      console.warn(
        `[MiniPhi] LM Studio REST client disabled: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  if (forceRestTransport && !restClient) {
    const message =
      restInitError instanceof Error ? restInitError.message : String(restInitError ?? "");
    throw new Error(
      `REST transport forced but LM Studio REST client is unavailable${
        message ? `: ${message}` : "."
      }`,
    );
  }
  if (forceRestTransport) {
    preferRestTransport = true;
  }
  let resolvedContextLength = contextLength;
  if (
    Number.isFinite(lmStudioCompatibility?.statusContextLength) &&
    lmStudioCompatibility.statusContextLength > 0 &&
    !contextLengthExplicit &&
    resolvedContextLength > lmStudioCompatibility.statusContextLength
  ) {
    resolvedContextLength = lmStudioCompatibility.statusContextLength;
    if (verbose) {
      console.log(
        `[MiniPhi] Runtime clamp: LM Studio reports context length ${resolvedContextLength}.`,
      );
    }
  }
  if (restClient) {
    if (typeof restClient.setDefaultModel === "function") {
      restClient.setDefaultModel(modelKey, resolvedContextLength);
    }
    phi4.setRestClient(restClient, { preferRestTransport });
  }
  if (!forceRestTransport) {
    try {
      await manager.getModel(modelKey, {
        contextLength: resolvedContextLength,
        gpu,
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to preload model ${modelKey}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  } else if (verbose) {
    console.log("[MiniPhi] Skipping model preload because REST transport is forced.");
  }

  let performanceTracker = null;
  try {
    const tracker = new PromptPerformanceTracker({
      dbPath: promptDbPath,
      debug: debugLm,
      schemaRegistry,
    });
    await tracker.prepare();
    performanceTracker = tracker;
    if (verbose) {
      const relDb = promptDbPath
        ? path.relative(process.cwd(), promptDbPath) || promptDbPath
        : "unknown";
      console.log(`[MiniPhi] Prompt scoring database ready at ${relDb}`);
    }
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Prompt scoring disabled: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  if (performanceTracker) {
    phi4.setPerformanceTracker(performanceTracker);
  }

  const runtime = {
    manager,
    phi4,
    restClient,
    resolvedContextLength,
    performanceTracker,
    scoringPhi: null,
    async load(options = undefined) {
      const loadGpu = typeof options?.gpu === "undefined" ? gpu : options.gpu;
      const requestedContextLength = options?.contextLength ?? resolvedContextLength;
      const loadContextLength =
        Number.isFinite(lmStudioCompatibility?.statusContextLength) &&
        lmStudioCompatibility.statusContextLength > 0 &&
        !contextLengthExplicit &&
        requestedContextLength > lmStudioCompatibility.statusContextLength
          ? lmStudioCompatibility.statusContextLength
          : requestedContextLength;
      if (forceRestTransport && typeof phi4.setTransportPreference === "function") {
        phi4.setTransportPreference({
          forceRest: true,
          preferRestTransport: true,
          reason: transportPreference.reason ?? "config.lmStudio.transport=rest",
        });
      } else {
        await phi4.load({
          contextLength: loadContextLength,
          gpu: loadGpu,
        });
      }
      if (performanceTracker && debugLm) {
        let scoringPhi = new LMStudioHandler(manager, {
          systemPrompt: PROMPT_SCORING_SYSTEM_PROMPT,
          schemaRegistry,
          noTokenTimeoutMs,
          modelKey,
        });
        if (restClient) {
          scoringPhi.setRestClient(restClient, { preferRestTransport });
        }
        if (forceRestTransport && typeof scoringPhi.setTransportPreference === "function") {
          scoringPhi.setTransportPreference({
            forceRest: true,
            preferRestTransport: true,
            reason: transportPreference.reason ?? "config.lmStudio.transport=rest",
          });
        }
        try {
          const scoringContextLength = Math.min(
            loadContextLength,
            8192,
          );
          if (!forceRestTransport) {
            await scoringPhi.load({ contextLength: scoringContextLength, gpu: loadGpu });
          } else if (verbose) {
            console.log("[MiniPhi] Prompt scoring evaluator using REST transport.");
          }
          performanceTracker.setSemanticEvaluator(async (evaluationPrompt, parentTrace) => {
            scoringPhi.clearHistory();
            return scoringPhi.chatStream(
              evaluationPrompt,
              undefined,
              undefined,
              undefined,
              {
                scope: "sub",
                label: "prompt-scoring",
                schemaId: "prompt-score",
                metadata: {
                  mode: "prompt-evaluator",
                  workspaceType: parentTrace?.metadata?.workspaceType ?? null,
                  objective: parentTrace?.label ?? null,
                },
              },
            );
          });
        } catch (error) {
          scoringPhi = null;
          performanceTracker.setSemanticEvaluator(null);
          if (verbose) {
            console.warn(
              `[MiniPhi] Prompt scoring evaluator disabled: ${
                error instanceof Error ? error.message : error
              }`,
            );
          }
        }
        runtime.scoringPhi = scoringPhi;
      } else if (performanceTracker && verbose) {
        console.log("[MiniPhi] Prompt scoring evaluator disabled (enable with --debug-lm).");
      }
      return runtime;
    },
  };

  return runtime;
}

export { createLmStudioRuntime };
