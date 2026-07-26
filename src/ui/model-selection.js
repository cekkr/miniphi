import { rankModelsForTask } from "../libs/model-catalog.js";
import { classifyTaskIntent } from "../libs/model-selector.js";

function normalizeRequestedModel(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "auto";
  }
  return value.trim();
}

/**
 * Builds deterministic Auto/manual choices from the normalized live catalog.
 * The task is known at this point, so Auto reflects the actual operator prompt
 * instead of a generic startup ranking.
 */
export function buildUiModelSelection({
  models = [],
  task = null,
  requestedModel = "auto",
  source = null,
  benchmarkResults = null,
} = {}) {
  const requested = normalizeRequestedModel(requestedModel);
  const { intent } = classifyTaskIntent({ task });
  const ranked = rankModelsForTask(models, { intent, benchmarkResults });
  const recommended = ranked[0] ?? null;
  const choices = [];

  if (recommended) {
    choices.push({
      value: "auto",
      requested: "auto",
      resolvedModel: recommended.model.id,
      model: recommended.model,
      score: recommended.score,
      reasons: recommended.reasons,
      benchmark: recommended.benchmark,
      intent,
      source,
      auto: true,
    });
  }

  for (const entry of ranked) {
    choices.push({
      value: entry.model.id,
      requested: entry.model.id,
      resolvedModel: entry.model.id,
      model: entry.model,
      score: entry.score,
      reasons: entry.reasons,
      benchmark: entry.benchmark,
      intent,
      source,
      auto: false,
    });
  }

  if (
    requested.toLowerCase() !== "auto" &&
    !choices.some((choice) => choice.value === requested)
  ) {
    choices.push({
      value: requested,
      requested,
      resolvedModel: requested,
      model: {
        id: requested,
        displayName: requested,
        state: "not-in-inventory",
        maxContextLength: null,
        loadedContextLength: null,
        loadedInstanceId: null,
        capabilities: [],
      },
      score: null,
      reasons: ["configured model is not present in the current LM Studio inventory"],
      intent,
      source,
      auto: false,
      unavailable: true,
    });
  }

  const selectedValue =
    requested.toLowerCase() === "auto" ||
    !choices.some((choice) => choice.value === requested)
      ? "auto"
      : requested;

  return {
    intent,
    recommendedModel: recommended?.model.id ?? null,
    selectedValue,
    choices,
  };
}

export default buildUiModelSelection;
