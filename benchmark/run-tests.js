#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import CliExecutor from "../src/libs/cli-executor.js";
import ResourceMonitor from "../src/libs/resource-monitor.js";
import { loadConfig as loadMiniPhiConfig } from "../src/libs/config-loader.js";
import { resolveLmStudioHttpBaseUrl, isLocalLmStudioBaseUrl } from "../src/libs/core-utils.js";

const DEFAULT_TIMEOUT = 15 * 60 * 1000;
const PROJECT_ROOT = process.cwd();
const LOG_ROOT = path.join(PROJECT_ROOT, "benchmark", "logs");
const RESOURCE_HISTORY = path.join(LOG_ROOT, "resource-usage.json");

async function main() {
  const { flags, filters } = parseArgs(process.argv.slice(2));
  const config = await loadBenchmarkConfig();
  const availableTests = config.tests ?? [];
  const miniConfig = loadMiniPhiConfig()?.data ?? {};
  const resolvedLmStudioBase = resolveLmStudioHttpBaseUrl(miniConfig);
  const lmStudioLocal = isLocalLmStudioBaseUrl(resolvedLmStudioBase);
  const resourceMonitorDisabled = !lmStudioLocal;

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

  const cli = new CliExecutor();
  let hasFailures = false;

  for (const test of selected) {
    const success = await runTest(cli, test, flags, {
      disableMonitor: flags.has("no-monitor")
        ? true
        : flags.has("force-monitor")
          ? false
          : resourceMonitorDisabled,
      lmStudioBase: resolvedLmStudioBase,
    });
    if (!success) {
      hasFailures = true;
      if (flags.has("fail-fast")) {
        break;
      }
    }
  }

  process.exitCode = hasFailures ? 1 : 0;
}

async function runTest(cli, test, flags, options = undefined) {
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

  const monitorDisabled = Boolean(options?.disableMonitor);
  let monitor;
  if (monitorDisabled) {
    const reason = options?.lmStudioBase
      ? `LM Studio endpoint is external (${options.lmStudioBase})`
      : "resource monitor disabled via flag";
    log("INFO", `Resource monitor skipped: ${reason}.`);
  } else {
    try {
      monitor = new ResourceMonitor({
        sampleInterval: 3000,
        historyFile: RESOURCE_HISTORY,
        label: `benchmark:${test.name}`,
      });
      await monitor.start(`benchmark:${test.name}`);
    } catch (error) {
      monitor = null;
      log("WARN", `Resource monitor unavailable (${error instanceof Error ? error.message : error}).`);
    }
  }

  const streamChunk = (data, stream) => {
    const lines = data.replace(/\r/g, "").split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      log(stream, line);
    }
  };

  try {
    await cli.executeCommand(test.command, {
      cwd: test.cwd ? path.resolve(PROJECT_ROOT, test.cwd) : PROJECT_ROOT,
      timeout,
      captureOutput: false,
      onStdout: (chunk) => streamChunk(chunk, "STDOUT"),
      onStderr: (chunk) => streamChunk(chunk, "STDERR"),
    });
    log("INFO", `Test "${test.name}" PASS (${logFile})`);
    await finalizeMonitor(monitor, log);
    logStream.end();
    return true;
  } catch (error) {
    log("ERROR", `Test "${test.name}" FAILED: ${error instanceof Error ? error.message : error}`);
    await finalizeMonitor(monitor, log);
    logStream.end();
    return false;
  }
}

async function finalizeMonitor(monitor, log) {
  if (!monitor) {
    return;
  }
  try {
    const summary = await monitor.stop();
    if (summary?.summary?.stats) {
      log(
        "INFO",
        `Resource stats - memory avg ${summary.summary.stats.memory.avg ?? "n/a"}%, cpu avg ${summary.summary.stats.cpu.avg ?? "n/a"}%, vram avg ${summary.summary.stats.vram.avg ?? "n/a"}%.`,
      );
    }
    if (summary?.summary?.warnings?.length) {
      for (const warning of summary.summary.warnings) {
        log("WARN", warning);
      }
    }
  } catch (error) {
    log("WARN", `Unable to persist resource stats: ${error instanceof Error ? error.message : error}`);
  }
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
