import { MODEL_PRESETS, DEFAULT_MODEL_KEY } from "./model-presets.js";

const WRITING_KEYWORDS = [
  "write",
  "draft",
  "essay",
  "article",
  "report",
  "overview",
  "summary",
  "summarize",
  "narrative",
  "story",
  "explain",
  "explanation",
];
const RESEARCH_KEYWORDS = ["research", "search", "sources", "citations", "evidence", "browse"];
const CODING_KEYWORDS = [
  "code",
  "refactor",
  "bug",
  "fix",
  "function",
  "class",
  "module",
  "tests",
  "lint",
  "compile",
  "build",
];
const ANALYSIS_KEYWORDS = ["analyze", "diagnose", "triage", "investigate", "root cause", "log"];

function matchesKeyword(text, keywords) {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

export function classifyTaskIntent({ task, mode, workspaceContext, command } = {}) {
  const workspaceType = workspaceContext?.classification?.domain ?? null;
  const taskText = typeof task === "string" ? task : "";
  const commandText = typeof command === "string" ? command : "";

  if (matchesKeyword(taskText, RESEARCH_KEYWORDS)) {
    return { intent: "research", workspaceType };
  }
  if (matchesKeyword(taskText, CODING_KEYWORDS)) {
    return { intent: "coding", workspaceType };
  }
  if (matchesKeyword(taskText, WRITING_KEYWORDS)) {
    return { intent: "writing", workspaceType };
  }
  if (matchesKeyword(taskText, ANALYSIS_KEYWORDS)) {
    return { intent: "analysis", workspaceType };
  }

  if (mode === "run" || mode === "analyze-file") {
    return { intent: "analysis", workspaceType };
  }
  if (workspaceType === "code") {
    return { intent: "coding", workspaceType };
  }
  if (workspaceType === "docs" || workspaceType === "book") {
    return { intent: "writing", workspaceType };
  }
  if (workspaceType === "data") {
    return { intent: "analysis", workspaceType };
  }

  if (matchesKeyword(commandText, CODING_KEYWORDS)) {
    return { intent: "coding", workspaceType };
  }
  if (matchesKeyword(commandText, ANALYSIS_KEYWORDS)) {
    return { intent: "analysis", workspaceType };
  }
  return { intent: "general", workspaceType };
}

function scoreModelForIntent(modelKey, intent) {
  const preset = MODEL_PRESETS[modelKey];
  const purpose = preset?.purpose ?? "general";
  if (intent === "coding") {
    return purpose === "coding" ? 10 : 4;
  }
  if (intent === "writing" || intent === "research") {
    return purpose === "general" ? 10 : 5;
  }
  if (intent === "analysis") {
    return purpose === "coding" ? 9 : 7;
  }
  return purpose === "general" ? 8 : 6;
}

export function selectModelForIntent({ intent, candidates, fallback }) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  if (!list.length) {
    return fallback ?? DEFAULT_MODEL_KEY;
  }
  const scored = list
    .map((modelKey) => ({ modelKey, score: scoreModelForIntent(modelKey, intent) }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.modelKey ?? list[0] ?? fallback ?? DEFAULT_MODEL_KEY;
}

export function selectNitpickModels({
  task,
  workspaceContext,
  candidates,
  writerModel,
  criticModel,
} = {}) {
  const intentInfo = classifyTaskIntent({ task, mode: "nitpick", workspaceContext });
  const intent = intentInfo.intent;
  const pool = Array.isArray(candidates) && candidates.length ? candidates : Object.keys(MODEL_PRESETS);

  const writer =
    writerModel ??
    selectModelForIntent({
      intent: intent === "analysis" ? "writing" : intent,
      candidates: pool,
    });

  let critic =
    criticModel ??
    selectModelForIntent({
      intent: intent === "writing" ? "analysis" : intent,
      candidates: pool,
      fallback: writer,
    });

  if (critic === writer && pool.length > 1) {
    const alternate = pool.find((modelKey) => modelKey !== writer);
    if (alternate) {
      critic = alternate;
    }
  }

  return {
    writerModel: writer ?? DEFAULT_MODEL_KEY,
    criticModel: critic ?? DEFAULT_MODEL_KEY,
    intent,
    workspaceType: intentInfo.workspaceType ?? null,
  };
}

