import path from "node:path";
import { resolveDurationMs } from "../libs/cli-utils.js";
import { buildRestClientOptions } from "../libs/lmstudio-client-options.js";
import { LMStudioRestClient } from "../libs/lmstudio-api.js";
import {
  estimateModelParams,
  fetchModelCatalog,
  rankModelsForTask,
} from "../libs/model-catalog.js";
import { classifyTaskIntent } from "../libs/model-selector.js";
import { loadFreshModelBenchmarkIndex } from "../libs/model-benchmarks.js";

function formatContext(maxContextLength) {
  if (!Number.isFinite(maxContextLength)) {
    return "?";
  }
  if (maxContextLength >= 1024) {
    return `${Math.round(maxContextLength / 1024)}k`;
  }
  return String(maxContextLength);
}

function formatParams(model) {
  const params = estimateModelParams(model.id, model.paramsString);
  if (!Number.isFinite(params.totalB)) {
    return "?";
  }
  if (Number.isFinite(params.activeB) && params.activeB !== params.totalB) {
    return `${params.totalB}B (a${params.activeB}B)`;
  }
  return `${params.totalB}B`;
}

function requireStringOption(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} requires a non-empty value.`);
  }
  return value.trim();
}

function parseOptionalContextLength(value) {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--context-length must be a positive integer.");
  }
  return parsed;
}

/**
 * `node src/index.js models [--task "<task>"] [--json]` lists the live LM
 * Studio model inventory and ranks each model for the given task so operators
 * (and `--model auto`) can see which model MiniPhi would pick and why.
 * Explicit `--load <model>` / `--unload <instance-id>` actions expose the v1
 * lifecycle without ever unloading another instance implicitly.
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
  let lifecycle = null;

  try {
    if (options.load && options.unload) {
      throw new Error("--load and --unload are mutually exclusive.");
    }
    if (options.load) {
      const model = requireStringOption(options.load, "--load");
      const contextLength = parseOptionalContextLength(options["context-length"]);
      const response = await restClient.loadModelV1({
        model,
        ...(contextLength ? { context_length: contextLength } : {}),
        echo_load_config: true,
      });
      lifecycle = {
        action: "load",
        target: model,
        response,
      };
    } else if (options.unload) {
      const instanceId = requireStringOption(options.unload, "--unload");
      const response = await restClient.unloadModelV1({
        instance_id: instanceId,
      });
      lifecycle = {
        action: "unload",
        target: instanceId,
        response,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonOutput) {
      console.log(
        JSON.stringify(
          { ok: false, base_url: restClient.baseUrl ?? null, error: message, models: [] },
          null,
          2,
        ),
      );
    } else {
      console.error(`[MiniPhi][Models] Lifecycle action failed: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

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
  const benchmarkIndex = await loadFreshModelBenchmarkIndex({
    cwd: path.resolve(options.cwd ?? process.cwd()),
    restClient,
    models: catalog.models,
  });
  const ranked = rankModelsForTask(catalog.models, {
    intent,
    benchmarkResults: benchmarkIndex.results,
  });

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
          lifecycle,
          benchmark_cache: benchmarkIndex.path,
          benchmark_stale_count: benchmarkIndex.staleCount,
          models: ranked.map(({ model, score, reasons, benchmark }) => ({
            ...model,
            score: Number(score.toFixed(2)),
            reasons,
            benchmark,
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
  if (lifecycle) {
    console.log(
      `[MiniPhi][Models] ${lifecycle.action === "load" ? "Loaded model" : "Unloaded instance"} ${lifecycle.target}`,
    );
  }
  ranked.forEach(({ model, score, reasons, benchmark }, index) => {
    const marker = index === 0 ? "*" : " ";
    const bits = [
      `ctx=${formatContext(model.maxContextLength)}`,
      `params=${formatParams(model)}`,
      model.quantization ? `quant=${model.quantization}` : null,
      `state=${model.state}`,
      model.loadedContextLength
        ? `loaded-ctx=${formatContext(model.loadedContextLength)}`
        : null,
      model.capabilities.length
        ? `caps=${model.capabilities.join(",")}`
        : null,
      `score=${score.toFixed(1)}`,
      benchmark ? `benchmark=${benchmark.category}:${benchmark.score}` : null,
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
