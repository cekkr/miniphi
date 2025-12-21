export const DEFAULT_CONTEXT_LENGTH = 16384;
const PHI_REASONING_PLUS_KEY = "microsoft/phi-4-reasoning-plus";
const DEVSTRAL_SMALL_2_2512_KEY = "mistralai/devstral-small-2-2512";
export const DEFAULT_MODEL_KEY = DEVSTRAL_SMALL_2_2512_KEY;
const CODING_SYSTEM_PROMPT = [
  "You are MiniPhi, a local coding agent.",
  "Prioritize precise code edits, minimal filler, and clear diffs when proposing changes.",
  "Flag risky shell commands and suggest quick checks or tests that validate your edits.",
].join(" ");

export const MODEL_PRESETS = {
  [DEFAULT_MODEL_KEY]: {
    key: DEFAULT_MODEL_KEY,
    label: "Granite 4 H Tiny",
    purpose: "coding",
    defaultContextLength: 16384,
    maxContextLength: 32768,
    systemPrompt: CODING_SYSTEM_PROMPT,
  },
  [PHI_REASONING_PLUS_KEY]: {
    key: PHI_REASONING_PLUS_KEY,
    label: "Phi-4 Reasoning+",
    purpose: "general",
    defaultContextLength: 32768,
    maxContextLength: 131072,
  },
  "mistralai/devstral-small-2507": {
    key: "mistralai/devstral-small-2507",
    label: "Devstral Small 2507",
    purpose: "coding",
    defaultContextLength: 128000,
    maxContextLength: 131072,
    systemPrompt: CODING_SYSTEM_PROMPT,
  },
  [DEVSTRAL_SMALL_2_2512_KEY]: {
    key: DEVSTRAL_SMALL_2_2512_KEY,
    label: "Devstral Small 2 2512",
    purpose: "coding",
    defaultContextLength: 131072,
    maxContextLength: 393216,
    systemPrompt: CODING_SYSTEM_PROMPT,
  },
};

const MODEL_ALIASES = new Map([
  ["phi", PHI_REASONING_PLUS_KEY],
  ["phi-4", PHI_REASONING_PLUS_KEY],
  ["phi4", PHI_REASONING_PLUS_KEY],
  ["phi-4-reasoning-plus", PHI_REASONING_PLUS_KEY],
  [PHI_REASONING_PLUS_KEY, PHI_REASONING_PLUS_KEY],
  ["granite-4-h-tiny", "ibm/granite-4-h-tiny"],
  ["granite4h", "ibm/granite-4-h-tiny"],
  ["granite4", "ibm/granite-4-h-tiny"],
  ["devstral", DEVSTRAL_SMALL_2_2512_KEY],
  ["devstral-small", DEVSTRAL_SMALL_2_2512_KEY],
  ["devstral-2507", "mistralai/devstral-small-2507"],
  ["devstral-2-2512", DEVSTRAL_SMALL_2_2512_KEY],
  ["devstral2", DEVSTRAL_SMALL_2_2512_KEY],
  ["mistral/devstral-small-2-2512", DEVSTRAL_SMALL_2_2512_KEY],
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
