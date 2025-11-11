#!/usr/bin/env node
import fs from "fs";
import path from "path";
import CliExecutor from "./libs/cli-executor.js";
import LMStudioManager from "./libs/lmstudio-api.js";
import Phi4Handler from "./libs/lms-phi4.js";
import PythonLogSummarizer from "./libs/python-log-summarizer.js";
import EfficientLogAnalyzer from "./libs/efficient-log-analyzer.js";

const COMMANDS = new Set(["run", "analyze-file"]);

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
  const summaryLevels = options["summary-levels"] ? Number(options["summary-levels"]) : 3;
  const contextLength = options["context-length"] ? Number(options["context-length"]) : 32768;
  const gpu = options.gpu ?? "auto";
  const timeout = options.timeout ? Number(options.timeout) : 60000;
  const task = options.task ?? "Provide a precise technical analysis of the captured output.";

  const manager = new LMStudioManager();
  const phi4 = new Phi4Handler(manager);
  const cli = new CliExecutor();
  const summarizer = new PythonLogSummarizer(options["python-script"]);
  const analyzer = new EfficientLogAnalyzer(phi4, cli, summarizer);

  try {
    await phi4.load({ contextLength, gpu });
    let result;

    if (command === "run") {
      const cmd = options.cmd ?? positionals.join(" ");
      if (!cmd) {
        throw new Error('Missing --cmd "<command>" for run mode.');
      }

      const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
      result = await analyzer.analyzeCommandOutput(cmd, task, {
        summaryLevels,
        verbose,
        streamOutput,
        cwd,
        timeout,
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

      result = await analyzer.analyzeLogFile(filePath, task, {
        summaryLevels,
        streamOutput,
        maxLinesPerChunk: options["chunk-size"] ? Number(options["chunk-size"]) : undefined,
      });
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
      await phi4.eject();
    } catch {
      // no-op
    }
  }
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

function printHelp() {
  console.log(`MiniPhi CLI

Usage:
  node src/index.js run --cmd "npm test" --task "Analyze failures"
  node src/index.js analyze-file --file ./logs/output.log --task "Summarize log"

Options:
  --cmd <command>              Command to execute in run mode
  --file <path>                File to analyze in analyze-file mode
  --task <description>         Task instructions for Phi-4
  --cwd <path>                 Working directory for --cmd
  --summary-levels <n>         Depth for recursive summarization (default: 3)
  --context-length <tokens>    Override Phi-4 context length (default: 32768)
  --gpu <mode>                 GPU setting forwarded to LM Studio (default: auto)
  --timeout <ms>               Command timeout in milliseconds (default: 60000)
  --python-script <path>       Custom path to log_summarizer.py
  --chunk-size <lines>         Chunk size when analyzing files (default: 2000)
  --verbose                    Print progress details
  --no-stream                  Disable live streaming of Phi-4 output
  --no-summary                 Skip JSON summary footer
  --help                       Show this help message
`);
}

main();
