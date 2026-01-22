import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import CliExecutor from "./cli-executor.js";
import WorkspaceProfiler from "./workspace-profiler.js";
import CapabilityInventory from "./capability-inventory.js";
import MiniPhiMemory from "./miniphi-memory.js";
import ResourceMonitor from "./resource-monitor.js";
import ApiNavigator from "./api-navigator.js";
import PromptDecomposer from "./prompt-decomposer.js";
import PromptTemplateBaselineBuilder from "./prompt-template-baselines.js";
import { parseNumericSetting } from "./cli-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const GENERAL_BENCHMARK_BASELINE_PATH = path.join(
  PROJECT_ROOT,
  "benchmark",
  "baselines",
  "general-purpose-baseline.json",
);

async function loadGeneralBenchmarkBaseline() {
  try {
    const payload = await fs.promises.readFile(GENERAL_BENCHMARK_BASELINE_PATH, "utf8");
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function computeResourceBaselineDiff(current, baseline) {
  if (!current || !baseline) {
    return null;
  }
  const diff = {};
  for (const metric of ["memory", "cpu", "vram"]) {
    const currentMetric = current[metric];
    const baselineMetric = baseline[metric];
    const currentAvg = Number(currentMetric?.avg ?? currentMetric?.mean ?? NaN);
    const baselineAvg = Number(baselineMetric?.avg ?? baselineMetric?.mean ?? NaN);
    if (!Number.isFinite(currentAvg) || !Number.isFinite(baselineAvg)) {
      continue;
    }
    diff[metric] = {
      currentAvg: Number(currentAvg.toFixed(2)),
      baselineAvg: Number(baselineAvg.toFixed(2)),
      delta: Number((currentAvg - baselineAvg).toFixed(2)),
    };
  }
  return Object.keys(diff).length ? diff : null;
}

function formatResourceBaselineDiff(diff) {
  if (!diff) {
    return "";
  }
  const parts = [];
  for (const metric of ["memory", "cpu", "vram"]) {
    const entry = diff[metric];
    if (!entry) {
      continue;
    }
    const delta = entry.delta;
    const deltaLabel = delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
    parts.push(
      `${metric} \u0394 ${deltaLabel} (current ${entry.currentAvg.toFixed(2)} vs baseline ${entry.baselineAvg.toFixed(2)})`,
    );
  }
  return parts.join(" | ");
}

async function runGeneralPurposeBenchmark({
  options,
  verbose,
  schemaRegistry,
  restClient = null,
  configData = undefined,
  resourceConfig = undefined,
  resourceMonitorForcedDisabled = false,
  generateWorkspaceSnapshot,
  globalMemory,
  schemaAdapterRegistry,
  mirrorPromptTemplateToGlobal,
  emitFeatureDisableNotice,
}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const task =
    (typeof options.task === "string" && options.task.trim()) ||
    (typeof options.objective === "string" && options.objective.trim()) ||
    "General-purpose benchmark";
  const command = options.cmd ?? options.command ?? null;
  const silenceTimeout = parseNumericSetting(options["silence-timeout"], "--silence-timeout") ?? 15000;
  const timeoutMs = parseNumericSetting(options.timeout, "--timeout") ?? 60000;
  const stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
  let benchmarkMonitor = null;
  let benchmarkMonitorResult = null;
  if (!resourceMonitorForcedDisabled) {
    const monitorHistoryFile = path.join(stateManager.historyDir, "benchmark-resource-usage.json");
    benchmarkMonitor = new ResourceMonitor({
      ...(resourceConfig ?? {}),
      historyFile: monitorHistoryFile,
      label: `benchmark:general:${path.basename(cwd) || "workspace"}`,
    });
    try {
      await benchmarkMonitor.start(`benchmark:${path.basename(cwd) || cwd}`);
    } catch (error) {
      benchmarkMonitor = null;
      if (verbose) {
        console.warn(
          `[MiniPhi][Benchmark] Resource monitor unavailable for general-purpose benchmark: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  const cli = new CliExecutor();
  const workspaceProfiler = new WorkspaceProfiler();
  const capabilityInventory = new CapabilityInventory();
  const navigator =
    restClient &&
    new ApiNavigator({
      restClient,
      cliExecutor: cli,
      memory: stateManager,
      globalMemory,
      logger: verbose ? (message) => console.warn(message) : null,
      adapterRegistry: schemaAdapterRegistry,
      schemaRegistry,
      helperSilenceTimeoutMs: configData?.prompt?.navigator?.helperSilenceTimeoutMs,
    });
  const workspaceContext = await generateWorkspaceSnapshot({
    rootDir: cwd,
    workspaceProfiler,
    capabilityInventory,
    verbose,
    navigator: navigator ?? null,
    objective: task,
    executeHelper: true,
    memory: stateManager,
    globalMemory,
    emitFeatureDisableNotice,
  });

  let decompositionPlan = null;
  if (restClient) {
    const decomposer = new PromptDecomposer({
      restClient,
      logger: verbose ? (message) => console.warn(message) : null,
      schemaRegistry,
    });
    try {
      decompositionPlan = await decomposer.decompose({
        objective: `${task} (plan)`,
        command: command ?? null,
        workspace: workspaceContext,
        storage: stateManager,
        metadata: { mode: "benchmark", scope: "general-purpose" },
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi][Benchmark] Prompt decomposer skipped: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    } finally {
      if (typeof decomposer.consumeDisableNotice === "function") {
        const notice = decomposer.consumeDisableNotice();
        if (notice) {
          emitFeatureDisableNotice("Prompt decomposer", notice);
        }
      }
    }
  }

  const builder = new PromptTemplateBaselineBuilder({ schemaRegistry });
  const datasetSummary =
    workspaceContext?.summary ??
    `Workspace ${path.basename(cwd) || cwd} contains mixed artifacts; optimize prompts for this context.`;
  const templatePayloads = [
    builder.build({
      baseline: "truncation",
      task: `${task} (chunking)`,
      datasetSummary,
      workspaceContext,
    }),
    builder.build({
      baseline: "analysis",
      task: `${task} (analysis)`,
      datasetSummary,
      workspaceContext,
    }),
  ];
  const savedTemplates = [];
  for (const payload of templatePayloads) {
    const templateLabel = `general-purpose ${payload.metadata?.baseline ?? payload.baseline ?? "prompt"}`;
    const saved = await stateManager.savePromptTemplateBaseline({
      ...payload,
      label: templateLabel,
      cwd,
    });
    savedTemplates.push(saved);
    if (verbose) {
      const rel = path.relative(process.cwd(), saved.path) || saved.path;
      console.log(`[MiniPhi][Benchmark] Saved prompt template to ${rel}`);
    }
    await mirrorPromptTemplateToGlobal(
      saved,
      {
        label: templateLabel,
        schemaId: payload.schemaId ?? null,
        baseline: payload.metadata?.baseline ?? payload.baseline ?? null,
        task: payload.task ?? null,
      },
      workspaceContext,
      { verbose, source: "general-benchmark" },
    );
  }

  let commandDetails = null;
  if (command) {
    const logDir = path.join(stateManager.historyDir, "benchmarks");
    await fs.promises.mkdir(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = command.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "command";
    const stdoutPath = path.join(logDir, `${timestamp}-${slug}-stdout.log`);
    const stderrPath = path.join(logDir, `${timestamp}-${slug}-stderr.log`);
    if (verbose) {
      console.log(`[MiniPhi][Benchmark] Running general-purpose command: ${command}`);
    }
    let execResult;
    try {
      execResult = await cli.executeCommand(command, {
        cwd,
        timeout: timeoutMs,
        maxSilenceMs: silenceTimeout,
        captureOutput: true,
        onStdout: (text) => process.stdout.write(text),
        onStderr: (text) => process.stderr.write(text),
      });
    } catch (error) {
      execResult = {
        code: typeof error.code === "number" ? error.code : -1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? (error instanceof Error ? error.message : String(error)),
        silenceExceeded: error.silenceExceeded ?? false,
        durationMs: error.durationMs ?? null,
      };
      if (verbose) {
        console.warn(`[MiniPhi][Benchmark] Command execution failed: ${execResult.stderr}`);
      }
    }
    await fs.promises.writeFile(stdoutPath, execResult.stdout ?? "", "utf8");
    await fs.promises.writeFile(stderrPath, execResult.stderr ?? "", "utf8");
    commandDetails = {
      command,
      exitCode: execResult.code ?? execResult.exitCode ?? 0,
      stdoutPath,
      stderrPath,
      silenceExceeded: Boolean(execResult.silenceExceeded),
      durationMs: execResult.durationMs ?? null,
    };
    if (verbose) {
      console.log(
        `[MiniPhi][Benchmark] Command finished with exit ${commandDetails.exitCode}${
          commandDetails.silenceExceeded ? " (terminated for silence)" : ""
        }`,
      );
    }
    if (commandDetails.silenceExceeded) {
      console.warn(
        "[MiniPhi][Benchmark] Command output stalled; review stdout/stderr logs before trusting the run.",
      );
    }
  }

  if (benchmarkMonitor) {
    try {
      benchmarkMonitorResult = await benchmarkMonitor.stop();
      if (benchmarkMonitorResult?.persisted?.path && verbose) {
        const relMonitor =
          path.relative(process.cwd(), benchmarkMonitorResult.persisted.path) ||
          benchmarkMonitorResult.persisted.path;
        console.log(`[MiniPhi][Benchmark] Resource stats appended to ${relMonitor}`);
      }
      if (benchmarkMonitorResult?.summary?.warnings?.length) {
        for (const warning of benchmarkMonitorResult.summary.warnings) {
          console.warn(`[MiniPhi][Resources] ${warning}`);
        }
      }
    } catch (error) {
      console.warn(
        `[MiniPhi][Benchmark] Unable to finalize resource monitor: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  const summaryDir = path.join(stateManager.historyDir, "benchmarks");
  await fs.promises.mkdir(summaryDir, { recursive: true });
  const summaryPath = path.join(
    summaryDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-general-benchmark.json`,
  );
  const resourceStats = benchmarkMonitorResult?.summary?.stats ?? null;
  let resourceBaseline = null;
  let resourceBaselineDiff = null;
  try {
    resourceBaseline = await loadGeneralBenchmarkBaseline();
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi][Benchmark] Unable to load general-purpose baseline: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  if (resourceStats && resourceBaseline?.resourceStats) {
    resourceBaselineDiff = computeResourceBaselineDiff(resourceStats, resourceBaseline.resourceStats);
  }
  if (resourceBaselineDiff) {
    const diffSummary = formatResourceBaselineDiff(resourceBaselineDiff);
    if (diffSummary) {
      console.log(`[MiniPhi][Benchmark] Resource delta vs baseline: ${diffSummary}`);
    }
  }
  const summary = {
    kind: "general-purpose",
    analyzedAt: new Date().toISOString(),
    directory: cwd,
    task,
    workspaceType: workspaceContext?.classification?.label ?? null,
    workspaceSummary: workspaceContext?.summary ?? null,
    templates: savedTemplates.map((entry) => entry?.path ?? null).filter(Boolean),
    command: commandDetails,
    navigation: workspaceContext?.navigationSummary ?? null,
    helperScript: workspaceContext?.helperScript
      ? {
          id: workspaceContext.helperScript.id ?? null,
          name: workspaceContext.helperScript.name ?? null,
          path: workspaceContext.helperScript.path ?? null,
          version: workspaceContext.helperScript.version ?? null,
          stdin: workspaceContext.helperScript.stdin ?? null,
          run: workspaceContext.helperScript.run
            ? {
                exitCode: workspaceContext.helperScript.run.exitCode ?? null,
                summary: workspaceContext.helperScript.run.summary ?? null,
                silenceExceeded: workspaceContext.helperScript.run.silenceExceeded ?? null,
              }
            : null,
        }
      : null,
    decompositionPlan: decompositionPlan
      ? {
          id: decompositionPlan.planId ?? null,
          summary: decompositionPlan.summary ?? null,
          outline: decompositionPlan.outline ?? null,
        }
      : null,
    resourceStats,
    resourceWarnings: benchmarkMonitorResult?.summary?.warnings ?? [],
    resourceLogPath: benchmarkMonitorResult?.persisted?.path ?? null,
    resourceBaseline: resourceBaseline?.resourceStats ?? null,
    resourceBaselineLabel: resourceBaseline?.label ?? null,
    resourceBaselineSources: resourceBaseline?.logSources ?? resourceBaseline?.sources ?? null,
    resourceBaselineDiff,
  };
  await fs.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  await stateManager.recordBenchmarkSummary(summary, { summaryPath, type: "general-purpose" });
  if (verbose) {
    const rel = path.relative(process.cwd(), summaryPath) || summaryPath;
    console.log(`[MiniPhi][Benchmark] General-purpose benchmark summary saved to ${rel}`);
  }
}

export { runGeneralPurposeBenchmark };
