#!/usr/bin/env node
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();
const RUN_DIR = path.join(PROJECT_ROOT, "benchmark", "logs", "benchmark-analyze");

async function main() {
  await fs.promises.mkdir(RUN_DIR, { recursive: true });
  const payload = {
    direction: "roundtrip",
    sampleDir: path.join("samples", "recompose", "hello-flow"),
    generatedAt: new Date().toISOString(),
    steps: [
      { phase: "code-to-markdown", durationMs: 12, discovered: 2, converted: 2, skipped: 0 },
      { phase: "markdown-to-code", durationMs: 18, processed: 2, converted: 2, warnings: [] },
      { phase: "comparison", durationMs: 5, matches: 2, mismatches: [], missing: [], extras: [] },
    ],
  };
  const runPath = path.join(RUN_DIR, "RUN-001.json");
  await fs.promises.writeFile(runPath, JSON.stringify(payload, null, 2), "utf8");

  await runCommand("node", ["src/index.js", "benchmark", "analyze", "--path", RUN_DIR]);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
    child.on("error", (error) => reject(error));
  });
}

main().catch((error) => {
  console.error(`[benchmark-analyze-smoke] ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
