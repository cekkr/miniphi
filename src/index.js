#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import YAML from "yaml";
import CliExecutor from "./libs/cli-executor.js";
import LMStudioManager, {
  LMStudioRestClient,
  normalizeLmStudioHttpUrl,
  normalizeLmStudioWsUrl,
} from "./libs/lmstudio-api.js";
import Phi4Handler from "./libs/lms-phi4.js";
import PythonLogSummarizer from "./libs/python-log-summarizer.js";
import EfficientLogAnalyzer from "./libs/efficient-log-analyzer.js";
import MiniPhiMemory from "./libs/miniphi-memory.js";
import GlobalMiniPhiMemory from "./libs/global-memory.js";
import ResourceMonitor from "./libs/resource-monitor.js";
import PromptRecorder from "./libs/prompt-recorder.js";
import PromptStepJournal from "./libs/prompt-step-journal.js";
import WebResearcher from "./libs/web-researcher.js";
import HistoryNotesManager from "./libs/history-notes.js";
import RecomposeTester from "./libs/recompose-tester.js";
import RecomposeBenchmarkRunner from "./libs/recompose-benchmark-runner.js";
import BenchmarkAnalyzer from "./libs/benchmark-analyzer.js";
import { loadConfig } from "./libs/config-loader.js";
import WorkspaceProfiler from "./libs/workspace-profiler.js";
import PromptPerformanceTracker from "./libs/prompt-performance-tracker.js";
import PromptDecomposer from "./libs/prompt-decomposer.js";
import PromptSchemaRegistry from "./libs/prompt-schema-registry.js";
import PromptTemplateBaselineBuilder from "./libs/prompt-template-baselines.js";
import CapabilityInventory from "./libs/capability-inventory.js";
import ApiNavigator from "./libs/api-navigator.js";
import CommandAuthorizationManager, {
  normalizeCommandPolicy,
} from "./libs/command-authorization-manager.js";
import SchemaAdapterRegistry from "./libs/schema-adapter-registry.js";
import {
  buildWorkspaceHintBlock,
  collectManifestSummary,
  readReadmeSnippet,
} from "./libs/workspace-context-utils.js";
import {
  normalizeDangerLevel,
  mergeFixedReferences,
  buildPlanOperations,
  buildNavigationOperations,
  normalizePlanDirections,
  buildResourceConfig,
  resolveLmStudioHttpBaseUrl,
  isLocalLmStudioBaseUrl,
} from "./libs/core-utils.js";

const COMMANDS = new Set([
  "run",
  "analyze-file",
  "web-research",
  "history-notes",
  "recompose",
  "benchmark",
  "workspace",
  "prompt-template",
]);

const DEFAULT_TASK_DESCRIPTION = "Provide a precise technical analysis of the captured output.";
const DEFAULT_PROMPT_TIMEOUT_MS = 180000;
const DEFAULT_NO_TOKEN_TIMEOUT_MS = 300000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const globalMemory = new GlobalMiniPhiMemory();
const schemaAdapterRegistry = new SchemaAdapterRegistry();
const PROMPT_SCORING_SYSTEM_PROMPT = [
  "You grade MiniPhi prompt effectiveness.",
  "Given an objective, workspace context, prompt text, and the assistant response, you must return JSON with:",
  "score (0-100), prompt_category, summary, follow_up_needed, follow_up_reason, tags, recommended_prompt_pattern, series_strategy.",
  "series_strategy must always be an array of short strategy strings (use [] if you have no suggestions); never return a bare string.",
  "Focus on whether the response satisfied the objective and whether another prompt is required.",
  "Return JSON only.",
].join(" ");

function parseNumericSetting(value, label) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} expects a finite number.`);
  }
  return numeric;
}

function resolveDurationMs({
  secondsValue,
  secondsLabel = "duration (seconds)",
  millisValue,
  millisLabel = "duration (milliseconds)",
} = {}) {
  if (secondsValue !== undefined && secondsValue !== null && secondsValue !== "") {
    const seconds = parseNumericSetting(secondsValue, secondsLabel);
    if (seconds !== undefined) {
      if (seconds <= 0) {
        throw new Error(`${secondsLabel} expects a positive number of seconds.`);
      }
      return seconds * 1000;
    }
  }
  if (millisValue !== undefined && millisValue !== null && millisValue !== "") {
    const millis = parseNumericSetting(millisValue, millisLabel);
    if (millis !== undefined) {
      if (millis <= 0) {
        throw new Error(`${millisLabel} expects a positive number of milliseconds.`);
      }
      return millis;
    }
  }
  return undefined;
}

function extractImplicitWorkspaceTask(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { task: null, rest: [] };
  }
  const boundary = tokens.findIndex((token) => token.startsWith("-"));
  const end = boundary === -1 ? tokens.length : boundary;
  const messageTokens = tokens.slice(0, end).filter((token) => !COMMANDS.has(token));
  const task = messageTokens.join(" ").trim() || null;
  const rest = boundary === -1 ? [] : tokens.slice(boundary);
  return { task, rest };
}

const FILE_REF_PATTERN = /@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;

function parseDirectFileReferences(taskText, cwd) {
  if (!taskText || typeof taskText !== "string") {
    return { cleanedTask: taskText, references: [] };
  }
  const references = [];
  const cleanedTask = taskText.replace(FILE_REF_PATTERN, (match, dq, sq, bare) => {
    const raw = dq ?? sq ?? bare;
    if (!raw) {
      return match;
    }
    const resolved = path.resolve(cwd, raw);
    const record = {
      label: raw,
      path: resolved,
      relative: path.relative(cwd, resolved),
    };
    try {
      const content = fs.readFileSync(resolved, "utf8");
      record.bytes = Buffer.byteLength(content, "utf8");
      record.hash = createHash("sha256").update(content).digest("hex");
      record.preview = content.slice(0, 4000);
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    references.push(record);
    return raw;
  });
  return {
    cleanedTask: cleanedTask.trim() || taskText,
    references,
  };
}

function parseListOption(value) {
  if (!value && value !== 0) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseListOption(entry)).filter(Boolean);
  }
  const text = value.toString().trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[,|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function appendForgottenRequirementNote({ targetPath, context, command, verbose }) {
  if (!targetPath || !context) {
    return false;
  }
  const trimmedContext = context.toString().trim();
  if (!trimmedContext) {
    return false;
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const timestamp = new Date().toISOString();
  const scopeLabel = command ? ` (${command})` : "";
  const noteLine = `- Forgotten requirement for ${timestamp}${scopeLabel}: ${trimmedContext}`;
  const payload = `\n${noteLine}\n`;
  await fs.promises.appendFile(targetPath, payload, "utf8");
  if (verbose) {
    const relPath = path.relative(process.cwd(), targetPath) || targetPath;
    console.log(`[MiniPhi] Recorded placeholder requirement in ${relPath}`);
  }
  return true;
}

// normalizeDangerLevel and mergeFixedReferences moved to src/libs/core-utils.js

function buildRestClientOptions(configData) {
  const overrides = configData?.lmStudio?.rest ?? configData?.rest ?? null;
  const options = overrides && typeof overrides === "object" ? { ...overrides } : {};
  const explicitBase =
    typeof options.baseUrl === "string" && options.baseUrl.trim().length
      ? options.baseUrl
      : null;
  const candidateBase =
    explicitBase ?? configData?.lmStudio?.clientOptions?.baseUrl ?? null;
  if (candidateBase) {
    options.baseUrl = normalizeLmStudioHttpUrl(candidateBase);
  }
  return Object.keys(options).length ? options : undefined;
}

// LM Studio base URL helpers moved to src/libs/core-utils.js

const VALID_JOURNAL_STATUS = new Set(["active", "paused", "completed", "closed"]);

function normalizeJournalStatus(value) {
  if (!value && value !== 0) {
    return null;
  }
  let normalized = value.toString().trim().toLowerCase();
  if (normalized === "complete") {
    normalized = "completed";
  }
  if (VALID_JOURNAL_STATUS.has(normalized)) {
    return normalized;
  }
  return null;
}

// buildPlanOperations and buildNavigationOperations moved to src/libs/core-utils.js

async function recordPlanStepInJournal(journal, sessionId, context = undefined) {
  if (!journal || !sessionId || !context?.planResult) {
    return;
  }
  const operations = buildPlanOperations(context.planResult.plan);
  const commandLine = context.command ? `\nCommand: ${context.command}` : "";
  await journal.appendStep(sessionId, {
    label: context.label ?? "prompt-plan",
    prompt: `Objective: ${context.objective ?? "workspace task"}${commandLine}`.trim(),
    response: context.planResult.outline ?? JSON.stringify(context.planResult.plan, null, 2),
    status: "plan",
    operations,
    metadata: {
      planId: context.planResult.planId ?? null,
      summary: context.planResult.summary ?? null,
      mode: context.mode ?? null,
    },
    workspaceSummary: context.workspaceSummary ?? null,
  });
}

async function recordNavigationPlanInJournal(journal, sessionId, context = undefined) {
  if (!journal || !sessionId || !context?.navigationHints) {
    return;
  }
  const plan = context.navigationHints;
  const operations = buildNavigationOperations(plan);
  await journal.appendStep(sessionId, {
    label: context.label ?? "navigator-plan",
    prompt: `Navigator objective: ${context.objective ?? "workspace guidance"}`,
    response: plan.block ?? JSON.stringify(plan.raw ?? {}, null, 2),
    status: "advisor",
    operations,
    metadata: {
      summary: plan.summary ?? null,
      helper: plan.helper ?? null,
    },
    workspaceSummary: context.workspaceSummary ?? null,
  });
}

async function recordAnalysisStepInJournal(journal, sessionId, payload = undefined) {
  if (!journal || !sessionId || !payload) {
    return;
  }
  await journal.appendStep(sessionId, {
    label: payload.label ?? "analysis",
    prompt: payload.prompt ?? null,
    response: payload.response ?? null,
    schemaId: payload.schemaId ?? null,
    status: payload.status ?? "recorded",
    operations: payload.operations ?? [],
    metadata: payload.metadata ?? null,
    workspaceSummary: payload.workspaceSummary ?? null,
    startedAt: payload.startedAt ?? null,
    finishedAt: payload.finishedAt ?? null,
  });
}

schemaAdapterRegistry.registerAdapter({
  type: "api-navigator",
  version: "navigation-plan@v1",
  normalizeResponse: (plan) => {
    if (!plan || typeof plan !== "object") {
      return plan;
    }
    const normalized = {
      ...plan,
      schema_version: plan.schema_version ?? "navigation-plan@v1",
    };
    normalized.recommended_paths = Array.isArray(plan.recommended_paths)
      ? plan.recommended_paths
      : [];
    normalized.file_types = Array.isArray(plan.file_types) ? plan.file_types : [];
    normalized.focus_commands = Array.isArray(plan.focus_commands) ? plan.focus_commands : [];
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    normalized.actions = actions
      .map((action) => {
        if (!action || typeof action.command !== "string" || !action.command.trim()) {
          return null;
        }
        return {
          ...action,
          command: action.command.trim(),
          danger: normalizeDangerLevel(action.danger ?? "mid"),
          authorization_hint:
            action.authorization_hint ?? action.authorizationHint ?? null,
        };
      })
      .filter(Boolean);
    return normalized;
  },
});

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  let command = args[0];
  let rest = args.slice(1);
  let implicitWorkspaceTask = null;

  if (!COMMANDS.has(command)) {
    const extracted = extractImplicitWorkspaceTask(args);
    if (extracted.task) {
      implicitWorkspaceTask = extracted.task;
      rest = extracted.rest;
      command = "workspace";
    } else {
      console.error(`Unknown command "${command}".`);
      printHelp();
      process.exitCode = 1;
      return;
    }
  }

  const { options, positionals } = parseArgs(rest);
  const verbose = Boolean(options.verbose);
  const streamOutput = !options["no-stream"];
  const debugLm = Boolean(options["debug-lm"]);
  process.env.MINIPHI_DEBUG_LM = debugLm ? "1" : "0";

  let configResult;
  try {
    configResult = loadConfig(options.config);
  } catch (error) {
    console.error(`[MiniPhi] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  const configData = configResult?.data ?? {};
  const configPath = configResult?.path ?? null;
  if (configPath && verbose) {
    const relPath = path.relative(process.cwd(), configPath) || configPath;
    console.log(`[MiniPhi] Loaded configuration from ${relPath}`);
  }

  try {
    await globalMemory.prepare();
  } catch (error) {
    console.warn(
      `[MiniPhi] Unable to prepare global memory at ${globalMemory.baseDir}: ${error instanceof Error ? error.message : error}`,
    );
  }

  let storedCommandPolicy = null;
  try {
    storedCommandPolicy = await globalMemory.loadCommandPolicy();
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Unable to read global command policy: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const defaults = configData.defaults ?? {};
  const promptDefaults = configData.prompt ?? configData.lmStudio?.prompt ?? {};
  const pythonScriptPath =
    options["python-script"] ?? configData.pythonScript ?? defaults.pythonScript;

  const flagPolicy = typeof options["command-policy"] === "string" ? options["command-policy"] : null;
  const configPolicy = configData.commandPolicy ?? defaults.commandPolicy ?? null;
  const commandPolicy = normalizeCommandPolicy(
    flagPolicy ?? configPolicy ?? storedCommandPolicy?.policy ?? "ask",
  );
  if (flagPolicy) {
    await globalMemory.saveCommandPolicy({ policy: commandPolicy, source: "cli" });
  } else if (!storedCommandPolicy?.policy) {
    await globalMemory.saveCommandPolicy({ policy: commandPolicy, source: "default" });
  }
  const assumeYes = Boolean(options["assume-yes"]);
  const commandAuthorizer = new CommandAuthorizationManager({
    policy: commandPolicy,
    assumeYes,
    logger: verbose ? (message) => console.warn(message) : null,
  });

  const summaryLevels =
    parseNumericSetting(options["summary-levels"], "--summary-levels") ??
    parseNumericSetting(defaults.summaryLevels, "config.defaults.summaryLevels") ??
    3;

  const contextLength =
    parseNumericSetting(options["context-length"], "--context-length") ??
    parseNumericSetting(defaults.contextLength, "config.defaults.contextLength") ??
    32768;

  const gpu = options.gpu ?? defaults.gpu ?? "auto";

  const defaultCommandTimeoutMs =
    resolveDurationMs({
      secondsValue: defaults.timeoutSeconds,
      secondsLabel: "config.defaults.timeoutSeconds",
      millisValue: defaults.timeout,
      millisLabel: "config.defaults.timeout",
    }) ?? 60000;
  const timeout =
    resolveDurationMs({
      secondsValue: options.timeout,
      secondsLabel: "--timeout",
    }) ?? defaultCommandTimeoutMs;

  let task = options.task ?? defaults.task ?? DEFAULT_TASK_DESCRIPTION;
  if (command === "workspace" && implicitWorkspaceTask && !options.task) {
    task = implicitWorkspaceTask;
  }

  const skipForgottenNote = Boolean(options["no-forgotten-note"]);
  const providedForgottenNote =
    typeof options["forgotten-note"] === "string" ? options["forgotten-note"].trim() : null;
  const shouldRecordForgottenNote =
    !skipForgottenNote && ["run", "workspace", "analyze-file"].includes(command);
  if (shouldRecordForgottenNote) {
    const noteContext = providedForgottenNote || task;
    const notePath = path.join(PROJECT_ROOT, "docs", "studies", "notes", "TODOs.md");
    if (noteContext) {
      try {
        await appendForgottenRequirementNote({
          targetPath: notePath,
          context: noteContext,
          command,
          verbose,
        });
      } catch (error) {
        if (verbose) {
          console.warn(
            `[MiniPhi] Unable to append forgotten requirement note: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  }

  let promptId = typeof options["prompt-id"] === "string" ? options["prompt-id"].trim() : null;
  if (!promptId && typeof defaults.promptId === "string") {
    promptId = defaults.promptId.trim();
  }
  if (promptId === "") {
    promptId = null;
  }
  const promptGroupId =
    promptId ?? `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const rawPromptJournal = options["prompt-journal"];
  let promptJournalId = null;
  if (typeof rawPromptJournal === "string") {
    const trimmed = rawPromptJournal.trim();
    promptJournalId = trimmed || null;
  } else if (rawPromptJournal === true) {
    promptJournalId = promptGroupId;
  } else if (typeof defaults.promptJournal === "string") {
    const trimmed = defaults.promptJournal.trim();
    if (trimmed) {
      promptJournalId = trimmed;
    }
  } else if (defaults.promptJournal === true) {
    promptJournalId = promptGroupId;
  }
  const promptJournalStatus =
    normalizeJournalStatus(options["prompt-journal-status"]) ??
    normalizeJournalStatus(defaults.promptJournalStatus);

  const defaultSessionTimeoutMs =
    resolveDurationMs({
      secondsValue: defaults.sessionTimeoutSeconds,
      secondsLabel: "config.defaults.sessionTimeoutSeconds",
      millisValue: defaults.sessionTimeout,
      millisLabel: "config.defaults.sessionTimeout",
    }) ?? null;
  const sessionTimeoutMs =
    resolveDurationMs({
      secondsValue: options["session-timeout"],
      secondsLabel: "--session-timeout",
    }) ?? defaultSessionTimeoutMs;
  const runStart = Date.now();
  const sessionDeadline = sessionTimeoutMs ? runStart + sessionTimeoutMs : null;

  const chunkSize =
    parseNumericSetting(options["chunk-size"], "--chunk-size") ??
    parseNumericSetting(defaults.chunkSize, "config.defaults.chunkSize");

  const resourceDefaults = {};
  const resourceSource = configData.resourceMonitor ?? {};
  if (typeof resourceSource.maxMemoryPercent !== "undefined") {
    resourceDefaults["max-memory-percent"] = resourceSource.maxMemoryPercent;
  }
  if (typeof resourceSource.maxCpuPercent !== "undefined") {
    resourceDefaults["max-cpu-percent"] = resourceSource.maxCpuPercent;
  }
  if (typeof resourceSource.maxVramPercent !== "undefined") {
    resourceDefaults["max-vram-percent"] = resourceSource.maxVramPercent;
  }
  if (typeof resourceSource.sampleIntervalMs !== "undefined") {
    resourceDefaults["resource-sample-interval"] = resourceSource.sampleIntervalMs;
  }
  const resourceConfig = buildResourceConfig({
    ...resourceDefaults,
    ...options,
  });

  const resolvedLmStudioBaseUrl = resolveLmStudioHttpBaseUrl(configData);
  const resolvedLmStudioWsBase = normalizeLmStudioWsUrl(
    configData?.lmStudio?.clientOptions?.baseUrl,
  );
  const isLmStudioLocal = isLocalLmStudioBaseUrl(resolvedLmStudioBaseUrl);
  const resourceMonitorForcedDisabled = !isLmStudioLocal;
  if (resourceMonitorForcedDisabled && verbose) {
    const endpointLabel = resolvedLmStudioBaseUrl ?? "unknown";
    console.warn(
      `[MiniPhi] Resource monitor disabled (LM Studio endpoint is external: ${endpointLabel}).`,
    );
  }

  const schemaRegistry = new PromptSchemaRegistry({
    schemaDir: path.join(PROJECT_ROOT, "docs", "prompts"),
  });

  if (command === "web-research") {
    await handleWebResearch({ options, positionals, verbose });
    return;
  }

  if (command === "history-notes") {
    await handleHistoryNotes({ options, verbose });
    return;
  }

  // "recompose" command is ONLY for development testing purposes, like "benchmark". 
  if (command === "recompose") { 
    await handleRecompose({
      options,
      positionals,
      verbose,
      configData,
      promptDefaults,
      contextLength,
      debugLm,
      gpu,
      schemaRegistry,
    });
    return;
  }
  if (command === "benchmark") {
    await handleBenchmark({
      options,
      positionals,
      verbose,
      configData,
      promptDefaults,
      contextLength,
      debugLm,
      gpu,
      schemaRegistry,
    });
    return;
  }

  if (command === "prompt-template") {
    await handlePromptTemplateCommand({ options, verbose, schemaRegistry });
    return;
  }

  const manager = new LMStudioManager(configData.lmStudio?.clientOptions);
  const promptTimeoutMs =
    resolveDurationMs({
      secondsValue: promptDefaults.timeoutSeconds ?? promptDefaults.timeout,
      secondsLabel: "config.prompt.timeoutSeconds",
      millisValue: promptDefaults.timeoutMs,
      millisLabel: "config.prompt.timeoutMs",
    }) ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const noTokenTimeoutMs =
    resolveDurationMs({
      secondsValue:
        promptDefaults.noTokenTimeoutSeconds ?? promptDefaults.noTokenTimeout,
      secondsLabel: "config.prompt.noTokenTimeoutSeconds",
      millisValue: promptDefaults.noTokenTimeoutMs,
      millisLabel: "config.prompt.noTokenTimeoutMs",
    }) ?? DEFAULT_NO_TOKEN_TIMEOUT_MS;
  if (verbose) {
    const promptSeconds = Math.round(promptTimeoutMs / 1000);
    const noTokenSeconds = Math.round(noTokenTimeoutMs / 1000);
    const restLabel = resolvedLmStudioBaseUrl ?? "n/a";
    const wsLabel = resolvedLmStudioWsBase ?? "default";
    console.log(
      `[MiniPhi] Prompt timeout ${promptSeconds}s | No-token timeout ${noTokenSeconds}s | LM Studio WS ${wsLabel} | REST ${restLabel}`,
    );
  }
  const phi4 = new Phi4Handler(manager, {
    systemPrompt: promptDefaults.system,
    promptTimeoutMs,
    schemaRegistry,
    noTokenTimeoutMs,
  });
  const cli = new CliExecutor();
  const summarizer = new PythonLogSummarizer(pythonScriptPath);
  const analyzer = new EfficientLogAnalyzer(phi4, cli, summarizer, {
    schemaRegistry,
    commandAuthorizer,
    devLogDir: path.join(PROJECT_ROOT, ".miniphi", "dev-logs"),
  });
  const workspaceProfiler = new WorkspaceProfiler();
  const capabilityInventory = new CapabilityInventory();
  const navigatorBlocklist = [
    /\brm\s+-rf\b/i,
    /\brmdir\b/i,
    /\bdel\s+/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bmkfs\b/i,
    /\bformat\b/i,
    /\bpoweroff\b/i,
    /\binit\s+0\b/i,
    /:\/\//i, // avoid network fetches via curl/wget etc.
  ];
  const isNavigatorCommandSafe = (command) => {
    if (!command || typeof command !== "string") {
      return false;
    }
    const trimmed = command.trim();
    if (!trimmed || trimmed.length > 200 || /[\n\r]/.test(trimmed)) {
      return false;
    }
    return !navigatorBlocklist.some((regex) => regex.test(trimmed));
  };
  let restClient = null;
  try {
    restClient = new LMStudioRestClient(buildRestClientOptions(configData));
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] LM Studio REST client disabled: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  const buildNavigator = (memoryInstance) =>
    restClient
      ? new ApiNavigator({
          restClient,
          cliExecutor: cli,
          memory: memoryInstance ?? null,
          logger: verbose ? (message) => console.warn(message) : null,
          adapterRegistry: schemaAdapterRegistry,
        })
      : null;
  const runNavigatorFollowUps = async ({
    commands,
    cwd,
    workspaceContext,
    summaryLevels,
    streamOutput,
    timeout,
    sessionDeadline,
    promptGroupId,
    baseMetadata,
    promptJournal,
    promptJournalId,
  }) => {
    if (!Array.isArray(commands) || commands.length === 0) {
      return [];
    }
    const normalize = (entry) => {
      if (!entry) {
        return null;
      }
      if (typeof entry === "string") {
        return { command: entry, danger: "mid", reason: null, authorizationHint: null };
      }
      if (typeof entry.command !== "string") {
        return null;
      }
      return {
        command: entry.command,
        danger: normalizeDangerLevel(entry.danger ?? "mid"),
        reason: entry.reason ?? null,
        authorizationHint: entry.authorizationHint ?? null,
      };
    };
    const normalizedEntries = commands.map(normalize).filter(Boolean);
    if (!normalizedEntries.length) {
      return [];
    }
    const MAX_FOLLOW_UPS = 2;
    const followUps = [];
    for (const entry of normalizedEntries.slice(0, MAX_FOLLOW_UPS)) {
      if (!isNavigatorCommandSafe(entry.command)) {
        if (verbose) {
          console.warn(`[MiniPhi] Navigator follow-up blocked: ${entry.command}`);
        }
        followUps.push({
          command: entry.command,
          skipped: true,
          danger: entry.danger,
          reason: "blocked",
        });
        if (promptJournal && promptJournalId) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `Navigator follow-up blocked: ${entry.command}`,
            prompt: `Navigator suggested ${entry.command}`,
            response: null,
            status: "skipped",
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: entry.danger,
                status: "blocked",
                summary: "Navigator follow-up blocked by policy",
              },
            ],
            metadata: {
              mode: "navigator-follow-up",
              parent: baseMetadata?.parentCommand ?? null,
              reason: "blocked",
            },
            workspaceSummary: workspaceContext?.summary ?? null,
          });
        }
        continue;
      }
      try {
        const followUpTask = `Navigator follow-up: ${entry.command}`;
        const followUpResult = await analyzer.analyzeCommandOutput(entry.command, followUpTask, {
          summaryLevels,
          streamOutput,
          cwd,
          timeout,
          sessionDeadline,
          workspaceContext,
          promptContext: {
            scope: "sub",
            label: followUpTask,
            mainPromptId: promptGroupId,
            metadata: {
              ...(baseMetadata ?? {}),
              mode: "navigator-follow-up",
              command: entry.command,
              workspaceType:
                workspaceContext?.classification?.domain ??
                workspaceContext?.classification?.label ??
                null,
            },
          },
          commandDanger: entry.danger,
          commandSource: "navigator",
            authorizationContext: {
              reason: entry.reason ?? "Navigator follow-up",
              hint: entry.authorizationHint ?? null,
            },
          });
        followUps.push({
          command: entry.command,
          danger: entry.danger,
          analysis: followUpResult.analysis,
            prompt: followUpResult.prompt,
            linesAnalyzed: followUpResult.linesAnalyzed,
            compressedTokens: followUpResult.compressedTokens,
          });
        if (promptJournal && promptJournalId) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: followUpTask,
            prompt: followUpResult.prompt,
            response: followUpResult.analysis,
            schemaId: followUpResult.schemaId ?? null,
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: entry.danger,
                status: "executed",
                summary: `Navigator command captured ${followUpResult.linesAnalyzed ?? 0} lines`,
              },
            ],
            metadata: {
              mode: "navigator-follow-up",
              parent: baseMetadata?.parentCommand ?? null,
              navigationReason: entry.reason ?? null,
            },
            workspaceSummary: workspaceContext?.summary ?? null,
            startedAt: followUpResult.startedAt ?? null,
            finishedAt: followUpResult.finishedAt ?? null,
          });
        }
      } catch (error) {
        followUps.push({
          command: entry.command,
          danger: entry.danger,
          error: error instanceof Error ? error.message : String(error),
        });
        if (promptJournal && promptJournalId) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `Navigator follow-up failed: ${entry.command}`,
            prompt: `Navigator suggested ${entry.command}`,
            response: null,
            status: "error",
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: entry.danger,
                status: "failed",
                summary: error instanceof Error ? error.message : String(error),
              },
            ],
            metadata: {
              mode: "navigator-follow-up",
              parent: baseMetadata?.parentCommand ?? null,
            },
            workspaceSummary: workspaceContext?.summary ?? null,
          });
        }
      }
    }
    return followUps;
  };
  const decomposerTimeoutMs =
    resolveDurationMs({
      secondsValue: configData.prompt?.decomposer?.timeoutSeconds,
      secondsLabel: "config.prompt.decomposer.timeoutSeconds",
      millisValue: configData.prompt?.decomposer?.timeoutMs,
      millisLabel: "config.prompt.decomposer.timeoutMs",
    }) ??
    resolveDurationMs({
      secondsValue:
        configData.prompt?.timeoutSeconds ?? configData.lmStudio?.prompt?.timeoutSeconds,
      secondsLabel: "config.prompt.timeoutSeconds",
      millisValue:
        configData.prompt?.timeoutMs ?? configData.lmStudio?.prompt?.timeoutMs,
      millisLabel: "config.prompt.timeoutMs",
    }) ??
    defaultCommandTimeoutMs;
  const promptDecomposer =
    restClient &&
    new PromptDecomposer({
      restClient,
      logger: verbose ? (message) => console.warn(message) : null,
      maxDepth: configData.prompt?.decomposer?.maxDepth,
      maxActions: configData.prompt?.decomposer?.maxActions,
      timeoutMs: decomposerTimeoutMs,
    });
  let performanceTracker = null;
  let scoringPhi = null;

  try {
    const tracker = new PromptPerformanceTracker({
      dbPath: globalMemory.promptDbPath,
      debug: debugLm,
      schemaRegistry,
    });
    await tracker.prepare();
    performanceTracker = tracker;
    if (verbose) {
      const relDb =
        path.relative(process.cwd(), globalMemory.promptDbPath) || globalMemory.promptDbPath;
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

  let stateManager;
  let promptRecorder = null;
  let promptJournal = null;
  const archiveMetadata = { promptId };
  let resourceMonitor;
  let resourceSummary = null;
  const initializeResourceMonitor = async (label) => {
    if (resourceMonitorForcedDisabled || resourceMonitor) {
      return;
    }
    const historyFile = stateManager?.resourceUsageFile ?? null;
    resourceMonitor = new ResourceMonitor({
      ...resourceConfig,
      historyFile,
      label,
    });
    try {
      await resourceMonitor.start(label);
    } catch (error) {
      resourceMonitor = null;
      if (verbose) {
        console.warn(
          `[MiniPhi] Resource monitor failed to start: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  };
  const stopResourceMonitorIfNeeded = async () => {
    if (resourceMonitorForcedDisabled || !resourceMonitor || resourceSummary) {
      return resourceSummary;
    }
    try {
      resourceSummary = await resourceMonitor.stop();
      if (resourceSummary?.summary?.warnings?.length) {
        for (const warning of resourceSummary.summary.warnings) {
          console.warn(`[MiniPhi][Resources] ${warning}`);
        }
      }
      if (resourceSummary?.persisted?.path && verbose) {
        const rel = path.relative(process.cwd(), resourceSummary.persisted.path);
        console.log(`[MiniPhi] Resource usage appended to ${rel || resourceSummary.persisted.path}`);
      }
    } catch (error) {
      console.warn(
        `[MiniPhi] Unable to finalize resource monitor: ${error instanceof Error ? error.message : error}`,
      );
    }
    return resourceSummary;
  };

  const describeWorkspace = (dir, options = undefined) =>
    generateWorkspaceSnapshot({
      rootDir: dir,
      workspaceProfiler,
      capabilityInventory,
      verbose,
      navigator: options?.navigator ?? null,
      objective: options?.objective ?? null,
      executeHelper: options?.executeHelper ?? true,
    });

  try {
    await phi4.load({ contextLength, gpu });
    if (performanceTracker) {
        scoringPhi = new Phi4Handler(manager, {
          systemPrompt: PROMPT_SCORING_SYSTEM_PROMPT,
          schemaRegistry,
          noTokenTimeoutMs,
        });
      try {
        await scoringPhi.load({ contextLength: Math.min(contextLength, 8192), gpu });
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
            `[MiniPhi] Prompt scoring evaluator disabled: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }

    let result;

    if (command === "workspace") {
      if (task === DEFAULT_TASK_DESCRIPTION && !implicitWorkspaceTask && !options.task) {
        throw new Error(
          'Workspace mode expects a task description. Pass a free-form prompt (e.g., `miniphi "Draft README"`) or supply --task "<description>".',
        );
      }
      const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
      const workspaceRefsResult = parseDirectFileReferences(task, cwd);
      const workspaceFixedReferences = workspaceRefsResult.references;
      task = workspaceRefsResult.cleanedTask;
      archiveMetadata.cwd = cwd;
      stateManager = new MiniPhiMemory(cwd);
      await stateManager.prepare();
      if (workspaceFixedReferences.length) {
        await stateManager.recordFixedReferences({
          references: workspaceFixedReferences,
          promptId: promptGroupId,
          task,
          cwd,
        });
      }
      const navigator = buildNavigator(stateManager);
      let workspaceContext = await describeWorkspace(cwd, {
        navigator,
        objective: task,
      });
      workspaceContext = mergeFixedReferences(workspaceContext, workspaceFixedReferences);
      if (promptJournalId) {
        promptJournal = new PromptStepJournal(stateManager.baseDir);
        await promptJournal.openSession(promptJournalId, {
          mode: "workspace",
          task,
          command: null,
          cwd,
          promptId: promptGroupId,
          workspaceSummary: workspaceContext?.summary ?? null,
          workspaceType:
            workspaceContext?.classification?.domain ??
            workspaceContext?.classification?.label ??
            null,
          argv: process.argv.slice(2),
        });
      } else {
        promptJournal = null;
      }
      promptRecorder = new PromptRecorder(stateManager.baseDir);
      await promptRecorder.prepare();
      phi4.setPromptRecorder(promptRecorder);
      if (promptId) {
        const history = await stateManager.loadPromptSession(promptId);
        if (history) {
          phi4.setHistory(history);
        }
      }
      let planResult = null;
      if (promptDecomposer) {
        try {
          planResult = await promptDecomposer.decompose({
            objective: task,
            command: null,
            workspace: workspaceContext,
            promptRecorder,
            storage: stateManager,
            mainPromptId: promptGroupId,
            metadata: { mode: "workspace" },
          });
        } catch (error) {
          if (verbose) {
            console.warn(
              `[MiniPhi] Workspace decomposition failed: ${error instanceof Error ? error.message : error}`,
            );
          }
        }
      }
      if (planResult) {
        workspaceContext = {
          ...(workspaceContext ?? {}),
          taskPlanSummary: planResult.summary ?? null,
          taskPlanId: planResult.planId ?? null,
          taskPlanOutline: planResult.outline ?? null,
        };
      }
      if (promptJournal) {
        await recordPlanStepInJournal(promptJournal, promptJournalId, {
          planResult,
          objective: task,
          command: null,
          workspaceSummary: workspaceContext?.summary ?? null,
          mode: "workspace",
        });
        if (workspaceContext?.navigationHints) {
          await recordNavigationPlanInJournal(promptJournal, promptJournalId, {
            navigationHints: workspaceContext.navigationHints,
            workspaceSummary: workspaceContext.summary ?? null,
            objective: task,
          });
        }
      }
      console.log(`[MiniPhi][Workspace] cwd: ${cwd}`);
      console.log(`[MiniPhi][Workspace] task: ${task}`);
      if (workspaceContext?.summary) {
        console.log(`[MiniPhi][Workspace] summary: ${workspaceContext.summary}`);
      }
      if (workspaceContext?.navigationBlock) {
        console.log(`[MiniPhi][Workspace] navigation:\n${workspaceContext.navigationBlock}`);
      }
      if (planResult?.outline) {
        console.log(`[MiniPhi][Workspace] plan (${planResult.planId}):\n${planResult.outline}`);
      } else if (!promptDecomposer) {
        console.log("[MiniPhi][Workspace] Prompt decomposer is not configured; skipping plan output.");
      }
      return;
    }

    if (command === "run") {
      const cmd = options.cmd ?? positionals.join(" ");
      if (!cmd) {
        throw new Error('Missing --cmd "<command>" for run mode.');
      }

      const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
      const fileRefResult = parseDirectFileReferences(task, cwd);
      const fixedReferences = fileRefResult.references;
      task = fileRefResult.cleanedTask;
      const userCommandDanger = normalizeDangerLevel(
        options["command-danger"] ?? defaults.commandDanger ?? "mid",
      );
      archiveMetadata.command = cmd;
      archiveMetadata.cwd = cwd;
      stateManager = new MiniPhiMemory(cwd);
      await stateManager.prepare();
      if (fixedReferences.length) {
        await stateManager.recordFixedReferences({
          references: fixedReferences,
          promptId: promptGroupId,
          task,
          cwd,
        });
      }
      const navigator = buildNavigator(stateManager);
      let workspaceContext = await describeWorkspace(cwd, {
        navigator,
        objective: task,
      });
      workspaceContext = mergeFixedReferences(workspaceContext, fixedReferences);
      if (promptJournalId) {
        promptJournal = new PromptStepJournal(stateManager.baseDir);
        await promptJournal.openSession(promptJournalId, {
          mode: "run",
          task,
          command: cmd,
          cwd,
          promptId: promptGroupId,
          workspaceSummary: workspaceContext?.summary ?? null,
          workspaceType:
            workspaceContext?.classification?.domain ??
            workspaceContext?.classification?.label ??
            null,
          argv: process.argv.slice(2),
        });
      } else {
        promptJournal = null;
      }
      let planResult = null;
        promptRecorder = new PromptRecorder(stateManager.baseDir);
        await promptRecorder.prepare();
        phi4.setPromptRecorder(promptRecorder);
        if (verbose) {
          console.log(`[MiniPhi] Prompt recorder enabled (main id: ${promptGroupId})`);
        }
        if (promptId) {
          const history = await stateManager.loadPromptSession(promptId);
          if (history) {
            phi4.setHistory(history);
          }
        }
        if (promptDecomposer) {
          try {
            planResult = await promptDecomposer.decompose({
              objective: task,
              command: cmd,
              workspace: workspaceContext,
              promptRecorder,
              storage: stateManager,
              mainPromptId: promptGroupId,
              metadata: { mode: "run" },
            });
          } catch (error) {
            if (verbose) {
              console.warn(
                `[MiniPhi] Prompt decomposition failed: ${error instanceof Error ? error.message : error}`,
              );
            }
          }
        }
        if (planResult) {
          workspaceContext = {
            ...(workspaceContext ?? {}),
            taskPlanSummary: planResult.summary ?? null,
            taskPlanId: planResult.planId ?? null,
            taskPlanOutline: planResult.outline ?? null,
          };
          if (planResult.outline && verbose) {
            const outlineLines = planResult.outline.split(/\r?\n/);
            const preview = outlineLines.slice(0, 10).join("\n");
            const suffix = outlineLines.length > 10 ? "\n..." : "";
            console.log(`[MiniPhi] Prompt plan (${planResult.planId}):\n${preview}${suffix}`);
          }
        }
        if (promptJournal) {
          await recordPlanStepInJournal(promptJournal, promptJournalId, {
            planResult,
            objective: task,
            command: filePath,
            workspaceSummary: workspaceContext?.summary ?? null,
            mode: "analyze-file",
          });
          if (workspaceContext?.navigationHints) {
            await recordNavigationPlanInJournal(promptJournal, promptJournalId, {
              navigationHints: workspaceContext.navigationHints,
              workspaceSummary: workspaceContext.summary ?? null,
              objective: task,
            });
          }
        }
        if (promptJournal) {
          await recordPlanStepInJournal(promptJournal, promptJournalId, {
            planResult,
            objective: task,
            command: cmd,
            workspaceSummary: workspaceContext?.summary ?? null,
            mode: "run",
          });
          if (workspaceContext?.navigationHints) {
            await recordNavigationPlanInJournal(promptJournal, promptJournalId, {
              navigationHints: workspaceContext.navigationHints,
              workspaceSummary: workspaceContext.summary ?? null,
              objective: task,
            });
          }
        }
        await initializeResourceMonitor(`run:${cmd}`);
        result = await analyzer.analyzeCommandOutput(cmd, task, {
          summaryLevels,
          verbose,
          streamOutput,
          cwd,
          timeout,
          sessionDeadline,
          workspaceContext,
          promptContext: {
            scope: "main",
            label: task,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "run",
              command: cmd,
              cwd,
              workspaceType: workspaceContext?.classification?.domain ?? workspaceContext?.classification?.label ?? null,
              workspaceSummary: workspaceContext?.summary ?? null,
              workspaceHint: workspaceContext?.hintBlock ?? null,
              workspaceManifest: (workspaceContext?.manifestPreview ?? []).slice(0, 5).map((entry) => entry.path),
              workspaceReadmeSnippet: workspaceContext?.readmeSnippet ?? null,
              taskPlanId: planResult?.planId ?? null,
              taskPlanOutline: planResult?.outline ?? null,
              workspaceConnections: workspaceContext?.connections?.hotspots ?? null,
              workspaceConnectionGraph: workspaceContext?.connectionGraphic ?? null,
              capabilitySummary: workspaceContext?.capabilitySummary ?? null,
              capabilities: workspaceContext?.capabilityDetails ?? null,
              navigationSummary: workspaceContext?.navigationSummary ?? null,
              navigationBlock: workspaceContext?.navigationBlock ?? null,
              helperScript: workspaceContext?.helperScript ?? null,
            },
          },
          commandDanger: userCommandDanger,
          commandSource: "user",
          authorizationContext: {
            reason: "Primary --cmd execution",
          },
        });
        if (promptJournal && result) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `run:${cmd}`,
            prompt: result.prompt,
            response: result.analysis,
            schemaId: result.schemaId ?? null,
            operations: [
              {
                type: "command",
                command: cmd,
                cwd,
                danger: userCommandDanger,
                status: "executed",
                summary: `Captured ${result.linesAnalyzed ?? 0} lines`,
              },
            ],
            metadata: {
              mode: "run",
              linesAnalyzed: result.linesAnalyzed ?? null,
              compressedTokens: result.compressedTokens ?? null,
            },
            workspaceSummary: workspaceContext?.summary ?? null,
            startedAt: result.startedAt ?? null,
            finishedAt: result.finishedAt ?? null,
          });
        }
        const navigatorActions =
          (workspaceContext?.navigationHints?.actions ?? []).length > 0
            ? workspaceContext.navigationHints.actions
            : (workspaceContext?.navigationHints?.focusCommands ?? []).map((command) => ({
                command,
                danger: "mid",
              }));
        if (navigatorActions.length) {
          const followUps = await runNavigatorFollowUps({
            commands: navigatorActions,
            cwd,
            workspaceContext,
            summaryLevels,
            streamOutput,
            timeout,
            sessionDeadline,
            promptGroupId,
            baseMetadata: {
              parentCommand: cmd,
              parentMode: "run",
              workspaceSummary: workspaceContext?.summary ?? null,
            },
            promptJournal,
            promptJournalId,
          });
          if (followUps.length) {
            result.navigatorFollowUps = followUps;
          }
        }
    } else if (command === "analyze-file") {
      const fileFromFlag = options.file ?? options.path ?? positionals[0];
      if (!fileFromFlag) {
        throw new Error('Missing --file "<path>" for analyze-file mode.');
      }

      const filePath = path.resolve(fileFromFlag);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const analyzeCwd = path.dirname(filePath);
      const analyzeRefsResult = parseDirectFileReferences(task, analyzeCwd);
      const analyzeFixedReferences = analyzeRefsResult.references;
      task = analyzeRefsResult.cleanedTask;
      archiveMetadata.filePath = filePath;
      archiveMetadata.cwd = analyzeCwd;
      stateManager = new MiniPhiMemory(archiveMetadata.cwd);
      await stateManager.prepare();
      if (analyzeFixedReferences.length) {
        await stateManager.recordFixedReferences({
          references: analyzeFixedReferences,
          promptId: promptGroupId,
          task,
          cwd: analyzeCwd,
        });
      }
      const navigator = buildNavigator(stateManager);
      let workspaceContext = await describeWorkspace(analyzeCwd, {
        navigator,
        objective: task,
      });
      workspaceContext = mergeFixedReferences(workspaceContext, analyzeFixedReferences);
      if (promptJournalId) {
        promptJournal = new PromptStepJournal(stateManager.baseDir);
        await promptJournal.openSession(promptJournalId, {
          mode: "analyze-file",
          task,
          command: filePath,
          cwd: analyzeCwd,
          promptId: promptGroupId,
          workspaceSummary: workspaceContext?.summary ?? null,
          workspaceType:
            workspaceContext?.classification?.domain ??
            workspaceContext?.classification?.label ??
            null,
          argv: process.argv.slice(2),
        });
        const resumeStatus = promptJournalStatus ?? "paused";
        console.log(
          `[MiniPhi] Prompt journal session "${promptJournalId}" (${resumeStatus}). Re-run with --prompt-journal ${promptJournalId} to resume.`,
        );
      } else {
        promptJournal = null;
      }
      let planResult = null;

        promptRecorder = new PromptRecorder(stateManager.baseDir);
        await promptRecorder.prepare();
        phi4.setPromptRecorder(promptRecorder);
        if (verbose) {
          console.log(`[MiniPhi] Prompt recorder enabled (main id: ${promptGroupId})`);
        }
        if (promptId) {
          const history = await stateManager.loadPromptSession(promptId);
          if (history) {
            phi4.setHistory(history);
          }
        }
        if (promptDecomposer) {
          try {
            planResult = await promptDecomposer.decompose({
              objective: task,
              command: filePath,
              workspace: workspaceContext,
              promptRecorder,
              storage: stateManager,
              mainPromptId: promptGroupId,
              metadata: { mode: "analyze-file" },
            });
          } catch (error) {
            if (verbose) {
              console.warn(
                `[MiniPhi] Prompt decomposition failed: ${error instanceof Error ? error.message : error}`,
              );
            }
          }
        }
        if (planResult) {
          workspaceContext = {
            ...(workspaceContext ?? {}),
            taskPlanSummary: planResult.summary ?? null,
            taskPlanId: planResult.planId ?? null,
            taskPlanOutline: planResult.outline ?? null,
          };
          if (planResult.outline && verbose) {
            const outlineLines = planResult.outline.split(/\r?\n/);
            const preview = outlineLines.slice(0, 10).join("\n");
            const suffix = outlineLines.length > 10 ? "\n..." : "";
            console.log(`[MiniPhi] Prompt plan (${planResult.planId}):\n${preview}${suffix}`);
          }
        }
        await initializeResourceMonitor(`analyze:${path.basename(filePath)}`);
        result = await analyzer.analyzeLogFile(filePath, task, {
          summaryLevels,
          streamOutput,
          maxLinesPerChunk: chunkSize,
          sessionDeadline,
          workspaceContext,
          promptContext: {
            scope: "main",
            label: task,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "analyze-file",
              filePath,
              cwd: analyzeCwd,
              workspaceType: workspaceContext?.classification?.domain ?? workspaceContext?.classification?.label ?? null,
              workspaceSummary: workspaceContext?.summary ?? null,
              workspaceHint: workspaceContext?.hintBlock ?? null,
              workspaceManifest: (workspaceContext?.manifestPreview ?? []).slice(0, 5).map((entry) => entry.path),
              workspaceReadmeSnippet: workspaceContext?.readmeSnippet ?? null,
              taskPlanId: planResult?.planId ?? null,
              taskPlanOutline: planResult?.outline ?? null,
              workspaceConnections: workspaceContext?.connections?.hotspots ?? null,
              workspaceConnectionGraph: workspaceContext?.connectionGraphic ?? null,
              capabilitySummary: workspaceContext?.capabilitySummary ?? null,
              capabilities: workspaceContext?.capabilityDetails ?? null,
              navigationSummary: workspaceContext?.navigationSummary ?? null,
              navigationBlock: workspaceContext?.navigationBlock ?? null,
              helperScript: workspaceContext?.helperScript ?? null,
            },
          },
        });
        if (promptJournal && result) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `analyze-file:${path.basename(filePath)}`,
            prompt: result.prompt,
            response: result.analysis,
            schemaId: result.schemaId ?? null,
            operations: [
              {
                type: "file-analysis",
                file: filePath,
                status: "completed",
                summary: `Analyzed ${result.linesAnalyzed ?? 0} lines`,
              },
            ],
            metadata: {
              mode: "analyze-file",
              linesAnalyzed: result.linesAnalyzed ?? null,
              compressedTokens: result.compressedTokens ?? null,
            },
            workspaceSummary: workspaceContext?.summary ?? null,
            startedAt: result.startedAt ?? null,
            finishedAt: result.finishedAt ?? null,
          });
        }
        const analyzeNavigatorActions =
          (workspaceContext?.navigationHints?.actions ?? []).length > 0
            ? workspaceContext.navigationHints.actions
            : (workspaceContext?.navigationHints?.focusCommands ?? []).map((command) => ({
                command,
                danger: "mid",
              }));
        if (analyzeNavigatorActions.length) {
          const followUps = await runNavigatorFollowUps({
            commands: analyzeNavigatorActions,
            cwd: analyzeCwd,
            workspaceContext,
            summaryLevels,
            streamOutput,
            timeout,
            sessionDeadline,
            promptGroupId,
            baseMetadata: {
              parentCommand: filePath,
              parentMode: "analyze-file",
              workspaceSummary: workspaceContext?.summary ?? null,
            },
            promptJournal,
            promptJournalId,
          });
          if (followUps.length) {
            result.navigatorFollowUps = followUps;
          }
        }
      }

    await stopResourceMonitorIfNeeded();

    if (stateManager && result) {
      const archive = await stateManager.persistExecution({
        mode: command,
        task,
        command: archiveMetadata.command,
        filePath: archiveMetadata.filePath,
        cwd: archiveMetadata.cwd,
        summaryLevels,
        contextLength,
        resourceUsage: resourceSummary?.summary ?? null,
        result,
        promptId,
      });
      if (archive && options.verbose) {
        const relativePath = path.relative(process.cwd(), archive.path);
        console.log(`[MiniPhi] Execution archived under ${relativePath || archive.path}`);
      }
    }

    if (!options["no-summary"]) {
      console.log("\n[MiniPhi] Analysis summary:");
      console.log(
        JSON.stringify(
          {
            task: result.task,
            linesAnalyzed: result.linesAnalyzed,
            compressedTokens: result.compressedTokens,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(`[MiniPhi] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    try {
      if (promptId && stateManager) {
        await stateManager.savePromptSession(promptId, phi4.getHistory());
      }
      if (promptJournal && promptJournalId) {
        const finalJournalStatus = promptJournalStatus ?? "completed";
        await promptJournal.setStatus(promptJournalId, finalJournalStatus, {
          mode: command,
          completedAt: new Date().toISOString(),
        });
      }
      await stopResourceMonitorIfNeeded();
      await phi4.eject();
      if (scoringPhi) {
        await scoringPhi.eject();
      }
      if (performanceTracker) {
        await performanceTracker.dispose();
      }
    } catch {
      // no-op
    }
  }
}

async function handleWebResearch({ options, positionals, verbose }) {
  const queries = [];
  const pushQuery = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      queries.push(trimmed);
    }
  };
  pushQuery(options.query);
  for (const positional of positionals) {
    pushQuery(positional);
  }
  if (options["query-file"]) {
    const filePath = path.resolve(options["query-file"]);
    const contents = await fs.promises.readFile(filePath, "utf8");
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach(pushQuery);
  }

  if (queries.length === 0) {
    throw new Error('web-research expects at least one query via --query "<text>" or positional arguments.');
  }

  const provider = typeof options.provider === "string" ? options.provider : "duckduckgo";
  const maxResults = parseNumericSetting(options["max-results"], "--max-results");
  const includeRaw = Boolean(options["include-raw"]);
  const note = typeof options.note === "string" ? options.note : null;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const memory = new MiniPhiMemory(cwd);
  await memory.prepare();
  const researcher = new WebResearcher();
  const shouldSave = !options["no-save"];

  for (const query of queries) {
    if (verbose) {
      console.log(`[MiniPhi][Research] Searching "${query}" via ${provider}...`);
    }
    const report = await researcher.search(query, {
      provider,
      maxResults,
      includeRaw,
      note,
    });
    const persisted = shouldSave ? await memory.saveResearchReport(report) : null;
    console.log(
      `[MiniPhi][Research] ${report.results.length} result${report.results.length === 1 ? "" : "s"} for "${report.query}" (${report.durationMs} ms)`,
    );
    report.results.forEach((result, index) => {
      console.log(`  ${index + 1}. ${result.title ?? result.url} [${result.source ?? "unknown"}]`);
      console.log(`     ${result.url}`);
      if (result.snippet) {
        console.log(`     ${result.snippet}`);
      }
    });
    if (persisted?.path && verbose) {
      const rel = path.relative(process.cwd(), persisted.path);
      console.log(`[MiniPhi][Research] Saved snapshot to ${rel || persisted.path}`);
    }
  }
}

async function handleHistoryNotes({ options, verbose }) {
  const includeGit = !options["no-git"];
  const label = typeof options.label === "string" ? options.label.trim() : null;
  const historyRoot = options["history-root"] ? path.resolve(options["history-root"]) : process.cwd();
  const memory = new MiniPhiMemory(historyRoot);
  const manager = new HistoryNotesManager(memory);
  const snapshot = await manager.captureSnapshot({ includeGit, label });
  const note = snapshot.note;
  console.log(
    `[MiniPhi][History] Changed: ${note.changedFiles.length}, added: ${note.addedFiles.length}, removed: ${note.removedFiles.length}, stable: ${note.stableCount}`,
  );
  if (snapshot.previousSnapshot?.path && verbose) {
    const prevRel = path.relative(process.cwd(), snapshot.previousSnapshot.path);
    console.log(`[MiniPhi][History] Compared against ${prevRel || snapshot.previousSnapshot.path}`);
  }
  if (snapshot.jsonPath) {
    const relJson = path.relative(process.cwd(), snapshot.jsonPath);
    console.log(`[MiniPhi][History] JSON: ${relJson || snapshot.jsonPath}`);
  }
  if (snapshot.markdownPath) {
    const relMd = path.relative(process.cwd(), snapshot.markdownPath);
    console.log(`[MiniPhi][History] Markdown: ${relMd || snapshot.markdownPath}`);
  }
}

async function handleRecompose({
  options,
  positionals,
  verbose,
  configData,
  promptDefaults,
  contextLength,
  debugLm,
  gpu,
  schemaRegistry,
}) {
  const sessionLabel =
    typeof options.label === "string"
      ? options.label
      : typeof options["session-label"] === "string"
        ? options["session-label"]
        : null;
  const rawMode =
    typeof options["recompose-mode"] === "string"
      ? options["recompose-mode"].toLowerCase()
      : configData.recompose?.mode?.toLowerCase() ?? "offline";
  const recomposeMode = rawMode === "live" ? "live" : "offline";
  const harness = await createRecomposeHarness({
    configData,
    promptDefaults,
    contextLength,
    debugLm,
    verbose,
    sessionLabel,
    gpu,
    schemaRegistry,
    promptDbPath: globalMemory.promptDbPath,
    recomposeMode,
  });
  const sampleArg = options.sample ?? options["sample-dir"] ?? positionals[0] ?? null;
  const direction = (options.direction ?? positionals[1] ?? "roundtrip").toLowerCase();
  let report;
  let reportPath = null;
  let promptLogExportPath = null;
  try {
    report = await harness.tester.run({
      sampleDir: sampleArg ? path.resolve(sampleArg) : null,
      direction,
      codeDir: options["code-dir"],
      descriptionsDir: options["descriptions-dir"],
      outputDir: options["output-dir"],
      clean: Boolean(options.clean),
      sessionLabel,
    });
    const defaultReportBase = report.sampleDir ?? (sampleArg ? path.resolve(sampleArg) : process.cwd());
    reportPath = path.resolve(options.report ?? path.join(defaultReportBase, "recompose-report.json"));
    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
    if (typeof harness.tester.exportPromptLog === "function") {
      promptLogExportPath = await harness.tester.exportPromptLog({
        targetDir: path.dirname(reportPath),
        fileName: `${path.basename(reportPath, path.extname(reportPath))}.prompts.log`,
        label: sessionLabel ?? direction,
      });
    }
  } finally {
    await harness.cleanup();
  }

  report.steps.forEach((step) => {
    if (step.phase === "code-to-markdown") {
      console.log(
        `[MiniPhi][Recompose] code→md: ${step.converted}/${step.discovered} files converted in ${step.durationMs} ms (skipped ${step.skipped})`,
      );
    } else if (step.phase === "markdown-to-code") {
      console.log(
        `[MiniPhi][Recompose] md→code: ${step.converted}/${step.processed} markdown files restored in ${step.durationMs} ms (warnings: ${step.warnings.length})`,
      );
      if (verbose && step.warnings.length) {
        step.warnings.slice(0, 5).forEach((warning) => {
          console.warn(`[MiniPhi][Recompose][Warn] ${warning.path}: ${warning.reason}`);
        });
        if (step.warnings.length > 5) {
          console.warn(`[MiniPhi][Recompose][Warn] ...${step.warnings.length - 5} additional warnings`);
        }
      }
    } else if (step.phase === "comparison") {
      console.log(
        `[MiniPhi][Recompose] compare: ${step.matches} matches, ${step.mismatches.length} mismatches, ${step.missing.length} missing, ${step.extras.length} extra files (took ${step.durationMs} ms)`,
      );
    }
  });

  if (!reportPath) {
    throw new Error("Failed to resolve recompose report path.");
  }
  if (promptLogExportPath) {
    const relPrompt = path.relative(process.cwd(), promptLogExportPath) || promptLogExportPath;
    const normalizedPrompt = relPrompt.replace(/\\/g, "/");
    report.promptLogExport = normalizedPrompt;
    console.log(`[MiniPhi][Recompose] Prompt log saved to ${normalizedPrompt}`);
  }
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  const rel = path.relative(process.cwd(), reportPath);
  console.log(`[MiniPhi][Recompose] Report saved to ${rel || reportPath}`);
}

async function handleBenchmark({
  options,
  positionals,
  verbose,
  configData,
  promptDefaults,
  contextLength,
  debugLm,
  gpu,
  schemaRegistry,
}) {
  const mode = (positionals[0] ?? options.mode ?? "recompose").toLowerCase();
  if (mode === "analyze") {
    const baselineDir = options.baseline ?? options.path ?? options.dir ?? positionals[1] ?? null;
    if (!baselineDir) {
      throw new Error("benchmark analyze requires --path <dir> or a positional directory argument.");
    }
    const candidateDir = options.compare ?? options.candidate ?? null;
    const analyzer = new BenchmarkAnalyzer();
    if (candidateDir) {
      await analyzer.compareDirectories(baselineDir, candidateDir);
    } else {
      await analyzer.analyzeDirectory(baselineDir);
    }
    return;
  }

  if (mode === "plan") {
    const action = (positionals[1] ?? options.action ?? "scaffold").toLowerCase();
    if (action !== "scaffold") {
      throw new Error(`Unsupported benchmark plan action "${action}".`);
    }
    const sampleDir = options.sample ?? options["sample-dir"] ?? positionals[2] ?? null;
    await scaffoldBenchmarkPlan({
      sampleDir,
      benchmarkRoot: options["benchmark-root"] ?? null,
      outputPath: options.output ?? options.o ?? null,
      verbose,
    });
    return;
  }

  if (mode !== "recompose") {
    throw new Error(`Unsupported benchmark mode "${mode}". Expected "recompose" or "analyze".`);
  }

  const planPath = options.plan ?? options["plan-file"] ?? null;
  const plan = planPath ? await loadBenchmarkPlan(planPath) : null;
  if (plan?.path && verbose) {
    const rel = path.relative(process.cwd(), plan.path) || plan.path;
    console.log(`[MiniPhi][Benchmark] Loaded plan from ${rel}`);
  }
  const planSample = plan ? resolvePlanPath(plan, plan.data.sampleDir ?? plan.data.sample) : null;
  const planBenchmarkRoot = plan ? resolvePlanPath(plan, plan.data.benchmarkRoot ?? plan.data.outputDir) : null;
  const sampleArg = options.sample ?? options["sample-dir"] ?? positionals[1] ?? planSample ?? null;
  const benchmarkRoot = options["benchmark-root"] ?? planBenchmarkRoot ?? undefined;
  const harness = await createRecomposeHarness({
    configData,
    promptDefaults,
    contextLength,
    debugLm,
    verbose,
    sessionLabel: null,
    gpu,
    schemaRegistry,
    promptDbPath: globalMemory.promptDbPath,
    recomposeMode: "live",
  });
  const runner = new RecomposeBenchmarkRunner({
    sampleDir: sampleArg,
    benchmarkRoot,
    tester: harness.tester,
  });
  const timestamp = options.timestamp ?? plan?.data?.timestamp ?? undefined;
  const runPrefix = options["run-prefix"] ?? plan?.data?.runPrefix ?? plan?.data?.defaults?.runPrefix ?? "RUN";
  const clean = options.clean ?? plan?.data?.clean ?? plan?.data?.defaults?.clean ?? false;
  const resumeDescriptions =
    options["resume-descriptions"] ??
    plan?.data?.resumeDescriptions ??
    plan?.data?.defaults?.resumeDescriptions ??
    false;

  let result;
  try {
    if (plan) {
      const planRuns = buildBenchmarkPlanRuns(plan.data);
      if (!planRuns.length) {
        throw new Error("Benchmark plan must include at least one run definition.");
      }
      result = await runner.runSeries({
        planRuns,
        timestamp,
        runPrefix,
        clean,
        resumeDescriptions: Boolean(resumeDescriptions),
      });
    } else {
      const directionsValue = options.directions ?? options.direction ?? "roundtrip";
      const directions = directionsValue.split(",").map((value) => value.trim()).filter(Boolean);
      const repeat = Number(options.repeat ?? 1);
      result = await runner.runSeries({
        directions,
        repeat,
        clean: Boolean(clean),
        timestamp,
        runPrefix,
        resumeDescriptions: Boolean(resumeDescriptions),
      });
    }
  } finally {
    await harness.cleanup();
  }
  const relDir = path.relative(process.cwd(), result.outputDir) || result.outputDir;
  console.log(`[MiniPhi][Benchmark] ${result.runs.length} runs saved under ${relDir}`);
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
  recomposeMode = "live",
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
    const recomposePromptTimeout = Math.max(baseTimeoutMs, 300000);
    phi4 = new Phi4Handler(manager, {
      systemPrompt: promptDefaults.system,
      promptTimeoutMs: recomposePromptTimeout,
      schemaRegistry,
    });
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
    useLivePrompts: recomposeMode === "live",
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

function parseArgs(tokens) {
  const options = {};
  const positionals = [];
  const shortValueFlags = {
    c: "cmd",
    t: "task",
    f: "file",
    p: "python-script",
  };
  const shortBooleanFlags = {
    v: "verbose",
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (!next || next.startsWith("-")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    } else if (token.startsWith("-") && token.length === 2) {
      const short = token[1];
      if (shortValueFlags[short]) {
        const next = tokens[i + 1];
        if (!next || next.startsWith("-")) {
          throw new Error(`Flag -${short} expects a value.`);
        }
        options[shortValueFlags[short]] = next;
        i += 1;
      } else if (shortBooleanFlags[short]) {
        options[shortBooleanFlags[short]] = true;
      } else if (short === "h") {
        options.help = true;
      } else {
        positionals.push(token);
      }
    } else {
      positionals.push(token);
    }
  }

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  return { options, positionals };
}

async function loadBenchmarkPlan(planPath) {
  const absolute = path.resolve(planPath);
  const raw = await fs.promises.readFile(absolute, "utf8");
  const ext = path.extname(absolute).toLowerCase();
  let data;
  if (ext === ".yaml" || ext === ".yml") {
    data = YAML.parse(raw);
  } else {
    data = JSON.parse(raw);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Benchmark plan must be a JSON or YAML object.");
  }
  return {
    path: absolute,
    dir: path.dirname(absolute),
    data,
  };
}

async function generateWorkspaceSnapshot({
  rootDir,
  workspaceProfiler,
  capabilityInventory,
  verbose = false,
  navigator = null,
  objective = null,
  executeHelper = true,
}) {
  let profile;
  try {
    profile = workspaceProfiler.describe(rootDir);
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Workspace profiling failed for ${rootDir}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return null;
  }

  const manifestResult = await collectManifestSummary(rootDir, { limit: 10 }).catch((error) => {
    if (verbose) {
      console.warn(
        `[MiniPhi] Workspace manifest scan failed for ${rootDir}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return { files: [], manifest: [] };
  });
  const readmeSnippet = await readReadmeSnippet({
    candidates: [
      path.join(rootDir, "README.md"),
      path.join(rootDir, "README.md.md"),
      path.join(rootDir, "docs", "README.md"),
    ],
  }).catch(() => null);
  const hintBlock = buildWorkspaceHintBlock(manifestResult.files, rootDir, readmeSnippet, {
    limit: 8,
  });

  let capabilities = null;
  try {
    capabilities = await capabilityInventory.describe(rootDir);
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Capability inventory failed for ${rootDir}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const workspaceSnapshot = {
    ...profile,
    manifestPreview: manifestResult.manifest,
    readmeSnippet,
    hintBlock: hintBlock || null,
    capabilitySummary: capabilities?.summary ?? null,
    capabilityDetails: capabilities?.details ?? null,
  };

  let navigationHints = null;
  if (navigator) {
    try {
      navigationHints = await navigator.generateNavigationHints({
        workspace: workspaceSnapshot,
        capabilities,
        objective,
        cwd: rootDir,
        executeHelper,
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Navigation advisor failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  return {
    ...workspaceSnapshot,
    navigationSummary: navigationHints?.summary ?? null,
    navigationBlock: navigationHints?.block ?? null,
    helperScript: navigationHints?.helper ?? null,
    navigationHints,
  };
}

async function handlePromptTemplateCommand({ options, verbose, schemaRegistry }) {
  const rawBaseline =
    (typeof options.baseline === "string" && options.baseline.trim()) ||
    (typeof options.type === "string" && options.type.trim()) ||
    "truncation";
  const baseline = rawBaseline.toLowerCase();
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const task =
    (typeof options.task === "string" && options.task.trim()) ||
    "Explain how to truncate this oversized dataset so I can analyze it with Phi across multiple prompts while keeping history synced.";
  const datasetSummary =
    (typeof options["dataset-summary"] === "string" && options["dataset-summary"].trim()) ||
    (typeof options.dataset === "string" && options.dataset.trim()) ||
    `Oversized log/output data captured from ${path.basename(cwd) || "the workspace"}.`;
  const totalLines =
    parseNumericSetting(options["total-lines"], "--total-lines") ??
    parseNumericSetting(options.lines, "--lines");
  const chunkTarget =
    parseNumericSetting(options["target-lines"], "--target-lines") ??
    parseNumericSetting(options["chunk-size"], "--chunk-size");
  const helperFocus = parseListOption(options["helper-focus"]);
  const historyKeys = parseListOption(options["history-keys"]);
  const notes =
    typeof options.notes === "string" && options.notes.trim().length ? options.notes.trim() : null;
  const skipWorkspace = Boolean(options["no-workspace"]);

  let workspaceContext = null;
  if (!skipWorkspace) {
    const workspaceProfiler = new WorkspaceProfiler();
    const capabilityInventory = new CapabilityInventory();
    workspaceContext = await generateWorkspaceSnapshot({
      rootDir: cwd,
      workspaceProfiler,
      capabilityInventory,
      verbose,
      navigator: null,
      objective: task,
      executeHelper: false,
    });
  }

  const builder = new PromptTemplateBaselineBuilder({ schemaRegistry });
  let template;
  try {
    template = builder.build({
      baseline,
      task,
      datasetSummary,
      datasetStats: { totalLines, chunkTarget },
      helperFocus,
      historyKeys,
      notes,
      workspaceContext,
    });
  } catch (error) {
    console.error(
      `[MiniPhi] Unable to build prompt baseline: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
    return;
  }

  const stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
  const labelCandidate = typeof options.label === "string" ? options.label.trim() : "";
  const label = labelCandidate || `${baseline}-baseline`;
  const saved = await stateManager.savePromptTemplateBaseline({
    baseline,
    label,
    schemaId: template.schemaId,
    task: template.task,
    prompt: template.prompt,
    metadata: template.metadata,
    cwd,
  });
  const savedRel = path.relative(process.cwd(), saved.path);
  console.log(
    `[MiniPhi] Prompt template baseline ${saved.id} stored at ${savedRel || saved.path}`,
  );

  const outputPath =
    typeof options.output === "string" && options.output.trim()
      ? path.resolve(options.output.trim())
      : null;
  if (outputPath) {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, `${template.prompt}\n`, "utf8");
    const rel = path.relative(process.cwd(), outputPath);
    console.log(`[MiniPhi] Prompt text exported to ${rel || outputPath}`);
  }

  console.log("\n--- Prompt Template ---\n");
  console.log(template.prompt);
  console.log("\n--- End Template ---");
}

function resolvePlanPath(plan, candidate) {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.resolve(plan.dir, candidate);
}

function buildBenchmarkPlanRuns(planData) {
  if (!planData || typeof planData !== "object" || Array.isArray(planData)) {
    throw new Error("Benchmark plan content must be an object.");
  }
  const defaultDirections = normalizePlanDirections(planData.defaults?.directions ?? planData.directions);
  const fallbackDirections = defaultDirections.length ? defaultDirections : ["roundtrip"];
  const fallbackRepeat = Math.max(1, Number(planData.defaults?.repeat ?? planData.repeat ?? 1) || 1);
  const fallbackClean = planData.defaults?.clean ?? planData.clean ?? false;
  const fallbackPrefix = planData.defaults?.runPrefix ?? planData.runPrefix ?? "RUN";
  const fallbackResume = planData.defaults?.resumeDescriptions ?? planData.resumeDescriptions ?? false;
  const entries = Array.isArray(planData.runs) && planData.runs.length
    ? planData.runs
    : [
        {
          directions: planData.directions ?? fallbackDirections,
          repeat: planData.repeat ?? fallbackRepeat,
          clean: planData.clean ?? fallbackClean,
          runPrefix: planData.runPrefix ?? fallbackPrefix,
          resumeDescriptions: planData.resumeDescriptions ?? fallbackResume,
          label: planData.label,
          runLabel: planData.runLabel,
          labels: planData.labels,
        },
      ];
  if (!entries.length) {
    throw new Error("Benchmark plan must define at least one run entry.");
  }
  const runs = [];
  entries.forEach((entry, entryIndex) => {
    const entryDirections = normalizePlanDirections(entry.directions ?? entry.direction ?? fallbackDirections);
    if (!entryDirections.length) {
      throw new Error(`Plan run ${entryIndex} resolved to zero directions.`);
    }
    const repeat = Math.max(1, Number(entry.repeat ?? fallbackRepeat) || 1);
    const entryClean = entry.clean ?? fallbackClean;
    const entryPrefix = entry.runPrefix ?? fallbackPrefix;
    const entryResume = entry.resumeDescriptions ?? fallbackResume;
    const labelList = Array.isArray(entry.labels) ? entry.labels : null;
    for (let cycle = 0; cycle < repeat; cycle += 1) {
      entryDirections.forEach((direction, directionIndex) => {
        const prioritizedLabel =
          (labelList ? labelList[directionIndex] ?? labelList[labelList.length - 1] : null) ??
          (typeof entry.runLabel === "string" ? entry.runLabel : null) ??
          (typeof entry.label === "string" ? entry.label : null);
        let resolvedLabel = prioritizedLabel ?? null;
        const needsSuffix = repeat > 1 || (entryDirections.length > 1 && !labelList);
        if (resolvedLabel && needsSuffix) {
          const suffixParts = [cycle + 1];
          if (entryDirections.length > 1 && !labelList) {
            suffixParts.push(directionIndex + 1);
          }
          resolvedLabel = `${resolvedLabel}-${suffixParts.join("-")}`;
        }
        runs.push({
          direction,
          clean: entryClean,
          runPrefix: entryPrefix,
          runLabel: resolvedLabel,
          resumeDescriptions: entryResume,
        });
      });
    }
  });
  return runs;
}

async function scaffoldBenchmarkPlan({ sampleDir, benchmarkRoot, outputPath, verbose }) {
  const defaultSample = path.join("samples", "recompose", "hello-flow");
  const resolvedSample = path.resolve(sampleDir ?? defaultSample);
  let stats;
  try {
    stats = await fs.promises.stat(resolvedSample);
  } catch {
    throw new Error(`Unable to locate sample directory ${resolvedSample}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Sample path is not a directory: ${resolvedSample}`);
  }
  const sampleName = path.basename(resolvedSample);
  const codeDir = path.join(resolvedSample, "code");
  const descriptionsDir = path.join(resolvedSample, "descriptions");
  const normalized = (target) => {
    const relative = path.relative(process.cwd(), target);
    return (relative || target).replace(/\\/g, "/");
  };
  const planSlug = `${sampleName}-plan`;
  const resolvedBenchmarkRoot =
    benchmarkRoot && path.isAbsolute(benchmarkRoot)
      ? benchmarkRoot
      : path.resolve(benchmarkRoot ?? path.join("samples", "benchmark", "recompose", planSlug));
  const codeFiles = await collectSampleFileStats(codeDir);
  const descriptionFiles = await collectSampleFileStats(descriptionsDir);
  const readmeSnippet = await loadReadmeSnippet(resolvedSample);
  const lines = [];
  lines.push(`# MiniPhi benchmark plan scaffold (${new Date().toISOString()})`);
  lines.push(`# Sample: ${sampleName}`);
  lines.push(`# Detected ${codeFiles.length} code files under ${normalized(codeDir)}`);
  lines.push(`# Detected ${descriptionFiles.length} description files under ${normalized(descriptionsDir)}`);
  if (readmeSnippet) {
    lines.push(`# README excerpt: ${readmeSnippet}`);
  }
  if (codeFiles.length) {
    lines.push(`# First files: ${codeFiles.slice(0, 5).map((file) => file.path).join(", ")}`);
  }
  lines.push("");
  lines.push(`sampleDir: ${normalized(resolvedSample)}`);
  lines.push(`benchmarkRoot: ${normalized(resolvedBenchmarkRoot)}`);
  lines.push(`timestamp: ${planSlug}`);
  lines.push(`runPrefix: PLAN`);
  lines.push("defaults:");
  lines.push("  # Roundtrip ensures both directions are exercised.");
  lines.push("  directions:");
  lines.push("    - roundtrip");
  lines.push("  repeat: 1");
  lines.push("  clean: false");
  lines.push("  resumeDescriptions: false");
  lines.push("runs:");
  lines.push("  # Fresh sweep to regenerate markdown + reconstructed code.");
  lines.push("  - label: clean-roundtrip");
  lines.push("    clean: true");
  lines.push("    directions:");
  lines.push("      - roundtrip");
  lines.push("  # Target markdown-to-code iterations without re-narrating files.");
  lines.push("  - label: markdown-focus");
  lines.push("    directions:");
  lines.push("      - markdown-to-code");
  lines.push("    repeat: 2");
  lines.push("    runPrefix: PLAN-MD");
  lines.push("    resumeDescriptions: true");
  lines.push("");
  const output = `${lines.join("\n").trim()}\n`;
  if (outputPath) {
    const resolvedOutput = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.promises.writeFile(resolvedOutput, output, "utf8");
    const rel = normalized(resolvedOutput);
    console.log(`[MiniPhi][Benchmark][Plan] Scaffold saved to ${rel}`);
  } else {
    if (!verbose) {
      console.log("[MiniPhi][Benchmark][Plan] Use --output <file> to save this scaffold automatically.");
    }
    console.log(output);
  }
}

async function collectSampleFileStats(baseDir) {
  try {
    const stats = await fs.promises.stat(baseDir);
    if (!stats.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  const files = [];
  const stack = [""];
  while (stack.length) {
    const current = stack.pop();
    const absolute = path.join(baseDir, current);
    const dirents = await fs.promises.readdir(absolute, { withFileTypes: true });
    for (const entry of dirents) {
      const rel = path.join(current, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.isFile()) {
        const info = await fs.promises.stat(path.join(baseDir, rel));
        files.push({ path: rel, bytes: info.size });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function loadReadmeSnippet(sampleDir) {
  const candidates = [
    path.join(sampleDir, "README.md"),
    path.join(sampleDir, "README.md.md"),
    path.join(sampleDir, "code", "README.md"),
    path.join(sampleDir, "descriptions", "README.md"),
  ];
  for (const candidate of candidates) {
    try {
      const stats = await fs.promises.stat(candidate);
      if (!stats.isFile()) {
        continue;
      }
      const content = await fs.promises.readFile(candidate, "utf8");
      const trimmed = content.replace(/\s+/g, " ").trim();
      if (trimmed) {
        return trimmed.slice(0, 220);
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function printHelp() {
  console.log(`MiniPhi CLI

Usage:
  node src/index.js run --cmd "npm test" --task "Analyze failures"
  node src/index.js analyze-file --file ./logs/output.log --task "Summarize log"
  node src/index.js web-research "phi-4 roadmap" --max-results 5
  node src/index.js history-notes --label "post benchmark"
  node src/index.js workspace --task "Plan README refresh"
  node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean
  node src/index.js benchmark recompose --directions roundtrip,code-to-markdown --repeat 3
  node src/index.js prompt-template --baseline truncation --task "Teach me how to chunk jest logs"

Options:
  --cmd <command>              Command to execute in run mode
  --file <path>                File to analyze in analyze-file mode
  --task <description>         Task instructions for Phi-4
  --config <path>              Path to optional config.json (searches upward by default)
  --cwd <path>                 Working directory for --cmd
  --summary-levels <n>         Depth for recursive summarization (default: 3)
  --context-length <tokens>    Override Phi-4 context length (default: 32768)
  --gpu <mode>                 GPU setting forwarded to LM Studio (default: auto)
  --timeout <s>                Command timeout in seconds (default: 60)
  --max-memory-percent <n>     Trigger warnings when RAM usage exceeds <n>%
  --max-cpu-percent <n>        Trigger warnings when CPU usage exceeds <n>%
  --max-vram-percent <n>       Trigger warnings when VRAM usage exceeds <n>%
  --resource-sample-interval <ms>  Resource sampling cadence (default: 5000)
  --forgotten-note <text>      Custom text for the placeholder backlog entry recorded each session
  --no-forgotten-note          Skip recording the placeholder backlog entry for this invocation
  --python-script <path>       Custom path to log_summarizer.py
  --chunk-size <lines>         Chunk size when analyzing files (default: 2000)
  --verbose                    Print progress details
  --no-stream                  Disable live streaming of Phi-4 output
  --no-summary                 Skip JSON summary footer
  --prompt-id <id>             Attach/continue a prompt session (persists LM history)
  --prompt-journal [id]        Mirror each Phi/API step + operations into .miniphi/prompt-exchanges/stepwise
  --prompt-journal-status <s>  Finalize the journal as active|paused|completed|closed (default: completed)
  --session-timeout <s>        Hard limit (seconds) for the entire MiniPhi run (optional)
  --debug-lm                   Print each objective + prompt when scoring is running
  --command-policy <mode>      Command authorization: ask | session | allow | deny (default: ask)
  --assume-yes                 Auto-approve prompts when the policy is ask/session
  --command-danger <level>     Danger classification for --cmd (low | mid | high; default: mid)
  (workspace mode also accepts free-form positional text: npx miniphi "Draft release notes".)

Prompt template baselines:
  --baseline <name>            Baseline template id to scaffold (default: truncation)
  --dataset-summary <text>     Short description of the oversized dataset/logs
  --total-lines <n>            Approximate number of lines captured in the dataset
  --target-lines <n>           Desired per-chunk line budget for truncation_strategy
  --history-keys <list>        Comma/pipe-separated JSON keys to persist between prompts
  --helper-focus <list>        Comma/pipe-separated helper commands/tools to emphasize
  --label <text>               Friendly label stored with the template artifact
  --output <path>              Persist the generated prompt text to a separate file
  --no-workspace               Skip workspace profiling when drafting the template
  --notes <text>               Extra reminders appended to the prompt body

Web research:
  --query <text>               Query string (can be repeated or passed as positional)
  --query-file <path>          File containing newline-delimited queries
  --provider <name>            Research provider (default: duckduckgo)
  --max-results <n>            Limit number of results per query (default: 6)
  --include-raw                Persist raw provider payload into the saved snapshot
  --no-save                    Do not store the research snapshot under .miniphi/research
  --note <text>                Optional annotation attached to the research snapshot

History notes:
  --history-root <path>        Override the directory used to locate .miniphi (default: cwd)
  --label <text>               Friendly label for the snapshot (e.g., "post-upgrade")
  --no-git                     Skip git metadata when summarizing .miniphi changes

Recompose benchmarks:
  --sample <path>              Samples/recompose project to operate on
  --direction <mode>           code-to-markdown | markdown-to-code | roundtrip (default)
  --code-dir <path>            Override code directory (default: <sample>/code)
  --descriptions-dir <path>    Override markdown descriptions directory (default: <sample>/descriptions)
  --output-dir <path>          Override reconstructed code output directory (default: <sample>/reconstructed)
  --clean                      Remove generated description/output directories before running
  --report <path>              Persist benchmark report JSON to a custom path
  --help                       Show this help message

Benchmark helper:
  benchmark recompose [sample]  Run timestamped benchmark batches (defaults to hello-flow sample)
    --sample <path>             Override sample directory
    --benchmark-root <path>     Directory used to store timestamped runs (default: samples/benchmark/recompose)
    --directions <list>         Comma-separated directions to execute (default: roundtrip)
    --repeat <n>                Repeat the direction list n times (default: 1)
    --run-prefix <text>         Prefix for run artifacts (default: RUN)
    --timestamp <value>         Pin a timestamp folder (default: current time)
    --clean                     Perform clean before each run
    --resume-descriptions       Skip the code-to-markdown sweep when descriptions already exist
  benchmark analyze [dir]       Summarize existing JSON reports under the directory
    --path <dir>                Directory containing RUN-###.json files (positional also accepted)
    --compare <dir>             Optional candidate directory to diff against baseline
  benchmark plan scaffold [sample]  Emit a commented plan template for the sample
    --sample <path>             Sample directory to inspect (default: samples/recompose/hello-flow)
    --benchmark-root <path>     Suggested benchmark root override
    --output <path>             Persist the scaffold to a file instead of stdout
`);
}

main();
