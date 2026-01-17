import fs from "fs";
import path from "path";
import LMStudioManager, { LMStudioRestClient } from "./lmstudio-api.js";
import LMStudioHandler from "./lmstudio-handler.js";
import MiniPhiMemory from "./miniphi-memory.js";
import PromptRecorder from "./prompt-recorder.js";
import PromptPerformanceTracker from "./prompt-performance-tracker.js";
import RecomposeTester from "./recompose-tester.js";
import { resolveDurationMs } from "./cli-utils.js";
import { buildRestClientOptions } from "./lmstudio-client-options.js";
import {
  DEFAULT_PROMPT_TIMEOUT_MS,
  normalizeLmStudioRequestTimeoutMs,
  RECOMPOSE_AUTO_STATUS_TIMEOUT_MS,
} from "./runtime-defaults.js";

async function resolveRecomposeMode({ rawMode, configData, modelKey, contextLength, verbose }) {
  const normalized = typeof rawMode === "string" ? rawMode.toLowerCase().trim() : "auto";
  if (normalized === "live" || normalized === "offline") {
    return normalized;
  }
  if (normalized && normalized !== "auto") {
    if (verbose) {
      console.warn(
        `[MiniPhi][Recompose] Unknown recompose mode "${normalized}". Falling back to auto.`,
      );
    }
  }

  const restOptions = {
    ...(buildRestClientOptions(configData, { modelKey, contextLength }) ?? {}),
    timeoutMs: RECOMPOSE_AUTO_STATUS_TIMEOUT_MS,
  };
  try {
    const probeClient = new LMStudioRestClient(restOptions);
    const status = await probeClient.getStatus();
    if (status?.ok) {
      if (verbose) {
        console.log("[MiniPhi][Recompose] LM Studio reachable; using live mode.");
      }
      return "live";
    }
  } catch (error) {
    if (verbose) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[MiniPhi][Recompose] LM Studio probe failed: ${message}`);
    }
  }
  if (verbose) {
    console.log("[MiniPhi][Recompose] LM Studio not available; using offline mode.");
  }
  return "offline";
}

async function createRecomposeHarness({
  configData,
  promptDefaults,
  contextLength,
  debugLm,
  verbose,
  sessionLabel,
  gpu,
  schemaRegistry,
  promptDbPath,
  restClient = null,
  preferRestTransport = false,
  recomposeMode = "live",
  systemPrompt = undefined,
  modelKey = undefined,
  workspaceOverviewTimeoutMs = undefined,
}) {
  let phi4 = null;
  let manager = null;
  if (recomposeMode === "live") {
    manager = new LMStudioManager(configData.lmStudio?.clientOptions);
    const baseTimeoutMs =
      resolveDurationMs({
        secondsValue: promptDefaults.timeoutSeconds ?? promptDefaults.timeout,
        secondsLabel: "config.prompt.timeoutSeconds",
        millisValue: promptDefaults.timeoutMs,
        millisLabel: "config.prompt.timeoutMs",
      }) ?? DEFAULT_PROMPT_TIMEOUT_MS;
    const recomposePromptTimeout = normalizeLmStudioRequestTimeoutMs(
      baseTimeoutMs,
      DEFAULT_PROMPT_TIMEOUT_MS,
    );
    phi4 = new LMStudioHandler(manager, {
      systemPrompt: systemPrompt ?? promptDefaults.system,
      promptTimeoutMs: recomposePromptTimeout,
      schemaRegistry,
      modelKey,
    });
    if (restClient) {
      phi4.setRestClient(restClient, { preferRestTransport });
    }
    const loadOptions = { contextLength, gpu };
    await phi4.load(loadOptions);
  }
  const memory = new MiniPhiMemory(process.cwd());
  await memory.prepare();
  let promptRecorder = null;
  if (phi4) {
    promptRecorder = new PromptRecorder(memory.baseDir);
    await promptRecorder.prepare();
    phi4.setPromptRecorder(promptRecorder);
  }
  let performanceTracker = null;
  if (phi4) {
    try {
      const tracker = new PromptPerformanceTracker({
        dbPath: promptDbPath,
        debug: debugLm,
        schemaRegistry,
      });
      await tracker.prepare();
      phi4.setPerformanceTracker(tracker);
      performanceTracker = tracker;
    } catch (error) {
      if (verbose) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[MiniPhi][Recompose] Prompt scoring disabled: ${message}`);
      }
    }
  }
  const sessionRoot = path.join(memory.baseDir, "recompose");
  await fs.promises.mkdir(sessionRoot, { recursive: true });
  const tester = new RecomposeTester({
    phi4,
    sessionRoot,
    promptLabel: sessionLabel ?? "recompose",
    verboseLogging: verbose,
    memory,
    schemaRegistry,
    useLivePrompts: recomposeMode === "live",
    workspaceOverviewTimeoutMs,
  });
  const cleanup = async () => {
    if (phi4) {
      await phi4.eject();
    }
    if (performanceTracker) {
      await performanceTracker.dispose();
    }
  };
  return { tester, cleanup };
}

export { createRecomposeHarness, resolveRecomposeMode };
