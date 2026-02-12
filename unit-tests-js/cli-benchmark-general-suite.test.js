import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTempWorkspace,
  removeTempWorkspace,
  runCli,
} from "./cli-test-utils.js";

const SUITE_PATH = path.resolve("dev_samples", "test_tasks", "general-purpose-suite.json");

async function seedWorkspace(workspace) {
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "# Benchmark Workspace\n", "utf8");
  await fs.writeFile(path.join(workspace, "src", "index.js"), "export const ready = true;\n", "utf8");
  await fs.writeFile(
    path.join(workspace, "docs", "notes.md"),
    "This workspace is used by benchmark-general suite tests.\n",
    "utf8",
  );
}

test(
  "CLI benchmark general executes cloned benchmark suite tasks without LM Studio",
  { timeout: 4 * 60 * 1000 },
  async () => {
    const workspace = await createTempWorkspace("miniphi-cli-benchmark-suite-");
    try {
      await seedWorkspace(workspace);
      const suite = JSON.parse(await fs.readFile(SUITE_PATH, "utf8"));
      const historyDir = path.join(workspace, ".miniphi", "history", "benchmarks");
      const env = {
        HOME: workspace,
        USERPROFILE: workspace,
      };

      for (const task of suite.tasks) {
        const result = runCli(
          [
            "benchmark",
            "general",
            "--cwd",
            workspace,
            "--task",
            task.task,
            "--cmd",
            task.command,
            "--timeout",
            "20000",
            "--silence-timeout",
            "5000",
          ],
          { cwd: workspace, env, maxBuffer: 20 * 1024 * 1024 },
        );
        assert.equal(result.code, 0, result.stderr);
      }

      const summaryFiles = (await fs.readdir(historyDir))
        .filter((name) => name.endsWith("-general-benchmark.json"))
        .sort();
      assert.equal(summaryFiles.length, suite.tasks.length);

      const executedTasks = new Set();
      for (const fileName of summaryFiles) {
        const summaryPath = path.join(historyDir, fileName);
        const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
        assert.equal(summary.kind, "general-purpose");
        assert.ok(typeof summary.task === "string" && summary.task.trim().length > 0);
        assert.ok(Array.isArray(summary.templates) && summary.templates.length >= 2);
        assert.ok(summary.command && typeof summary.command === "object");
        assert.equal(summary.command.command, "node -v");
        assert.equal(summary.command.exitCode, 0);
        executedTasks.add(summary.task);
      }

      for (const task of suite.tasks) {
        assert.ok(executedTasks.has(task.task), `Missing summary entry for task ${task.id}`);
      }
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);
