#!/usr/bin/env node
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import process from "process";

const DEFAULT_TIMEOUT = 15 * 60 * 1000;
const PROJECT_ROOT = process.cwd();
const LOG_ROOT = path.join(PROJECT_ROOT, "benchmark", "logs");

async function main() {
  const { flags, filters } = parseArgs(process.argv.slice(2));
  const config = await loadBenchmarkConfig();
  const availableTests = config.tests ?? [];

  if (flags.has("list")) {
    printTestList(availableTests);
    return;
  }

  const selected = filters.length
    ? availableTests.filter((test) => filters.includes(test.name))
    : availableTests;

  if (selected.length === 0) {
    console.error("[benchmark] No tests selected. Use --list to see available suites.");
    process.exitCode = 1;
    return;
  }

  await fs.promises.mkdir(LOG_ROOT, { recursive: true });

  let hasFailures = false;

  for (const test of selected) {
    const { success } = await runTest(test, flags);
    if (!success) {
      hasFailures = true;
      if (flags.has("fail-fast")) {
        break;
      }
    }
  }

  process.exitCode = hasFailures ? 1 : 0;
}

async function runTest(test, flags) {
  const timeout = Math.min(test.timeoutMs ?? DEFAULT_TIMEOUT, DEFAULT_TIMEOUT);
  const logDir = path.join(LOG_ROOT, test.logDir ?? test.name ?? "default");
  await fs.promises.mkdir(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(logDir, `${timestamp}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const log = (level, message) => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    logStream.write(`${line}\n`);
    if (!flags.has("quiet")) {
      console.log(line);
    }
  };
  log("INFO", `Starting test "${test.name}"`);
  log("INFO", test.description ?? "No description provided.");
  const startedAt = Date.now();

  const streamChunk = (data, stream) => {
    const lines = data.replace(/\r/g, "").split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      log(stream, line);
    }
  };

  try {
    await executeCommand(test.command, {
      cwd: test.cwd ? path.resolve(PROJECT_ROOT, test.cwd) : PROJECT_ROOT,
      timeout,
      onStdout: (chunk) => streamChunk(chunk, "STDOUT"),
      onStderr: (chunk) => streamChunk(chunk, "STDERR"),
    });
    const durationMs = Date.now() - startedAt;
    log("INFO", `Test "${test.name}" PASS (${logFile}) in ${durationMs} ms`);
    logStream.end();
    return { success: true };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    log(
      "ERROR",
      `Test "${test.name}" FAILED after ${durationMs} ms: ${error instanceof Error ? error.message : error}`,
    );
    logStream.end();
    return { success: false };
  }
}

async function executeCommand(command, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: options?.cwd ?? PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timeoutId = options?.timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeout)
      : null;

    child.stdout.on("data", (data) => {
      options?.onStdout?.(data.toString());
    });
    child.stderr.on("data", (data) => {
      options?.onStderr?.(data.toString());
    });
    child.on("error", (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (timedOut) {
        reject(new Error(`Command timed out after ${options.timeout} ms`));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });
  });
}

async function loadBenchmarkConfig() {
  const configPath = path.join(PROJECT_ROOT, "benchmark", "tests.config.json");
  const raw = await fs.promises.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

function parseArgs(args) {
  const flags = new Set();
  const filters = [];
  for (const token of args) {
    if (token.startsWith("--")) {
      flags.add(token.replace(/^--/, ""));
    } else {
      filters.push(token);
    }
  }
  return { flags, filters };
}

function printTestList(tests) {
  if (tests.length === 0) {
    console.log("No benchmark tests defined.");
    return;
  }
  console.log("Available benchmark tests:\n");
  for (const test of tests) {
    console.log(`- ${test.name}: ${test.description ?? "no description"}`);
  }
}

main().catch((error) => {
  console.error(`[benchmark] Unexpected failure: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
