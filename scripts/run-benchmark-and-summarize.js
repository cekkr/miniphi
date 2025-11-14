#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const RESULTS_DIR = path.resolve("samples/benchmark/bash");
const DEFAULT_TEST = "samples-bash-explain";
const DEFAULT_PROMPT_FILE = path.resolve("docs/prompts/windows-benchmark-default.md");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const testName = options.test ?? DEFAULT_TEST;
  await runCommand("node", ["benchmark/run-tests.js", testName], {
    env: process.env,
  });

  const latestExplain = await findLatestExplain();
  if (!latestExplain) {
    throw new Error(`Unable to locate EXPLAIN output under ${RESULTS_DIR}`);
  }

  if (options.skipAnalyze) {
    console.log(`[BenchmarkWorkflow] Latest EXPLAIN file: ${latestExplain}`);
    return;
  }

  const promptPath = options.promptFile ?? DEFAULT_PROMPT_FILE;
  const prompt = await readPrompt(promptPath);
  const analyzeArgs = [
    "src/index.js",
    "analyze-file",
    "--file",
    latestExplain,
    "--task",
    prompt,
  ];
  if (options.verbose) {
    analyzeArgs.push("--verbose");
  }
  analyzeArgs.push(...options.forwardArgs);
  await runCommand("node", analyzeArgs, {
    env: process.env,
  });
}

function parseArgs(tokens) {
  const options = {
    forwardArgs: [],
  };
  let forwardMode = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (forwardMode) {
      options.forwardArgs.push(token);
      continue;
    }
    if (token === "--") {
      forwardMode = true;
      continue;
    }
    switch (token) {
      case "--test":
        options.test = tokens[++i];
        break;
      case "--prompt-file":
        options.promptFile = tokens[++i];
        break;
      case "--skip-analyze":
        options.skipAnalyze = true;
        break;
      case "--verbose":
        options.verbose = true;
        options.forwardArgs.push("--verbose");
        break;
      default:
        options.forwardArgs.push(token);
        break;
    }
  }
  return options;
}

async function findLatestExplain() {
  const runDirs = await listRunDirs();
  let latestFile = null;
  let latestMTime = 0;
  for (const dir of runDirs) {
    const files = await fs.promises.readdir(dir);
    for (const name of files) {
      if (!/^EXPLAIN-\d+\.md$/i.test(name)) {
        continue;
      }
      const filePath = path.join(dir, name);
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs >= latestMTime) {
        latestMTime = stat.mtimeMs;
        latestFile = filePath;
      }
    }
  }
  return latestFile;
}

async function readPrompt(promptPath) {
  try {
    const content = await fs.promises.readFile(promptPath, "utf8");
    console.log(`[BenchmarkWorkflow] Using prompt from ${promptPath}`);
    return content.trim();
  } catch (error) {
    console.warn(
      `[BenchmarkWorkflow] Unable to read prompt file (${promptPath}). Using default fallback.`,
    );
    return "Summarize the EXPLAIN report, highlight regressions, and list next implementation steps.";
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[BenchmarkWorkflow] ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
    child.on("error", (error) => {
      reject(error);
    });
  });
}

main().catch((error) => {
  console.error(`[BenchmarkWorkflow] ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});

async function listRunDirs() {
  try {
    const entries = await fs.promises.readdir(RESULTS_DIR, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(RESULTS_DIR, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
