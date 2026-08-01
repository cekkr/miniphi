import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const scriptPath = path.resolve("scripts", "run-cheetah-wikipedia-soak.js");

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Wikipedia soak runner documents its bounded four-hour defaults", async () => {
  const result = await runScript(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--duration-hours <n>/);
  assert.match(result.stdout, /default: 4/);
  assert.match(result.stdout, /archives an Easy benchmark payload/);
});

test("Wikipedia soak runner rejects invalid numeric controls before starting services", async () => {
  const result = await runScript(["--duration-hours", "0"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--duration-hours must be a positive number/);
});
