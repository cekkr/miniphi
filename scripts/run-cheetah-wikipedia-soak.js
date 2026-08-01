#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const defaults = {
  durationHours: 4,
  articleBatch: 100,
  probeEvery: 25,
  probeCount: 5,
  benchmarkEvery: 1,
  testEvery: 1,
  datasetPath: "E:\\Models\\datasets\\wiki-data-2021",
  baseUrl: "http://192.168.56.1:1234",
  model: "smollm2-360m-instruct",
  database: "wikidata",
  checkpoint: path.join(
    repoRoot,
    ".miniphi",
    "cheetah",
    "wikipedia",
    "wikidata-checkpoint.json",
  ),
};

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function positiveNumber(value, label, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return numeric;
}

function positiveInteger(value, label, fallback) {
  return Math.floor(positiveNumber(value, label, fallback));
}

function printHelp() {
  console.log(`Run a timed MiniPhi/Cheetah Wikipedia reliability session.

Each cycle resumes Wikipedia learning, performs fixed-subject inference probes,
archives an Easy benchmark payload, and runs the repository unit suite. A failed
step stops the session so the runtime can be repaired before resuming it.

Usage:
  node scripts/run-cheetah-wikipedia-soak.js [options]

Options:
  --duration-hours <n>       Session duration (default: 4)
  --deadline <ISO>           Fixed UTC deadline; overrides duration for a new session
  --session-dir <dir>        New or resumable artifact directory
  --article-batch <n>        Wikipedia articles per cycle (default: 100)
  --probe-every <n>          Retention probe interval (default: 25)
  --probe-count <n>          Fixed early subjects per probe (default: 5)
  --benchmark-every <n>      Benchmark every N cycles (default: 1)
  --test-every <n>           Run npm test every N cycles (default: 1)
  --no-tests                 Skip repository test gates
  --dataset-path <dir>       Wikipedia JSON shard directory
  --base-url <url>           LM Studio REST URL
  --model <key>              Exact LM Studio model key
  --database <name>          Cheetah database (default: wikidata)
  --checkpoint <file>        Wikipedia resume checkpoint
  --help                     Show this help
`);
}

function parseArgs(argv) {
  const result = { ...defaults };
  const keyMap = {
    "duration-hours": "durationHours",
    deadline: "deadline",
    "session-dir": "sessionDir",
    "article-batch": "articleBatch",
    "probe-every": "probeEvery",
    "probe-count": "probeCount",
    "benchmark-every": "benchmarkEvery",
    "test-every": "testEvery",
    "dataset-path": "datasetPath",
    "base-url": "baseUrl",
    model: "model",
    database: "database",
    checkpoint: "checkpoint",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") {
      result.help = true;
      continue;
    }
    if (token === "--no-tests") {
      result.noTests = true;
      continue;
    }
    if (!token.startsWith("--") || !keyMap[token.slice(2)]) {
      throw new Error(`Unknown option ${token}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} expects a value.`);
    }
    result[keyMap[token.slice(2)]] = value;
    index += 1;
  }
  result.durationHours = positiveNumber(
    result.durationHours,
    "--duration-hours",
    defaults.durationHours,
  );
  result.articleBatch = positiveInteger(
    result.articleBatch,
    "--article-batch",
    defaults.articleBatch,
  );
  result.probeEvery = positiveInteger(
    result.probeEvery,
    "--probe-every",
    defaults.probeEvery,
  );
  result.probeCount = positiveInteger(
    result.probeCount,
    "--probe-count",
    defaults.probeCount,
  );
  result.benchmarkEvery = positiveInteger(
    result.benchmarkEvery,
    "--benchmark-every",
    defaults.benchmarkEvery,
  );
  result.testEvery = positiveInteger(result.testEvery, "--test-every", defaults.testEvery);
  return result;
}

function runProcess(command, args, { env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendEvent(sessionDir, event) {
  const record = { at: new Date().toISOString(), ...event };
  await fs.appendFile(
    path.join(sessionDir, "events.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("Benchmark command emitted an empty response.");
  }
  return JSON.parse(trimmed);
}

async function loadOrCreateSession(options) {
  const requestedDir = options.sessionDir
    ? path.resolve(options.sessionDir)
    : path.join(
        repoRoot,
        ".miniphi",
        "cheetah",
        "soak",
        compactTimestamp(),
      );
  const stateFile = path.join(requestedDir, "session.json");
  try {
    const existing = await readJson(stateFile);
    return { sessionDir: requestedDir, stateFile, state: existing, resumed: true };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const startedAt = new Date();
  const explicitDeadline = options.deadline ? new Date(options.deadline) : null;
  if (explicitDeadline && !Number.isFinite(explicitDeadline.getTime())) {
    throw new Error("--deadline must be a valid ISO date/time.");
  }
  const deadline = explicitDeadline ?? new Date(startedAt.getTime() + options.durationHours * 3600000);
  const state = {
    schemaVersion: "miniphi-cheetah-soak@v1",
    status: "running",
    startedAt: startedAt.toISOString(),
    deadline: deadline.toISOString(),
    finishedAt: null,
    completedCycles: 0,
    lastCompletedStep: null,
    lastError: null,
    options: {
      durationHours: options.durationHours,
      articleBatch: options.articleBatch,
      probeEvery: options.probeEvery,
      probeCount: options.probeCount,
      benchmarkEvery: options.benchmarkEvery,
      testEvery: options.testEvery,
      noTests: Boolean(options.noTests),
      datasetPath: path.resolve(options.datasetPath),
      baseUrl: options.baseUrl,
      model: options.model,
      database: options.database,
      checkpoint: path.resolve(options.checkpoint),
    },
  };
  await writeJson(stateFile, state);
  return { sessionDir: requestedDir, stateFile, state, resumed: false };
}

async function runStep({ sessionDir, stateFile, state, cycle, name, command, args, env, capture }) {
  const startedAt = Date.now();
  await appendEvent(sessionDir, { type: "step-start", cycle, step: name, command, args });
  const result = await runProcess(command, args, { env, capture });
  const durationMs = Date.now() - startedAt;
  if (capture) {
    const prefix = path.join(
      sessionDir,
      "snapshots",
      `cycle-${String(cycle).padStart(4, "0")}-${name}`,
    );
    await fs.writeFile(`${prefix}.stdout.log`, result.stdout, "utf8");
    await fs.writeFile(`${prefix}.stderr.log`, result.stderr, "utf8");
  }
  await appendEvent(sessionDir, {
    type: "step-finish",
    cycle,
    step: name,
    code: result.code,
    signal: result.signal ?? null,
    durationMs,
  });
  if (result.code !== 0) {
    const diagnostic = (result.stderr || result.stdout).trim().slice(-4000);
    if (diagnostic) {
      console.error(diagnostic);
    }
    state.status = "failed";
    state.lastError = `${name} exited with code ${result.code}`;
    state.lastCompletedStep = null;
    await writeJson(stateFile, state);
    throw new Error(state.lastError);
  }
  state.lastCompletedStep = name;
  state.lastError = null;
  await writeJson(stateFile, state);
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const session = await loadOrCreateSession(options);
  const { sessionDir, stateFile, state } = session;
  const runOptions = { ...options, ...(session.resumed ? state.options : {}) };
  const deadlineMs = new Date(state.deadline).getTime();
  if (!Number.isFinite(deadlineMs)) {
    throw new Error(`Invalid persisted deadline ${state.deadline}.`);
  }
  await fs.mkdir(path.join(sessionDir, "snapshots"), { recursive: true });
  state.status = "running";
  state.lastError = null;
  await writeJson(stateFile, state);
  await appendEvent(sessionDir, {
    type: session.resumed ? "session-resume" : "session-start",
    deadline: state.deadline,
  });
  console.log(`[soak] session=${sessionDir}`);
  console.log(`[soak] deadline=${state.deadline}`);

  const env = { ...process.env, LMSTUDIO_REST_URL: runOptions.baseUrl };
  while (Date.now() < deadlineMs) {
    const cycle = state.completedCycles + 1;
    console.log(`[soak] cycle=${cycle} remainingMinutes=${Math.ceil((deadlineMs - Date.now()) / 60000)}`);

    await runStep({
      sessionDir,
      stateFile,
      state,
      cycle,
      name: "wikipedia-learning",
      command: process.execPath,
      args: [
        path.join(repoRoot, "scripts", "run-cheetah-wikipedia-learning.js"),
        "--dataset-path",
        path.resolve(runOptions.datasetPath),
        "--base-url",
        runOptions.baseUrl,
        "--model",
        runOptions.model,
        "--database",
        runOptions.database,
        "--checkpoint",
        path.resolve(runOptions.checkpoint),
        "--limit",
        String(runOptions.articleBatch),
        "--probe-every",
        String(runOptions.probeEvery),
        "--probe-count",
        String(runOptions.probeCount),
        "--max-errors",
        "5",
        "--max-no-progress",
        "10",
      ],
      env,
      capture: false,
    });
    const checkpoint = await readJson(path.resolve(runOptions.checkpoint));
    await writeJson(
      path.join(sessionDir, "snapshots", `cycle-${String(cycle).padStart(4, "0")}-checkpoint.json`),
      checkpoint,
    );

    if (cycle % runOptions.benchmarkEvery === 0 && Date.now() < deadlineMs) {
      const benchmark = await runStep({
        sessionDir,
        stateFile,
        state,
        cycle,
        name: "easy-benchmark",
        command: process.execPath,
        args: [
          path.join(repoRoot, "src", "index.js"),
          "benchmark",
          "models",
          "--easy",
          "--models",
          runOptions.model,
          "--refresh",
          "--json",
          "--cwd",
          repoRoot,
          "--model-timeout",
          "30",
        ],
        env,
        capture: true,
      });
      const benchmarkPayload = extractJsonObject(benchmark.stdout);
      await writeJson(
        path.join(sessionDir, "snapshots", `cycle-${String(cycle).padStart(4, "0")}-benchmark.json`),
        benchmarkPayload,
      );
      const row = benchmarkPayload.rows?.[0] ?? null;
      console.log(
        `[soak][benchmark] cycle=${cycle} overall=${row?.overall ?? "n/a"} ` +
          `latencyMs=${row?.latencyMs ?? "n/a"} status=${benchmarkPayload.ok ? "ok" : "failed"}`,
      );
    }

    if (
      !runOptions.noTests &&
      cycle % runOptions.testEvery === 0 &&
      Date.now() < deadlineMs
    ) {
      const tests = await runStep({
        sessionDir,
        stateFile,
        state,
        cycle,
        name: "unit-tests",
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: ["test"],
        env,
        capture: true,
      });
      const pass = tests.stdout.match(/# pass (\d+)/)?.[1] ?? "n/a";
      const fail = tests.stdout.match(/# fail (\d+)/)?.[1] ?? "n/a";
      const skipped = tests.stdout.match(/# skipped (\d+)/)?.[1] ?? "n/a";
      console.log(`[soak][tests] cycle=${cycle} pass=${pass} fail=${fail} skipped=${skipped}`);
    }

    state.completedCycles = cycle;
    state.lastCompletedStep = "cycle-complete";
    await writeJson(stateFile, state);
    await appendEvent(sessionDir, { type: "cycle-complete", cycle });
  }

  state.status = "completed";
  state.finishedAt = new Date().toISOString();
  state.lastCompletedStep = "session-complete";
  await writeJson(stateFile, state);
  await appendEvent(sessionDir, {
    type: "session-complete",
    completedCycles: state.completedCycles,
  });
  console.log(`[soak] completed cycles=${state.completedCycles} session=${sessionDir}`);
}

main().catch((error) => {
  console.error(`[soak] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
