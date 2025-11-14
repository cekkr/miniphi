#!/usr/bin/env node
import fs from "fs";
import path from "path";
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
import { loadConfig } from "./libs/config-loader.js";

const COMMANDS = new Set(["run", "analyze-file", "web-research", "history-notes", "recompose"]);

const DEFAULT_TASK_DESCRIPTION = "Provide a precise technical analysis of the captured output.";

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
    await handleRecompose({ options, positionals, verbose });
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

  try {
    await phi4.load({ contextLength, gpu });
    let result;

    if (command === "run") {
      const cmd = options.cmd ?? positionals.join(" ");
      if (!cmd) {
        throw new Error('Missing --cmd "<command>" for run mode.');
      }

      const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
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
          promptContext: {
            scope: "main",
            label: task,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "run",
              command: cmd,
              cwd,
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
          promptContext: {
            scope: "main",
            label: task,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "analyze-file",
              filePath,
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

async function handleRecompose({ options, positionals, verbose }) {
  const tester = new RecomposeTester();
  const sampleArg = options.sample ?? options["sample-dir"] ?? positionals[0] ?? null;
  const direction = (options.direction ?? positionals[1] ?? "roundtrip").toLowerCase();
  const report = await tester.run({
    sampleDir: sampleArg ? path.resolve(sampleArg) : null,
    direction,
    codeDir: options["code-dir"],
    descriptionsDir: options["descriptions-dir"],
    outputDir: options["output-dir"],
    clean: Boolean(options.clean),
  });

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

  const defaultReportBase = report.sampleDir ?? (sampleArg ? path.resolve(sampleArg) : process.cwd());
  const reportPath = path.resolve(options.report ?? path.join(defaultReportBase, "recompose-report.json"));
  await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  const rel = path.relative(process.cwd(), reportPath);
  console.log(`[MiniPhi][Recompose] Report saved to ${rel || reportPath}`);
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

function printHelp() {
  console.log(`MiniPhi CLI

Usage:
  node src/index.js run --cmd "npm test" --task "Analyze failures"
  node src/index.js analyze-file --file ./logs/output.log --task "Summarize log"
  node src/index.js web-research "phi-4 roadmap" --max-results 5
  node src/index.js history-notes --label "post benchmark"
  node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean

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
`);
}

main();
