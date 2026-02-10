import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TaskExecutionRegister from "../src/libs/task-execution-register.js";

test("TaskExecutionRegister normalizes legacy stop reasons in error payloads", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-task-exec-"));
  try {
    const register = new TaskExecutionRegister(workspace);
    const opened = await register.openSession("task-exec-stop-test", {
      mode: "run",
      task: "Normalize stop reasons",
    });
    assert.ok(opened?.path);

    await register.record({
      type: "lmstudio.chat",
      error: {
        message: "legacy fallback marker",
        stop_reason: "partial-fallback",
        stop_reason_code: "fallback",
      },
    });

    await register.record({
      type: "lmstudio.chat",
      error: "session-timeout: session deadline exceeded.",
    });

    const payload = JSON.parse(await fs.readFile(opened.path, "utf8"));
    assert.equal(Array.isArray(payload.entries), true);
    assert.equal(payload.entries.length, 2);

    const first = payload.entries[0];
    assert.equal(first.error.stop_reason, "analysis-error");
    assert.equal(first.error.stop_reason_code, "analysis-error");
    assert.equal(first.error.stop_reason_detail, "legacy fallback marker");

    const second = payload.entries[1];
    assert.equal(second.error.stop_reason, "session-timeout");
    assert.equal(second.error.stop_reason_code, "session-timeout");
    assert.equal(
      second.error.stop_reason_detail,
      "session-timeout: session deadline exceeded.",
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
