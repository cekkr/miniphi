import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import ApiNavigator from "../src/libs/api-navigator.js";

test("ApiNavigator executes helpers after stripping surrounding quotes from paths", async () => {
  const helperPath = path.join(process.cwd(), ".tmp-helper-path.py");
  fs.writeFileSync(helperPath, "print('ok')", "utf8");

  let capturedCommand = null;
  let capturedCwd = null;
  const cliExecutor = {
    async executeCommand(command, options) {
      capturedCommand = command;
      capturedCwd = options?.cwd ?? null;
      return { code: 0, stdout: "", stderr: "" };
    },
  };

  const navigator = new ApiNavigator({ cliExecutor });
  // Seed the runner cache so unit tests do not depend on a local Python installation.
  navigator.pythonRunnerCache = {
    runner: { command: "python", label: "python" },
    expiresAt: Date.now() + 60_000,
  };
  try {
    const result = await navigator._executeHelper(`"${helperPath}"`, "python", path.dirname(helperPath));

    const expectedCommand = `python \"${helperPath}\"`;
    assert.strictEqual(result.command, expectedCommand);
    assert.strictEqual(capturedCommand, expectedCommand);
    assert.strictEqual(capturedCwd, path.dirname(helperPath));
  } finally {
    fs.rmSync(helperPath, { force: true });
  }
});

test("ApiNavigator rejects prose-only navigation responses", () => {
  const navigator = new ApiNavigator();
  const parsed = navigator._parsePlan("Sure, let me think about the repo first...");
  assert.strictEqual(parsed, null);
});

test("ApiNavigator sanitizes helper code wrapped in fences", () => {
  const navigator = new ApiNavigator();
  const cleaned = navigator._sanitizeHelperCode("```python\nprint('hello')\n```");
  assert.strictEqual(cleaned, "print('hello')");
});
