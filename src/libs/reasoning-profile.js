export const DEFAULT_REASONING_PROFILE = "high";
export const REASONING_PROFILE_NAMES = Object.freeze([
  "off",
  "low",
  "medium",
  "high",
]);

const PROFILE_LIMITS = Object.freeze({
  off: Object.freeze({
    maxExpansions: 0,
    maxDepth: 1,
    expansionMaxTokens: 0,
    expansionTimeBudgetMs: 0,
  }),
  low: Object.freeze({
    maxExpansions: 1,
    maxDepth: 2,
    expansionMaxTokens: 1024,
    expansionTimeBudgetMs: 60_000,
  }),
  medium: Object.freeze({
    maxExpansions: 2,
    maxDepth: 3,
    expansionMaxTokens: 2048,
    expansionTimeBudgetMs: 120_000,
  }),
  high: Object.freeze({
    maxExpansions: 4,
    maxDepth: 3,
    expansionMaxTokens: -1,
    expansionTimeBudgetMs: 240_000,
  }),
});

export function normalizeReasoningProfile(value, fallback = DEFAULT_REASONING_PROFILE) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (REASONING_PROFILE_NAMES.includes(normalized)) {
    return normalized;
  }
  if (value === undefined || value === null || normalized === "") {
    return fallback;
  }
  throw new Error(
    `Invalid reasoning profile "${value}". Expected one of: ${REASONING_PROFILE_NAMES.join(", ")}.`,
  );
}

function normalizeAllowedOptions(model) {
  const options = model?.capabilityDetails?.reasoning?.allowedOptions;
  if (!Array.isArray(options)) {
    return [];
  }
  return [...new Set(
    options
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim().toLowerCase()),
  )];
}

function resolveModelEffort(profile, model) {
  const allowedOptions = normalizeAllowedOptions(model);
  if (!allowedOptions.length) {
    return {
      requested: profile,
      resolved: null,
      supported: false,
      exact: false,
      allowedOptions,
      reason: "model does not advertise adjustable reasoning",
    };
  }
  if (allowedOptions.includes(profile)) {
    return {
      requested: profile,
      resolved: profile,
      supported: true,
      exact: true,
      allowedOptions,
      reason: "exact reasoning level advertised by LM Studio",
    };
  }
  if (profile === "off" && allowedOptions.includes("off")) {
    return {
      requested: profile,
      resolved: "off",
      supported: true,
      exact: true,
      allowedOptions,
      reason: "reasoning disabled by advertised LM Studio option",
    };
  }
  if (profile !== "off" && allowedOptions.includes("on")) {
    return {
      requested: profile,
      resolved: "on",
      supported: true,
      exact: false,
      allowedOptions,
      reason: `model only advertises on/off reasoning; ${profile} maps to on`,
    };
  }
  return {
    requested: profile,
    resolved: null,
    supported: false,
    exact: false,
    allowedOptions,
    reason: `model reasoning options (${allowedOptions.join(", ")}) cannot represent ${profile}`,
  };
}

/**
 * Resolves the user-facing profile into independent model and MiniPhi
 * decomposition controls. Explicit low-level planner overrides always win.
 */
export function resolveReasoningProfile({
  profile,
  source = "default",
  model = null,
  maxExpansions = undefined,
  maxDepth = undefined,
  expandSubprompts = undefined,
} = {}) {
  const normalized = normalizeReasoningProfile(profile);
  const defaults = PROFILE_LIMITS[normalized];
  const explicitMaxExpansions = Number(maxExpansions);
  const explicitMaxDepth = Number(maxDepth);
  const resolvedMaxExpansions =
    Number.isFinite(explicitMaxExpansions) && explicitMaxExpansions >= 0
      ? Math.floor(explicitMaxExpansions)
      : defaults.maxExpansions;
  const resolvedMaxDepth =
    Number.isFinite(explicitMaxDepth) && explicitMaxDepth > 0
      ? Math.floor(explicitMaxDepth)
      : defaults.maxDepth;
  const expansionEnabled =
    expandSubprompts === false
      ? false
      : resolvedMaxExpansions > 0;
  return {
    profile: normalized,
    source,
    model: resolveModelEffort(normalized, model),
    agent: {
      expandSubprompts: expansionEnabled,
      maxExpansions: expansionEnabled ? resolvedMaxExpansions : 0,
      maxDepth: resolvedMaxDepth,
      expansionMaxTokens: expansionEnabled ? defaults.expansionMaxTokens : 0,
      expansionTimeBudgetMs: expansionEnabled
        ? defaults.expansionTimeBudgetMs
        : 0,
      overrides: {
        maxExpansions:
          Number.isFinite(explicitMaxExpansions) && explicitMaxExpansions >= 0,
        maxDepth: Number.isFinite(explicitMaxDepth) && explicitMaxDepth > 0,
        expandSubprompts: expandSubprompts === false,
      },
    },
  };
}

export function findCatalogModel(models, modelId) {
  if (!Array.isArray(models) || typeof modelId !== "string") {
    return null;
  }
  return models.find((model) => model?.id === modelId) ?? null;
}

export default resolveReasoningProfile;
