#!/usr/bin/env node

import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startCheetahServer } from "../src/libs/cheetah-binder.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const defaults = {
  datasetPath: "E:\\Models\\datasets\\wiki-data-2021",
  baseUrl: "http://192.168.56.1:1234",
  model: "smollm2-360m-instruct",
  database: "wikidata",
  cheetahHost: "127.0.0.1",
  cheetahPort: "4455",
  cheetahTimeoutMs: "10000",
  limit: "100",
  probeEvery: "10",
  probeCount: "3",
  maxErrors: "5",
  maxNoProgress: "10",
  maxSentences: "2",
  maxChars: "700",
  maxArticleBytes: null,
  checkpoint: path.join(repoRoot, ".miniphi", "cheetah", "wikipedia", "wikidata-checkpoint.json"),
  cheetahDataDir: path.join(repoRoot, "thirds", "cheetah", "cheetah_data"),
};

function printHelp() {
  console.log(`Stream a local Wikipedia dump into Cheetah and probe recall while it learns.

Usage:
  node scripts/run-cheetah-wikipedia-learning.js [options]

Defaults target the reference Windows setup:
  dataset:  ${defaults.datasetPath}
  LM Studio: ${defaults.baseUrl}
  model:    ${defaults.model}
  database: ${defaults.database}

Options:
  --dataset-path <dir>       Directory of JSON-array Wikipedia shards
  --base-url <url>           LM Studio HTTP base URL
  --model <key>              Exact LM Studio model key
  --database <name>          Cheetah database (default: wikidata)
  --limit <n>                Articles attempted in this bounded invocation
  --probe-every <n>          Run retention inference every N articles
  --probe-count <n>          Fixed early subjects re-queried per probe
  --checkpoint <file>        Resume checkpoint JSON
  --max-errors <n>           Stop after N consecutive inference errors
  --max-no-progress <n>      Stop after N articles with no source memory or facts
  --max-sentences <n>        Article-leading sentences sent to the model
  --max-chars <n>            Maximum snippet characters
  --max-article-bytes <n>    Maximum raw bytes accepted for one article
  --cheetah-timeout-ms <n>   Cheetah request timeout in milliseconds
  --cheetah-host <host>      Cheetah TCP host
  --cheetah-port <port>      Cheetah TCP port
  --cheetah-data-dir <dir>   Persistent server data directory when auto-started
  --no-start-cheetah         Require an already-running Cheetah server
  --keep-cheetah             Leave an auto-started server running
  --no-resume                Ignore the checkpoint position (does not reset the DB)
  --reset-database           Destructively reset the selected DB and start at article zero
  --verbose                  Print each article result
  --json                     Emit final machine-readable JSON
  --help                     Show this help
`);
}

function parseArgs(argv) {
  const options = { ...defaults };
  const booleanKeys = new Set([
    "no-start-cheetah",
    "keep-cheetah",
    "no-resume",
    "reset-database",
    "verbose",
    "json",
    "help",
  ]);
  const keyMap = {
    "dataset-path": "datasetPath",
    "base-url": "baseUrl",
    model: "model",
    database: "database",
    limit: "limit",
    "probe-every": "probeEvery",
    "probe-count": "probeCount",
    checkpoint: "checkpoint",
    "max-errors": "maxErrors",
    "max-no-progress": "maxNoProgress",
    "max-sentences": "maxSentences",
    "max-chars": "maxChars",
    "max-article-bytes": "maxArticleBytes",
    "cheetah-host": "cheetahHost",
    "cheetah-port": "cheetahPort",
    "cheetah-timeout-ms": "cheetahTimeoutMs",
    "cheetah-data-dir": "cheetahDataDir",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (booleanKeys.has(key)) {
      options[key] = true;
      continue;
    }
    const property = keyMap[key];
    if (!property) {
      throw new Error(`Unknown option --${key}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${key} expects a value.`);
    }
    options[property] = value;
    index += 1;
  }
  return options;
}

function canConnect(host, port, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function runMiniPhi(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "src", "index.js"), ...args], {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`MiniPhi was terminated by ${signal}.`));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  let server = null;
  const alreadyRunning = await canConnect(options.cheetahHost, options.cheetahPort);
  if (!alreadyRunning) {
    if (options["no-start-cheetah"]) {
      throw new Error(
        `Cheetah is not reachable at ${options.cheetahHost}:${options.cheetahPort}.`,
      );
    }
    server = await startCheetahServer({
      host: options.cheetahHost,
      port: Number(options.cheetahPort),
      cwd: path.join(repoRoot, "thirds", "cheetah"),
      dataDir: path.resolve(options.cheetahDataDir),
      build: true,
      captureLogs: true,
      readyTimeoutMs: 30000,
    });
    console.log(
      `[wikipedia-learning] Started Cheetah pid=${server.child.pid} data=${server.dataDir}`,
    );
  } else {
    console.log(
      `[wikipedia-learning] Reusing Cheetah at ${options.cheetahHost}:${options.cheetahPort}.`,
    );
  }

  const args = [
    "cheetah-learn",
    "wikipedia",
    "--dataset-path",
    path.resolve(options.datasetPath),
    "--base-url",
    options.baseUrl,
    "--model",
    options.model,
    "--cheetah-host",
    options.cheetahHost,
    "--cheetah-port",
    options.cheetahPort,
    "--cheetah-database",
    options.database,
    "--cheetah-timeout-ms",
    options.cheetahTimeoutMs,
    "--limit",
    options.limit,
    "--probe-every",
    options.probeEvery,
    "--probe-count",
    options.probeCount,
    "--checkpoint",
    path.resolve(options.checkpoint),
    "--max-errors",
    options.maxErrors,
    "--max-no-progress",
    options.maxNoProgress,
    "--max-sentences",
    options.maxSentences,
    "--max-chars",
    options.maxChars,
  ];
  if (options.maxArticleBytes) {
    args.push("--max-article-bytes", options.maxArticleBytes);
  }
  if (options["no-resume"]) args.push("--no-resume");
  if (options["reset-database"]) args.push("--reset-database");
  if (options.verbose) args.push("--verbose");
  if (options.json) args.push("--json");

  try {
    const code = await runMiniPhi(args);
    if (code !== 0) {
      throw new Error(`MiniPhi exited with code ${code}.`);
    }
  } finally {
    if (server && !options["keep-cheetah"]) {
      await server.stop({ graceMs: 10000 });
      console.log("[wikipedia-learning] Stopped the Cheetah process started by this script.");
    } else if (server) {
      console.log(`[wikipedia-learning] Leaving Cheetah running (pid=${server.child.pid}).`);
    }
  }
}

main().catch((error) => {
  console.error(`[wikipedia-learning] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
