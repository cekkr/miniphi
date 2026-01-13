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
import { DEFAULT_CONTEXT_LENGTH, resolveModelConfig } from "./libs/model-presets.js";
import LMStudioHandler, { LMStudioProtocolError } from "./libs/lmstudio-handler.js";
import PythonLogSummarizer from "./libs/python-log-summarizer.js";
import EfficientLogAnalyzer from "./libs/efficient-log-analyzer.js";
import MiniPhiMemory from "./libs/miniphi-memory.js";
import GlobalMiniPhiMemory from "./libs/global-memory.js";
import ResourceMonitor from "./libs/resource-monitor.js";
import PromptRecorder from "./libs/prompt-recorder.js";
import PromptStepJournal from "./libs/prompt-step-journal.js";
import RecomposeTester from "./libs/recompose-tester.js";
import RecomposeBenchmarkRunner from "./libs/recompose-benchmark-runner.js";
import BenchmarkAnalyzer from "./libs/benchmark-analyzer.js";
import { loadConfig } from "./libs/config-loader.js";
import { parseNumericSetting, resolveDurationMs } from "./libs/cli-utils.js";
import WorkspaceProfiler from "./libs/workspace-profiler.js";
import PromptPerformanceTracker from "./libs/prompt-performance-tracker.js";
import PromptDecomposer from "./libs/prompt-decomposer.js";
import PromptSchemaRegistry from "./libs/prompt-schema-registry.js";
import PromptTemplateBaselineBuilder from "./libs/prompt-template-baselines.js";
import CapabilityInventory from "./libs/capability-inventory.js";
import ApiNavigator from "./libs/api-navigator.js";
import { relativeToCwd } from "./libs/recompose-utils.js";
import CommandAuthorizationManager, {
  normalizeCommandPolicy,
} from "./libs/command-authorization-manager.js";
import SchemaAdapterRegistry from "./libs/schema-adapter-registry.js";
import {
  buildWorkspaceHintBlock,
  collectManifestSummary,
  readReadmeSnippet,
  buildPromptTemplateBlock,
  buildPromptCompositionBlock,
} from "./libs/workspace-context-utils.js";
import {
  normalizeDangerLevel,
  mergeFixedReferences,
  buildPlanOperations,
  buildPlanSegments,
  formatPlanSegmentsBlock,
  formatPlanRecommendationsBlock,
  buildNavigationOperations,
  normalizePlanDirections,
  buildResourceConfig,
  resolveLmStudioHttpBaseUrl,
  isLocalLmStudioBaseUrl,
  extractRecommendedCommandsFromAnalysis,
  extractContextRequestsFromAnalysis,
  extractMissingSnippetsFromAnalysis,
  extractNeedsMoreContextFlag,
} from "./libs/core-utils.js";
import { handleAnalyzeFileCommand } from "./commands/analyze-file.js";
import { handleCommandLibrary } from "./commands/command-library.js";
import { handleHelpersCommand } from "./commands/helpers.js";
import { handleHistoryNotes } from "./commands/history-notes.js";
import { handleRunCommand } from "./commands/run.js";
import { handleWebResearch } from "./commands/web-research.js";
import { handleWorkspaceCommand } from "./commands/workspace.js";

const COMMANDS = new Set([
  "run",
  "analyze-file",
  "web-research",
  "history-notes",
  "recompose",
  "benchmark",
  "workspace",
  "prompt-template",
  "command-library",
  "helpers",
]);

const DEFAULT_TASK_DESCRIPTION = "Provide a precise technical analysis of the captured output.";
const DEFAULT_PROMPT_TIMEOUT_MS = 180000;
const DEFAULT_NO_TOKEN_TIMEOUT_MS = 300000;
const RECOMPOSE_AUTO_STATUS_TIMEOUT_MS = 2500;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const GENERAL_BENCHMARK_BASELINE_PATH = path.join(
  PROJECT_ROOT,
  "benchmark",
  "baselines",
  "general-purpose-baseline.json",
);
const globalMemory = new GlobalMiniPhiMemory();
const schemaAdapterRegistry = new SchemaAdapterRegistry();
const PROMPT_SCORING_SYSTEM_PROMPT = [
  "You grade MiniPhi prompt effectiveness.",
  "Given an objective, workspace context, prompt text, and the assistant response, you must return JSON with:",
  "score (0-100), prompt_category, summary, follow_up_needed, follow_up_reason, needs_more_context, missing_snippets, tags, recommended_prompt_pattern, series_strategy.",
  "series_strategy must always be an array of short strategy strings (use [] if you have no suggestions); never return a bare string.",
  "Focus on whether the response satisfied the objective and whether another prompt is required.",
  "Return JSON only.",
].join(" ");

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

function formatCommandLibraryBlock(entries, limit = 6) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }
  const capped = entries.slice(0, Math.max(1, limit));
  const lines = ["Command library recommendations:"];
  for (const entry of capped) {
    const parts = [`- ${entry.command}`];
    if (entry.description) {
      parts.push(entry.description);
    }
    const meta = [];
    if (Array.isArray(entry.files) && entry.files.length) {
      meta.push(`files: ${entry.files.slice(0, 2).join(", ")}`);
    }
    if (Array.isArray(entry.tags) && entry.tags.length) {
      meta.push(`tags: ${entry.tags.join(", ")}`);
    }
    if (entry.owner) {
      meta.push(`owner: ${entry.owner}`);
    }
    const schemaLabel =
      typeof entry.schemaId === "string" && entry.schemaId.trim().length
        ? `schema: ${entry.schemaId.trim()}`
        : null;
    if (schemaLabel) {
      meta.push(schemaLabel);
    }
    const ctxBudget = Number(entry.contextBudget ?? entry.contextTokens);
    if (Number.isFinite(ctxBudget) && ctxBudget > 0) {
      meta.push(`ctx<=${Math.round(ctxBudget)}`);
    }
    if (entry.workspaceType) {
      meta.push(`workspace: ${entry.workspaceType}`);
    }
    if (entry.source) {
      meta.push(`source: ${entry.source}`);
    }
    if (entry.catalog) {
      meta.push(`library: ${entry.catalog}`);
    }
    if (meta.length) {
      parts.push(`(${meta.join(" | ")})`);
    }
    lines.push(parts.join(" "));
  }
  if (entries.length > capped.length) {
    lines.push(`- ... ${entries.length - capped.length} more stored command${entries.length - capped.length === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

function mergeHintBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return null;
  }
  const seen = new Set();
  const merged = [];
  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const sections = String(block)
      .split(/\n{2,}/)
      .map((section) => section.trim())
      .filter(Boolean);
    for (const section of sections) {
      if (seen.has(section)) {
        continue;
      }
      seen.add(section);
      merged.push(section);
    }
  }
  return merged.length ? merged.join("\n\n") : null;
}

function buildWorkspaceFileIndex(workspaceContext) {
  const manifest = Array.isArray(workspaceContext?.manifestPreview)
    ? workspaceContext.manifestPreview
    : [];
  const files = new Set();
  const basenames = new Set();
  for (const entry of manifest) {
    const filePath = typeof entry?.path === "string" ? entry.path.replace(/\\/g, "/") : "";
    if (!filePath) {
      continue;
    }
    files.add(filePath.toLowerCase());
    basenames.add(path.basename(filePath).toLowerCase());
  }
  const root =
    typeof workspaceContext?.root === "string" && workspaceContext.root.trim().length
      ? path.resolve(workspaceContext.root)
      : null;
  const hasPackageJson =
    files.has("package.json") || (root ? fs.existsSync(path.join(root, "package.json")) : false);
  return {
    root,
    files,
    basenames,
    hasPackageJson,
    stats: workspaceContext?.stats ?? null,
  };
}

function commandMentionsWorkspaceFile(command, fileIndex) {
  if (!command || !fileIndex?.basenames?.size) {
    return false;
  }
  const normalized = command.toLowerCase();
  for (const basename of fileIndex.basenames) {
    if (basename && normalized.includes(basename)) {
      return true;
    }
  }
  return false;
}

function entryMatchesWorkspaceFiles(entryFiles, fileIndex) {
  if (!Array.isArray(entryFiles) || entryFiles.length === 0) {
    return false;
  }
  for (const file of entryFiles) {
    if (typeof file !== "string") {
      continue;
    }
    const trimmed = file.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = trimmed.replace(/\\/g, "/");
    if (fileIndex?.files?.has(normalized.toLowerCase())) {
      return true;
    }
    const basename = path.basename(normalized).toLowerCase();
    if (fileIndex?.basenames?.has(basename)) {
      return true;
    }
    if (fileIndex?.root) {
      const absolute = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(fileIndex.root, trimmed);
      if (absolute.startsWith(fileIndex.root) && fs.existsSync(absolute)) {
        return true;
      }
    }
  }
  return false;
}

function isGenericCommandAllowed(command, fileIndex) {
  if (!command) {
    return false;
  }
  const normalized = command.trim().toLowerCase();
  const hasCode = Number(fileIndex?.stats?.codeFiles ?? 0) > 0;
  const usesNode =
    normalized.startsWith("npm ") ||
    normalized.startsWith("pnpm ") ||
    normalized.startsWith("yarn ") ||
    normalized.startsWith("node ") ||
    normalized.startsWith("bun ");
  if (usesNode && (fileIndex?.hasPackageJson || hasCode)) {
    return true;
  }
  return false;
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

async function attachCommandLibraryToWorkspace(
  workspaceContext,
  memory,
  globalMemory,
  options = undefined,
) {
  if (!memory && !globalMemory) {
    return workspaceContext;
  }
  if (Array.isArray(workspaceContext?.commandLibraryEntries) && workspaceContext.commandLibraryEntries.length) {
    return workspaceContext;
  }
  const fileIndex = buildWorkspaceFileIndex(workspaceContext);
  const limit =
    Number.isFinite(Number(options?.limit)) && Number(options.limit) > 0 ? Number(options.limit) : 6;
  let localEntries = [];
  if (memory) {
    try {
      localEntries = await memory.loadCommandLibrary(limit);
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] Unable to load command library: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  let globalEntries = [];
  if (globalMemory?.loadCommandLibrary) {
    try {
      globalEntries = await globalMemory.loadCommandLibrary(limit);
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] Unable to load global command library: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  if (!localEntries.length && !globalEntries.length) {
    return workspaceContext;
  }
  const merged = [];
  const seen = new Set();
  const addEntries = (entries, origin) => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      const commandText = typeof entry?.command === "string" ? entry.command.trim() : "";
      if (!commandText) {
        continue;
      }
      if (origin === "global") {
        const mode = typeof options?.mode === "string" ? options.mode.trim() : "";
        if (mode && entry?.mode && entry.mode !== mode) {
          continue;
        }
        const schemaId = typeof options?.schemaId === "string" ? options.schemaId.trim() : "";
        if (schemaId && entry?.schemaId && entry.schemaId !== schemaId) {
          continue;
        }
        const matchesFiles = entryMatchesWorkspaceFiles(entry?.files, fileIndex);
        const mentionsFile = commandMentionsWorkspaceFile(commandText, fileIndex);
        if (!matchesFiles && !mentionsFile && !isGenericCommandAllowed(commandText, fileIndex)) {
          continue;
        }
      }
      const key = commandText.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push({
        ...entry,
        command: commandText,
        catalog: origin,
      });
      if (merged.length >= limit) {
        break;
      }
    }
  };
  addEntries(localEntries, "project");
  addEntries(globalEntries, "global");
  if (!merged.length) {
    return workspaceContext;
  }
  const block = formatCommandLibraryBlock(merged, limit);
  return {
    ...(workspaceContext ?? {}),
    commandLibraryEntries: merged,
    commandLibraryBlock: block,
    commandLibrarySources: {
      project: localEntries.length,
      global: globalEntries.length,
      merged: merged.length,
    },
  };
}

async function attachPromptCompositionsToWorkspace(
  workspaceContext,
  memory,
  globalMemory,
  options = undefined,
) {
  if (!memory && !globalMemory) {
    return workspaceContext;
  }
  if (Array.isArray(workspaceContext?.compositionEntries) && workspaceContext.compositionEntries.length) {
    return workspaceContext;
  }
  const limit =
    Number.isFinite(Number(options?.limit)) && Number(options.limit) > 0 ? Number(options.limit) : 6;
  const workspaceType =
    workspaceContext?.classification?.label ??
    workspaceContext?.classification?.domain ??
    null;
  const filters = {
    limit,
    workspaceType,
    includeFallback: Boolean(options?.includeFallback),
  };
  const dedupeKey = (entry) => {
    if (!entry) return null;
    if (typeof entry.key === "string") {
      return entry.key;
    }
    const schema = typeof entry.schemaId === "string" ? entry.schemaId.trim().toLowerCase() : "none";
    const mode = typeof entry.mode === "string" ? entry.mode.trim().toLowerCase() : "unknown";
    const command =
      typeof entry.command === "string" && entry.command.trim().length
        ? entry.command.trim().toLowerCase()
        : typeof entry.task === "string" && entry.task.trim().length
          ? entry.task.trim().toLowerCase()
          : "objective";
    const workspaceLabel =
      typeof entry.workspaceType === "string" && entry.workspaceType.trim().length
        ? entry.workspaceType.trim().toLowerCase()
        : "any";
    return [schema, mode, command, workspaceLabel].join("::");
  };
  const merged = [];
  const seen = new Set();
  const addEntries = (entries, source) => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      const key = dedupeKey(entry);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push({ ...entry, source });
      if (merged.length >= limit) {
        break;
      }
    }
  };
  let localEntries = [];
  let globalEntries = [];
  if (memory?.loadPromptCompositions) {
    try {
      localEntries = await memory.loadPromptCompositions(filters);
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] Unable to load prompt compositions: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  if (globalMemory?.loadPromptCompositions) {
    try {
      globalEntries = await globalMemory.loadPromptCompositions(filters);
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] Unable to load global prompt compositions: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  addEntries(localEntries, "project");
  addEntries(globalEntries, "global");
  if (!merged.length) {
    return workspaceContext;
  }
  const block = buildPromptCompositionBlock(merged, { limit });
  return {
    ...(workspaceContext ?? {}),
    compositionEntries: merged,
    compositionBlock: block,
    compositionSources: {
      project: localEntries.length,
      global: globalEntries.length,
      merged: merged.length,
    },
  };
}

async function recordCompositionSnapshot(payload, memory, globalMemory, options = undefined) {
  if (!payload) {
    return;
  }
  const verbose = Boolean(options?.verbose);
  if (memory?.recordPromptComposition) {
    try {
      await memory.recordPromptComposition(payload);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to store prompt composition: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  if (globalMemory?.recordPromptComposition) {
    try {
      await globalMemory.recordPromptComposition({ ...payload, source: payload.source ?? "project" });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to store global prompt composition: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
}

async function recordLmStudioStatusSnapshot(restClient, memory, options = undefined) {
  if (!restClient || !memory) {
    return null;
  }
  try {
    const status = await restClient.getStatus();
    const snapshot = {
      status: status ?? null,
      baseUrl: restClient.baseUrl ?? null,
      transport: options?.transport ?? "rest",
    };
    const record = await memory.recordLmStudioStatus(snapshot, { label: options?.label ?? null });
    if (options?.verbose) {
      const model =
        status?.loaded_model ??
        status?.model ??
        status?.model_key ??
        status?.modelKey ??
        status?.defaultModel ??
        null;
      const contextLength =
        status?.context_length ??
        status?.contextLength ??
        status?.context_length_limit ??
        status?.context_length_max ??
        null;
      const gpu = status?.gpu ?? status?.device ?? status?.hardware ?? null;
      const relPath = record?.path ? path.relative(process.cwd(), record.path) : null;
      console.log(
        `[MiniPhi] LM Studio status: model=${model ?? "unknown"} ctx=${contextLength ?? "?"} gpu=${gpu ?? "?"}`,
      );
      if (record?.path) {
        console.log(
          `[MiniPhi] LM Studio status snapshot stored at ${relPath && !relPath.startsWith("..") ? relPath : record.path}`,
        );
      }
    }
    return record;
  } catch (error) {
    if (options?.verbose) {
      console.warn(
        `[MiniPhi] LM Studio status check failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    return null;
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

function describeTruncationChunk(chunk) {
  if (!chunk) {
    return "chunk";
  }
  const parts = [chunk.goal ?? chunk.label ?? chunk.id ?? "chunk"];
  if (chunk.startLine || chunk.endLine) {
    const start = chunk.startLine ?? "?";
    const end = chunk.endLine ?? "end";
    parts.push(`lines ${start}-${end}`);
  }
  if (chunk.context) {
    parts.push(chunk.context);
  }
  return parts.join(" | ");
}

function sortTruncationChunks(planRecord) {
  const chunks = planRecord?.plan?.chunkingPlan;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }
  return [...chunks].sort((a, b) => {
    const pa = Number.isFinite(a.priority) ? a.priority : Number.isFinite(a.index) ? a.index + 1 : Infinity;
    const pb = Number.isFinite(b.priority) ? b.priority : Number.isFinite(b.index) ? b.index + 1 : Infinity;
    if (pa === pb) {
      return (a.index ?? 0) - (b.index ?? 0);
    }
    return pa - pb;
  });
}

function selectTruncationChunk(planRecord, selector = null) {
  const chunks = planRecord?.plan?.chunkingPlan;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return null;
  }
  const sorted = sortTruncationChunks(planRecord);
  const defaultChunk = sorted[0];
  if (!selector) {
    return defaultChunk;
  }
  const normalized = selector.toString().trim();
  if (!normalized) {
    return defaultChunk;
  }
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) {
    const priorityMatch = chunks.find(
      (chunk) => Number.isFinite(chunk.priority) && chunk.priority === numeric,
    );
    if (priorityMatch) {
      return priorityMatch;
    }
    const indexMatch = sorted[numeric - 1];
    if (indexMatch) {
      return indexMatch;
    }
  }
  const lowered = normalized.toLowerCase();
  const textMatch = chunks.find((chunk) => {
    const goal = (chunk.goal ?? chunk.label ?? "").toLowerCase();
    return goal.includes(lowered);
  });
  return textMatch ?? defaultChunk;
}

function buildLineRangeFromChunk(chunk) {
  if (!chunk) {
    return null;
  }
  const startLine = Number.isFinite(chunk.startLine) ? chunk.startLine : null;
  const endLine = Number.isFinite(chunk.endLine) ? chunk.endLine : null;
  if (startLine || endLine) {
    return { startLine, endLine };
  }
  return null;
}

function buildTruncationChunkKey(chunk) {
  if (!chunk) {
    return null;
  }
  if (chunk.id && typeof chunk.id === "string") {
    return chunk.id;
  }
  const goal = chunk.goal ?? chunk.label ?? null;
  const range =
    Number.isFinite(chunk.startLine) || Number.isFinite(chunk.endLine)
      ? `${Number.isFinite(chunk.startLine) ? chunk.startLine : "?"}-${Number.isFinite(chunk.endLine) ? chunk.endLine : "?"}`
      : null;
  const normalizedGoal = goal ? goal.toString().trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") : null;
  return [normalizedGoal ?? "chunk", range].filter(Boolean).join("@");
}

function ensureTruncationProgressEntry(progress, chunkKey, chunk) {
  if (!progress || !chunkKey) {
    return null;
  }
  if (!progress.chunks || typeof progress.chunks !== "object") {
    progress.chunks = {};
  }
  if (!progress.chunks[chunkKey]) {
    progress.chunks[chunkKey] = {
      key: chunkKey,
      label: chunk?.goal ?? chunk?.label ?? chunk?.id ?? chunkKey,
      range:
        Number.isFinite(chunk?.startLine) || Number.isFinite(chunk?.endLine)
          ? {
              startLine: Number.isFinite(chunk?.startLine) ? chunk.startLine : null,
              endLine: Number.isFinite(chunk?.endLine) ? chunk.endLine : null,
            }
          : null,
      helpers: [],
      completedAt: null,
      lastHelperAt: null,
      lastRunAt: null,
    };
  }
  return progress.chunks[chunkKey];
}

function isTruncationChunkCompleted(progress, chunkKey) {
  if (!progress || !chunkKey || !progress.chunks) {
    return false;
  }
  return Boolean(progress.chunks[chunkKey]?.completedAt);
}

function findNextIncompleteChunk(planRecord, progress, skipKey = null) {
  const ordered = sortTruncationChunks(planRecord);
  for (const chunk of ordered) {
    const key = buildTruncationChunkKey(chunk);
    if (skipKey && key === skipKey) {
      continue;
    }
    if (!key || !isTruncationChunkCompleted(progress, key)) {
      return chunk;
    }
  }
  return null;
}

function computeTruncationProgress(planRecord, progress) {
  const ordered = sortTruncationChunks(planRecord);
  if (!ordered.length) {
    return { total: 0, completed: 0 };
  }
  let completed = 0;
  for (const chunk of ordered) {
    const key = buildTruncationChunkKey(chunk);
    if (key && isTruncationChunkCompleted(progress, key)) {
      completed += 1;
    }
  }
  return { total: ordered.length, completed };
}

async function persistTruncationProgressSafe(memory, executionId, progress) {
  if (!memory || !executionId || !progress) {
    return;
  }
  progress.executionId = executionId;
  try {
    await memory.saveTruncationProgress(executionId, progress);
  } catch (error) {
    console.warn(
      `[MiniPhi] Unable to save truncation progress for ${executionId}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
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

function buildRestClientOptions(configData, modelSelection = undefined) {
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
  if (typeof options.timeoutMs === "undefined") {
    const promptTimeoutSeconds =
      configData?.lmStudio?.prompt?.timeoutSeconds ??
      configData?.prompt?.timeoutSeconds ??
      null;
    const promptTimeoutMs = Number(promptTimeoutSeconds) * 1000;
    if (Number.isFinite(promptTimeoutMs) && promptTimeoutMs > 0) {
      options.timeoutMs = Math.floor(promptTimeoutMs);
    }
  }
  if (modelSelection?.modelKey) {
    options.defaultModel = modelSelection.modelKey;
  }
  if (Number.isFinite(modelSelection?.contextLength)) {
    options.defaultContextLength = modelSelection.contextLength;
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
  const responseSegments = [];
  if (context.planResult.segmentBlock) {
    responseSegments.push(context.planResult.segmentBlock);
  }
  if (context.planResult.outline) {
    responseSegments.push(context.planResult.outline);
  }
  const responsePayload =
    responseSegments.length > 0
      ? responseSegments.join("\n\n")
      : JSON.stringify(context.planResult.plan, null, 2);
  await journal.appendStep(sessionId, {
    label: context.label ?? "prompt-plan",
    prompt: `Objective: ${context.objective ?? "workspace task"}${commandLine}`.trim(),
    response: responsePayload,
    status: "plan",
    operations,
    metadata: {
      planId: context.planResult.planId ?? null,
      summary: context.planResult.summary ?? null,
      mode: context.mode ?? null,
      branch: context.planResult.branch ?? null,
      source: context.planSource ?? null,
      recommendedTools: context.planResult.recommendedTools ?? [],
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
    recommendedTools: Array.isArray(planRecord.recommendedTools) ? planRecord.recommendedTools : null,
    recommendationsBlock: planRecord.recommendationsBlock ?? null,
  };
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

function classifyStopReason(error) {
  if (!error) {
    return "unknown";
  }
  if (isLmStudioProtocolError(error)) {
    return "lmstudio-protocol";
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("denied by policy")) {
    return "command-denied";
  }
  if (normalized.includes("tokens emitted")) {
    return "no-token-timeout";
  }
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("cancel")) {
    return "cancelled";
  }
  return "error";
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
  const reasonLabel = notice.reason ?? "REST failure";
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
  if (configPath && verbose) {
    const relPath = path.relative(process.cwd(), configPath) || configPath;
    console.log(`[MiniPhi] Loaded configuration from ${relPath}`);
  }
  const activeProfile = configResult?.profileName ?? null;
  if (activeProfile) {
    const profileDetails = [];
    const lmStudioBase = resolveLmStudioHttpBaseUrl(configData);
    if (lmStudioBase) {
      profileDetails.push(`LM Studio: ${lmStudioBase}`);
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
  let restClient = null;

  if (command === "web-research") {
    await handleWebResearch({ options, positionals, verbose });
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
      systemPrompt: resolvedSystemPrompt,
      modelKey: modelSelection.modelKey,
      restClient,
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
      systemPrompt: resolvedSystemPrompt,
      modelKey: modelSelection.modelKey,
      restClient,
      resourceConfig,
      resourceMonitorForcedDisabled,
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
  const phi4 = new LMStudioHandler(manager, {
    systemPrompt: resolvedSystemPrompt,
    promptTimeoutMs,
    schemaRegistry,
    noTokenTimeoutMs,
    modelKey: modelSelection.modelKey,
  });
  try {
    await manager.getModel(modelSelection.modelKey, {
      contextLength,
      gpu,
    });
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Unable to preload model ${modelSelection.modelKey}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
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
  restClient = null;
  let lmStudioCompatibility = { ok: true, preferRest: !isLmStudioLocal };
  let preferRestTransport = !isLmStudioLocal;
  try {
    restClient = new LMStudioRestClient(buildRestClientOptions(configData, modelSelection));
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
  const buildNavigator = (memoryInstance) =>
    restClient
      ? new ApiNavigator({
          restClient,
          cliExecutor: cli,
          memory: memoryInstance ?? null,
          globalMemory,
          logger: verbose ? (message) => console.warn(message) : null,
          adapterRegistry: schemaAdapterRegistry,
          promptRecorder,
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
    });
  const emitDecomposerNoticeIfNeeded = () => {
    if (promptDecomposer && typeof promptDecomposer.consumeDisableNotice === "function") {
      const notice = promptDecomposer.consumeDisableNotice();
      if (notice) {
        emitFeatureDisableNotice("Prompt decomposer", notice);
      }
    }
  };
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
    let promptJournalFinalized = false;
    let stopReason = null;
    let stopStatus = null;
    let stopError = null;
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
  });

  try {
    await phi4.load({ contextLength, gpu });
    if (performanceTracker && debugLm) {
        scoringPhi = new LMStudioHandler(manager, {
          systemPrompt: PROMPT_SCORING_SYSTEM_PROMPT,
          schemaRegistry,
          noTokenTimeoutMs,
          modelKey: modelSelection.modelKey,
        });
      if (restClient) {
        scoringPhi.setRestClient(restClient, { preferRestTransport });
      }
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
    } else if (performanceTracker && verbose) {
      console.log("[MiniPhi] Prompt scoring evaluator disabled (enable with --debug-lm).");
    }

    let result;
    let workspaceContext = null;

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
      defaults,
      verbose,
      restClient,
      phi4,
      analyzer,
      globalMemory,
      promptDecomposer,
      summaryLevels,
      streamOutput,
      timeout,
      sessionDeadline,
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
      const fallbackReason = result?.analysisDiagnostics?.fallbackReason ?? null;
      const finalStatus = stopStatus ?? "completed";
      const finalStopReason = stopReason ?? fallbackReason ?? "completed";
      const finalError = stopError ?? null;
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
        truncationPlan: result?.truncationPlan ?? null,
        status: finalStatus,
        stopReason: finalStopReason,
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
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    stopStatus = "failed";
    stopReason = classifyStopReason(error);
    stopError = error instanceof Error ? error.message : String(error);
    console.error(`[MiniPhi] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    try {
      if (result) {
        const fallbackReason = result?.analysisDiagnostics?.fallbackReason ?? null;
        const finalStopReason = stopReason ?? fallbackReason ?? "completed";
        await finalizePromptJournal({ stopReason: finalStopReason });
      }

      await stopResourceMonitorIfNeeded();
      if (stateManager) {
        await stateManager.persistExecutionStop({
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
      const fallbackReason = result?.analysisDiagnostics?.fallbackReason ?? null;
      const finalStopReason = stopReason ?? fallbackReason ?? "completed";
      await finalizePromptJournal({ stopReason: finalStopReason });
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
}

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
  systemPrompt,
  modelKey,
  restClient,
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
      : configData.recompose?.mode?.toLowerCase() ?? "auto";
  const recomposeMode = await resolveRecomposeMode({
    rawMode,
    configData,
    modelKey,
    contextLength,
    verbose,
  });
  const workspaceOverviewTimeoutMs =
    resolveDurationMs({
      secondsValue: options["workspace-overview-timeout"],
      secondsLabel: "--workspace-overview-timeout",
      millisValue: options["workspace-overview-timeout-ms"],
      millisLabel: "--workspace-overview-timeout-ms",
    }) ?? null;
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
    systemPrompt,
    modelKey,
    workspaceOverviewTimeoutMs,
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
    const relPrompt = relativeToCwd(promptLogExportPath);
    const normalizedPrompt = relPrompt ? relPrompt.replace(/\\/g, "/") : relPrompt;
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
  systemPrompt,
  modelKey,
  restClient = null,
  resourceConfig = undefined,
  resourceMonitorForcedDisabled = false,
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

  if (mode === "general" || mode === "general-purpose" || mode === "generalpurpose") {
    await runGeneralPurposeBenchmark({
      options,
      verbose,
      schemaRegistry,
      restClient,
      configData,
      resourceConfig,
      resourceMonitorForcedDisabled,
    });
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
  const benchmarkWorkspaceOverviewTimeout =
    resolveDurationMs({
      secondsValue: options["workspace-overview-timeout"],
      secondsLabel: "--workspace-overview-timeout",
      millisValue: options["workspace-overview-timeout-ms"],
      millisLabel: "--workspace-overview-timeout-ms",
    }) ?? null;
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
    systemPrompt,
    modelKey,
    workspaceOverviewTimeoutMs: benchmarkWorkspaceOverviewTimeout,
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

async function runGeneralPurposeBenchmark({
  options,
  verbose,
  schemaRegistry,
  restClient = null,
  configData = undefined,
  resourceConfig = undefined,
  resourceMonitorForcedDisabled = false,
}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const task =
    (typeof options.task === "string" && options.task.trim()) ||
    (typeof options.objective === "string" && options.objective.trim()) ||
    "General-purpose benchmark";
  const command = options.cmd ?? options.command ?? null;
  const silenceTimeout = parseNumericSetting(options["silence-timeout"], "--silence-timeout") ?? 15000;
  const timeoutMs = parseNumericSetting(options.timeout, "--timeout") ?? 60000;
  const stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
  let benchmarkMonitor = null;
  let benchmarkMonitorResult = null;
  if (!resourceMonitorForcedDisabled) {
    const monitorHistoryFile = path.join(stateManager.historyDir, "benchmark-resource-usage.json");
    benchmarkMonitor = new ResourceMonitor({
      ...(resourceConfig ?? {}),
      historyFile: monitorHistoryFile,
      label: `benchmark:general:${path.basename(cwd) || "workspace"}`,
    });
    try {
      await benchmarkMonitor.start(`benchmark:${path.basename(cwd) || cwd}`);
    } catch (error) {
      benchmarkMonitor = null;
      if (verbose) {
        console.warn(
          `[MiniPhi][Benchmark] Resource monitor unavailable for general-purpose benchmark: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  const cli = new CliExecutor();
  const workspaceProfiler = new WorkspaceProfiler();
  const capabilityInventory = new CapabilityInventory();
  const navigator =
    restClient &&
    new ApiNavigator({
      restClient,
      cliExecutor: cli,
      memory: stateManager,
      globalMemory,
      logger: verbose ? (message) => console.warn(message) : null,
      adapterRegistry: schemaAdapterRegistry,
      helperSilenceTimeoutMs: configData?.prompt?.navigator?.helperSilenceTimeoutMs,
    });
  const workspaceContext = await generateWorkspaceSnapshot({
    rootDir: cwd,
    workspaceProfiler,
    capabilityInventory,
    verbose,
    navigator: navigator ?? null,
    objective: task,
    executeHelper: true,
    memory: stateManager,
    globalMemory,
  });

  let decompositionPlan = null;
  if (restClient) {
    const decomposer = new PromptDecomposer({
      restClient,
      logger: verbose ? (message) => console.warn(message) : null,
    });
    try {
      decompositionPlan = await decomposer.decompose({
        objective: `${task} (plan)`,
        command: command ?? null,
        workspace: workspaceContext,
        storage: stateManager,
        metadata: { mode: "benchmark", scope: "general-purpose" },
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi][Benchmark] Prompt decomposer skipped: ${error instanceof Error ? error.message : error}`,
        );
      }
    } finally {
      if (typeof decomposer.consumeDisableNotice === "function") {
        const notice = decomposer.consumeDisableNotice();
        if (notice) {
          emitFeatureDisableNotice("Prompt decomposer", notice);
        }
      }
    }
  }

  const builder = new PromptTemplateBaselineBuilder({ schemaRegistry });
  const datasetSummary =
    workspaceContext?.summary ??
    `Workspace ${path.basename(cwd) || cwd} contains mixed artifacts; optimize prompts for this context.`;
  const templatePayloads = [
    builder.build({
      baseline: "truncation",
      task: `${task} (chunking)`,
      datasetSummary,
      workspaceContext,
    }),
    builder.build({
      baseline: "analysis",
      task: `${task} (analysis)`,
      datasetSummary,
      workspaceContext,
    }),
  ];
  const savedTemplates = [];
  for (const payload of templatePayloads) {
    const templateLabel = `general-purpose ${payload.metadata?.baseline ?? payload.baseline ?? "prompt"}`;
    const saved = await stateManager.savePromptTemplateBaseline({
      ...payload,
      label: templateLabel,
      cwd,
    });
    savedTemplates.push(saved);
    if (verbose) {
      const rel = path.relative(process.cwd(), saved.path) || saved.path;
      console.log(`[MiniPhi][Benchmark] Saved prompt template to ${rel}`);
    }
    await mirrorPromptTemplateToGlobal(
      saved,
      {
        label: templateLabel,
        schemaId: payload.schemaId ?? null,
        baseline: payload.metadata?.baseline ?? payload.baseline ?? null,
        task: payload.task ?? null,
      },
      workspaceContext,
      { verbose, source: "general-benchmark" },
    );
  }

  let commandDetails = null;
  if (command) {
    const logDir = path.join(stateManager.historyDir, "benchmarks");
    await fs.promises.mkdir(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = command.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "command";
    const stdoutPath = path.join(logDir, `${timestamp}-${slug}-stdout.log`);
    const stderrPath = path.join(logDir, `${timestamp}-${slug}-stderr.log`);
    if (verbose) {
      console.log(`[MiniPhi][Benchmark] Running general-purpose command: ${command}`);
    }
    let execResult;
    try {
      execResult = await cli.executeCommand(command, {
        cwd,
        timeout: timeoutMs,
        maxSilenceMs: silenceTimeout,
        captureOutput: true,
        onStdout: (text) => process.stdout.write(text),
        onStderr: (text) => process.stderr.write(text),
      });
    } catch (error) {
      execResult = {
        code: typeof error.code === "number" ? error.code : -1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? (error instanceof Error ? error.message : String(error)),
        silenceExceeded: error.silenceExceeded ?? false,
        durationMs: error.durationMs ?? null,
      };
      if (verbose) {
        console.warn(`[MiniPhi][Benchmark] Command execution failed: ${execResult.stderr}`);
      }
    }
    await fs.promises.writeFile(stdoutPath, execResult.stdout ?? "", "utf8");
    await fs.promises.writeFile(stderrPath, execResult.stderr ?? "", "utf8");
    commandDetails = {
      command,
      exitCode: execResult.code ?? execResult.exitCode ?? 0,
      stdoutPath,
      stderrPath,
      silenceExceeded: Boolean(execResult.silenceExceeded),
      durationMs: execResult.durationMs ?? null,
    };
    if (verbose) {
      console.log(
        `[MiniPhi][Benchmark] Command finished with exit ${commandDetails.exitCode}${
          commandDetails.silenceExceeded ? " (terminated for silence)" : ""
        }`,
      );
    }
    if (commandDetails.silenceExceeded) {
      console.warn(
        "[MiniPhi][Benchmark] Command output stalled; review stdout/stderr logs before trusting the run.",
      );
    }
  }

  if (benchmarkMonitor) {
    try {
      benchmarkMonitorResult = await benchmarkMonitor.stop();
      if (benchmarkMonitorResult?.persisted?.path && verbose) {
        const relMonitor =
          path.relative(process.cwd(), benchmarkMonitorResult.persisted.path) ||
          benchmarkMonitorResult.persisted.path;
        console.log(`[MiniPhi][Benchmark] Resource stats appended to ${relMonitor}`);
      }
      if (benchmarkMonitorResult?.summary?.warnings?.length) {
        for (const warning of benchmarkMonitorResult.summary.warnings) {
          console.warn(`[MiniPhi][Resources] ${warning}`);
        }
      }
    } catch (error) {
      console.warn(
        `[MiniPhi][Benchmark] Unable to finalize resource monitor: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const summaryDir = path.join(stateManager.historyDir, "benchmarks");
  await fs.promises.mkdir(summaryDir, { recursive: true });
  const summaryPath = path.join(
    summaryDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-general-benchmark.json`,
  );
  const resourceStats = benchmarkMonitorResult?.summary?.stats ?? null;
  let resourceBaseline = null;
  let resourceBaselineDiff = null;
  try {
    resourceBaseline = await loadGeneralBenchmarkBaseline();
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi][Benchmark] Unable to load general-purpose baseline: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  if (resourceStats && resourceBaseline?.resourceStats) {
    resourceBaselineDiff = computeResourceBaselineDiff(resourceStats, resourceBaseline.resourceStats);
  }
  if (resourceBaselineDiff) {
    const diffSummary = formatResourceBaselineDiff(resourceBaselineDiff);
    if (diffSummary) {
      console.log(`[MiniPhi][Benchmark] Resource delta vs baseline: ${diffSummary}`);
    }
  }
  const summary = {
    kind: "general-purpose",
    analyzedAt: new Date().toISOString(),
    directory: cwd,
    task,
    workspaceType: workspaceContext?.classification?.label ?? null,
    workspaceSummary: workspaceContext?.summary ?? null,
    templates: savedTemplates.map((entry) => entry?.path ?? null).filter(Boolean),
    command: commandDetails,
    navigation: workspaceContext?.navigationSummary ?? null,
    helperScript: workspaceContext?.helperScript
      ? {
          id: workspaceContext.helperScript.id ?? null,
          name: workspaceContext.helperScript.name ?? null,
          path: workspaceContext.helperScript.path ?? null,
          version: workspaceContext.helperScript.version ?? null,
          stdin: workspaceContext.helperScript.stdin ?? null,
          run: workspaceContext.helperScript.run
            ? {
                exitCode: workspaceContext.helperScript.run.exitCode ?? null,
                summary: workspaceContext.helperScript.run.summary ?? null,
                silenceExceeded: workspaceContext.helperScript.run.silenceExceeded ?? null,
              }
            : null,
        }
      : null,
    decompositionPlan: decompositionPlan
      ? {
          id: decompositionPlan.planId ?? null,
          summary: decompositionPlan.summary ?? null,
          outline: decompositionPlan.outline ?? null,
        }
      : null,
    resourceStats,
    resourceWarnings: benchmarkMonitorResult?.summary?.warnings ?? [],
    resourceLogPath: benchmarkMonitorResult?.persisted?.path ?? null,
    resourceBaseline: resourceBaseline?.resourceStats ?? null,
    resourceBaselineLabel: resourceBaseline?.label ?? null,
    resourceBaselineSources: resourceBaseline?.logSources ?? resourceBaseline?.sources ?? null,
    resourceBaselineDiff,
  };
  await fs.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  await stateManager.recordBenchmarkSummary(summary, { summaryPath, type: "general-purpose" });
  if (verbose) {
    const rel = path.relative(process.cwd(), summaryPath) || summaryPath;
    console.log(`[MiniPhi][Benchmark] General-purpose benchmark summary saved to ${rel}`);
  }
}

async function loadGeneralBenchmarkBaseline() {
  try {
    const payload = await fs.promises.readFile(GENERAL_BENCHMARK_BASELINE_PATH, "utf8");
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const resourceStats = normalizeBaselineStats(parsed.resourceStats ?? parsed.stats ?? null);
    return {
      ...parsed,
      resourceStats,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function normalizeBaselineStats(stats) {
  if (!stats || typeof stats !== "object") {
    return null;
  }
  const normalized = {};
  for (const metric of ["memory", "cpu", "vram"]) {
    const entry = stats[metric];
    if (!entry) {
      continue;
    }
    const avg = Number(entry.avg ?? entry.average ?? entry.mean);
    if (!Number.isFinite(avg)) {
      continue;
    }
    normalized[metric] = {
      avg: Number(avg.toFixed(2)),
    };
  }
  return normalized;
}

function computeResourceBaselineDiff(current, baseline) {
  if (!current || !baseline) {
    return null;
  }
  const diff = {};
  for (const metric of ["memory", "cpu", "vram"]) {
    const currentAvg = Number(current[metric]?.avg ?? current[metric]?.average ?? current[metric]?.mean);
    const baselineAvg = Number(baseline[metric]?.avg ?? baseline[metric]?.average ?? baseline[metric]?.mean);
    if (!Number.isFinite(currentAvg) || !Number.isFinite(baselineAvg)) {
      continue;
    }
    diff[metric] = {
      currentAvg: Number(currentAvg.toFixed(2)),
      baselineAvg: Number(baselineAvg.toFixed(2)),
      delta: Number((currentAvg - baselineAvg).toFixed(2)),
    };
  }
  return Object.keys(diff).length ? diff : null;
}

function formatResourceBaselineDiff(diff) {
  if (!diff) {
    return "";
  }
  const parts = [];
  for (const metric of ["memory", "cpu", "vram"]) {
    const entry = diff[metric];
    if (!entry) {
      continue;
    }
    const delta = entry.delta;
    const deltaLabel = delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
    parts.push(
      `${metric} Δ ${deltaLabel} (current ${entry.currentAvg.toFixed(2)} vs baseline ${entry.baselineAvg.toFixed(2)})`,
    );
  }
  return parts.join(" | ");
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
    const recomposePromptTimeout = Math.max(baseTimeoutMs, 300000);
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
  memory = null,
  globalMemory = null,
  indexLimit = 6,
  benchmarkLimit = 3,
  mode = null,
  schemaId = null,
  focusPath = null,
  promptId = null,
  promptJournalId = null,
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
  const planDirectives = profile?.directives ?? null;
  const hasHintBlock = Boolean(hintBlock && hintBlock.trim());
  let cachedHint = null;
  if (memory?.loadWorkspaceHint) {
    try {
      cachedHint = await memory.loadWorkspaceHint(rootDir);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Workspace hint cache read failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  const cachedHintBlock = !hasHintBlock ? cachedHint?.hintBlock ?? null : null;
  const cachedDirectives =
    !planDirectives && cachedHint?.directives
      ? `Cached directives: ${cachedHint.directives}`
      : null;
  const mergedHintBlock = mergeHintBlocks([
    hintBlock,
    planDirectives ? `Workspace directives: ${planDirectives}` : null,
    cachedHintBlock,
    cachedDirectives,
  ]);

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

  let workspaceSnapshot = {
    ...profile,
    manifestPreview: manifestResult.manifest,
    readmeSnippet,
    hintBlock: mergedHintBlock || null,
    planDirectives,
    capabilitySummary: capabilities?.summary ?? null,
    capabilityDetails: capabilities?.details ?? null,
    cachedHints: cachedHint,
  };

  const promptTemplates = [];
  const templateKeys = new Set();
  const registerTemplates = (entries, sourceLabel) => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      if (!entry) {
        continue;
      }
      const keyBase = entry.id ?? entry.path ?? entry.label ?? entry.schemaId ?? sourceLabel;
      const key = `${keyBase}::${entry.source ?? sourceLabel}`;
      if (templateKeys.has(key)) {
        continue;
      }
      templateKeys.add(key);
      const previewSource = typeof entry.prompt === "string" ? entry.prompt : null;
      const preview =
        previewSource && previewSource.length > 320
          ? `${previewSource.slice(0, 320)}…`
          : previewSource;
      promptTemplates.push({
        id: entry.id ?? keyBase,
        label: entry.label ?? entry.schemaId ?? keyBase,
        schemaId: entry.schemaId ?? null,
        baseline: entry.baseline ?? null,
        task: entry.task ?? null,
        createdAt: entry.createdAt ?? null,
        workspaceType: entry.workspaceType ?? profile?.classification?.label ?? null,
        path: entry.path ?? null,
        source: entry.source ?? sourceLabel,
        preview,
      });
      if (promptTemplates.length >= 8) {
        break;
      }
    }
  };
  if (memory?.loadPromptTemplates) {
    try {
      const localTemplates = await memory.loadPromptTemplates({
        cwd: rootDir,
        limit: 5,
      });
      registerTemplates(localTemplates, "local");
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load local prompt templates: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  if (globalMemory?.loadPromptTemplates) {
    try {
      const globalTemplates = await globalMemory.loadPromptTemplates({
        workspaceType: profile?.classification?.label ?? profile?.classification?.domain ?? null,
        limit: 4,
      });
      registerTemplates(globalTemplates, "global");
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load global prompt templates: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  const promptTemplateBlock =
    promptTemplates.length > 0 ? buildPromptTemplateBlock(promptTemplates) : null;
  workspaceSnapshot.promptTemplates = promptTemplates;
  workspaceSnapshot.promptTemplateBlock = promptTemplateBlock;

  workspaceSnapshot = await attachCommandLibraryToWorkspace(
    workspaceSnapshot,
    memory,
    globalMemory,
    { limit: 8, verbose, mode, schemaId },
  );
  workspaceSnapshot = await attachPromptCompositionsToWorkspace(
    workspaceSnapshot,
    memory,
    globalMemory,
    { limit: 8, verbose },
  );

  let indexSummary = null;
  let benchmarkHistory = null;
  if (memory) {
    try {
      indexSummary = await memory.loadIndexSummaries(indexLimit);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load .miniphi index summaries: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    try {
      benchmarkHistory = await memory.loadBenchmarkHistory(benchmarkLimit);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load benchmark history: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  let navigationHints = null;
  if (navigator) {
    try {
      navigationHints = await navigator.generateNavigationHints({
        workspace: workspaceSnapshot,
        capabilities,
        objective,
        cwd: rootDir,
        executeHelper,
        focusPath,
        promptId,
        promptJournalId,
      });
    } catch (error) {
      if (verbose) {
        console.warn(
        `[MiniPhi] Navigation advisor failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (typeof navigator.consumeDisableNotice === "function") {
      const notice = navigator.consumeDisableNotice();
      if (notice) {
        emitFeatureDisableNotice("Navigation advisor", notice);
      }
    }
    }
  }

  if (memory?.saveWorkspaceHint) {
    try {
      await memory.saveWorkspaceHint({
        root: rootDir,
        summary: workspaceSnapshot.summary ?? null,
        classification: workspaceSnapshot.classification ?? null,
        hintBlock: workspaceSnapshot.hintBlock ?? null,
        directives: workspaceSnapshot.planDirectives ?? null,
        manifestPreview: workspaceSnapshot.manifestPreview ?? null,
        navigationSummary: navigationHints?.summary ?? null,
        navigationBlock: navigationHints?.block ?? null,
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to persist workspace hint cache: ${
            error instanceof Error ? error.message : error
          }`,
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
    indexSummary,
    benchmarkHistory,
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
  const schemaId =
    (typeof options["schema-id"] === "string" && options["schema-id"].trim()) ||
    (typeof options.schema === "string" && options.schema.trim()) ||
    null;
  const notes =
    typeof options.notes === "string" && options.notes.trim().length ? options.notes.trim() : null;
  const skipWorkspace = Boolean(options["no-workspace"]);

  const stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
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
      memory: stateManager,
      globalMemory,
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
      schemaId,
      workspaceContext,
    });
  } catch (error) {
    console.error(
      `[MiniPhi] Unable to build prompt baseline: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
    return;
  }

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
  await mirrorPromptTemplateToGlobal(
    saved,
    {
      label,
      schemaId: template.schemaId ?? null,
      baseline: template.metadata?.baseline ?? baseline,
      task: template.task ?? task,
    },
    workspaceContext,
    { verbose, source: "prompt-template-cli" },
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
  node src/index.js command-library --limit 10
  node src/index.js helpers --limit 6
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
  --prompt-id <id>             Attach/continue a prompt session (persists LM history)
  --plan-branch <id>           Focus a saved decomposition branch when reusing --prompt-id
  --refresh-plan               Force a fresh plan even if one exists for the prompt session
  --prompt-journal [id]        Mirror each Phi/API step + operations into .miniphi/prompt-exchanges/stepwise
  --prompt-journal-status <s>  Finalize the journal as active|paused|completed|closed (default: completed)
  --session-timeout <s>        Hard limit (seconds) for the entire MiniPhi run (optional)
  --debug-lm                   Print each objective + prompt when scoring is running
  --command-policy <mode>      Command authorization: ask | session | allow | deny (default: ask)
  --assume-yes                 Auto-approve prompts when the policy is ask/session
  --command-danger <level>     Danger classification for --cmd (low | mid | high; default: mid)
  --workspace-overview-timeout <s>   Workspace overview prompt timeout (seconds; default 120s for recompose)
  --workspace-overview-timeout-ms <ms>  Workspace overview prompt timeout (milliseconds override)
  (workspace mode also accepts free-form positional text: npx miniphi "Draft release notes".)

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
