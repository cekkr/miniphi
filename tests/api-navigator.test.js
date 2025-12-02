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
