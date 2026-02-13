import fs from "fs";
import path from "path";
import YAML from "yaml";
import RecomposeBenchmarkRunner from "../libs/recompose-benchmark-runner.js";
import BenchmarkAnalyzer from "../libs/benchmark-analyzer.js";
import { resolveDurationMs } from "../libs/cli-utils.js";
import { normalizePlanDirections } from "../libs/core-utils.js";
import { runGeneralPurposeBenchmark } from "../libs/benchmark-general.js";
import { createRecomposeHarness } from "../libs/recompose-harness.js";
import { LMStudioRestClient } from "../libs/lmstudio-api.js";
import { buildRestClientOptions } from "../libs/lmstudio-client-options.js";

export async function handleBenchmarkCommand(context) {
  const {
    options,
    positionals,
    verbose,
    configData,
    promptDefaults,
    contextLength,
    debugLm,
    gpu,
    schemaRegistry,
    systemPrompt,
    modelKey,
    restClient = null,
    resourceConfig = undefined,
    resourceMonitorForcedDisabled = false,
    promptDbPath,
    generateWorkspaceSnapshot,
    globalMemory,
    schemaAdapterRegistry,
    mirrorPromptTemplateToGlobal,
    emitFeatureDisableNotice,
  } = context;

  const mode = (positionals[0] ?? options.mode ?? "recompose").toLowerCase();
  if (mode === "analyze") {
    const baselineDir = options.baseline ?? options.path ?? options.dir ?? positionals[1] ?? null;
    if (!baselineDir) {
      throw new Error("benchmark analyze requires --path <dir> or a positional directory argument.");
    }
    const candidateDir = options.compare ?? options.candidate ?? null;
    const analyzer = new BenchmarkAnalyzer();
    if (candidateDir) {
      await analyzer.compareDirectories(baselineDir, candidateDir);
    } else {
      await analyzer.analyzeDirectory(baselineDir);
    }
    return;
  }

  if (mode === "general" || mode === "general-purpose" || mode === "generalpurpose") {
    const liveLmRequested =
      options["live-lm"] === true ||
      options.liveLm === true ||
      process.env.MINIPHI_BENCHMARK_LIVE_LM === "1";
    const liveLmTimeoutMs =
      resolveDurationMs({
        secondsValue: options["live-lm-timeout"],
        secondsLabel: "--live-lm-timeout",
        millisValue: options["live-lm-timeout-ms"],
        millisLabel: "--live-lm-timeout-ms",
      }) ?? 12000;
    const liveLmPlanTimeoutMs =
      resolveDurationMs({
        secondsValue: options["live-lm-plan-timeout"],
        secondsLabel: "--live-lm-plan-timeout",
        millisValue: options["live-lm-plan-timeout-ms"],
        millisLabel: "--live-lm-plan-timeout-ms",
      }) ?? 12000;
    let effectiveRestClient = restClient;
    if (liveLmRequested && !effectiveRestClient) {
      try {
        const clientOptions = buildRestClientOptions(
          configData,
          { modelKey, contextLength },
          { timeoutMs: liveLmTimeoutMs },
        );
        effectiveRestClient = new LMStudioRestClient(clientOptions);
      } catch (error) {
        effectiveRestClient = null;
        if (verbose) {
          console.warn(
            `[MiniPhi][Benchmark] Live LM initialization failed: ${
              error instanceof Error ? error.message : error
            }`,
          );
        }
      }
    }
    await runGeneralPurposeBenchmark({
      options,
      verbose,
      schemaRegistry,
      restClient: effectiveRestClient,
      liveLmEnabled: liveLmRequested,
      liveLmTimeoutMs,
      liveLmPlanTimeoutMs,
      configData,
      resourceConfig,
      resourceMonitorForcedDisabled,
      generateWorkspaceSnapshot,
      globalMemory,
      schemaAdapterRegistry,
      mirrorPromptTemplateToGlobal,
      emitFeatureDisableNotice,
    });
    return;
  }

  if (mode === "plan") {
    const action = (positionals[1] ?? options.action ?? "scaffold").toLowerCase();
    if (action !== "scaffold") {
      throw new Error(`Unsupported benchmark plan action "${action}".`);
    }
    const sampleDir = options.sample ?? options["sample-dir"] ?? positionals[2] ?? null;
    await scaffoldBenchmarkPlan({
      sampleDir,
      benchmarkRoot: options["benchmark-root"] ?? null,
      outputPath: options.output ?? options.o ?? null,
      verbose,
    });
    return;
  }

  if (mode !== "recompose") {
    throw new Error(`Unsupported benchmark mode "${mode}". Expected "recompose" or "analyze".`);
  }

  const planPath = options.plan ?? options["plan-file"] ?? null;
  const plan = planPath ? await loadBenchmarkPlan(planPath) : null;
  if (plan?.path && verbose) {
    const rel = path.relative(process.cwd(), plan.path) || plan.path;
    console.log(`[MiniPhi][Benchmark] Loaded plan from ${rel}`);
  }
  const planSample = plan ? resolvePlanPath(plan, plan.data.sampleDir ?? plan.data.sample) : null;
  const planBenchmarkRoot = plan ? resolvePlanPath(plan, plan.data.benchmarkRoot ?? plan.data.outputDir) : null;
  const sampleArg = options.sample ?? options["sample-dir"] ?? positionals[1] ?? planSample ?? null;
  const benchmarkRoot = options["benchmark-root"] ?? planBenchmarkRoot ?? undefined;
  const benchmarkWorkspaceOverviewTimeout =
    resolveDurationMs({
      secondsValue: options["workspace-overview-timeout"],
      secondsLabel: "--workspace-overview-timeout",
      millisValue: options["workspace-overview-timeout-ms"],
      millisLabel: "--workspace-overview-timeout-ms",
    }) ?? null;
  const harness = await createRecomposeHarness({
    configData,
    promptDefaults,
    contextLength,
    debugLm,
    verbose,
    sessionLabel: null,
    gpu,
    schemaRegistry,
    promptDbPath,
    recomposeMode: "live",
    systemPrompt,
    modelKey,
    workspaceOverviewTimeoutMs: benchmarkWorkspaceOverviewTimeout,
  });
  const runner = new RecomposeBenchmarkRunner({
    sampleDir: sampleArg,
    benchmarkRoot,
    tester: harness.tester,
  });
  const timestamp = options.timestamp ?? plan?.data?.timestamp ?? undefined;
  const runPrefix = options["run-prefix"] ?? plan?.data?.runPrefix ?? plan?.data?.defaults?.runPrefix ?? "RUN";
  const clean = options.clean ?? plan?.data?.clean ?? plan?.data?.defaults?.clean ?? false;
  const resumeDescriptions =
    options["resume-descriptions"] ??
    plan?.data?.resumeDescriptions ??
    plan?.data?.defaults?.resumeDescriptions ??
    false;

  let result;
  try {
    if (plan) {
      const planRuns = buildBenchmarkPlanRuns(plan.data);
      if (!planRuns.length) {
        throw new Error("Benchmark plan must include at least one run definition.");
      }
      result = await runner.runSeries({
        planRuns,
        timestamp,
        runPrefix,
        clean,
        resumeDescriptions: Boolean(resumeDescriptions),
      });
    } else {
      const directionsValue = options.directions ?? options.direction ?? "roundtrip";
      const directions = directionsValue.split(",").map((value) => value.trim()).filter(Boolean);
      const repeat = Number(options.repeat ?? 1);
      result = await runner.runSeries({
        directions,
        repeat,
        clean: Boolean(clean),
        timestamp,
        runPrefix,
        resumeDescriptions: Boolean(resumeDescriptions),
      });
    }
  } finally {
    await harness.cleanup();
  }
  const relDir = path.relative(process.cwd(), result.outputDir) || result.outputDir;
  console.log(`[MiniPhi][Benchmark] ${result.runs.length} runs saved under ${relDir}`);
}

function resolvePlanPath(plan, candidate) {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.resolve(plan.dir, candidate);
}

function buildBenchmarkPlanRuns(planData) {
  if (!planData || typeof planData !== "object" || Array.isArray(planData)) {
    throw new Error("Benchmark plan content must be an object.");
  }
  const defaultDirections = normalizePlanDirections(planData.defaults?.directions ?? planData.directions);
  const fallbackDirections = defaultDirections.length ? defaultDirections : ["roundtrip"];
  const fallbackRepeat = Math.max(1, Number(planData.defaults?.repeat ?? planData.repeat ?? 1) || 1);
  const fallbackClean = planData.defaults?.clean ?? planData.clean ?? false;
  const fallbackPrefix = planData.defaults?.runPrefix ?? planData.runPrefix ?? "RUN";
  const fallbackResume = planData.defaults?.resumeDescriptions ?? planData.resumeDescriptions ?? false;
  const entries = Array.isArray(planData.runs) && planData.runs.length
    ? planData.runs
    : [
        {
          directions: planData.directions ?? fallbackDirections,
          repeat: planData.repeat ?? fallbackRepeat,
          clean: planData.clean ?? fallbackClean,
          runPrefix: planData.runPrefix ?? fallbackPrefix,
          resumeDescriptions: planData.resumeDescriptions ?? fallbackResume,
          label: planData.label,
          runLabel: planData.runLabel,
          labels: planData.labels,
        },
      ];
  if (!entries.length) {
    throw new Error("Benchmark plan must define at least one run entry.");
  }
  const runs = [];
  entries.forEach((entry, entryIndex) => {
    const entryDirections = normalizePlanDirections(entry.directions ?? entry.direction ?? fallbackDirections);
    if (!entryDirections.length) {
      throw new Error(`Plan run ${entryIndex} resolved to zero directions.`);
    }
    const repeat = Math.max(1, Number(entry.repeat ?? fallbackRepeat) || 1);
    const entryClean = entry.clean ?? fallbackClean;
    const entryPrefix = entry.runPrefix ?? fallbackPrefix;
    const entryResume = entry.resumeDescriptions ?? fallbackResume;
    const labelList = Array.isArray(entry.labels) ? entry.labels : null;
    for (let cycle = 0; cycle < repeat; cycle += 1) {
      entryDirections.forEach((direction, directionIndex) => {
        const prioritizedLabel =
          (labelList ? labelList[directionIndex] ?? labelList[labelList.length - 1] : null) ??
          (typeof entry.runLabel === "string" ? entry.runLabel : null) ??
          (typeof entry.label === "string" ? entry.label : null);
        let resolvedLabel = prioritizedLabel ?? null;
        const needsSuffix = repeat > 1 || (entryDirections.length > 1 && !labelList);
        if (resolvedLabel && needsSuffix) {
          const suffixParts = [cycle + 1];
          if (entryDirections.length > 1 && !labelList) {
            suffixParts.push(directionIndex + 1);
          }
          resolvedLabel = `${resolvedLabel}-${suffixParts.join("-")}`;
        }
        runs.push({
          direction,
          clean: entryClean,
          runPrefix: entryPrefix,
          runLabel: resolvedLabel,
          resumeDescriptions: entryResume,
        });
      });
    }
  });
  return runs;
}

async function scaffoldBenchmarkPlan({ sampleDir, benchmarkRoot, outputPath, verbose }) {
  const defaultSample = path.join("samples", "recompose", "hello-flow");
  const resolvedSample = path.resolve(sampleDir ?? defaultSample);
  let stats;
  try {
    stats = await fs.promises.stat(resolvedSample);
  } catch {
    throw new Error(`Unable to locate sample directory ${resolvedSample}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Sample path is not a directory: ${resolvedSample}`);
  }
  const sampleName = path.basename(resolvedSample);
  const codeDir = path.join(resolvedSample, "code");
  const descriptionsDir = path.join(resolvedSample, "descriptions");
  const normalized = (target) => {
    const relative = path.relative(process.cwd(), target);
    return (relative || target).replace(/\\/g, "/");
  };
  const planSlug = `${sampleName}-plan`;
  const resolvedBenchmarkRoot =
    benchmarkRoot && path.isAbsolute(benchmarkRoot)
      ? benchmarkRoot
      : path.resolve(benchmarkRoot ?? path.join("samples", "benchmark", "recompose", planSlug));
  const codeFiles = await collectSampleFileStats(codeDir);
  const descriptionFiles = await collectSampleFileStats(descriptionsDir);
  const readmeSnippet = await loadReadmeSnippet(resolvedSample);
  const lines = [];
  lines.push(`# MiniPhi benchmark plan scaffold (${new Date().toISOString()})`);
  lines.push(`# Sample: ${sampleName}`);
  lines.push(`# Detected ${codeFiles.length} code files under ${normalized(codeDir)}`);
  lines.push(`# Detected ${descriptionFiles.length} description files under ${normalized(descriptionsDir)}`);
  if (readmeSnippet) {
    lines.push(`# README excerpt: ${readmeSnippet}`);
  }
  if (codeFiles.length) {
    lines.push(`# First files: ${codeFiles.slice(0, 5).map((file) => file.path).join(", ")}`);
  }
  lines.push("");
  lines.push(`sampleDir: ${normalized(resolvedSample)}`);
  lines.push(`benchmarkRoot: ${normalized(resolvedBenchmarkRoot)}`);
  lines.push(`timestamp: ${planSlug}`);
  lines.push("runPrefix: PLAN");
  lines.push("defaults:");
  lines.push("  # Roundtrip ensures both directions are exercised.");
  lines.push("  directions:");
  lines.push("    - roundtrip");
  lines.push("  repeat: 1");
  lines.push("  clean: false");
  lines.push("  resumeDescriptions: false");
  lines.push("runs:");
  lines.push("  # Fresh sweep to regenerate markdown + reconstructed code.");
  lines.push("  - label: clean-roundtrip");
  lines.push("    clean: true");
  lines.push("    directions:");
  lines.push("      - roundtrip");
  lines.push("  # Target markdown-to-code iterations without re-narrating files.");
  lines.push("  - label: markdown-focus");
  lines.push("    directions:");
  lines.push("      - markdown-to-code");
  lines.push("    repeat: 2");
  lines.push("    runPrefix: PLAN-MD");
  lines.push("    resumeDescriptions: true");
  lines.push("");
  const output = `${lines.join("\n").trim()}\n`;
  if (outputPath) {
    const resolvedOutput = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.promises.writeFile(resolvedOutput, output, "utf8");
    const rel = normalized(resolvedOutput);
    console.log(`[MiniPhi][Benchmark][Plan] Scaffold saved to ${rel}`);
  } else {
    if (!verbose) {
      console.log("[MiniPhi][Benchmark][Plan] Use --output <file> to save this scaffold automatically.");
    }
    console.log(output);
  }
}

async function collectSampleFileStats(baseDir) {
  try {
    const stats = await fs.promises.stat(baseDir);
    if (!stats.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  const files = [];
  const stack = [""];
  while (stack.length) {
    const current = stack.pop();
    const absolute = path.join(baseDir, current);
    const dirents = await fs.promises.readdir(absolute, { withFileTypes: true });
    for (const entry of dirents) {
      const rel = path.join(current, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        stack.push(rel);
      } else if (entry.isFile()) {
        const info = await fs.promises.stat(path.join(baseDir, rel));
        files.push({ path: rel, bytes: info.size });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function loadReadmeSnippet(sampleDir) {
  const candidates = [
    path.join(sampleDir, "README.md"),
    path.join(sampleDir, "README.md.md"),
    path.join(sampleDir, "code", "README.md"),
    path.join(sampleDir, "descriptions", "README.md"),
  ];
  for (const candidate of candidates) {
    try {
      const stats = await fs.promises.stat(candidate);
      if (!stats.isFile()) {
        continue;
      }
      const content = await fs.promises.readFile(candidate, "utf8");
      const trimmed = content.replace(/\s+/g, " ").trim();
      if (trimmed) {
        return trimmed.slice(0, 220);
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function loadBenchmarkPlan(planPath) {
  const absolute = path.resolve(planPath);
  const raw = await fs.promises.readFile(absolute, "utf8");
  const ext = path.extname(absolute).toLowerCase();
  let data;
  if (ext === ".yaml" || ext === ".yml") {
    data = YAML.parse(raw);
  } else {
    data = JSON.parse(raw);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Benchmark plan must be a JSON or YAML object.");
  }
  return {
    path: absolute,
    dir: path.dirname(absolute),
    data,
  };
}
