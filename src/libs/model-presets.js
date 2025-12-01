export const DEFAULT_MODEL_KEY = "microsoft/phi-4-reasoning-plus";

export const DEFAULT_CONTEXT_LENGTH = 32768;
const CODING_SYSTEM_PROMPT = [
  "You are MiniPhi, a local coding agent.",
  "Prioritize precise code edits, minimal filler, and clear diffs when proposing changes.",
  "Flag risky shell commands and suggest quick checks or tests that validate your edits.",
].join(" ");

export const MODEL_PRESETS = {
  [DEFAULT_MODEL_KEY]: {
    key: DEFAULT_MODEL_KEY,
    label: "Phi-4 Reasoning+",
    purpose: "general",
    defaultContextLength: DEFAULT_CONTEXT_LENGTH,
    maxContextLength: 131072,
  },
  "ibm/granite-4-h-tiny": {
    key: "ibm/granite-4-h-tiny",
    label: "Granite 4 H Tiny",
    purpose: "coding",
    defaultContextLength: 16384,
    maxContextLength: 32768,
    systemPrompt: CODING_SYSTEM_PROMPT,
  },
  "mistralai/devstral-small-2507": {
    key: "mistralai/devstral-small-2507",
    label: "Devstral Small 2507",
    purpose: "coding",
    defaultContextLength: 128000,
    maxContextLength: 131072,
    systemPrompt: CODING_SYSTEM_PROMPT,
  },
};

const MODEL_ALIASES = new Map([
  ["phi", DEFAULT_MODEL_KEY],
  ["phi-4", DEFAULT_MODEL_KEY],
  ["phi4", DEFAULT_MODEL_KEY],
  ["phi-4-reasoning-plus", DEFAULT_MODEL_KEY],
  ["microsoft/phi-4-reasoning-plus", DEFAULT_MODEL_KEY],
  ["granite-4-h-tiny", "ibm/granite-4-h-tiny"],
  ["granite4h", "ibm/granite-4-h-tiny"],
  ["granite4", "ibm/granite-4-h-tiny"],
  ["devstral", "mistralai/devstral-small-2507"],
  ["devstral-small", "mistralai/devstral-small-2507"],
  ["mistral/devstral-small-2507", "mistralai/devstral-small-2507"],
]);

function normalizeModelDescriptor(candidate) {
  if (!candidate && candidate !== 0) {
    return { key: DEFAULT_MODEL_KEY, wasAlias: false };
  }
  const trimmed = candidate.toString().trim();
  if (!trimmed) {
    return { key: DEFAULT_MODEL_KEY, wasAlias: false };
  }
  const lookup = trimmed.toLowerCase();
  const aliasTarget = MODEL_ALIASES.get(lookup);
  if (aliasTarget) {
    return { key: aliasTarget, wasAlias: aliasTarget !== trimmed };
  }
  return { key: trimmed, wasAlias: false };
}

export function normalizeModelKey(candidate) {
  return normalizeModelDescriptor(candidate).key;
}

export function resolveModelConfig({ model, contextLength, contextIsExplicit = false } = {}) {
  const { key, wasAlias } = normalizeModelDescriptor(model);
  const preset = MODEL_PRESETS[key] ?? null;
  const fallbackContext = preset?.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH;
  const hasNumericContext = Number.isFinite(contextLength) && contextLength > 0;
  let resolvedContext =
    hasNumericContext && (contextIsExplicit || !preset) ? contextLength : fallbackContext;
  let clampedToPreset = false;
  if (preset?.maxContextLength && resolvedContext > preset.maxContextLength) {
    resolvedContext = preset.maxContextLength;
    clampedToPreset = true;
  }
  return {
    modelKey: key,
    preset,
    contextLength: resolvedContext,
    clampedToPreset,
    normalizedFromAlias: wasAlias,
    systemPrompt: preset?.systemPrompt ?? null,
    usedDefaultModel: !model,
  };
}
