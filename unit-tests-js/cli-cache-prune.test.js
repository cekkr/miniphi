import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace, runCli } from "./cli-test-utils.js";

test("CLI cache-prune trims indexed .miniphi artifacts", async () => {
  const workspace = await createTempWorkspace();
  try {
    const miniPhiDir = path.join(workspace, ".miniphi");
    const executionsDir = path.join(miniPhiDir, "executions");
    const indicesDir = path.join(miniPhiDir, "indices");
    const promptDir = path.join(miniPhiDir, "prompt-exchanges");
    const stepwiseDir = path.join(promptDir, "stepwise");
    await fs.mkdir(executionsDir, { recursive: true });
    await fs.mkdir(indicesDir, { recursive: true });
    await fs.mkdir(stepwiseDir, { recursive: true });

    const execIds = ["exec-1", "exec-2", "exec-3"];
    for (const execId of execIds) {
      const execPath = path.join(executionsDir, execId);
      await fs.mkdir(execPath, { recursive: true });
      await fs.writeFile(
        path.join(execPath, "index.json"),
        JSON.stringify({ id: execId }, null, 2),
        "utf8",
      );
    }
    const execEntries = [
      { id: "exec-3", createdAt: "2026-01-03T00:00:00Z", path: "executions/exec-3/index.json" },
      { id: "exec-2", createdAt: "2026-01-02T00:00:00Z", path: "executions/exec-2/index.json" },
      { id: "exec-1", createdAt: "2026-01-01T00:00:00Z", path: "executions/exec-1/index.json" },
    ];
    await fs.writeFile(
      path.join(indicesDir, "executions-index.json"),
      JSON.stringify({ entries: execEntries, byTask: {}, latest: execEntries[0] }, null, 2),
      "utf8",
    );

    const promptEntries = [
      { id: "prompt-2", file: "prompt-exchanges/prompt-2.json", recordedAt: "2026-01-02T00:00:00Z" },
      { id: "prompt-1", file: "prompt-exchanges/prompt-1.json", recordedAt: "2026-01-01T00:00:00Z" },
    ];
    await fs.mkdir(promptDir, { recursive: true });
    await fs.writeFile(
      path.join(promptDir, "prompt-1.json"),
      JSON.stringify({ id: "prompt-1" }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(promptDir, "prompt-2.json"),
      JSON.stringify({ id: "prompt-2" }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(promptDir, "index.json"),
      JSON.stringify({ entries: promptEntries, updatedAt: "2026-01-02T00:00:00Z" }, null, 2),
      "utf8",
    );

    const journalEntries = [
      {
        id: "journal-2",
        file: "prompt-exchanges/stepwise/journal-2/session.json",
        updatedAt: "2026-01-02T00:00:00Z",
        status: "active",
        steps: 2,
      },
      {
        id: "journal-1",
        file: "prompt-exchanges/stepwise/journal-1/session.json",
        updatedAt: "2026-01-01T00:00:00Z",
        status: "completed",
        steps: 1,
      },
    ];
    await fs.mkdir(path.join(stepwiseDir, "journal-1"), { recursive: true });
    await fs.mkdir(path.join(stepwiseDir, "journal-2"), { recursive: true });
    await fs.writeFile(
      path.join(stepwiseDir, "journal-1", "session.json"),
      JSON.stringify({ id: "journal-1" }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(stepwiseDir, "journal-2", "session.json"),
      JSON.stringify({ id: "journal-2" }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(stepwiseDir, "index.json"),
      JSON.stringify({ entries: journalEntries, updatedAt: "2026-01-02T00:00:00Z" }, null, 2),
      "utf8",
    );

    const result = runCli(
      [
        "cache-prune",
        "--retain-executions",
        "1",
        "--retain-prompt-exchanges",
        "1",
        "--retain-prompt-journals",
        "1",
        "--json",
        "--cwd",
        workspace,
      ],
      { cwd: workspace },
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, false);

    await fs.stat(path.join(executionsDir, "exec-3"));
    await assert.rejects(fs.stat(path.join(executionsDir, "exec-2")));
    await assert.rejects(fs.stat(path.join(executionsDir, "exec-1")));

    await fs.stat(path.join(promptDir, "prompt-2.json"));
    await assert.rejects(fs.stat(path.join(promptDir, "prompt-1.json")));

    await fs.stat(path.join(stepwiseDir, "journal-2"));
    await assert.rejects(fs.stat(path.join(stepwiseDir, "journal-1")));

    const updatedExecIndex = JSON.parse(
      await fs.readFile(path.join(indicesDir, "executions-index.json"), "utf8"),
    );
    assert.equal(updatedExecIndex.entries.length, 1);
  } finally {
    await removeTempWorkspace(workspace);
  }
});
