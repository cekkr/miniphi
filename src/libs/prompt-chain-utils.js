const DEFAULT_LEARNED_SCHEMA_VERSION = "prompt-chain-learned@v1";

function normalizeOptionEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) {
    return null;
  }
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const description = typeof entry.description === "string" ? entry.description.trim() : null;
  const promptHint = typeof entry.prompt_hint === "string" ? entry.prompt_hint.trim() : null;
  return {
    id,
    label: label || id,
    description: description || null,
    prompt_hint: promptHint || null,
  };
}

function normalizeOptionSet(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const description = typeof entry.description === "string" ? entry.description.trim() : null;
  const rawOptions = Array.isArray(entry.options) ? entry.options : [];
  const options = rawOptions.map(normalizeOptionEntry).filter(Boolean);
  const defaultId = typeof entry.default === "string" ? entry.default.trim() : null;
  const selectedId = typeof entry.selected === "string" ? entry.selected.trim() : null;
  return {
    description: description || null,
    options,
    default: defaultId || null,
    selected: selectedId || null,
  };
}

export function normalizeOptionSets(rawSets) {
  if (!rawSets || typeof rawSets !== "object") {
    return {};
  }
  const normalized = {};
  for (const [setId, entry] of Object.entries(rawSets)) {
    if (!setId || typeof setId !== "string") {
      continue;
    }
    const cleanedId = setId.trim();
    if (!cleanedId) {
      continue;
    }
    const set = normalizeOptionSet(entry);
    if (!set) {
      continue;
    }
    normalized[cleanedId] = set;
  }
  return normalized;
}

export function mergeOptionSets(baseSets, learnedSets) {
  const base = normalizeOptionSets(baseSets);
  const learned = normalizeOptionSets(learnedSets);
  const merged = { ...base };
  for (const [setId, learnedSet] of Object.entries(learned)) {
    if (!merged[setId]) {
      merged[setId] = { ...learnedSet };
      continue;
    }
    const existing = merged[setId];
    const existingIds = new Set(existing.options.map((opt) => opt.id));
    const mergedOptions = [...existing.options];
    for (const option of learnedSet.options) {
      if (!existingIds.has(option.id)) {
        mergedOptions.push(option);
        existingIds.add(option.id);
      }
    }
    merged[setId] = {
      description: existing.description ?? learnedSet.description ?? null,
      options: mergedOptions,
      default: existing.default ?? learnedSet.default ?? null,
      selected: existing.selected ?? learnedSet.selected ?? null,
    };
  }
  return merged;
}

export function resolveOptionSelections(optionSets, overrides = undefined) {
  const selections = {};
  const normalizedOverrides = overrides && typeof overrides === "object" ? overrides : {};
  const normalizedSets = normalizeOptionSets(optionSets);
  for (const [setId, set] of Object.entries(normalizedSets)) {
    const override = typeof normalizedOverrides[setId] === "string"
      ? normalizedOverrides[setId].trim()
      : null;
    const optionIds = set.options.map((opt) => opt.id);
    let selected = override && optionIds.includes(override) ? override : null;
    if (!selected && set.selected && optionIds.includes(set.selected)) {
      selected = set.selected;
    }
    if (!selected && set.default && optionIds.includes(set.default)) {
      selected = set.default;
    }
    if (!selected && optionIds.length > 0) {
      selected = optionIds[0];
    }
    selections[setId] = selected;
  }
  return selections;
}

export function buildOptionHintBlock(optionSets, selections) {
  const normalizedSets = normalizeOptionSets(optionSets);
  const lines = [];
  for (const [setId, set] of Object.entries(normalizedSets)) {
    const selectedId = selections?.[setId];
    const option = set.options.find((entry) => entry.id === selectedId);
    if (!option) {
      continue;
    }
    const hint = option.prompt_hint || option.description || option.label;
    if (!hint) {
      continue;
    }
    lines.push(`- ${setId}=${option.id}: ${hint}`);
  }
  return lines.join("\n");
}

function resolvePath(source, pathText) {
  if (!source || !pathText) {
    return undefined;
  }
  return pathText.split(".").reduce((acc, key) => {
    if (!acc || typeof acc !== "object") {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(acc, key)) {
      return undefined;
    }
    return acc[key];
  }, source);
}

export function applyPromptTemplate(template, context = undefined) {
  if (!template || typeof template !== "string") {
    return "";
  }
  const source = context && typeof context === "object" ? context : {};
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (match, token) => {
    const value = resolvePath(source, token);
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "object") {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  });
}

export function normalizeOptionUpdates(rawUpdates) {
  if (!Array.isArray(rawUpdates)) {
    return [];
  }
  const normalized = [];
  for (const update of rawUpdates) {
    if (!update || typeof update !== "object") {
      continue;
    }
    const setId = typeof update.set === "string" ? update.set.trim() : "";
    if (!setId) {
      continue;
    }
    const options = Array.isArray(update.options)
      ? update.options.map(normalizeOptionEntry).filter(Boolean)
      : [];
    if (!options.length) {
      continue;
    }
    const reason = typeof update.reason === "string" ? update.reason.trim() : null;
    const defaultId = typeof update.default === "string" ? update.default.trim() : null;
    const selectedId = typeof update.selected === "string" ? update.selected.trim() : null;
    normalized.push({
      set: setId,
      options,
      reason: reason || null,
      default: defaultId || null,
      selected: selectedId || null,
    });
  }
  return normalized;
}

export function mergeLearnedOptions(learned, updates, metadata = undefined) {
  const base = learned && typeof learned === "object" ? learned : {};
  const normalizedBaseSets = normalizeOptionSets(base.option_sets ?? base.optionSets ?? {});
  const normalizedUpdates = normalizeOptionUpdates(updates);
  const now =
    typeof metadata?.now === "string" && metadata.now.trim().length > 0
      ? metadata.now.trim()
      : new Date().toISOString();
  const mergedSets = { ...normalizedBaseSets };
  for (const update of normalizedUpdates) {
    const setId = update.set;
    const existing = mergedSets[setId] ?? { description: null, options: [], default: null, selected: null };
    const existingIds = new Set(existing.options.map((opt) => opt.id));
    const appended = [];
    for (const option of update.options) {
      if (existingIds.has(option.id)) {
        continue;
      }
      appended.push({
        ...option,
        source_step: typeof metadata?.stepId === "string" ? metadata.stepId : null,
        added_at: now,
      });
      existingIds.add(option.id);
    }
    const mergedOptions = [...existing.options, ...appended];
    mergedSets[setId] = {
      description: existing.description,
      options: mergedOptions,
      default: update.default ?? existing.default ?? null,
      selected: update.selected ?? existing.selected ?? null,
    };
  }
  return {
    schema_version:
      typeof base.schema_version === "string" && base.schema_version.trim().length > 0
        ? base.schema_version.trim()
        : DEFAULT_LEARNED_SCHEMA_VERSION,
    updated_at: now,
    option_sets: mergedSets,
  };
}

export { DEFAULT_LEARNED_SCHEMA_VERSION };
