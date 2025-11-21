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
  if (!analysisText || typeof analysisText !== "string") {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(analysisText);
  } catch {
    return null;
  }
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
  if (!analysisText || typeof analysisText !== "string") {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(analysisText);
  } catch {
    return [];
  }
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
      if (!trimmed) {
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
  if (!analysisText || typeof analysisText !== "string") {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(analysisText);
  } catch {
    return [];
  }
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
