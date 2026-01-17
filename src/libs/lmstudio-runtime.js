import path from "path";
import LMStudioManager, { LMStudioRestClient } from "./lmstudio-api.js";
import LMStudioHandler from "./lmstudio-handler.js";
import PromptPerformanceTracker from "./prompt-performance-tracker.js";
import { resolveDurationMs } from "./cli-utils.js";
import { buildRestClientOptions } from "./lmstudio-client-options.js";
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
    sdkVersion: typeof manager?.getSdkVersion === "function" ? manager.getSdkVersion() : null,
    preferRest: false,
  };
  if (!restClient) {
    return result;
  }
  let statusPayload = null;
  try {
    statusPayload = await restClient.getStatus();
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
  gpu,
  debugLm,
  verbose,
  schemaRegistry,
  promptDbPath,
  isLmStudioLocal = true,
  restBaseUrl = null,
  wsBaseUrl = null,
}) {
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
    console.log(
      `[MiniPhi] Prompt timeout ${promptSeconds}s | No-token timeout ${noTokenSeconds}s | LM Studio WS ${wsLabel} | REST ${restLabel}`,
    );
  }
  const modelKey = modelSelection?.modelKey;
  const phi4 = new LMStudioHandler(manager, {
    systemPrompt: resolvedSystemPrompt,
    promptTimeoutMs,
    schemaRegistry,
    noTokenTimeoutMs,
    modelKey,
  });
  try {
    await manager.getModel(modelKey, {
      contextLength,
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

  let restClient = null;
  let lmStudioCompatibility = { ok: true, preferRest: !isLmStudioLocal };
  let preferRestTransport = !isLmStudioLocal;
  try {
    const restOverrides = restBaseUrl ? { baseUrl: restBaseUrl } : undefined;
    restClient = new LMStudioRestClient(
      buildRestClientOptions(configData, modelSelection, restOverrides),
    );
    lmStudioCompatibility = await checkLmStudioCompatibility(restClient, manager, { verbose });
    if (typeof lmStudioCompatibility?.preferRest === "boolean") {
      preferRestTransport = lmStudioCompatibility.preferRest;
    }
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] LM Studio REST client disabled: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  if (restClient) {
    phi4.setRestClient(restClient, { preferRestTransport });
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
    performanceTracker,
    scoringPhi: null,
    async load(options = undefined) {
      const loadGpu = typeof options?.gpu === "undefined" ? gpu : options.gpu;
      await phi4.load({
        contextLength: options?.contextLength ?? contextLength,
        gpu: loadGpu,
      });
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
        try {
          const scoringContextLength = Math.min(
            options?.contextLength ?? contextLength,
            8192,
          );
          await scoringPhi.load({ contextLength: scoringContextLength, gpu: loadGpu });
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
