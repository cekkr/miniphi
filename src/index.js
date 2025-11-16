#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";
import CliExecutor from "./libs/cli-executor.js";
import LMStudioManager from "./libs/lmstudio-api.js";
import Phi4Handler from "./libs/lms-phi4.js";
import PythonLogSummarizer from "./libs/python-log-summarizer.js";
import EfficientLogAnalyzer from "./libs/efficient-log-analyzer.js";
import MiniPhiMemory from "./libs/miniphi-memory.js";
import ResourceMonitor from "./libs/resource-monitor.js";
import PromptRecorder from "./libs/prompt-recorder.js";
import WebResearcher from "./libs/web-researcher.js";
import HistoryNotesManager from "./libs/history-notes.js";
import RecomposeTester from "./libs/recompose-tester.js";
import RecomposeBenchmarkRunner from "./libs/recompose-benchmark-runner.js";
import BenchmarkAnalyzer from "./libs/benchmark-analyzer.js";
import { loadConfig } from "./libs/config-loader.js";
import WorkspaceProfiler from "./libs/workspace-profiler.js";
import PromptPerformanceTracker from "./libs/prompt-performance-tracker.js";
import {
  buildWorkspaceHintBlock,
  collectManifestSummary,
  readReadmeSnippet,
} from "./libs/workspace-context-utils.js";

const COMMANDS = new Set(["run", "analyze-file", "web-research", "history-notes", "recompose", "benchmark"]);

const DEFAULT_TASK_DESCRIPTION = "Provide a precise technical analysis of the captured output.";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PROMPT_DB_PATH = path.join(PROJECT_ROOT, "miniphi-prompts.db");
const PROMPT_SCORING_SYSTEM_PROMPT = [
  "You grade MiniPhi prompt effectiveness.",
  "Given an objective, workspace context, prompt text, and the assistant response, you must return JSON with:",
  "score (0-100), prompt_category, summary, follow_up_needed, follow_up_reason, tags, recommended_prompt_pattern, series_strategy.",
  "Focus on whether the response satisfied the objective and whether another prompt is required.",
  "Return JSON only.",
].join(" ");

function parseNumericSetting(value, label) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} expects a finite number.`);
  }
  return numeric;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const [command, ...rest] = args;

  if (!COMMANDS.has(command)) {
    console.error(`Unknown command "${command}".`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const { options, positionals } = parseArgs(rest);
  const verbose = Boolean(options.verbose);
  const streamOutput = !options["no-stream"];
  const debugLm = Boolean(options["debug-lm"]);

  let configResult;
  try {
    configResult = loadConfig(options.config);
  } catch (error) {
    console.error(`[MiniPhi] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  const configData = configResult?.data ?? {};
  const configPath = configResult?.path ?? null;
  if (configPath && verbose) {
    const relPath = path.relative(process.cwd(), configPath) || configPath;
    console.log(`[MiniPhi] Loaded configuration from ${relPath}`);
  }

  const defaults = configData.defaults ?? {};
  const promptDefaults = configData.prompt ?? configData.lmStudio?.prompt ?? {};
  const pythonScriptPath =
    options["python-script"] ?? configData.pythonScript ?? defaults.pythonScript;

  const summaryLevels =
    parseNumericSetting(options["summary-levels"], "--summary-levels") ??
    parseNumericSetting(defaults.summaryLevels, "config.defaults.summaryLevels") ??
    3;

  const contextLength =
    parseNumericSetting(options["context-length"], "--context-length") ??
    parseNumericSetting(defaults.contextLength, "config.defaults.contextLength") ??
    32768;

  const gpu = options.gpu ?? defaults.gpu ?? "auto";

  const timeout =
    parseNumericSetting(options.timeout, "--timeout") ??
    parseNumericSetting(defaults.timeout, "config.defaults.timeout") ??
    60000;

  const task = options.task ?? defaults.task ?? DEFAULT_TASK_DESCRIPTION;

  let promptId = typeof options["prompt-id"] === "string" ? options["prompt-id"].trim() : null;
  if (!promptId && typeof defaults.promptId === "string") {
    promptId = defaults.promptId.trim();
  }
  if (promptId === "") {
    promptId = null;
  }
  const promptGroupId =
    promptId ?? `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const sessionTimeoutValue =
    parseNumericSetting(options["session-timeout"], "--session-timeout") ??
    parseNumericSetting(defaults.sessionTimeout, "config.defaults.sessionTimeout");
  if (sessionTimeoutValue !== undefined && sessionTimeoutValue <= 0) {
    throw new Error("--session-timeout expects a positive number of milliseconds.");
  }
  const sessionTimeoutMs = sessionTimeoutValue ?? null;
  const runStart = Date.now();
  const sessionDeadline = sessionTimeoutMs ? runStart + sessionTimeoutMs : null;

  const chunkSize =
    parseNumericSetting(options["chunk-size"], "--chunk-size") ??
    parseNumericSetting(defaults.chunkSize, "config.defaults.chunkSize");

  const resourceDefaults = {};
  const resourceSource = configData.resourceMonitor ?? {};
  if (typeof resourceSource.maxMemoryPercent !== "undefined") {
    resourceDefaults["max-memory-percent"] = resourceSource.maxMemoryPercent;
  }
  if (typeof resourceSource.maxCpuPercent !== "undefined") {
    resourceDefaults["max-cpu-percent"] = resourceSource.maxCpuPercent;
  }
  if (typeof resourceSource.maxVramPercent !== "undefined") {
    resourceDefaults["max-vram-percent"] = resourceSource.maxVramPercent;
  }
  if (typeof resourceSource.sampleIntervalMs !== "undefined") {
    resourceDefaults["resource-sample-interval"] = resourceSource.sampleIntervalMs;
  }
  const resourceConfig = buildResourceConfig({
    ...resourceDefaults,
    ...options,
  });

  if (command === "web-research") {
    await handleWebResearch({ options, positionals, verbose });
    return;
  }

  if (command === "history-notes") {
    await handleHistoryNotes({ options, verbose });
    return;
  }

  if (command === "recompose") {
    await handleRecompose({
      options,
      positionals,
      verbose,
      configData,
      promptDefaults,
      contextLength,
      debugLm,
      gpu,
    });
    return;
  }
  if (command === "benchmark") {
    await handleBenchmark({
      options,
      positionals,
      verbose,
      configData,
      promptDefaults,
      contextLength,
      debugLm,
      gpu,
    });
    return;
  }

  const manager = new LMStudioManager(configData.lmStudio?.clientOptions);
  const phi4 = new Phi4Handler(manager, {
    systemPrompt: promptDefaults.system,
    promptTimeoutMs: parseNumericSetting(promptDefaults.timeoutMs, "config.prompt.timeoutMs"),
  });
  const cli = new CliExecutor();
  const summarizer = new PythonLogSummarizer(pythonScriptPath);
  const analyzer = new EfficientLogAnalyzer(phi4, cli, summarizer);
  const workspaceProfiler = new WorkspaceProfiler();
  let performanceTracker = null;
  let scoringPhi = null;

  try {
    const tracker = new PromptPerformanceTracker({
      dbPath: PROMPT_DB_PATH,
      debug: debugLm,
    });
    await tracker.prepare();
    performanceTracker = tracker;
    if (verbose) {
      const relDb = path.relative(process.cwd(), PROMPT_DB_PATH) || PROMPT_DB_PATH;
      console.log(`[MiniPhi] Prompt scoring database ready at ${relDb}`);
    }
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Prompt scoring disabled: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  if (performanceTracker) {
    phi4.setPerformanceTracker(performanceTracker);
  }

  let stateManager;
  let promptRecorder = null;
  const archiveMetadata = { promptId };
  let resourceMonitor;
  let resourceSummary = null;
  const initializeResourceMonitor = async (label) => {
    if (resourceMonitor) {
      return;
    }
    const historyFile = stateManager?.resourceUsageFile ?? null;
    resourceMonitor = new ResourceMonitor({
      ...resourceConfig,
      historyFile,
      label,
    });
    try {
      await resourceMonitor.start(label);
    } catch (error) {
      resourceMonitor = null;
      if (verbose) {
        console.warn(
          `[MiniPhi] Resource monitor failed to start: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  };
  const stopResourceMonitorIfNeeded = async () => {
    if (!resourceMonitor || resourceSummary) {
      return resourceSummary;
    }
    try {
      resourceSummary = await resourceMonitor.stop();
      if (resourceSummary?.summary?.warnings?.length) {
        for (const warning of resourceSummary.summary.warnings) {
          console.warn(`[MiniPhi][Resources] ${warning}`);
        }
      }
      if (resourceSummary?.persisted?.path && verbose) {
        const rel = path.relative(process.cwd(), resourceSummary.persisted.path);
        console.log(`[MiniPhi] Resource usage appended to ${rel || resourceSummary.persisted.path}`);
      }
    } catch (error) {
      console.warn(
        `[MiniPhi] Unable to finalize resource monitor: ${error instanceof Error ? error.message : error}`,
      );
    }
    return resourceSummary;
  };

  const describeWorkspace = async (dir) => {
    let profile;
    try {
      profile = workspaceProfiler.describe(dir);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Workspace profiling failed for ${dir}: ${error instanceof Error ? error.message : error}`,
        );
      }
      return null;
    }
    const manifestResult = await collectManifestSummary(dir, { limit: 10 }).catch((error) => {
      if (verbose) {
        console.warn(
          `[MiniPhi] Workspace manifest scan failed for ${dir}: ${error instanceof Error ? error.message : error}`,
        );
      }
      return { files: [], manifest: [] };
    });
    const readmeSnippet = await readReadmeSnippet({
      candidates: [
        path.join(dir, "README.md"),
        path.join(dir, "README.md.md"),
        path.join(dir, "docs", "README.md"),
      ],
    }).catch(() => null);
    const hintBlock = buildWorkspaceHintBlock(
      manifestResult.files,
      dir,
      readmeSnippet,
      { limit: 8 },
    );
    return {
      ...profile,
      manifestPreview: manifestResult.manifest,
      readmeSnippet,
      hintBlock: hintBlock || null,
    };
  };

  try {
    await phi4.load({ contextLength, gpu });
    if (performanceTracker) {
      scoringPhi = new Phi4Handler(manager, {
        systemPrompt: PROMPT_SCORING_SYSTEM_PROMPT,
      });
      try {
        await scoringPhi.load({ contextLength: Math.min(contextLength, 8192), gpu });
        performanceTracker.setSemanticEvaluator(async (evaluationPrompt, parentTrace) => {
          scoringPhi.clearHistory();
          return scoringPhi.chatStream(
            evaluationPrompt,
            undefined,
            undefined,
            undefined,
            {
              scope: "sub",
              label: "prompt-scoring",
              metadata: {
                mode: "prompt-evaluator",
                workspaceType: parentTrace?.metadata?.workspaceType ?? null,
                objective: parentTrace?.label ?? null,
              },
            },
          );
        });
      } catch (error) {
        scoringPhi = null;
        performanceTracker.setSemanticEvaluator(null);
        if (verbose) {
          console.warn(
            `[MiniPhi] Prompt scoring evaluator disabled: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }

    let result;

    if (command === "run") {
      const cmd = options.cmd ?? positionals.join(" ");
      if (!cmd) {
        throw new Error('Missing --cmd "<command>" for run mode.');
      }

      const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
      const workspaceContext = await describeWorkspace(cwd);
        archiveMetadata.command = cmd;
        archiveMetadata.cwd = cwd;
        stateManager = new MiniPhiMemory(cwd);
        await stateManager.prepare();
        promptRecorder = new PromptRecorder(stateManager.baseDir);
        await promptRecorder.prepare();
        phi4.setPromptRecorder(promptRecorder);
        if (verbose) {
          console.log(`[MiniPhi] Prompt recorder enabled (main id: ${promptGroupId})`);
        }
        if (promptId) {
          const history = await stateManager.loadPromptSession(promptId);
          if (history) {
            phi4.setHistory(history);
          }
        }
        await initializeResourceMonitor(`run:${cmd}`);
        result = await analyzer.analyzeCommandOutput(cmd, task, {
          summaryLevels,
          verbose,
          streamOutput,
          cwd,
          timeout,
          sessionDeadline,
          workspaceContext,
          promptContext: {
            scope: "main",
            label: task,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "run",
              command: cmd,
              cwd,
              workspaceType: workspaceContext?.classification?.domain ?? workspaceContext?.classification?.label ?? null,
              workspaceSummary: workspaceContext?.summary ?? null,
              workspaceHint: workspaceContext?.hintBlock ?? null,
              workspaceManifest: (workspaceContext?.manifestPreview ?? []).slice(0, 5).map((entry) => entry.path),
              workspaceReadmeSnippet: workspaceContext?.readmeSnippet ?? null,
            },
          },
        });
    } else if (command === "analyze-file") {
      const fileFromFlag = options.file ?? options.path ?? positionals[0];
      if (!fileFromFlag) {
        throw new Error('Missing --file "<path>" for analyze-file mode.');
      }

      const filePath = path.resolve(fileFromFlag);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const analyzeCwd = path.dirname(filePath);
      const workspaceContext = await describeWorkspace(analyzeCwd);

        archiveMetadata.filePath = filePath;
        archiveMetadata.cwd = path.dirname(filePath);
        stateManager = new MiniPhiMemory(archiveMetadata.cwd);
        await stateManager.prepare();
        promptRecorder = new PromptRecorder(stateManager.baseDir);
        await promptRecorder.prepare();
        phi4.setPromptRecorder(promptRecorder);
        if (verbose) {
          console.log(`[MiniPhi] Prompt recorder enabled (main id: ${promptGroupId})`);
        }
        if (promptId) {
          const history = await stateManager.loadPromptSession(promptId);
          if (history) {
            phi4.setHistory(history);
          }
        }
        await initializeResourceMonitor(`analyze:${path.basename(filePath)}`);
        result = await analyzer.analyzeLogFile(filePath, task, {
          summaryLevels,
          streamOutput,
          maxLinesPerChunk: chunkSize,
          sessionDeadline,
          workspaceContext,
          promptContext: {
            scope: "main",
            label: task,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "analyze-file",
              filePath,
              cwd: analyzeCwd,
              workspaceType: workspaceContext?.classification?.domain ?? workspaceContext?.classification?.label ?? null,
              workspaceSummary: workspaceContext?.summary ?? null,
              workspaceHint: workspaceContext?.hintBlock ?? null,
              workspaceManifest: (workspaceContext?.manifestPreview ?? []).slice(0, 5).map((entry) => entry.path),
              workspaceReadmeSnippet: workspaceContext?.readmeSnippet ?? null,
            },
          },
        });
      }

    await stopResourceMonitorIfNeeded();

    if (stateManager && result) {
      const archive = await stateManager.persistExecution({
        mode: command,
        task,
        command: archiveMetadata.command,
        filePath: archiveMetadata.filePath,
        cwd: archiveMetadata.cwd,
        summaryLevels,
        contextLength,
        resourceUsage: resourceSummary?.summary ?? null,
        result,
        promptId,
      });
      if (archive && options.verbose) {
        const relativePath = path.relative(process.cwd(), archive.path);
        console.log(`[MiniPhi] Execution archived under ${relativePath || archive.path}`);
      }
    }

    if (!options["no-summary"]) {
      console.log("\n[MiniPhi] Analysis summary:");
      console.log(
        JSON.stringify(
          {
            task: result.task,
            linesAnalyzed: result.linesAnalyzed,
            compressedTokens: result.compressedTokens,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(`[MiniPhi] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    try {
      if (promptId && stateManager) {
        await stateManager.savePromptSession(promptId, phi4.getHistory());
      }
      await stopResourceMonitorIfNeeded();
      await phi4.eject();
      if (scoringPhi) {
        await scoringPhi.eject();
      }
      if (performanceTracker) {
        await performanceTracker.dispose();
      }
    } catch {
      // no-op
    }
  }
}

async function handleWebResearch({ options, positionals, verbose }) {
  const queries = [];
  const pushQuery = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      queries.push(trimmed);
    }
  };
  pushQuery(options.query);
  for (const positional of positionals) {
    pushQuery(positional);
  }
  if (options["query-file"]) {
    const filePath = path.resolve(options["query-file"]);
    const contents = await fs.promises.readFile(filePath, "utf8");
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach(pushQuery);
  }

  if (queries.length === 0) {
    throw new Error('web-research expects at least one query via --query "<text>" or positional arguments.');
  }

  const provider = typeof options.provider === "string" ? options.provider : "duckduckgo";
  const maxResults = parseNumericSetting(options["max-results"], "--max-results");
  const includeRaw = Boolean(options["include-raw"]);
  const note = typeof options.note === "string" ? options.note : null;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const memory = new MiniPhiMemory(cwd);
  await memory.prepare();
  const researcher = new WebResearcher();
  const shouldSave = !options["no-save"];

  for (const query of queries) {
    if (verbose) {
      console.log(`[MiniPhi][Research] Searching "${query}" via ${provider}...`);
    }
    const report = await researcher.search(query, {
      provider,
      maxResults,
      includeRaw,
      note,
    });
    const persisted = shouldSave ? await memory.saveResearchReport(report) : null;
    console.log(
      `[MiniPhi][Research] ${report.results.length} result${report.results.length === 1 ? "" : "s"} for "${report.query}" (${report.durationMs} ms)`,
    );
    report.results.forEach((result, index) => {
      console.log(`  ${index + 1}. ${result.title ?? result.url} [${result.source ?? "unknown"}]`);
      console.log(`     ${result.url}`);
      if (result.snippet) {
        console.log(`     ${result.snippet}`);
      }
    });
    if (persisted?.path && verbose) {
      const rel = path.relative(process.cwd(), persisted.path);
      console.log(`[MiniPhi][Research] Saved snapshot to ${rel || persisted.path}`);
    }
  }
}

async function handleHistoryNotes({ options, verbose }) {
  const includeGit = !options["no-git"];
  const label = typeof options.label === "string" ? options.label.trim() : null;
  const historyRoot = options["history-root"] ? path.resolve(options["history-root"]) : process.cwd();
  const memory = new MiniPhiMemory(historyRoot);
  const manager = new HistoryNotesManager(memory);
  const snapshot = await manager.captureSnapshot({ includeGit, label });
  const note = snapshot.note;
  console.log(
    `[MiniPhi][History] Changed: ${note.changedFiles.length}, added: ${note.addedFiles.length}, removed: ${note.removedFiles.length}, stable: ${note.stableCount}`,
  );
  if (snapshot.previousSnapshot?.path && verbose) {
    const prevRel = path.relative(process.cwd(), snapshot.previousSnapshot.path);
    console.log(`[MiniPhi][History] Compared against ${prevRel || snapshot.previousSnapshot.path}`);
  }
  if (snapshot.jsonPath) {
    const relJson = path.relative(process.cwd(), snapshot.jsonPath);
    console.log(`[MiniPhi][History] JSON: ${relJson || snapshot.jsonPath}`);
  }
  if (snapshot.markdownPath) {
    const relMd = path.relative(process.cwd(), snapshot.markdownPath);
    console.log(`[MiniPhi][History] Markdown: ${relMd || snapshot.markdownPath}`);
  }
}

async function handleRecompose({
  options,
  positionals,
  verbose,
  configData,
  promptDefaults,
  contextLength,
  debugLm,
  gpu,
}) {
  const sessionLabel =
    typeof options.label === "string"
      ? options.label
      : typeof options["session-label"] === "string"
        ? options["session-label"]
        : null;
  const harness = await createRecomposeHarness({
    configData,
    promptDefaults,
    contextLength,
    debugLm,
    verbose,
    sessionLabel,
    gpu,
  });
  const sampleArg = options.sample ?? options["sample-dir"] ?? positionals[0] ?? null;
  const direction = (options.direction ?? positionals[1] ?? "roundtrip").toLowerCase();
  let report;
  let reportPath = null;
  let promptLogExportPath = null;
  try {
    report = await harness.tester.run({
      sampleDir: sampleArg ? path.resolve(sampleArg) : null,
      direction,
      codeDir: options["code-dir"],
      descriptionsDir: options["descriptions-dir"],
      outputDir: options["output-dir"],
      clean: Boolean(options.clean),
      sessionLabel,
    });
    const defaultReportBase = report.sampleDir ?? (sampleArg ? path.resolve(sampleArg) : process.cwd());
    reportPath = path.resolve(options.report ?? path.join(defaultReportBase, "recompose-report.json"));
    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
    if (typeof harness.tester.exportPromptLog === "function") {
      promptLogExportPath = await harness.tester.exportPromptLog({
        targetDir: path.dirname(reportPath),
        fileName: `${path.basename(reportPath, path.extname(reportPath))}.prompts.log`,
        label: sessionLabel ?? direction,
      });
    }
  } finally {
    await harness.cleanup();
  }

  report.steps.forEach((step) => {
    if (step.phase === "code-to-markdown") {
      console.log(
        `[MiniPhi][Recompose] code→md: ${step.converted}/${step.discovered} files converted in ${step.durationMs} ms (skipped ${step.skipped})`,
      );
    } else if (step.phase === "markdown-to-code") {
      console.log(
        `[MiniPhi][Recompose] md→code: ${step.converted}/${step.processed} markdown files restored in ${step.durationMs} ms (warnings: ${step.warnings.length})`,
      );
      if (verbose && step.warnings.length) {
        step.warnings.slice(0, 5).forEach((warning) => {
          console.warn(`[MiniPhi][Recompose][Warn] ${warning.path}: ${warning.reason}`);
        });
        if (step.warnings.length > 5) {
          console.warn(`[MiniPhi][Recompose][Warn] ...${step.warnings.length - 5} additional warnings`);
        }
      }
    } else if (step.phase === "comparison") {
      console.log(
        `[MiniPhi][Recompose] compare: ${step.matches} matches, ${step.mismatches.length} mismatches, ${step.missing.length} missing, ${step.extras.length} extra files (took ${step.durationMs} ms)`,
      );
    }
  });

  if (!reportPath) {
    throw new Error("Failed to resolve recompose report path.");
  }
  if (promptLogExportPath) {
    const relPrompt = path.relative(process.cwd(), promptLogExportPath) || promptLogExportPath;
    const normalizedPrompt = relPrompt.replace(/\\/g, "/");
    report.promptLogExport = normalizedPrompt;
    console.log(`[MiniPhi][Recompose] Prompt log saved to ${normalizedPrompt}`);
  }
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  const rel = path.relative(process.cwd(), reportPath);
  console.log(`[MiniPhi][Recompose] Report saved to ${rel || reportPath}`);
}

async function handleBenchmark({
  options,
  positionals,
  verbose,
  configData,
  promptDefaults,
  contextLength,
  debugLm,
  gpu,
}) {
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
  const harness = await createRecomposeHarness({
    configData,
    promptDefaults,
    contextLength,
    debugLm,
    verbose,
    sessionLabel: null,
    gpu,
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

async function createRecomposeHarness({
  configData,
  promptDefaults,
  contextLength,
  debugLm,
  verbose,
  sessionLabel,
  gpu,
}) {
  const manager = new LMStudioManager(configData.lmStudio?.clientOptions);
  const phi4 = new Phi4Handler(manager, {
    systemPrompt: promptDefaults.system,
    promptTimeoutMs: parseNumericSetting(promptDefaults.timeoutMs, "config.prompt.timeoutMs"),
  });
  const loadOptions = { contextLength, gpu };
  await phi4.load(loadOptions);
  const memory = new MiniPhiMemory(process.cwd());
  await memory.prepare();
  const promptRecorder = new PromptRecorder(memory.baseDir);
  await promptRecorder.prepare();
  phi4.setPromptRecorder(promptRecorder);
  let performanceTracker = null;
  try {
    const tracker = new PromptPerformanceTracker({
      dbPath: PROMPT_DB_PATH,
      debug: debugLm,
    });
    await tracker.prepare();
    phi4.setPerformanceTracker(tracker);
    performanceTracker = tracker;
  } catch (error) {
    if (verbose) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[MiniPhi][Recompose] Prompt scoring disabled: ${message}`);
    }
  }
  const sessionRoot = path.join(memory.baseDir, "recompose");
  await fs.promises.mkdir(sessionRoot, { recursive: true });
  const tester = new RecomposeTester({
    phi4,
    sessionRoot,
    promptLabel: sessionLabel ?? "recompose",
    verboseLogging: verbose,
    memory,
  });
  const cleanup = async () => {
    await phi4.eject();
    if (performanceTracker) {
      await performanceTracker.dispose();
    }
  };
  return { tester, cleanup };
}

function parseArgs(tokens) {
  const options = {};
  const positionals = [];
  const shortValueFlags = {
    c: "cmd",
    t: "task",
    f: "file",
    p: "python-script",
  };
  const shortBooleanFlags = {
    v: "verbose",
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (!next || next.startsWith("-")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    } else if (token.startsWith("-") && token.length === 2) {
      const short = token[1];
      if (shortValueFlags[short]) {
        const next = tokens[i + 1];
        if (!next || next.startsWith("-")) {
          throw new Error(`Flag -${short} expects a value.`);
        }
        options[shortValueFlags[short]] = next;
        i += 1;
      } else if (shortBooleanFlags[short]) {
        options[shortBooleanFlags[short]] = true;
      } else if (short === "h") {
        options.help = true;
      } else {
        positionals.push(token);
      }
    } else {
      positionals.push(token);
    }
  }

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  return { options, positionals };
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

function normalizePlanDirections(candidate) {
  if (!candidate) {
    return [];
  }
  const rawValues = Array.isArray(candidate) ? candidate : String(candidate).split(",");
  return rawValues.map((value) => (typeof value === "string" ? value.toLowerCase().trim() : "")).filter(Boolean);
}

function buildResourceConfig(cliOptions) {
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
  const memory = parsePercent(cliOptions["max-memory-percent"]);
  const cpu = parsePercent(cliOptions["max-cpu-percent"]);
  const vram = parsePercent(cliOptions["max-vram-percent"]);
  if (typeof memory === "number") thresholds.memory = memory;
  if (typeof cpu === "number") thresholds.cpu = cpu;
  if (typeof vram === "number") thresholds.vram = vram;

  return {
    thresholds,
    sampleInterval: parseInterval(cliOptions["resource-sample-interval"]),
  };
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
  lines.push(`runPrefix: PLAN`);
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

function printHelp() {
  console.log(`MiniPhi CLI

Usage:
  node src/index.js run --cmd "npm test" --task "Analyze failures"
  node src/index.js analyze-file --file ./logs/output.log --task "Summarize log"
  node src/index.js web-research "phi-4 roadmap" --max-results 5
  node src/index.js history-notes --label "post benchmark"
  node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean
  node src/index.js benchmark recompose --directions roundtrip,code-to-markdown --repeat 3

Options:
  --cmd <command>              Command to execute in run mode
  --file <path>                File to analyze in analyze-file mode
  --task <description>         Task instructions for Phi-4
  --config <path>              Path to optional config.json (searches upward by default)
  --cwd <path>                 Working directory for --cmd
  --summary-levels <n>         Depth for recursive summarization (default: 3)
  --context-length <tokens>    Override Phi-4 context length (default: 32768)
  --gpu <mode>                 GPU setting forwarded to LM Studio (default: auto)
  --timeout <ms>               Command timeout in milliseconds (default: 60000)
  --max-memory-percent <n>     Trigger warnings when RAM usage exceeds <n>%
  --max-cpu-percent <n>        Trigger warnings when CPU usage exceeds <n>%
  --max-vram-percent <n>       Trigger warnings when VRAM usage exceeds <n>%
  --resource-sample-interval <ms>  Resource sampling cadence (default: 5000)
  --python-script <path>       Custom path to log_summarizer.py
  --chunk-size <lines>         Chunk size when analyzing files (default: 2000)
  --verbose                    Print progress details
  --no-stream                  Disable live streaming of Phi-4 output
  --no-summary                 Skip JSON summary footer
  --prompt-id <id>             Attach/continue a prompt session (persists LM history)
  --session-timeout <ms>       Hard limit for the entire MiniPhi run (optional)
  --debug-lm                   Print each objective + prompt when scoring is running

Web research:
  --query <text>               Query string (can be repeated or passed as positional)
  --query-file <path>          File containing newline-delimited queries
  --provider <name>            Research provider (default: duckduckgo)
  --max-results <n>            Limit number of results per query (default: 6)
  --include-raw                Persist raw provider payload into the saved snapshot
  --no-save                    Do not store the research snapshot under .miniphi/research
  --note <text>                Optional annotation attached to the research snapshot

History notes:
  --history-root <path>        Override the directory used to locate .miniphi (default: cwd)
  --label <text>               Friendly label for the snapshot (e.g., "post-upgrade")
  --no-git                     Skip git metadata when summarizing .miniphi changes

Recompose benchmarks:
  --sample <path>              Samples/recompose project to operate on
  --direction <mode>           code-to-markdown | markdown-to-code | roundtrip (default)
  --code-dir <path>            Override code directory (default: <sample>/code)
  --descriptions-dir <path>    Override markdown descriptions directory (default: <sample>/descriptions)
  --output-dir <path>          Override reconstructed code output directory (default: <sample>/reconstructed)
  --clean                      Remove generated description/output directories before running
  --report <path>              Persist benchmark report JSON to a custom path
  --help                       Show this help message

Benchmark helper:
  benchmark recompose [sample]  Run timestamped benchmark batches (defaults to hello-flow sample)
    --sample <path>             Override sample directory
    --benchmark-root <path>     Directory used to store timestamped runs (default: samples/benchmark/recompose)
    --directions <list>         Comma-separated directions to execute (default: roundtrip)
    --repeat <n>                Repeat the direction list n times (default: 1)
    --run-prefix <text>         Prefix for run artifacts (default: RUN)
    --timestamp <value>         Pin a timestamp folder (default: current time)
    --clean                     Perform clean before each run
    --resume-descriptions       Skip the code-to-markdown sweep when descriptions already exist
  benchmark analyze [dir]       Summarize existing JSON reports under the directory
    --path <dir>                Directory containing RUN-###.json files (positional also accepted)
    --compare <dir>             Optional candidate directory to diff against baseline
  benchmark plan scaffold [sample]  Emit a commented plan template for the sample
    --sample <path>             Sample directory to inspect (default: samples/recompose/hello-flow)
    --benchmark-root <path>     Suggested benchmark root override
    --output <path>             Persist the scaffold to a file instead of stdout
`);
}

main();
