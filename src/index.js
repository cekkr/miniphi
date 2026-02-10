#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import CliExecutor from "./libs/cli-executor.js";
import { DEFAULT_CONTEXT_LENGTH, resolveModelConfig } from "./libs/model-presets.js";
import { LMStudioProtocolError } from "./libs/lmstudio-handler.js";
import PythonLogSummarizer from "./libs/python-log-summarizer.js";
import EfficientLogAnalyzer from "./libs/efficient-log-analyzer.js";
import MiniPhiMemory from "./libs/miniphi-memory.js";
import GlobalMiniPhiMemory from "./libs/global-memory.js";
import ResourceMonitor from "./libs/resource-monitor.js";
import PromptRecorder from "./libs/prompt-recorder.js";
import PromptStepJournal from "./libs/prompt-step-journal.js";
import { loadConfig } from "./libs/config-loader.js";
import { parseNumericSetting, resolveDurationMs } from "./libs/cli-utils.js";
import WorkspaceProfiler from "./libs/workspace-profiler.js";
import PromptDecomposer from "./libs/prompt-decomposer.js";
import PromptSchemaRegistry from "./libs/prompt-schema-registry.js";
import CapabilityInventory from "./libs/capability-inventory.js";
import ApiNavigator from "./libs/api-navigator.js";
import {
  classifyLmStudioError,
  getLmStudioStopReasonLabel,
} from "./libs/lmstudio-error-utils.js";
import { resolveLmStudioEndpoints } from "./libs/lmstudio-endpoints.js";
import { createLmStudioRuntime } from "./libs/lmstudio-runtime.js";
import CommandAuthorizationManager, {
  normalizeCommandPolicy,
} from "./libs/command-authorization-manager.js";
import SchemaAdapterRegistry from "./libs/schema-adapter-registry.js";
import {
  attachCommandLibraryToWorkspace,
  attachPromptCompositionsToWorkspace,
  generateWorkspaceSnapshot,
  recordCompositionSnapshot,
  recordLmStudioStatusSnapshot,
} from "./libs/workspace-snapshot.js";
import {
  normalizeDangerLevel,
  mergeFixedReferences,
  buildPlanOperations,
  buildPlanSegments,
  buildFocusedPlanSegments,
  applyRequestedPlanBranchFocus,
  formatPlanSegmentsBlock,
  formatPlanRecommendationsBlock,
  buildNavigationOperations,
  buildResourceConfig,
  shouldForceFastMode,
  extractRecommendedCommandsFromAnalysis,
  extractContextRequestsFromAnalysis,
  extractMissingSnippetsFromAnalysis,
  extractNeedsMoreContextFlag,
  extractSummaryFromAnalysis,
  extractSummaryUpdatesFromAnalysis,
} from "./libs/core-utils.js";
import {
  DEFAULT_PROMPT_TIMEOUT_MS,
  normalizeLmStudioRequestTimeoutMs,
} from "./libs/runtime-defaults.js";
import { resolveLmStudioTransportPreference } from "./libs/lmstudio-transport.js";
import { extractLmStudioContextLength } from "./libs/lmstudio-status-utils.js";
import {
  buildLineRangeFromChunk,
  buildTruncationChunkKey,
  computeTruncationProgress,
  describeTruncationChunk,
  ensureTruncationProgressEntry,
  findNextIncompleteChunk,
  isTruncationChunkCompleted,
  persistTruncationProgressSafe,
  selectTruncationChunk,
} from "./libs/truncation-utils.js";
import { handleAnalyzeFileCommand } from "./commands/analyze-file.js";
import { handleBenchmarkCommand } from "./commands/benchmark.js";
import { handleCachePruneCommand } from "./commands/cache-prune.js";
import { handleCommandLibrary } from "./commands/command-library.js";
import { handleHelpersCommand } from "./commands/helpers.js";
import { handleHistoryNotes } from "./commands/history-notes.js";
import { handleLmStudioHealthCommand, probeLmStudioHealth } from "./commands/lmstudio-health.js";
import { handleNitpickCommand } from "./commands/nitpick.js";
import { handlePromptTemplateCommand } from "./commands/prompt-template.js";
import { handleRunCommand } from "./commands/run.js";
import { handleRecomposeCommand } from "./commands/recompose.js";
import { handleWebResearch } from "./commands/web-research.js";
import { handleWebBrowse } from "./commands/web-browse.js";
import { handleWorkspaceCommand } from "./commands/workspace.js";

const COMMANDS = new Set([
  "run",
  "analyze-file",
  "lmstudio-health",
  "web-research",
  "web-browse",
  "history-notes",
  "recompose",
  "benchmark",
  "workspace",
  "prompt-template",
  "command-library",
  "helpers",
  "cache-prune",
  "nitpick",
]);

const DEFAULT_TASK_DESCRIPTION = "Provide a precise technical analysis of the captured output.";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const globalMemory = new GlobalMiniPhiMemory();
const schemaAdapterRegistry = new SchemaAdapterRegistry();

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

function displayContextRequests(contextRequests) {
  if (!Array.isArray(contextRequests) || contextRequests.length === 0) {
    return;
  }
  console.log("\n[MiniPhi] Phi requested additional context before continuing:");
  contextRequests.forEach((request, index) => {
    const prefix = `${index + 1}. ${request.description}`;
    const extras = [];
    if (request.context) {
      extras.push(`context: ${request.context}`);
    }
    if (request.scope) {
      extras.push(`scope: ${request.scope}`);
    }
    if (request.priority) {
      extras.push(`priority: ${request.priority}`);
    }
    if (request.source) {
      extras.push(`source: ${request.source}`);
    }
    console.log(`  ${prefix}${extras.length ? ` (${extras.join(", ")})` : ""}`);
    if (request.detail) {
      console.log(`     Details: ${request.detail}`);
    }
  });
}

function displayMissingSnippets(snippets) {
  if (!Array.isArray(snippets) || snippets.length === 0) {
    return;
  }
  console.log("\n[MiniPhi] Minimal snippets/files requested before proceeding:");
  snippets.forEach((snippet, index) => {
    console.log(`  ${index + 1}. ${snippet}`);
  });
}

function displaySummaryUpdates(summaryUpdates) {
  if (!Array.isArray(summaryUpdates) || summaryUpdates.length === 0) {
    return;
  }
  console.log("\n[MiniPhi] Phi progress updates:");
  summaryUpdates.forEach((update, index) => {
    console.log(`  ${index + 1}. ${update}`);
  });
}

function displayPhiSummary(summaryText) {
  if (!summaryText) {
    return;
  }
  console.log(`\n[MiniPhi] Phi summary: ${summaryText}`);
}

function announceNeedsMoreContext(flag, hasSnippets) {
  if (!flag) {
    return;
  }
  const suffix = hasSnippets ? "" : " Provide the missing snippets or rerun with a narrower dataset.";
  console.warn(
    `\n[MiniPhi] Phi flagged that the captured data is incomplete.${suffix}`,
  );
}

function attachContextRequestsToResult(result) {
  if (!result || typeof result !== "object") {
    return;
  }
  const summaryUpdates = extractSummaryUpdatesFromAnalysis(result.analysis ?? "");
  if (summaryUpdates !== null) {
    result.summaryUpdates = summaryUpdates;
  }
  if (summaryUpdates && summaryUpdates.length) {
    displaySummaryUpdates(summaryUpdates);
  }
  const summaryText = extractSummaryFromAnalysis(result.analysis ?? "");
  if (summaryText) {
    result.summary = summaryText;
    displayPhiSummary(summaryText);
  }
  const requests = extractContextRequestsFromAnalysis(result.analysis ?? "");
  result.contextRequests = requests;
  if (requests.length) {
    displayContextRequests(requests);
  }
  const missingSnippets = extractMissingSnippetsFromAnalysis(result.analysis ?? "");
  if (missingSnippets.length) {
    result.missingSnippets = missingSnippets;
    displayMissingSnippets(missingSnippets);
  }
  const needsMoreContext = extractNeedsMoreContextFlag(result.analysis ?? "");
  if (typeof needsMoreContext === "boolean") {
    result.needsMoreContext = needsMoreContext;
    announceNeedsMoreContext(needsMoreContext, missingSnippets.length > 0);
  }
}

async function mirrorPromptTemplateToGlobal(
  savedTemplate,
  templateDetails,
  workspaceContext,
  options = undefined,
) {
  if (
    !savedTemplate?.path ||
    !globalMemory?.recordPromptTemplateBaseline ||
    typeof globalMemory.recordPromptTemplateBaseline !== "function"
  ) {
    return;
  }
  try {
    await globalMemory.recordPromptTemplateBaseline({
      id: savedTemplate.id,
      label: templateDetails?.label ?? savedTemplate.id ?? null,
      schemaId: templateDetails?.schemaId ?? null,
      baseline: templateDetails?.baseline ?? templateDetails?.metadata?.baseline ?? null,
      objective: templateDetails?.task ?? null,
      workspaceType:
        workspaceContext?.classification?.label ?? workspaceContext?.classification?.domain ?? null,
      sourcePath: savedTemplate.path,
      source: options?.source ?? "cli",
    });
  } catch (error) {
    if (options?.verbose) {
      console.warn(
        `[MiniPhi] Unable to mirror prompt template globally: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
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

function parseBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "no" || normalized === "0") {
    return false;
  }
  return null;
}

function parseListFlag(value) {
  if (!value && value !== 0) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseListFlag(entry));
  }
  const text = value.toString().trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[,|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolveRouterStatePath(rawPath, configPath) {
  if (!rawPath || typeof rawPath !== "string") {
    return null;
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  if (configPath) {
    return path.resolve(path.dirname(configPath), trimmed);
  }
  return path.resolve(process.cwd(), trimmed);
}

function resolveRouterConfig({ options, configData, configPath, modelSelection }) {
  const rawConfig = configData?.rlRouter ?? configData?.promptRouter ?? null;
  const cliEnabled = parseBooleanFlag(options["rl-router"]);
  const configEnabled =
    typeof rawConfig?.enabled === "boolean"
      ? rawConfig.enabled
      : typeof rawConfig?.enable === "boolean"
        ? rawConfig.enable
        : null;
  const configModels = Array.isArray(rawConfig?.models)
    ? rawConfig.models
    : parseListFlag(rawConfig?.models);
  const cliModels = parseListFlag(options["rl-models"]);
  const modelList = cliModels.length ? cliModels : configModels;
  const hasModels = modelList.length > 0;
  const enabled =
    cliEnabled !== null ? cliEnabled : configEnabled !== null ? configEnabled : hasModels;

  if (!enabled) {
    return { enabled: false };
  }

  const defaultModel = modelSelection?.modelKey ?? null;
  const models = modelList.length ? [...modelList] : defaultModel ? [defaultModel] : [];
  if (defaultModel && !models.includes(defaultModel)) {
    models.unshift(defaultModel);
  }

  if (!models.length) {
    return { enabled: false };
  }

  const statePath =
    resolveRouterStatePath(options["rl-state"], configPath) ??
    resolveRouterStatePath(rawConfig?.statePath, configPath) ??
    path.resolve(process.cwd(), ".miniphi", "indices", "prompt-router.json");

  const learnEnabled =
    typeof rawConfig?.learnEnabled === "boolean"
      ? rawConfig.learnEnabled
      : typeof rawConfig?.learn === "boolean"
        ? rawConfig.learn
        : true;

  return {
    enabled: true,
    models,
    statePath,
    promptProfiles: rawConfig?.promptProfiles ?? null,
    alpha: rawConfig?.alpha,
    gamma: rawConfig?.gamma,
    epsilon: rawConfig?.epsilon,
    epsilonMin: rawConfig?.epsilonMin ?? rawConfig?.epsilon_min,
    epsilonDecay: rawConfig?.epsilonDecay ?? rawConfig?.epsilon_decay,
    reward: rawConfig?.reward ?? null,
    learnEnabled,
    maxSteps: rawConfig?.maxSteps,
    saveIntervalMs: rawConfig?.saveIntervalMs,
  };
}

// buildPlanOperations and buildNavigationOperations moved to src/libs/core-utils.js

async function recordPlanStepInJournal(journal, sessionId, context = undefined) {
  if (!journal || !sessionId || !context?.planResult) {
    return;
  }
  const operations = buildPlanOperations(context.planResult.plan);
  const commandLine = context.command ? `\nCommand: ${context.command}` : "";
  const promptExchange = context.planResult.promptExchange ?? null;
  const links = promptExchange
    ? {
        promptExchangeId: promptExchange.id ?? null,
        promptExchangePath: promptExchange.path ?? null,
      }
    : null;
  const responseSegments = [];
  if (context.planResult.segmentBlock) {
    responseSegments.push(context.planResult.segmentBlock);
  }
  if (context.planResult.outline) {
    responseSegments.push(context.planResult.outline);
  }
  const responseSummary = responseSegments.length > 0 ? responseSegments.join("\n\n") : null;
  const responsePayload = JSON.stringify(context.planResult.plan ?? {}, null, 2);
  await journal.appendStep(sessionId, {
    label: context.label ?? "prompt-plan",
    prompt: `Objective: ${context.objective ?? "workspace task"}${commandLine}`.trim(),
    response: responsePayload,
    schemaId: context.planResult.schemaId ?? null,
    status: "plan",
    operations,
    metadata: {
      planId: context.planResult.planId ?? null,
      summary: context.planResult.summary ?? null,
      mode: context.mode ?? null,
      branch: context.planResult.branch ?? null,
      focusBranch: context.planResult.focusBranch ?? null,
      focusReason: context.planResult.focusReason ?? null,
      focusMatchedRequestedBranch: Boolean(context.planResult.focusMatchedRequestedBranch),
      focusSegmentBlock: context.planResult.focusSegmentBlock ?? null,
      nextSubpromptBranch: context.planResult.nextSubpromptBranch ?? null,
      source: context.planSource ?? null,
      recommendedTools: context.planResult.recommendedTools ?? [],
      summaryBlock: responseSummary,
      outline: context.planResult.outline ?? null,
      segmentBlock: context.planResult.segmentBlock ?? null,
      recommendationsBlock: context.planResult.recommendationsBlock ?? null,
    },
    tool_calls: context.planResult.toolCalls ?? null,
    tool_definitions: context.planResult.toolDefinitions ?? null,
    workspaceSummary: context.workspaceSummary ?? null,
    links,
  });
}

async function recordNavigationPlanInJournal(journal, sessionId, context = undefined) {
  if (!journal || !sessionId || !context?.navigationHints) {
    return;
  }
  const plan = context.navigationHints;
  const operations = buildNavigationOperations(plan);
  const promptExchange = plan.promptExchange ?? null;
  const links = promptExchange
    ? {
        promptExchangeId: promptExchange.id ?? null,
        promptExchangePath: promptExchange.path ?? null,
      }
    : null;
  const responsePayload = JSON.stringify(plan.raw ?? plan ?? {}, null, 2);
  await journal.appendStep(sessionId, {
    label: context.label ?? "navigator-plan",
    prompt: `Navigator objective: ${context.objective ?? "workspace guidance"}`,
    response: responsePayload,
    schemaId: plan.schemaId ?? null,
    status: "advisor",
    operations,
    metadata: {
      summary: plan.summary ?? null,
      helper: plan.helper ?? null,
      summaryBlock: plan.block ?? null,
    },
    tool_calls: plan.toolCalls ?? null,
    tool_definitions: plan.toolDefinitions ?? null,
    workspaceSummary: context.workspaceSummary ?? null,
    links,
  });
}

function renderPlanOutline(steps, depth = 0, lines = [], prefix = "", maxLines = 80) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return lines.length ? lines.join("\n").trimEnd() || null : null;
  }
  for (const step of steps) {
    if (lines.length >= maxLines) {
      break;
    }
    const id = step?.id ?? `${prefix || depth + 1}`;
    const title = step?.title ?? "Untitled step";
    const desc = typeof step?.description === "string" ? step.description.trim() : "";
    const flags = [];
    if (step?.requires_subprompt) {
      flags.push("sub-prompt");
    }
    if (step?.recommendation) {
      flags.push(step.recommendation);
    }
    const indent = "  ".repeat(depth);
    const flagText = flags.length ? ` (${flags.join(" | ")})` : "";
    lines.push(`${indent}${id}. ${title}${flagText}`);
    if (desc) {
      lines.push(`${indent}   - ${desc}`);
    }
    if (Array.isArray(step?.children) && step.children.length > 0) {
      renderPlanOutline(step.children, depth + 1, lines, id, maxLines);
    }
  }
  return lines.slice(0, maxLines).join("\n").trimEnd() || null;
}

function normalizePlanRecord(planRecord, branch = null) {
  if (!planRecord || typeof planRecord !== "object") {
    return null;
  }
  const planPayload = planRecord.plan ?? null;
  if (!planPayload) {
    return null;
  }
  const planId = planRecord.id ?? planPayload.plan_id ?? null;
  const outline = planRecord.outline ?? renderPlanOutline(planPayload.steps);
  const normalized = {
    planId,
    summary: planRecord.summary ?? planPayload.summary ?? null,
    plan: planPayload,
    outline,
    branch: branch || null,
    segments: Array.isArray(planRecord.segments) ? planRecord.segments : null,
    segmentBlock: planRecord.segmentBlock ?? null,
    focusBranch: planRecord.focusBranch ?? null,
    focusReason: planRecord.focusReason ?? null,
    focusMatchedRequestedBranch: Boolean(planRecord.focusMatchedRequestedBranch),
    focusSegments: Array.isArray(planRecord.focusSegments) ? planRecord.focusSegments : null,
    focusSegmentBlock: planRecord.focusSegmentBlock ?? null,
    nextSubpromptBranch: planRecord.nextSubpromptBranch ?? null,
    availableSubpromptBranches: Array.isArray(planRecord.availableSubpromptBranches)
      ? planRecord.availableSubpromptBranches
      : null,
    recommendedTools: Array.isArray(planRecord.recommendedTools) ? planRecord.recommendedTools : null,
    recommendationsBlock: planRecord.recommendationsBlock ?? null,
    schemaId: "prompt-plan",
    schemaVersion: planPayload.schema_version ?? null,
  };
  applyRequestedPlanBranchFocus(normalized, branch);
  return enrichPlanResult(normalized);
}

function enrichPlanResult(planResult) {
  if (!planResult || !planResult.plan) {
    return planResult;
  }
  if (!Array.isArray(planResult.segments) || planResult.segments.length === 0) {
    planResult.segments = buildPlanSegments(planResult.plan);
  }
  if (!planResult.segmentBlock) {
    planResult.segmentBlock =
      formatPlanSegmentsBlock(planResult.segments, { limit: 16 }) ?? null;
  }
  const focus = buildFocusedPlanSegments(planResult.segments, {
    branch: planResult.focusBranch ?? planResult.branch ?? null,
    limit: 10,
    sourceLimit: 48,
  });
  if (!planResult.focusBranch) {
    planResult.focusBranch = focus.branch ?? null;
  }
  if (!planResult.focusReason) {
    planResult.focusReason = focus.reason ?? null;
  }
  if (!Array.isArray(planResult.focusSegments) || planResult.focusSegments.length === 0) {
    planResult.focusSegments = focus.segments ?? [];
  }
  if (!planResult.focusSegmentBlock) {
    planResult.focusSegmentBlock = focus.block ?? null;
  }
  if (!planResult.nextSubpromptBranch) {
    planResult.nextSubpromptBranch = focus.nextSubpromptBranch ?? null;
  }
  if (!Array.isArray(planResult.availableSubpromptBranches)) {
    planResult.availableSubpromptBranches = focus.availableSubpromptBranches ?? [];
  }
  if (!planResult.focusMatchedRequestedBranch) {
    planResult.focusMatchedRequestedBranch = Boolean(focus.matchedRequestedBranch);
  }
  if (!Array.isArray(planResult.recommendedTools)) {
    planResult.recommendedTools = Array.isArray(planResult.plan.recommended_tools)
      ? planResult.plan.recommended_tools
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0)
      : [];
  }
  if (!planResult.recommendationsBlock) {
    planResult.recommendationsBlock =
      formatPlanRecommendationsBlock(planResult.recommendedTools) ?? null;
  }
  return planResult;
}

function applyPlanResultToWorkspace(workspaceContext, planResult, planBranch = null, planSource = null) {
  if (!planResult) {
    return workspaceContext;
  }
  const enriched = enrichPlanResult(planResult);
  return {
    ...(workspaceContext ?? {}),
    taskPlanSummary: enriched.summary ?? null,
    taskPlanId: enriched.planId ?? null,
    taskPlanOutline: enriched.outline ?? null,
    taskPlanBranch: enriched.branch ?? planBranch ?? null,
    taskPlanSource: planSource ?? null,
    taskPlanSegments: enriched.segments ?? null,
    taskPlanSegmentsBlock: enriched.segmentBlock ?? null,
    taskPlanFocusBranch: enriched.focusBranch ?? null,
    taskPlanFocusReason: enriched.focusReason ?? null,
    taskPlanFocusMatchedRequestedBranch: Boolean(enriched.focusMatchedRequestedBranch),
    taskPlanFocusSegments: enriched.focusSegments ?? null,
    taskPlanFocusSegmentBlock: enriched.focusSegmentBlock ?? null,
    taskPlanNextSubpromptBranch: enriched.nextSubpromptBranch ?? null,
    taskPlanAvailableSubpromptBranches: enriched.availableSubpromptBranches ?? [],
    taskPlanRecommendations: enriched.recommendedTools ?? [],
    taskPlanRecommendationsBlock: enriched.recommendationsBlock ?? null,
  };
}

function logPlanContext(planResult, label = "[MiniPhi][Plan]") {
  if (!planResult) {
    return;
  }
  const enriched = enrichPlanResult(planResult);
  if (enriched.segmentBlock) {
    console.log(`${label} Segments:\n${enriched.segmentBlock}`);
  }
  if (enriched.focusSegmentBlock) {
    console.log(
      `${label} Focus (${enriched.focusBranch ?? "auto"} | ${enriched.focusReason ?? "unspecified"}):\n${enriched.focusSegmentBlock}`,
    );
  }
  if (enriched.recommendationsBlock) {
    console.log(`${label} ${enriched.recommendationsBlock}`);
  }
}

function parsePlanBranchOption(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
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
      toolCalls: payload.toolCalls ?? null,
      toolDefinitions: payload.toolDefinitions ?? null,
      workspaceSummary: payload.workspaceSummary ?? null,
      links: payload.links ?? null,
      startedAt: payload.startedAt ?? null,
      finishedAt: payload.finishedAt ?? null,
    });
  }

function isLmStudioProtocolError(error) {
  if (!error) {
    return false;
  }
  return error instanceof LMStudioProtocolError || error?.name === "LMStudioProtocolError";
}

function classifyStopInfo(error) {
  if (!error) {
    return { reason: "unknown", code: null, detail: null };
  }
  if (typeof error === "object") {
    const reason = error.stopReason ?? error.stop_reason ?? null;
    if (reason) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        reason,
        code: error.stopReasonCode ?? error.stop_reason_code ?? null,
        detail: error.stopReasonDetail ?? error.stop_reason_detail ?? message ?? null,
      };
    }
  }
  if (isLmStudioProtocolError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      reason: "lmstudio-protocol",
      code: "protocol",
      detail: message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("denied by policy")) {
    return {
      reason: "command-denied",
      code: "command-denied",
      detail: message,
    };
  }
  if (normalized.includes("command execution failed")) {
    return {
      reason: "command-failed",
      code: "command-failed",
      detail: message,
    };
  }
  if (normalized.includes("session timeout") || normalized.includes("session-timeout")) {
    return {
      reason: "session-timeout",
      code: "session-timeout",
      detail: message,
    };
  }
  if (normalized.includes("tokens emitted")) {
    return {
      reason: "no-token-timeout",
      code: "no-token-timeout",
      detail: message,
    };
  }
  if (normalized.includes("timeout")) {
    return { reason: "timeout", code: "timeout", detail: message };
  }
  if (normalized.includes("cancel")) {
    return { reason: "cancelled", code: "cancelled", detail: message };
  }
  const errorInfo = classifyLmStudioError(message);
  const mentionsLmStudio =
    normalized.includes("lm studio") || normalized.includes("lmstudio");
  if (errorInfo.code !== "rest-failure" || mentionsLmStudio) {
    return {
      reason: errorInfo.reason ?? "lmstudio-error",
      code: errorInfo.code ?? "lmstudio-error",
      detail: message,
    };
  }
  return { reason: "error", code: "error", detail: message };
}

function getSessionRemainingMs(sessionDeadline) {
  if (!Number.isFinite(sessionDeadline)) {
    return null;
  }
  return sessionDeadline - Date.now();
}

function isSessionDeadlineExceeded(sessionDeadline) {
  const remainingMs = getSessionRemainingMs(sessionDeadline);
  return remainingMs !== null && remainingMs <= 0;
}

function createSessionTimeoutPromise(sessionDeadline, options = undefined) {
  if (!Number.isFinite(sessionDeadline)) {
    return { promise: null, cancel: null, remainingMs: null };
  }
  const remainingMs = sessionDeadline - Date.now();
  const onTimeout = typeof options?.onTimeout === "function" ? options.onTimeout : null;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    if (onTimeout) {
      onTimeout();
    }
    const error = new Error("session-timeout: session deadline exceeded.");
    error.name = "SessionTimeoutError";
    return {
      promise: Promise.reject(error),
      cancel: null,
      remainingMs: 0,
    };
  }
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) {
        onTimeout();
      }
      const error = new Error("session-timeout: session deadline exceeded.");
      error.name = "SessionTimeoutError";
      reject(error);
    }, remainingMs);
    timer?.unref?.();
  });
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
    }
  };
  return { promise, cancel, remainingMs };
}

function extractLmStudioProtocolMetadata(error) {
  if (error instanceof LMStudioProtocolError && error.metadata) {
    return error.metadata;
  }
  if (error && typeof error.metadata === "object") {
    return error.metadata;
  }
  return null;
}

function formatLmStudioProtocolSummary(metadata) {
  if (!metadata) {
    return "";
  }
  const parts = [];
  if (metadata.transport) {
    parts.push(`transport=${metadata.transport}`);
  }
  if (metadata.sdkVersion) {
    parts.push(`sdk=${metadata.sdkVersion}`);
  }
  if (metadata.serverVersion) {
    parts.push(`server=${metadata.serverVersion}`);
  }
  if (metadata.restBaseUrl) {
    parts.push(metadata.restBaseUrl);
  }
  return parts.join(" | ");
}

async function handleLmStudioProtocolFailure({
  error,
  mode = "runtime",
  promptJournal = null,
  promptJournalId = null,
  context = undefined,
}) {
  if (!isLmStudioProtocolError(error)) {
    return;
  }
  const metadata = extractLmStudioProtocolMetadata(error);
  const summary = formatLmStudioProtocolSummary(metadata);
  const prefix = summary
    ? `[MiniPhi] LM Studio compatibility issue (${summary})`
    : "[MiniPhi] LM Studio compatibility issue";
  console.error(`${prefix}: ${error.message}`);

  if (promptJournal && promptJournalId) {
    await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
      label: "LM Studio compatibility failure",
      prompt: null,
      response: null,
      status: "error",
      operations: [
        {
          type: "lmstudio-protocol",
          status: "failed",
          summary: error.message,
          metadata,
        },
      ],
      metadata: {
        mode,
        warning: error.message,
        lmStudio: metadata ?? null,
      },
      workspaceSummary: context?.workspaceSummary ?? null,
    });
    await promptJournal.setStatus(promptJournalId, "paused", {
      reason: "lmstudio-protocol-warning",
      warning: error.message,
      metadata,
    });
  }
}

function emitFeatureDisableNotice(label, notice) {
  if (!notice) {
    return;
  }
  const reasonLabel = getLmStudioStopReasonLabel(notice.reason) ?? notice.reason ?? "REST failure";
  const detail = notice.message ? ` (${notice.message})` : "";
  console.warn(
    `[MiniPhi] ${label} disabled after ${reasonLabel}${detail}. Re-run your command once LM Studio recovers or restart MiniPhi to re-enable it.`,
  );
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
  let implicitTaskMode = false;

  if (!COMMANDS.has(command)) {
    const extracted = extractImplicitWorkspaceTask(args);
    if (extracted.task) {
      implicitWorkspaceTask = extracted.task;
      rest = extracted.rest;
      command = "workspace";
      implicitTaskMode = true;
    } else {
      console.error(`Unknown command "${command}".`);
      printHelp();
      process.exitCode = 1;
      return;
    }
  }

  const { options, positionals } = parseArgs(rest);
  if (implicitTaskMode) {
    const cmdOverride = typeof options.cmd === "string" && options.cmd.trim().length > 0;
    const fileOverride = typeof options.file === "string" && options.file.trim().length > 0;
    if (cmdOverride) {
      command = "run";
    } else if (fileOverride) {
      command = "analyze-file";
    }
  }
  const verbose = Boolean(options.verbose);
  const streamOutput = !options["no-stream"];
  const debugLm = Boolean(options["debug-lm"]);
  process.env.MINIPHI_DEBUG_LM = debugLm ? "1" : "0";

  let configResult;
  try {
    const requestedProfile =
      typeof options.profile === "string" && options.profile.trim()
        ? options.profile.trim()
        : null;
    configResult = loadConfig(options.config, { profile: requestedProfile });
  } catch (error) {
    console.error(`[MiniPhi] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  const configData = configResult?.data ?? {};
  const configPath = configResult?.path ?? null;
  const lmStudioEndpoints = resolveLmStudioEndpoints(configData);
  if (configPath && verbose) {
    const relPath = path.relative(process.cwd(), configPath) || configPath;
    console.log(`[MiniPhi] Loaded configuration from ${relPath}`);
  }
  const activeProfile = configResult?.profileName ?? null;
  if (activeProfile) {
    const profileDetails = [];
    if (lmStudioEndpoints?.restBaseUrl) {
      profileDetails.push(`LM Studio: ${lmStudioEndpoints.restBaseUrl}`);
    }
    if (configData?.defaults?.gpu) {
      profileDetails.push(`GPU: ${configData.defaults.gpu}`);
    }
    const templateLabel =
      configData?.promptTemplates?.default ??
      configData?.promptTemplates?.active ??
      configData?.prompt?.templateId ??
      null;
    if (templateLabel) {
      profileDetails.push(`prompt template: ${templateLabel}`);
    }
    const retention = configData?.retention ?? {};
    if (retention.executions || retention.history) {
      profileDetails.push(
        `retention: exec ${retention.executions ?? "auto"}/history ${retention.history ?? "auto"}`,
      );
    }
    const summary = profileDetails.length ? profileDetails.join(" | ") : "no overrides detected";
    console.log(`[MiniPhi] Active profile "${activeProfile}" (${summary}).`);
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

  const cliContextLength = parseNumericSetting(options["context-length"], "--context-length");
  const configContextLength = parseNumericSetting(
    defaults.contextLength,
    "config.defaults.contextLength",
  );
  const defaultContextFallback = DEFAULT_CONTEXT_LENGTH;
  const contextLengthExplicit =
    cliContextLength !== undefined && cliContextLength !== null
      ? true
      : configContextLength !== undefined && configContextLength !== null
        ? configContextLength !== defaultContextFallback
        : false;
  let contextLength = cliContextLength ?? configContextLength ?? defaultContextFallback;

  const gpu = options.gpu ?? defaults.gpu ?? "auto";

  const requestedModel =
    typeof options.model === "string" && options.model.trim()
      ? options.model.trim()
      : typeof configData?.defaults?.model === "string" && configData.defaults.model.trim()
        ? configData.defaults.model.trim()
        : typeof configData?.lmStudio?.model === "string" && configData.lmStudio.model.trim()
          ? configData.lmStudio.model.trim()
          : typeof process.env.MINIPHI_MODEL === "string" && process.env.MINIPHI_MODEL.trim()
            ? process.env.MINIPHI_MODEL.trim()
            : null;
  const modelSelection = resolveModelConfig({
    model: requestedModel,
    contextLength,
    contextIsExplicit: contextLengthExplicit,
  });
  contextLength = modelSelection.contextLength;
  const resolvedSystemPrompt = promptDefaults.system ?? modelSelection.systemPrompt ?? undefined;
    if (verbose) {
      const modelLabel = modelSelection.preset?.label ?? modelSelection.modelKey;
      const aliasNote =
        modelSelection.normalizedFromAlias && requestedModel ? ` (from ${requestedModel})` : "";
      const clampNote = modelSelection.clampedToPreset ? " (preset cap)" : "";
      console.log(
        `[MiniPhi] Model ${modelLabel}${aliasNote} | Context length ${contextLength}${clampNote}`,
      );
    }

    const routerConfig = resolveRouterConfig({
      options,
      configData,
      configPath,
      modelSelection,
    });
    if (routerConfig?.enabled && verbose) {
      const modelList = routerConfig.models?.join(", ") ?? "none";
      const stateLabel = routerConfig.statePath
        ? path.relative(process.cwd(), routerConfig.statePath) || routerConfig.statePath
        : "none";
      console.log(
        `[MiniPhi] RL router enabled (models: ${modelList}; state: ${stateLabel})`,
      );
    }

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

  const hasExplicitTask = typeof options.task === "string" && options.task.trim().length > 0;
  let task = hasExplicitTask ? options.task : defaults.task ?? DEFAULT_TASK_DESCRIPTION;
  if (!hasExplicitTask && implicitWorkspaceTask) {
    task = implicitWorkspaceTask;
  }

  const skipForgottenNote = Boolean(options["no-forgotten-note"]);
  const providedForgottenNote =
    typeof options["forgotten-note"] === "string" ? options["forgotten-note"].trim() : null;
  const shouldRecordForgottenNote =
    !skipForgottenNote &&
    Boolean(providedForgottenNote) &&
    ["run", "workspace", "analyze-file"].includes(command);
  const resumeTruncationId =
    typeof options["resume-truncation"] === "string" && options["resume-truncation"].trim()
      ? options["resume-truncation"].trim()
      : null;
  const truncationChunkSelector =
    typeof options["truncation-chunk"] === "string" && options["truncation-chunk"].trim()
      ? options["truncation-chunk"].trim()
      : null;
  if (shouldRecordForgottenNote) {
    const noteContext = providedForgottenNote;
    const notePath = path.join(PROJECT_ROOT, ".miniphi", "history", "forgotten-notes.md");
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

  if (resumeTruncationId && command !== "analyze-file") {
    console.warn(
      "[MiniPhi] --resume-truncation currently only applies to analyze-file runs; option ignored.",
    );
  }
  const planBranch = parsePlanBranchOption(options["plan-branch"]);
  const refreshPlan = Boolean(options["refresh-plan"]);

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
  const autoFastMode = shouldForceFastMode({
    sessionTimeoutMs,
    promptTimeoutMs,
    mode: command,
  });
  if (autoFastMode) {
    const sessionSeconds = Math.round(sessionTimeoutMs / 1000);
    const promptSeconds = Math.round(promptTimeoutMs / 1000);
    console.warn(
      `[MiniPhi] Session timeout ${sessionSeconds}s <= prompt timeout ${promptSeconds}s; skipping planner/navigator to preserve analysis time.`,
    );
  }

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

  const resolvedLmStudioBaseUrl = lmStudioEndpoints?.restBaseUrl ?? null;
  const resolvedLmStudioWsBase = lmStudioEndpoints?.wsBaseUrl ?? null;
  const isLmStudioLocal = lmStudioEndpoints?.isLocal ?? true;
  const transportPreference = resolveLmStudioTransportPreference(configData);
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
  let restClient = null;

  const healthConfig = configData?.lmStudio?.health ?? {};
  const healthEnabledConfig = parseBooleanFlag(healthConfig.enabled ?? healthConfig.enable);
  const healthDisabledFlag = parseBooleanFlag(options["no-health"]);
  let healthGateEnabled =
    healthDisabledFlag === true
      ? false
      : healthEnabledConfig !== null
        ? healthEnabledConfig
        : true;
  if (transportPreference.mode === "ws" && !transportPreference.forceRest) {
    if (healthGateEnabled && verbose) {
      console.warn(
        "[MiniPhi] LM Studio health gate skipped because transport is set to WS.",
      );
    }
    healthGateEnabled = false;
  }
  const resolvedHealthTimeoutMs =
    resolveDurationMs({
      secondsValue: healthConfig.timeoutSeconds ?? healthConfig.timeout,
      secondsLabel: "config.lmStudio.health.timeoutSeconds",
      millisValue: healthConfig.timeoutMs,
      millisLabel: "config.lmStudio.health.timeoutMs",
    }) ?? 10000;
  const healthGate = {
    enabled: healthGateEnabled,
    timeoutMs: resolvedHealthTimeoutMs,
    label: healthConfig.label ?? "health-gate",
  };

  if (command === "web-research") {
    await handleWebResearch({ options, positionals, verbose });
    return;
  }

  if (command === "web-browse") {
    await handleWebBrowse({ options, positionals, verbose, configData });
    return;
  }

  if (command === "history-notes") {
    await handleHistoryNotes({ options, verbose });
    return;
  }

  if (command === "command-library") {
    await handleCommandLibrary({ options, verbose });
    return;
  }

  if (command === "helpers") {
    await handleHelpersCommand({ options, verbose });
    return;
  }

  if (command === "cache-prune") {
    await handleCachePruneCommand({ options, verbose, configData });
    return;
  }

  if (command === "lmstudio-health") {
    await handleLmStudioHealthCommand({
      options,
      verbose,
      configData,
      modelSelection,
      restBaseUrl: resolvedLmStudioBaseUrl,
    });
    return;
  }

  // "recompose" command is ONLY for development testing purposes, like "benchmark". 
  if (command === "recompose") { 
    await handleRecomposeCommand({
      options,
      positionals,
      verbose,
      configData,
      promptDefaults,
      contextLength,
      debugLm,
      gpu,
      schemaRegistry,
      systemPrompt: resolvedSystemPrompt,
      modelKey: modelSelection.modelKey,
      promptDbPath: globalMemory.promptDbPath,
    });
    return;
  }
  if (command === "benchmark") {
    await handleBenchmarkCommand({
      options,
      positionals,
      verbose,
      configData,
      promptDefaults,
      contextLength,
      debugLm,
      gpu,
      schemaRegistry,
      systemPrompt: resolvedSystemPrompt,
      modelKey: modelSelection.modelKey,
      restClient,
      resourceConfig,
      resourceMonitorForcedDisabled,
      promptDbPath: globalMemory.promptDbPath,
      generateWorkspaceSnapshot,
      globalMemory,
      schemaAdapterRegistry,
      mirrorPromptTemplateToGlobal,
      emitFeatureDisableNotice,
    });
    return;
  }

  if (command === "prompt-template") {
    await handlePromptTemplateCommand({
      options,
      verbose,
      schemaRegistry,
      generateWorkspaceSnapshot,
      globalMemory,
      mirrorPromptTemplateToGlobal,
    });
    return;
  }

  let phi4 = null;
  let performanceTracker = null;
  let scoringPhi = null;
    const lmStudioRuntime = await createLmStudioRuntime({
      configData,
      promptDefaults,
      resolvedSystemPrompt,
      modelSelection,
      contextLength,
      contextLengthExplicit,
      gpu,
      debugLm,
      verbose,
      schemaRegistry,
      promptDbPath: globalMemory.promptDbPath,
      isLmStudioLocal,
      restBaseUrl: resolvedLmStudioBaseUrl,
      wsBaseUrl: resolvedLmStudioWsBase,
      routerConfig,
    });
  if (
    Number.isFinite(lmStudioRuntime?.resolvedContextLength) &&
    lmStudioRuntime.resolvedContextLength > 0
  ) {
    contextLength = lmStudioRuntime.resolvedContextLength;
    modelSelection.contextLength = lmStudioRuntime.resolvedContextLength;
  }
  phi4 = lmStudioRuntime.phi4;
  restClient = lmStudioRuntime.restClient;
  performanceTracker = lmStudioRuntime.performanceTracker;
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
  const isNavigatorCliCommand = (command) => {
    if (!command || typeof command !== "string") {
      return false;
    }
    const trimmed = command.trim();
    if (!trimmed) {
      return false;
    }
    const tokens = trimmed.split(/\s+/);
    const normalizedTokens = tokens.map((token) => token.replace(/^["']|["']$/g, ""));
    const firstToken = normalizedTokens[0];
    if (COMMANDS.has(firstToken)) {
      return true;
    }
    if (firstToken === "miniphi") {
      return true;
    }
    if (firstToken === "npx" && normalizedTokens[1] === "miniphi") {
      return true;
    }
    if (firstToken === "node" && normalizedTokens[1]) {
      const target = normalizedTokens[1].replace(/\\/g, "/");
      if (target.endsWith("/src/index.js") || target.endsWith("src/index.js")) {
        const subcommand = normalizedTokens[2] ?? null;
        if (!subcommand || COMMANDS.has(subcommand)) {
          return true;
        }
      }
    }
    return false;
  };
  const navigatorRequestTimeoutMs =
    resolveDurationMs({
      secondsValue:
        configData?.lmStudio?.prompt?.navigator?.timeoutSeconds ??
        configData?.prompt?.navigator?.timeoutSeconds,
      millisValue:
        configData?.lmStudio?.prompt?.navigator?.timeout ??
        configData?.prompt?.navigator?.timeout,
      secondsLabel: "config.prompt.navigator.timeoutSeconds",
      millisLabel: "config.prompt.navigator.timeout",
    }) ?? 60000;
  const buildNavigator = (memoryInstance, promptRecorderOverride = null) =>
    restClient
      ? new ApiNavigator({
          restClient,
          cliExecutor: cli,
          memory: memoryInstance ?? null,
          globalMemory,
          logger: verbose ? (message) => console.warn(message) : null,
          adapterRegistry: schemaAdapterRegistry,
          schemaRegistry,
          promptRecorder: promptRecorderOverride ?? promptRecorder,
          helperSilenceTimeoutMs: configData?.prompt?.navigator?.helperSilenceTimeoutMs,
          navigationRequestTimeoutMs: navigatorRequestTimeoutMs,
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
      if (isSessionDeadlineExceeded(sessionDeadline)) {
        followUps.push({
          command: entry.command,
          skipped: true,
          danger: entry.danger,
          reason: "session-timeout",
        });
        if (promptJournal && promptJournalId) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `Navigator follow-up skipped: ${entry.command}`,
            prompt: `Navigator suggested ${entry.command}`,
            response: null,
            status: "skipped",
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: entry.danger,
                status: "skipped",
                summary: "Navigator follow-up skipped after session timeout",
              },
            ],
            metadata: {
              mode: "navigator-follow-up",
              parent: baseMetadata?.parentCommand ?? null,
              reason: "session-timeout",
            },
            workspaceSummary: workspaceContext?.summary ?? null,
          });
        }
        continue;
      }
      if (isNavigatorCliCommand(entry.command)) {
        if (verbose) {
          console.warn(`[MiniPhi] Navigator follow-up skipped (CLI-only): ${entry.command}`);
        }
        followUps.push({
          command: entry.command,
          skipped: true,
          danger: entry.danger,
          reason: "cli-command",
        });
        if (promptJournal && promptJournalId) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `Navigator follow-up skipped: ${entry.command}`,
            prompt: `Navigator suggested ${entry.command}`,
            response: null,
            status: "skipped",
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: entry.danger,
                status: "skipped",
                summary: "Navigator follow-up skipped (CLI-only command)",
              },
            ],
            metadata: {
              mode: "navigator-follow-up",
              parent: baseMetadata?.parentCommand ?? null,
              reason: "cli-command",
            },
            workspaceSummary: workspaceContext?.summary ?? null,
          });
        }
        continue;
      }
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
              promptJournalId: promptJournalId ?? null,
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
          const promptExchange = followUpResult.promptExchange ?? null;
          const links = promptExchange
            ? {
                promptExchangeId: promptExchange.id ?? null,
                promptExchangePath: promptExchange.path ?? null,
              }
            : null;
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
              salvage: followUpResult?.analysisDiagnostics?.salvage ?? null,
              fallbackReason: followUpResult?.analysisDiagnostics?.fallbackReason ?? null,
            },
            workspaceSummary: workspaceContext?.summary ?? null,
            links,
            startedAt: followUpResult.startedAt ?? null,
            finishedAt: followUpResult.finishedAt ?? null,
          });
        }
      } catch (error) {
        if (isLmStudioProtocolError(error)) {
          await handleLmStudioProtocolFailure({
            error,
            mode: "navigator-follow-up",
            promptJournal,
            promptJournalId,
            context: { workspaceSummary: workspaceContext?.summary ?? null },
          });
          throw error;
        }
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
  const runTruncationPlanHelpers = async ({
    planRecord,
    chunk,
    chunkKey,
    cwd,
    workspaceContext,
    summaryLevels,
    streamOutput,
    timeout,
    sessionDeadline,
    promptGroupId,
    promptJournal,
    promptJournalId,
    planExecutionId = null,
  }) => {
    if (!planRecord || !chunk) {
      return [];
    }
    const seen = new Set();
    const helpers = [];
    const register = (command, scope) => {
      if (typeof command !== "string") {
        return;
      }
      const trimmed = command.trim();
      if (!trimmed || seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      helpers.push({ command: trimmed, scope });
    };
    const planHelpers = planRecord.plan?.helperCommands ?? [];
    planHelpers.forEach((cmd) => register(cmd, "plan"));
    const chunkHelpers = chunk.helperCommands ?? [];
    chunkHelpers.forEach((cmd) => register(cmd, "chunk"));
    if (!helpers.length) {
      return [];
    }
    const MAX_HELPERS = 2;
    const results = [];
    for (const entry of helpers.slice(0, MAX_HELPERS)) {
      if (isSessionDeadlineExceeded(sessionDeadline)) {
        results.push({
          command: entry.command,
          status: "skipped",
          note: "session-timeout",
        });
        if (promptJournal && promptJournalId) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `Truncation helper skipped: ${entry.command}`,
            prompt: `Helper command suggested by truncation plan (${chunk.goal ?? chunk.label ?? chunkKey ?? "chunk"})`,
            response: null,
            status: "skipped",
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: "mid",
                status: "skipped",
                summary: "Truncation helper skipped after session timeout",
              },
            ],
            metadata: {
              mode: "truncation-helper",
              chunk: chunk.goal ?? chunk.label ?? chunkKey ?? null,
              planExecutionId,
              reason: "session-timeout",
            },
            workspaceSummary: workspaceContext?.summary ?? null,
          });
        }
        continue;
      }
      if (!isNavigatorCommandSafe(entry.command)) {
        if (verbose) {
          console.warn(`[MiniPhi] Truncation helper command blocked: ${entry.command}`);
        }
        results.push({
          command: entry.command,
          status: "blocked",
          note: "blocked by policy",
        });
        if (promptJournal && promptJournalId) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `Truncation helper blocked: ${entry.command}`,
            prompt: `Helper command suggested by truncation plan (${chunk.goal ?? chunk.label ?? chunkKey ?? "chunk"})`,
            response: null,
            status: "skipped",
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: "mid",
                status: "blocked",
                summary: "Truncation helper blocked by policy",
              },
            ],
            metadata: {
              mode: "truncation-helper",
              chunk: chunk.goal ?? chunk.label ?? chunkKey ?? null,
              planExecutionId,
              reason: "blocked",
            },
            workspaceSummary: workspaceContext?.summary ?? null,
          });
        }
        continue;
      }
        try {
          const helperTask = `Truncation helper: ${entry.command}`;
          const helperResult = await analyzer.analyzeCommandOutput(entry.command, helperTask, {
            summaryLevels,
            streamOutput,
          cwd,
          timeout,
          sessionDeadline,
          workspaceContext,
          promptContext: {
            scope: "sub",
            label: helperTask,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "truncation-helper",
              chunk: chunk.goal ?? chunk.label ?? chunkKey ?? null,
              planExecutionId,
              promptJournalId: promptJournalId ?? null,
              workspaceType:
                workspaceContext?.classification?.domain ??
                workspaceContext?.classification?.label ??
                null,
            },
          },
          commandDanger: "mid",
          commandSource: "truncation-plan",
          authorizationContext: {
            reason: `Truncation helper for ${chunk.goal ?? chunk.label ?? chunkKey ?? "chunk"}`,
            hint: entry.scope === "chunk" ? "chunk-specific helper" : "plan helper",
          },
        });
          results.push({
            command: entry.command,
            status: "executed",
            linesAnalyzed: helperResult.linesAnalyzed ?? null,
            fallbackReason: helperResult?.analysisDiagnostics?.fallbackReason ?? null,
          });
          if (promptJournal && promptJournalId) {
            const promptExchange = helperResult.promptExchange ?? null;
            const links = promptExchange
              ? {
                  promptExchangeId: promptExchange.id ?? null,
                  promptExchangePath: promptExchange.path ?? null,
                }
              : null;
            await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
              label: helperTask,
              prompt: helperResult.prompt,
              response: helperResult.analysis,
              schemaId: helperResult.schemaId ?? null,
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: "mid",
                status: "executed",
                summary: `Helper command captured ${helperResult.linesAnalyzed ?? 0} lines`,
              },
            ],
            metadata: {
              mode: "truncation-helper",
              chunk: chunk.goal ?? chunk.label ?? chunkKey ?? null,
              planExecutionId,
                scope: entry.scope,
                salvage: helperResult?.analysisDiagnostics?.salvage ?? null,
                fallbackReason: helperResult?.analysisDiagnostics?.fallbackReason ?? null,
              },
              workspaceSummary: workspaceContext?.summary ?? null,
              links,
              startedAt: helperResult.startedAt ?? null,
              finishedAt: helperResult.finishedAt ?? null,
            });
          }
        } catch (error) {
        if (isLmStudioProtocolError(error)) {
          await handleLmStudioProtocolFailure({
            error,
            mode: "truncation-helper",
            promptJournal,
            promptJournalId,
            context: { workspaceSummary: workspaceContext?.summary ?? null },
          });
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          command: entry.command,
          status: "failed",
          note: message,
        });
        if (promptJournal && promptJournalId) {
          await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
            label: `Truncation helper failed: ${entry.command}`,
            prompt: `Helper command suggested by truncation plan (${chunk.goal ?? chunk.label ?? chunkKey ?? "chunk"})`,
            response: null,
            status: "error",
            operations: [
              {
                type: "command",
                command: entry.command,
                danger: "mid",
                status: "failed",
                summary: message,
              },
            ],
            metadata: {
              mode: "truncation-helper",
              chunk: chunk.goal ?? chunk.label ?? chunkKey ?? null,
              planExecutionId,
            },
            workspaceSummary: workspaceContext?.summary ?? null,
          });
        }
      }
    }
    return results;
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
      schemaRegistry,
    });
  const emitDecomposerNoticeIfNeeded = () => {
    if (promptDecomposer && typeof promptDecomposer.consumeDisableNotice === "function") {
      const notice = promptDecomposer.consumeDisableNotice();
      if (notice) {
        emitFeatureDisableNotice("Prompt decomposer", notice);
      }
    }
  };

    let stateManager;
    let promptRecorder = null;
    let promptJournal = null;
    let promptJournalFinalized = false;
    let stopReason = null;
    let stopReasonCode = null;
    let stopReasonDetail = null;
    let stopStatus = null;
    let stopError = null;
    let sessionTimeoutTriggered = false;
    let result;
    let workspaceContext = null;
  const archiveMetadata = {
    promptId,
    model: modelSelection.modelKey,
    contextLength,
  };
    let resourceMonitor;
    let resourceSummary = null;
    const finalizePromptJournal = async (noteOverrides = undefined) => {
      if (!promptJournal || !promptJournalId || promptJournalFinalized) {
        return;
      }
      const finalJournalStatus = promptJournalStatus ?? "paused";
      const note = {
        mode: command,
        completedAt: new Date().toISOString(),
        ...(noteOverrides ?? {}),
      };
      await promptJournal.setStatus(promptJournalId, finalJournalStatus, note);
      promptJournalFinalized = true;
    };
    const initializeResourceMonitor = async (label, historyFileOverride = undefined) => {
      if (resourceMonitorForcedDisabled || resourceMonitor) {
        return;
      }
      const historyFile = historyFileOverride ?? stateManager?.resourceUsageFile ?? null;
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
    memory: options?.memory ?? null,
    globalMemory: options?.globalMemory ?? globalMemory,
    indexLimit: options?.indexLimit,
    benchmarkLimit: options?.benchmarkLimit,
    mode: options?.mode ?? null,
    schemaId: options?.schemaId ?? null,
    focusPath: options?.focusPath ?? null,
    promptId: options?.promptId ?? null,
    promptJournalId: options?.promptJournalId ?? null,
    sessionDeadline: options?.sessionDeadline ?? null,
    emitFeatureDisableNotice,
  });

  const runCommandFlow = async () => {
    if (healthGate.enabled) {
      const healthCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
      const healthMemory = new MiniPhiMemory(healthCwd);
      await healthMemory.prepare();
      const healthResult = await probeLmStudioHealth({
        configData,
        modelSelection,
        restBaseUrl: resolvedLmStudioBaseUrl,
        timeoutMs: healthGate.timeoutMs,
      });
      await healthMemory.recordLmStudioStatus(healthResult.snapshot, {
        label: healthGate.label,
      });
      if (healthResult.warning && verbose) {
        console.warn(`[MiniPhi] LM Studio health warning: ${healthResult.warning}`);
      }
      if (!healthResult.ok) {
        const reason = healthResult.stopInfo?.reason ?? "lmstudio-health";
        const detail =
          healthResult.stopInfo?.detail ?? healthResult.snapshot.error ?? "Unknown error";
        const healthError = new Error(`LM Studio health check failed (${reason}): ${detail}`);
        healthError.stopReason = reason;
        healthError.stopReasonCode = healthResult.stopInfo?.code ?? null;
        healthError.stopReasonDetail = detail;
        await healthMemory.persistExecutionStop({
          mode: command,
          task,
          command: typeof options.cmd === "string" ? options.cmd : null,
          filePath: typeof options.file === "string" ? options.file : null,
          cwd: healthCwd,
          summaryLevels,
          contextLength,
          promptId,
          status: "failed",
          stopReason: healthError.stopReason,
          stopReasonCode: healthError.stopReasonCode,
          stopReasonDetail: healthError.stopReasonDetail,
          error: healthError.message,
        });
        throw healthError;
      }
      const healthContextLength = extractLmStudioContextLength(healthResult.status);
      if (
        Number.isFinite(healthContextLength) &&
        healthContextLength > 0 &&
        !contextLengthExplicit &&
        contextLength > healthContextLength
      ) {
        if (verbose) {
          console.log(
            `[MiniPhi] LM Studio reports context length ${healthContextLength}; clamping from ${contextLength}.`,
          );
        }
        contextLength = healthContextLength;
        modelSelection.contextLength = healthContextLength;
        if (restClient?.setDefaultModel) {
          restClient.setDefaultModel(modelSelection.modelKey, healthContextLength);
        }
      }
    }

    await lmStudioRuntime.load({ contextLength, gpu });
    scoringPhi = lmStudioRuntime.scoringPhi;

    const commandContext = {
      command,
      options,
      positionals,
      task,
      implicitWorkspaceTask,
      promptId,
      promptGroupId,
      promptJournalId,
      promptJournalStatus,
      planBranch,
      refreshPlan,
      configData,
      defaults,
      verbose,
      restClient,
      phi4,
      analyzer,
      globalMemory,
      promptDecomposer,
      schemaRegistry,
      systemPrompt: resolvedSystemPrompt,
      contextLength,
      gpu,
      lmStudioManager: lmStudioRuntime.manager ?? null,
      performanceTracker,
      routerConfig,
      summaryLevels,
      streamOutput,
      timeout,
      sessionDeadline,
      forceFastMode: autoFastMode,
      chunkSize,
      resumeTruncationId,
      truncationChunkSelector,
      archiveMetadata,
      DEFAULT_TASK_DESCRIPTION,
      parseDirectFileReferences,
      mergeFixedReferences,
      attachCommandLibraryToWorkspace,
      attachPromptCompositionsToWorkspace,
      applyPlanResultToWorkspace,
      logPlanContext,
      recordPlanStepInJournal,
      recordNavigationPlanInJournal,
      emitDecomposerNoticeIfNeeded,
      normalizePlanRecord,
      buildNavigator,
      recordLmStudioStatusSnapshot,
      describeWorkspace,
      initializeResourceMonitor,
      runNavigatorFollowUps,
      recordAnalysisStepInJournal,
      handleLmStudioProtocolFailure,
      attachContextRequestsToResult,
      isLmStudioProtocolError,
      runTruncationPlanHelpers,
      ensureTruncationProgressEntry,
      persistTruncationProgressSafe,
      computeTruncationProgress,
      findNextIncompleteChunk,
      buildTruncationChunkKey,
      selectTruncationChunk,
      buildLineRangeFromChunk,
      describeTruncationChunk,
      isTruncationChunkCompleted,
      stateManager,
      promptRecorder,
      promptJournal,
      workspaceContext,
      result,
    };

    if (command === "workspace") {
      await handleWorkspaceCommand(commandContext);
      task = commandContext.task;
      stateManager = commandContext.stateManager;
      promptRecorder = commandContext.promptRecorder;
      promptJournal = commandContext.promptJournal;
      workspaceContext = commandContext.workspaceContext;
      return;
    }

    if (command === "nitpick") {
      await handleNitpickCommand(commandContext);
      return;
    }

    if (command === "run") {
      await handleRunCommand(commandContext);
    } else if (command === "analyze-file") {
      await handleAnalyzeFileCommand(commandContext);
    }

    task = commandContext.task;
    stateManager = commandContext.stateManager;
    promptRecorder = commandContext.promptRecorder;
    promptJournal = commandContext.promptJournal;
    workspaceContext = commandContext.workspaceContext;
    result = commandContext.result;

    await stopResourceMonitorIfNeeded();

    if (stateManager && result) {
      const analysisStopReason =
        result?.analysisDiagnostics?.stopReason ??
        result?.analysisDiagnostics?.fallbackReason ??
        null;
      const finalStatus = stopStatus ?? "completed";
      const finalStopReason = stopReason ?? analysisStopReason ?? "completed";
      const finalError = stopError ?? result?.analysisDiagnostics?.stopReasonDetail ?? null;
      const archive = await stateManager.persistExecution({
        executionId: archiveMetadata.executionId ?? null,
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
        truncationPlan: result?.truncationPlan ?? null,
        status: finalStatus,
        stopReason: finalStopReason,
        stopReasonCode: result?.analysisDiagnostics?.stopReasonCode ?? null,
        stopReasonDetail: result?.analysisDiagnostics?.stopReasonDetail ?? null,
        error: finalError,
      });
      if (archive && options.verbose) {
        const relativePath = path.relative(process.cwd(), archive.path);
        console.log(`[MiniPhi] Execution archived under ${relativePath || archive.path}`);
      }
      if (archive?.id && result?.truncationPlan?.plan) {
        console.log(
          `[MiniPhi] Saved truncation plan for execution ${archive.id}. Resume with --resume-truncation ${archive.id} when applying the chunking strategy.`,
        );
      }
      if (archive?.id && result) {
        const workspaceTypeLabel =
          workspaceContext?.classification?.label ??
          workspaceContext?.classification?.domain ??
          null;
        const planId = workspaceContext?.taskPlanId ?? null;
        const compositionStatus =
          result?.schemaValid === false
            ? "invalid"
            : result?.analysisDiagnostics?.fallbackReason
              ? "fallback"
              : "ok";
        await recordCompositionSnapshot(
          {
            executionId: archive.id,
            schemaId: result?.schemaId ?? null,
            command: archiveMetadata.command ?? null,
            task,
            mode: command,
            workspaceType: workspaceTypeLabel,
            contextBudget: contextLength,
            compressedTokens: result?.compressedTokens ?? null,
            promptId: promptGroupId ?? null,
            planId,
            fallbackReason: result?.analysisDiagnostics?.fallbackReason ?? null,
            status: compositionStatus,
            source: "analysis",
          },
          stateManager,
          globalMemory,
          { verbose: options.verbose },
        );
      }
      if (archive?.id && result?.analysis) {
        const learnedCommands = extractRecommendedCommandsFromAnalysis(result.analysis);
        if (learnedCommands.length) {
          const validationStatus = result?.schemaValid === false ? "invalid" : "ok";
          const workspaceTypeLabel =
            workspaceContext?.classification?.label ??
            workspaceContext?.classification?.domain ??
            null;
          await stateManager.recordCommandIdeas({
            executionId: archive.id,
            task,
            mode: command,
            commands: learnedCommands,
            source: "analysis",
            schemaId: result?.schemaId ?? null,
            contextBudget: contextLength,
            validationStatus,
          });
          await globalMemory.recordCommandIdeas?.({
            commands: learnedCommands,
            source: "analysis",
            task,
            mode: command,
            schemaId: result?.schemaId ?? null,
            contextBudget: contextLength,
            validationStatus,
            workspaceType: workspaceTypeLabel,
          });
          if (options.verbose) {
            console.log(
              `[MiniPhi] Learned ${learnedCommands.length} recommended command${
                learnedCommands.length === 1 ? "" : "s"
              } from the analysis output.`,
            );
          }
        }
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
            modelSummary: result.summary ?? null,
            modelSummaryUpdates: result.summaryUpdates ?? null,
          },
          null,
          2,
        ),
      );
    }
  };

  try {
    const timeoutGuard = createSessionTimeoutPromise(sessionDeadline, {
      onTimeout: () => {
        sessionTimeoutTriggered = true;
      },
    });
    if (timeoutGuard.promise) {
      try {
        await Promise.race([runCommandFlow(), timeoutGuard.promise]);
      } finally {
        timeoutGuard.cancel?.();
      }
    } else {
      await runCommandFlow();
    }
  } catch (error) {
    stopStatus = "failed";
    const stopInfo = classifyStopInfo(error);
    stopReason = stopInfo.reason;
    stopReasonCode = stopInfo.code ?? null;
    stopReasonDetail = stopInfo.detail ?? null;
    stopError = stopInfo.detail ?? (error instanceof Error ? error.message : String(error));
    console.error(`[MiniPhi] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    try {
      if (result) {
        const analysisStopReason =
          result?.analysisDiagnostics?.stopReason ??
          result?.analysisDiagnostics?.fallbackReason ??
          null;
        const finalStopReason = stopReason ?? analysisStopReason ?? "completed";
        const finalStopReasonCode =
          stopReasonCode ?? result?.analysisDiagnostics?.stopReasonCode ?? null;
        const finalStopReasonDetail =
          stopReasonDetail ?? result?.analysisDiagnostics?.stopReasonDetail ?? null;
        await finalizePromptJournal({
          stopReason: finalStopReason,
          stopReasonCode: finalStopReasonCode,
          stopReasonDetail: finalStopReasonDetail,
        });
      }

      await stopResourceMonitorIfNeeded();
      if (stateManager) {
        await stateManager.persistExecutionStop({
          executionId: archiveMetadata.executionId ?? null,
          mode: command,
          task,
          command: archiveMetadata.command,
          filePath: archiveMetadata.filePath,
          cwd: archiveMetadata.cwd,
          summaryLevels,
          contextLength,
          resourceUsage: resourceSummary?.summary ?? null,
          promptId,
          status: stopStatus,
          stopReason,
          stopReasonCode,
          stopReasonDetail,
          error: stopError,
        });
      }
    } catch (persistError) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to persist failure record: ${
            persistError instanceof Error ? persistError.message : persistError
          }`,
        );
      }
    }
  } finally {
    if (promptId && stateManager) {
      try {
        await stateManager.savePromptSession(promptId, phi4.getHistory());
      } catch (error) {
        if (verbose) {
          console.warn(
            `[MiniPhi] Unable to persist prompt session: ${
              error instanceof Error ? error.message : error
            }`,
          );
        }
      }
    }
    try {
      const analysisStopReason =
        result?.analysisDiagnostics?.stopReason ??
        result?.analysisDiagnostics?.fallbackReason ??
        null;
      const finalStopReason = stopReason ?? analysisStopReason ?? "completed";
      const finalStopReasonCode =
        stopReasonCode ?? result?.analysisDiagnostics?.stopReasonCode ?? null;
      const finalStopReasonDetail =
        stopReasonDetail ?? result?.analysisDiagnostics?.stopReasonDetail ?? null;
      await finalizePromptJournal({
        stopReason: finalStopReason,
        stopReasonCode: finalStopReasonCode,
        stopReasonDetail: finalStopReasonDetail,
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to finalize prompt journal: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    try {
      await stopResourceMonitorIfNeeded();
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to stop resource monitor: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    try {
      await phi4.eject();
    } catch {
      // no-op
    }
    if (scoringPhi) {
      try {
        await scoringPhi.eject();
      } catch {
        // no-op
      }
    }
    if (performanceTracker) {
      try {
        await performanceTracker.dispose();
      } catch {
        // no-op
      }
    }
  }

  if (sessionTimeoutTriggered) {
    process.exitCode = 1;
    const exitTimer = setTimeout(() => {
      process.exit(1);
    }, 1000);
    exitTimer?.unref?.();
  }
}





function parseArgs(tokens) {
  const options = {};
  const positionals = [];
  const shortValueFlags = {
    c: "cmd",
    t: "task",
    f: "file",
    p: "python-script",
    m: "model",
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

function printHelp() {
  console.log(`MiniPhi CLI

Usage:
  node src/index.js run --cmd "npm test" --task "Analyze failures"
  node src/index.js analyze-file --file ./logs/output.log --task "Summarize log"
  node src/index.js lmstudio-health --timeout 10
  node src/index.js web-research "phi-4 roadmap" --max-results 5
  node src/index.js web-browse --url "https://example.com" --max-chars 4000
  node src/index.js history-notes --label "post benchmark"
  node src/index.js nitpick --task "Write 2000 words about X" --writer-model phi-4 --critic-model granite-4-h-tiny
  node src/index.js command-library --limit 10
  node src/index.js helpers --limit 6
  node src/index.js cache-prune --dry-run
  node src/index.js workspace --task "Plan README refresh"
  node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean
  node src/index.js benchmark recompose --directions roundtrip,code-to-markdown --repeat 3
  node src/index.js prompt-template --baseline truncation --task "Teach me how to chunk jest logs"

Options:
  --cmd <command>              Command to execute in run mode
  --file <path>                File to analyze in analyze-file mode
  --task <description>         Task instructions for the model
  --config <path>              Path to optional config.json (searches upward by default)
  --profile <name>             Named config profile to apply from config.json
  --cwd <path>                 Working directory for --cmd
  --summary-levels <n>         Depth for recursive summarization (default: 3)
  --context-length <tokens>    Override model context length (default: model preset)
  --model <id>                 LM Studio model key or alias (mistralai/devstral-small-2-2512, ibm/granite-4-h-tiny, phi-4)
  --rl-router                 Enable adaptive RL prompt routing (multi-model pool)
  --rl-models <list>          Comma-separated model keys to route between
  --rl-state <path>           Router Q-table JSON path (default: .miniphi/indices/prompt-router.json)
  --gpu <mode>                 GPU setting forwarded to LM Studio (default: auto)
  --timeout <s>                Command timeout in seconds (default: 60)
  --max-memory-percent <n>     Trigger warnings when RAM usage exceeds <n>%
  --max-cpu-percent <n>        Trigger warnings when CPU usage exceeds <n>%
  --max-vram-percent <n>       Trigger warnings when VRAM usage exceeds <n>%
  --resource-sample-interval <ms>  Resource sampling cadence (default: 5000)
  --forgotten-note <text>      Optional note recorded to .miniphi/history/forgotten-notes.md
  --no-forgotten-note          Skip recording the optional note (overrides --forgotten-note)
  --python-script <path>       Custom path to log_summarizer.py
  --chunk-size <lines>         Chunk size when analyzing files (default: 2000)
  --resume-truncation <id>     Reuse the truncation plan recorded for a previous analyze-file execution
  --truncation-chunk <value>   Focus a specific chunk when resuming (priority/index/substring)
  --verbose                    Print progress details
  --no-stream                  Disable live streaming of model output
  --no-summary                 Skip JSON summary footer
  --no-health                  Skip the LM Studio health gate before prompting
  --prompt-id <id>             Attach/continue a prompt session (persists LM history)
  --plan-branch <id>           Focus a saved decomposition branch when reusing --prompt-id
  --refresh-plan               Force a fresh plan even if one exists for the prompt session
  --prompt-journal [id]        Mirror each Phi/API step + operations into .miniphi/prompt-exchanges/stepwise
  --prompt-journal-status <s>  Finalize the journal as active|paused|completed|closed (default: completed)
  --session-timeout <s>        Hard limit (seconds) for the entire MiniPhi run (optional)
  --no-navigator               Skip navigator prompts and follow-up commands
  --debug-lm                   Print each objective + prompt when scoring is running
  --command-policy <mode>      Command authorization: ask | session | allow | deny (default: ask)
  --assume-yes                 Auto-approve prompts when the policy is ask/session
  --command-danger <level>     Danger classification for --cmd (low | mid | high; default: mid)
  --workspace-overview-timeout <s>   Workspace overview prompt timeout (seconds; default 120s for recompose)
  --workspace-overview-timeout-ms <ms>  Workspace overview prompt timeout (milliseconds override)
  (Free-form tasks default to workspace mode; add --cmd or --file to route to run/analyze-file.)

Prompt template baselines:
  --baseline <name>            Baseline template id to scaffold (default: truncation)
  --dataset-summary <text>     Short description of the oversized dataset/logs
  --total-lines <n>            Approximate number of lines captured in the dataset
  --target-lines <n>           Desired per-chunk line budget for truncation_strategy
  --history-keys <list>        Comma/pipe-separated JSON keys to persist between prompts
  --helper-focus <list>        Comma/pipe-separated helper commands/tools to emphasize
  --schema-id <id>             Schema identifier to embed (default: log-analysis)
  --label <text>               Friendly label stored with the template artifact
  --output <path>              Persist the generated prompt text to a separate file
  --no-workspace               Skip workspace profiling when drafting the template
  --notes <text>               Extra reminders appended to the prompt body

Command library:
  --limit <n>                  Number of commands to display (default: 12)
  --search <text>              Filter commands by substring match
  --tag <text>                 Filter commands by tag name
  --json                       Output JSON instead of human-readable text
  --cwd <path>                 Override which workspace library to inspect (default: cwd)

Helper scripts:
  --limit <n>                  Number of helpers to display (default: 12)
  --search <text>              Filter helpers by substring match
  --workspace-type <text>      Filter helpers by detected workspace classification
  --source <text>              Filter helpers by origin (api-navigator, manual, etc.)
  --json                       Output JSON instead of human-readable text
  --run <id>                   Execute a helper by id (accepts helper name or slug)
  --version <n>                Pin a historical helper version while running
  --stdin <text>               Provide stdin content when re-running the helper
  --stdin-file <path>          Read stdin content from a file
  --helper-timeout <ms>        Kill helper execution after N milliseconds (default: 60000)
  --helper-silence-timeout <ms>  Abort helper execution when no output is seen for N milliseconds (default: 15000)
  --helper-cwd <path>          Override the working directory when re-running helpers

Web research:
  --query <text>               Query string (can be repeated or passed as positional)
  --query-file <path>          File containing newline-delimited queries
  --provider <name>            Research provider (default: duckduckgo)
  --max-results <n>            Limit number of results per query (default: 6)
  --include-raw                Persist raw provider payload into the saved snapshot
  --no-save                    Do not store the research snapshot under .miniphi/research
  --note <text>                Optional annotation attached to the research snapshot

LM Studio health:
  --timeout <s>                REST probe timeout in seconds (default: config.lmStudio.health.timeoutMs or prompt timeout)
  --timeout-ms <ms>            REST probe timeout in milliseconds
  --label <text>               Optional label stored with the health snapshot
  --json                       Print a JSON summary for CI-friendly checks
  --no-save                    Do not store the health snapshot under .miniphi/health

Web browse:
  --url <text>                 URL to open (can be repeated or passed as positional)
  --url-file <path>            File containing newline-delimited URLs
  --timeout <s>                Page navigation timeout in seconds
  --timeout-ms <ms>            Page navigation timeout in milliseconds
  --wait-ms <ms>               Additional wait after navigation
  --wait-selector <css>        Wait for selector before extracting text
  --wait-until <event>         domcontentloaded | networkidle0 | networkidle2
  --selector <css>             Extract text from a specific selector instead of body
  --max-chars <n>              Max characters to keep from the page text
  --include-html               Persist full HTML into snapshots
  --screenshot                 Capture a full-page screenshot
  --screenshot-dir <path>      Directory for screenshots (default: .miniphi/web/screenshots)
  --headful                    Launch the browser in headful mode
  --block-resources <bool>     Block images/fonts/media (default: true)
  --no-save                    Do not store the web snapshot under .miniphi/web

Nitpick tests:
  --writer-model <id>          Writer model key (defaults to intent-based selection)
  --critic-model <id>          Critic model key (defaults to intent-based selection)
  --model-pool <list>          Comma-separated model pool to choose from
  --rounds <n>                 Number of critique/revision rounds (default: 2)
  --target-words <n>           Target word count (default: 1200)
  --blind                      Disable model prior knowledge and require web sources
  --research-rounds <n>        Max research refresh cycles when critiques request queries
  --max-results <n>            Max search results per query (default: 5)
  --max-sources <n>            Max web pages to fetch (default: 6)
  --max-source-chars <n>       Max characters to keep per source
  --provider <name>            Research provider for blind mode (default: duckduckgo)
  --browser-timeout <s>        Browser fetch timeout (seconds)
  --browser-timeout-ms <ms>    Browser fetch timeout (milliseconds)
  --output <path>              Write the final draft to a file
  --print                      Print the final draft to stdout
  --no-save                    Skip saving research/web snapshots

History notes:
  --history-root <path>        Override the directory used to locate .miniphi (default: cwd)
  --label <text>               Friendly label for the snapshot (e.g., "post-upgrade")
  --no-git                     Skip git metadata when summarizing .miniphi changes

Cache prune:
  --retain-executions <n>      Keep the newest N executions (default: 200)
  --retain-prompt-exchanges <n>  Keep the newest N prompt exchanges (default: 200)
  --retain-prompt-journals <n> Keep the newest N prompt journals (default: 200)
  --retain-prompt-sessions <n> Keep the newest N prompt sessions (default: 200)
  --retain-prompt-decompositions <n>  Keep the newest N prompt decompositions (default: 200)
  --retain-prompt-templates <n>  Keep the newest N prompt templates (default: 200)
  --retain-history-notes <n>   Keep the newest N history notes (default: 200)
  --retain-research <n>        Keep the newest N research snapshots (default: 200)
  --dry-run                    Report deletions without removing files
  --json                       Output JSON summary instead of human-readable text

Recompose benchmarks:
  --sample <path>              Samples/recompose project to operate on
  --direction <mode>           code-to-markdown | markdown-to-code | roundtrip (default)
  --code-dir <path>            Override code directory (default: <sample>/code)
  --descriptions-dir <path>    Override markdown descriptions directory (default: <sample>/descriptions)
  --output-dir <path>          Override reconstructed code output directory (default: <sample>/reconstructed)
  --recompose-mode <mode>      auto | live | offline (default: auto; offline creates stub code)
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

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) {
  main();
}

export { extractImplicitWorkspaceTask, parseDirectFileReferences };


