#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const RESULTS_DIR = path.resolve("benchmark/logs/benchmark-analyze");
const DEFAULT_TEST = "benchmark-analyze-smoke";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const testName = options.test ?? DEFAULT_TEST;
  await runCommand("node", ["benchmark/run-tests.js", testName], {
    env: process.env,
  });

  const summaryPath = await findLatestSummary();
  if (!summaryPath) {
    throw new Error(`Unable to locate SUMMARY.json output under ${RESULTS_DIR}`);
  }

  if (options.skipAnalyze) {
    console.log(`[BenchmarkWorkflow] Latest SUMMARY.json: ${summaryPath}`);
    return;
  }

  const summary = await readSummary(summaryPath);
  console.log(
    `[BenchmarkWorkflow] Summary: ${summary.totalRuns ?? 0} run(s) under ${summary.directory ?? "unknown"}`,
  );
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

async function findLatestSummary() {
  const runDirs = await listRunDirs();
  let latestFile = null;
  let latestMTime = 0;
  for (const dir of runDirs) {
    const filePath = path.join(dir, "SUMMARY.json");
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs >= latestMTime) {
        latestMTime = stat.mtimeMs;
        latestFile = filePath;
      }
    } catch {
      // ignore missing summary
    }
  }
  return latestFile;
}

async function readSummary(summaryPath) {
  const content = await fs.promises.readFile(summaryPath, "utf8");
  return JSON.parse(content);
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
