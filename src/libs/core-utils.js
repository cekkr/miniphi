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
