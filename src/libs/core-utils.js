import path from "path";
import { normalizeLmStudioHttpUrl } from "./lmstudio-api.js";

const VALID_DANGER_LEVELS = new Set(["low", "mid", "high"]);

export function normalizeDangerLevel(value) {
  if (!value) {
    return "mid";
  }
  const normalized = value.toString().toLowerCase();
  if (VALID_DANGER_LEVELS.has(normalized)) {
    return normalized;
  }
  return "mid";
}

export function mergeFixedReferences(context, references) {
  if (!Array.isArray(references) || references.length === 0) {
    return context;
  }
  return {
    ...(context ?? {}),
    fixedReferences: references,
  };
}

export function buildPlanOperations(plan, limit = 8) {
  if (!plan || !Array.isArray(plan.steps)) {
    return [];
  }
  const flattened = [];
  const visit = (steps) => {
    if (!Array.isArray(steps)) {
      return;
    }
    for (const step of steps) {
      if (flattened.length >= limit) {
        return;
      }
      flattened.push({
        type: "plan-step",
        id: step?.id ?? null,
        summary: step?.title ?? "Untitled step",
        status: step?.requires_subprompt ? "requires-subprompt" : "ready",
        description: step?.description ?? null,
        recommendation: step?.recommendation ?? null,
      });
      if (Array.isArray(step?.children) && step.children.length) {
        visit(step.children);
      }
    }
  };
  visit(plan.steps);
  return flattened;
}

export function buildPlanSegments(plan, options = undefined) {
  if (!plan || !Array.isArray(plan.steps)) {
    return [];
  }
  const limit = Math.max(1, Number(options?.limit) || 24);
  const segments = [];
  const visit = (steps, depth = 0) => {
    if (!Array.isArray(steps) || steps.length === 0) {
      return;
    }
    for (const step of steps) {
      if (!step || typeof step !== "object") {
        continue;
      }
      if (segments.length >= limit) {
        return;
      }
      const id = typeof step.id === "string" ? step.id : String(segments.length + 1);
      const title = typeof step.title === "string" ? step.title : "Untitled step";
      const description =
        typeof step.description === "string" && step.description.trim().length > 0
          ? step.description.trim()
          : null;
      const recommendation =
        typeof step.recommendation === "string" && step.recommendation.trim().length > 0
          ? step.recommendation.trim()
          : null;
      segments.push({
        id,
        title,
        description,
        depth,
        requiresSubprompt: Boolean(step.requires_subprompt),
        recommendation,
      });
      if (Array.isArray(step.children) && step.children.length > 0) {
        visit(step.children, depth + 1);
      }
    }
  };
  visit(plan.steps, 0);
  return segments;
}

export function formatPlanSegmentsBlock(segments, options = undefined) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return null;
  }
  const limit = Math.max(1, Number(options?.limit) || 12);
  const lines = [];
  const total = Math.min(limit, segments.length);
  for (let index = 0; index < total; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    const indent = "  ".repeat(Math.max(0, Number(segment.depth) || 0));
    const idLabel = segment.id ? `${segment.id}. ` : "";
    const flags = [];
    if (segment.requiresSubprompt) {
      flags.push("sub-prompt");
    }
    if (segment.recommendation) {
      flags.push(segment.recommendation);
    }
    const suffix = flags.length ? ` (${flags.join(" | ")})` : "";
    lines.push(`${indent}- ${idLabel}${segment.title ?? "Untitled"}${suffix}`);
    if (segment.description) {
      lines.push(`${indent}  ${segment.description}`);
    }
  }
  if (segments.length > limit) {
    lines.push(`(+${segments.length - limit} more steps)`);
  }
  return lines.join("\n");
}

export function formatPlanRecommendationsBlock(recommendedTools, options = undefined) {
  if (!Array.isArray(recommendedTools) || recommendedTools.length === 0) {
    return null;
  }
  const limit = Math.max(1, Number(options?.limit) || 6);
  const normalized = recommendedTools
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (!normalized.length) {
    return null;
  }
  const lines = normalized.slice(0, limit).map((tool) => `- ${tool}`);
  if (normalized.length > limit) {
    lines.push(`(+${normalized.length - limit} more recommended tools/scripts)`);
  }
  return `Recommended helpers:\n${lines.join("\n")}`;
}

export function buildNavigationOperations(hints, limit = 6) {
  if (!hints) {
    return [];
  }
  const operations = [];
  if (Array.isArray(hints.actions)) {
    for (const action of hints.actions) {
      if (!action?.command) {
        continue;
      }
      operations.push({
        type: "command",
        command: action.command,
        status: "pending",
        danger: normalizeDangerLevel(action.danger ?? "mid"),
        summary: action.reason ?? "Navigator follow-up",
        authorizationHint: action.authorizationHint ?? action.authorization_hint ?? null,
      });
      if (operations.length >= limit) {
        return operations;
      }
    }
  }
  if (operations.length < limit && Array.isArray(hints.focusCommands)) {
    for (const command of hints.focusCommands) {
      if (!command) continue;
      operations.push({
        type: "command",
        command,
        status: "pending",
        danger: "mid",
        summary: "Navigator focus command",
      });
      if (operations.length >= limit) {
        break;
      }
    }
  }
  return operations;
}

export function normalizePlanDirections(candidate) {
  if (!candidate) {
    return [];
  }
  const rawValues = Array.isArray(candidate) ? candidate : String(candidate).split(",");
  return rawValues
    .map((value) => (typeof value === "string" ? value.toLowerCase().trim() : ""))
    .filter(Boolean);
}

export function buildResourceConfig(cliOptions) {
  const parsePercent = (value) => {
    if (value === undefined) {
      return undefined;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return undefined;
    }
    return Math.min(100, Math.max(1, numeric));
  };
  const parseInterval = (value) => {
    if (value === undefined) {
      return undefined;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 250) {
      return undefined;
    }
    return numeric;
  };

  const thresholds = {};
  const memory = parsePercent(cliOptions?.["max-memory-percent"]);
  const cpu = parsePercent(cliOptions?.["max-cpu-percent"]);
  const vram = parsePercent(cliOptions?.["max-vram-percent"]);
  if (typeof memory === "number") thresholds.memory = memory;
  if (typeof cpu === "number") thresholds.cpu = cpu;
  if (typeof vram === "number") thresholds.vram = vram;

  return {
    thresholds,
    sampleInterval: parseInterval(cliOptions?.["resource-sample-interval"]),
  };
}

export function resolveLmStudioHttpBaseUrl(configData, env = process.env) {
  const candidate =
    configData?.lmStudio?.rest?.baseUrl ??
    configData?.rest?.baseUrl ??
    env?.LMSTUDIO_REST_URL ??
    configData?.lmStudio?.clientOptions?.baseUrl ??
    null;
  if (!candidate) {
    return null;
  }
  return normalizeLmStudioHttpUrl(candidate);
}

function isLoopbackHostname(hostname) {
  if (!hostname) {
    return true;
  }
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  if (normalized.startsWith("127.")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7);
    if (mapped.startsWith("127.") || mapped === "localhost") {
      return true;
    }
  }
  return false;
}

export function isLocalLmStudioBaseUrl(baseUrl) {
  if (!baseUrl) {
    return true;
  }
  try {
    const hostname = new URL(baseUrl).hostname;
    return isLoopbackHostname(hostname);
  } catch {
    return true;
  }
}

function toStringArray(candidate) {
  if (!candidate && candidate !== 0) {
    return [];
  }
  if (Array.isArray(candidate)) {
    return candidate
      .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return candidate
    .toString()
    .split(/[,|]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeLineRangeValue(value) {
  if (!value && value !== 0) {
    return null;
  }
  if (Array.isArray(value)) {
    const [start, end] = value;
    const startLine = Number(start);
    const endLine = Number(end);
    if (Number.isFinite(startLine) || Number.isFinite(endLine)) {
      return {
        startLine: Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : null,
        endLine: Number.isFinite(endLine) ? Math.max(1, Math.floor(endLine)) : null,
      };
    }
    return null;
  }
  if (typeof value === "object") {
    const startCandidate =
      value.start ?? value.begin ?? value.from ?? value.first ?? value.min ?? value.low;
    const endCandidate = value.end ?? value.stop ?? value.to ?? value.last ?? value.max ?? value.high;
    const startLine = Number(startCandidate);
    const endLine = Number(endCandidate);
    if (Number.isFinite(startLine) || Number.isFinite(endLine)) {
      return {
        startLine: Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : null,
        endLine: Number.isFinite(endLine) ? Math.max(1, Math.floor(endLine)) : null,
      };
    }
    return null;
  }
  const match = value.toString().match(/(\d+)\s*[-:,]\s*(\d+)/);
  if (match) {
    const startLine = Number(match[1]);
    const endLine = Number(match[2]);
    if (Number.isFinite(startLine) || Number.isFinite(endLine)) {
      return {
        startLine: Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : null,
        endLine: Number.isFinite(endLine) ? Math.max(1, Math.floor(endLine)) : null,
      };
    }
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return {
      startLine: Math.max(1, Math.floor(numeric)),
      endLine: null,
    };
  }
  return null;
}

export function normalizeTruncationPlan(strategy) {
  if (!strategy || typeof strategy !== "object") {
    return null;
  }
  const rawChunks = Array.isArray(strategy.chunking_plan ?? strategy.chunkingPlan)
    ? strategy.chunking_plan ?? strategy.chunkingPlan
    : [];
  const chunkingPlan = rawChunks
    .map((entry, index) => {
      if (!entry) {
        return null;
      }
      const range =
        normalizeLineRangeValue(
          entry.lines ?? entry.line_range ?? entry.lineWindow ?? entry.lineRange,
        ) ?? null;
      const helperCommands = toStringArray(
        entry.helper_commands ?? entry.commands ?? entry.helpers ?? [],
      );
      return {
        id: entry.id ?? `chunk-${index + 1}`,
        index,
        goal: entry.goal ?? entry.label ?? `Chunk ${index + 1}`,
        label: entry.label ?? entry.goal ?? `Chunk ${index + 1}`,
        priority: Number.isFinite(Number(entry.priority))
          ? Number(entry.priority)
          : index + 1,
        context: entry.context ?? entry.summary ?? entry.notes ?? null,
        notes: entry.notes ?? null,
        startLine: range?.startLine ?? null,
        endLine: range?.endLine ?? null,
        helperCommands,
        raw: entry,
      };
    })
    .filter(Boolean);
  const carryoverFields = toStringArray(strategy.carryover_fields ?? strategy.carryoverFields);
  const helperFocus = toStringArray(strategy.helper_focus ?? strategy.helperFocus);
  const helperCommands = toStringArray(strategy.helper_commands ?? strategy.helperCommands);
  const historySchema =
    typeof strategy.history_schema === "string"
      ? strategy.history_schema
      : typeof strategy.historySchema === "string"
        ? strategy.historySchema
        : null;
  const shouldSplitFlag =
    strategy.should_split ?? strategy.shouldSplit ?? (chunkingPlan.length > 0 ? true : null);
  return {
    shouldSplit: Boolean(shouldSplitFlag),
    chunkingPlan,
    carryoverFields,
    historySchema,
    helperFocus,
    helperCommands,
    notes: typeof strategy.notes === "string" ? strategy.notes : null,
    raw: strategy,
  };
}

export function extractTruncationPlanFromAnalysis(analysisText) {
  const parsed = parseStrictJsonObject(analysisText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const strategy = parsed.truncation_strategy ?? parsed.truncationStrategy ?? null;
  if (!strategy) {
    return null;
  }
  const plan = normalizeTruncationPlan(strategy);
  if (!plan) {
    return null;
  }
  const hasGuidance =
    plan.chunkingPlan.length > 0 ||
    plan.helperCommands.length > 0 ||
    plan.helperFocus.length > 0 ||
    Boolean(plan.historySchema) ||
    Boolean(plan.notes);
  if (!plan.shouldSplit && !hasGuidance) {
    return null;
  }
  const nextStepsCandidate = parsed.next_steps ?? parsed.nextSteps;
  const nextSteps = Array.isArray(nextStepsCandidate)
    ? nextStepsCandidate
        .filter((step) => typeof step === "string" && step.trim().length > 0)
        .map((step) => step.trim())
    : [];
  const recommendedFixesCandidate =
    parsed.recommended_fixes ?? parsed.recommendedFixes ?? [];
  const recommendedFixes = Array.isArray(recommendedFixesCandidate)
    ? recommendedFixesCandidate
    : [];
  return {
    plan,
    task: typeof parsed.task === "string" ? parsed.task : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    nextSteps,
    recommendedFixes,
  };
}

export function extractRecommendedCommandsFromAnalysis(analysisText) {
  const parsed = parseStrictJsonObject(analysisText);
  const fixes = parsed?.recommended_fixes ?? parsed?.recommendedFixes;
  if (!Array.isArray(fixes) || fixes.length === 0) {
    return [];
  }
  const commands = [];
  fixes.forEach((fix, index) => {
    if (!fix) {
      return;
    }
    const commandList = Array.isArray(fix.commands)
      ? fix.commands
      : Array.isArray(fix.scripts)
        ? fix.scripts
        : [];
    commandList.forEach((commandText) => {
      if (typeof commandText !== "string") {
        return;
      }
      const trimmed = commandText.trim();
      if (!trimmed || !_isExecutableCommand(trimmed)) {
        return;
      }
      commands.push({
        command: trimmed,
        description:
          typeof fix.description === "string"
            ? fix.description.trim()
            : `Command suggestion from recommended fix #${index + 1}`,
        files: Array.isArray(fix.files)
          ? fix.files.map((file) => (typeof file === "string" ? file.trim() : null)).filter(Boolean)
          : [],
        owner: typeof fix.owner === "string" ? fix.owner.trim() : null,
        tags: ["recommended-fix"],
      });
    });
  });
  return commands;
}

export function extractContextRequestsFromAnalysis(analysisText) {
  const parsed = parseStrictJsonObject(analysisText);
  const rawRequests = parsed?.context_requests ?? parsed?.contextRequests;
  if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
    return [];
  }
  const normalized = [];
  for (const request of rawRequests) {
    if (!request || typeof request !== "object") {
      continue;
    }
    const description =
      (typeof request.description === "string" && request.description.trim().length > 0
        ? request.description.trim()
        : null) ||
      (typeof request.request === "string" && request.request.trim().length > 0
        ? request.request.trim()
        : null);
    if (!description) {
      continue;
    }
    const detail =
      (typeof request.details === "string" && request.details.trim().length > 0
        ? request.details.trim()
        : null) ||
      (typeof request.detail === "string" && request.detail.trim().length > 0
        ? request.detail.trim()
        : null);
    const priority =
      typeof request.priority === "string" && request.priority.trim().length > 0
        ? request.priority.trim().toLowerCase()
        : null;
    const context =
      (typeof request.context === "string" && request.context.trim().length > 0
        ? request.context.trim()
        : null) ||
      (typeof request.scope === "string" && request.scope.trim().length > 0
        ? request.scope.trim()
        : null);
    const source =
      typeof request.source === "string" && request.source.trim().length > 0
        ? request.source.trim()
        : null;
    const id =
      typeof request.id === "string" && request.id.trim().length > 0 ? request.id.trim() : null;
    normalized.push({ id, description, detail, priority, context, source });
  }
  return normalized;
}

export function extractMissingSnippetsFromAnalysis(analysisText) {
  const parsed = parseStrictJsonObject(analysisText);
  const rawSnippets = parsed?.missing_snippets ?? parsed?.missingSnippets;
  if (!Array.isArray(rawSnippets) || rawSnippets.length === 0) {
    return [];
  }
  return rawSnippets
    .map((entry) => (typeof entry === "string" ? entry.trim() : null))
    .filter((entry) => entry && entry.length > 0);
}

export function extractNeedsMoreContextFlag(analysisText) {
  const parsed = parseStrictJsonObject(analysisText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (typeof parsed.needs_more_context === "boolean") {
    return parsed.needs_more_context;
  }
  if (typeof parsed.needsMoreContext === "boolean") {
    return parsed.needsMoreContext;
  }
  return null;
}

function stripThinkBlocks(text = "") {
  if (!text) {
    return "";
  }
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function stripJsonLikeFences(payload = "") {
  if (!payload) {
    return "";
  }
  const trimmed = payload.trim();
  if (!trimmed) {
    return "";
  }
  let candidate = trimmed;
  if (!candidate.startsWith("```")) {
    const fenceIndex = candidate.search(/(^|\n)```/);
    if (fenceIndex !== -1) {
      const offset = candidate[fenceIndex] === "\n" ? 1 : 0;
      candidate = candidate.slice(fenceIndex + offset).trimStart();
    }
  }
  if (!candidate.startsWith("```")) {
    return candidate;
  }
  const firstLineEnd = candidate.indexOf("\n");
  if (firstLineEnd === -1) {
    return candidate;
  }
  const fence = candidate.slice(0, firstLineEnd);
  if (/```json/i.test(fence)) {
    return candidate.slice(firstLineEnd + 1).replace(/```$/, "").trim();
  }
  return candidate.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
}

export function parseStrictJson(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const cleaned = stripJsonLikeFences(stripThinkBlocks(text)).trim();
  if (!cleaned) {
    return null;
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export function parseStrictJsonObject(text) {
  const parsed = parseStrictJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

function stripResponsePreamble(text = "") {
  if (!text) {
    return "";
  }
  const firstJsonIndex = text.search(/[{[]/);
  if (firstJsonIndex <= 0) {
    return text;
  }
  const prefix = text.slice(0, firstJsonIndex);
  const trimmed = prefix.trim();
  if (!trimmed) {
    return text.slice(firstJsonIndex);
  }
  const keyword = trimmed.split(/[\s:]+/)[0]?.toLowerCase() ?? "";
  const hasNewline = /[\r\n]/.test(prefix);
  const endsWithColon = trimmed.endsWith(":");
  const shortPreamble = trimmed.length <= 12;
  const knownPreamble =
    keyword.length > 0 &&
    [
      "assistant",
      "sure",
      "here",
      "note",
      "plan",
      "json",
      "response",
      "understood",
      "ok",
      "okay",
      "alright",
      "analysis",
      "summary",
      "thanks",
      "btw",
    ].includes(keyword);
  if (hasNewline || endsWithColon || shortPreamble || knownPreamble) {
    return text.slice(firstJsonIndex);
  }
  return text;
}

function sliceLikelyJsonPayload(text, openChar, closeChar) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const start = text.indexOf(openChar);
  const end = text.lastIndexOf(closeChar);
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1).trim();
}

export function extractJsonBlock(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const cleaned = stripThinkBlocks(stripJsonLikeFences(text));
  const trimmed = cleaned.trim();
  const sources = [];
  const preambleStripped = stripResponsePreamble(trimmed);
  if (preambleStripped && preambleStripped !== trimmed) {
    sources.push(preambleStripped);
  }
  if (trimmed) {
    sources.push(trimmed);
  }
  const candidates = [];
  const seen = new Set();
  for (const source of sources) {
    if (!source || seen.has(source)) {
      continue;
    }
    seen.add(source);
    candidates.push(source);
    const objectCandidate = sliceLikelyJsonPayload(source, "{", "}");
    if (objectCandidate && !seen.has(objectCandidate)) {
      seen.add(objectCandidate);
      candidates.push(objectCandidate);
    }
    const arrayCandidate = sliceLikelyJsonPayload(source, "[", "]");
    if (arrayCandidate && !seen.has(arrayCandidate)) {
      seen.add(arrayCandidate);
      candidates.push(arrayCandidate);
    }
  }
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      // keep searching other candidates
    }
  }
  return null;
}

const NON_COMMAND_EXTENSIONS = new Set([
  ".c",
  ".h",
  ".hpp",
  ".hh",
  ".md",
  ".markdown",
  ".txt",
  ".log",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".lock",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".xml",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".svg",
]);

function _isExecutableCommand(text) {
  if (!text || typeof text !== "string") {
    return false;
  }
  const normalized = text.trim();
  if (!normalized || normalized.length > 240 || normalized.includes("\n")) {
    return false;
  }
  const ext = path.extname(normalized).toLowerCase();
  if (ext && NON_COMMAND_EXTENSIONS.has(ext) && !normalized.includes(" ")) {
    return false;
  }
  return true;
}
