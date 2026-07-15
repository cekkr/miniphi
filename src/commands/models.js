import { resolveDurationMs } from "../libs/cli-utils.js";
import { buildRestClientOptions } from "../libs/lmstudio-client-options.js";
import { LMStudioRestClient } from "../libs/lmstudio-api.js";
import {
  estimateModelParams,
  fetchModelCatalog,
  rankModelsForTask,
} from "../libs/model-catalog.js";
import { classifyTaskIntent } from "../libs/model-selector.js";

function formatContext(maxContextLength) {
  if (!Number.isFinite(maxContextLength)) {
    return "?";
  }
  if (maxContextLength >= 1024) {
    return `${Math.round(maxContextLength / 1024)}k`;
  }
  return String(maxContextLength);
}

function formatParams(id) {
  const params = estimateModelParams(id);
  if (!Number.isFinite(params.totalB)) {
    return "?";
  }
  if (Number.isFinite(params.activeB) && params.activeB !== params.totalB) {
    return `${params.totalB}B (a${params.activeB}B)`;
  }
  return `${params.totalB}B`;
}

/**
 * `node src/index.js models [--task "<task>"] [--json]` lists the live LM
 * Studio model inventory and ranks each model for the given task so operators
 * (and `--model auto`) can see which model MiniPhi would pick and why.
 */
export async function handleModelsCommand({
  options,
  positionals,
  verbose,
  configData,
  modelSelection,
  restBaseUrl,
}) {
  const timeoutMs = resolveDurationMs({
    secondsValue: options.timeout ?? options["timeout-seconds"],
    secondsLabel: "--timeout",
    millisValue: options["timeout-ms"],
    millisLabel: "--timeout-ms",
  });
  const overrides = {};
  if (restBaseUrl) {
    overrides.baseUrl = restBaseUrl;
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    overrides.timeoutMs = timeoutMs;
  }
  const restOptions = buildRestClientOptions(configData, modelSelection, overrides);
  const restClient = new LMStudioRestClient(restOptions);

  const taskText =
    typeof options.task === "string" && options.task.trim()
      ? options.task.trim()
      : Array.isArray(positionals) && positionals.length
        ? positionals.join(" ").trim()
        : null;
  const jsonOutput = Boolean(options.json);

  let catalog;
  try {
    catalog = await fetchModelCatalog({ restClient });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: false, error: message, models: [] }, null, 2));
    } else {
      console.error(`[MiniPhi][Models] Unable to list LM Studio models: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  const { intent } = classifyTaskIntent({ task: taskText });
  const ranked = rankModelsForTask(catalog.models, { intent });

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          base_url: restClient.baseUrl ?? null,
          source: catalog.source,
          task: taskText,
          intent,
          recommended: ranked[0]?.model.id ?? null,
          models: ranked.map(({ model, score, reasons }) => ({
            ...model,
            score: Number(score.toFixed(2)),
            reasons,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `[MiniPhi][Models] ${ranked.length} chat-capable models at ${restClient.baseUrl} (intent: ${intent}${taskText ? ` for "${taskText}"` : ""})`,
  );
  ranked.forEach(({ model, score, reasons }, index) => {
    const marker = index === 0 ? "*" : " ";
    const bits = [
      `ctx=${formatContext(model.maxContextLength)}`,
      `params=${formatParams(model.id)}`,
      model.quantization ? `quant=${model.quantization}` : null,
      `state=${model.state}`,
      `score=${score.toFixed(1)}`,
    ].filter(Boolean);
    console.log(` ${marker} ${model.id} (${bits.join(" | ")})`);
    if (verbose && reasons.length) {
      console.log(`     ${reasons.join("; ")}`);
    }
  });
  if (ranked.length) {
    console.log(
      `[MiniPhi][Models] Recommended for this ${intent} task: ${ranked[0].model.id} (use --model auto to select it automatically)`,
    );
  }
}
