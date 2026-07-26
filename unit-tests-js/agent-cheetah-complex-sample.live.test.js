import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import { CheetahContextEngine } from "../src/libs/cheetah-context-engine.js";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";

const execFileAsync = promisify(execFile);
const LIVE =
  process.env.MINIPHI_LMSTUDIO_INTEGRATION === "1" &&
  process.env.MINIPHI_CHEETAH_INTEGRATION === "1";
const BASE_URL = process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234";
const MODEL = process.env.MINIPHI_LIVE_MODEL ?? "qwen2.5-coder-7b-instruct";
const CHEETAH_HOST = process.env.MINIPHI_CHEETAH_HOST ?? "127.0.0.1";
const CHEETAH_PORT = Number(process.env.MINIPHI_CHEETAH_PORT ?? 4455);
const TIMEOUT_MS = 900000;
const SAMPLE_ROOT = fileURLToPath(
  new URL("../samples/get-started/code/", import.meta.url),
);
const TASK = [
  "Extend this existing Node.js get-started sample with a production-style --doctor workflow.",
  "Inspect the existing modules first.",
  "Add a pure buildDoctorReport(report) export in src/system-info.js that returns status",
  "(healthy when no tools are missing, degraded otherwise), totalTools, availableTools,",
  "and missingTools. Wire --doctor through parseArgs and main in src/index.js so it prints",
  "a [Doctor] heading followed by JSON. Add deterministic smoke coverage and document the",
  "new command in README.md. Preserve every existing command and finish only after validation passes.",
].join(" ");

async function runNode(cwd, args) {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectDoctorWorkflow({ cwd }) {
  const issues = [];
  const read = (relative) =>
    fs.readFile(path.join(cwd, relative), "utf8").catch(() => "");
  const [systemInfo, indexSource, smokeSource, readme] = await Promise.all([
    read("src/system-info.js"),
    read("src/index.js"),
    read("src/tests/smoke.js"),
    read("README.md"),
  ]);

  if (!/export\s+function\s+buildDoctorReport\b/.test(systemInfo)) {
    issues.push("Export a pure buildDoctorReport(report) function from src/system-info.js.");
  }
  if (!/\bdoctor\s*:/.test(indexSource) || !/--doctor/.test(indexSource)) {
    issues.push("Parse and handle the --doctor flag in src/index.js.");
  }
  if (!/buildDoctorReport|--doctor/.test(smokeSource)) {
    issues.push("Add deterministic doctor-report assertions to src/tests/smoke.js.");
  }
  if (!/--doctor/.test(readme)) {
    issues.push("Document the --doctor command in README.md.");
  }

  const smoke = await runNode(cwd, ["src/tests/smoke.js"]);
  if (!smoke.ok || !/Smoke tests passed\./.test(smoke.stdout)) {
    const detail =
      smoke.error ||
      smoke.stderr ||
      smoke.stdout ||
      "the command exited without printing the required \"Smoke tests passed.\" marker";
    issues.push(
      `Make the complete smoke test pass: ${detail}`.slice(
        0,
        800,
      ),
    );
  }

  const doctor = await runNode(cwd, ["src/index.js", "--doctor"]);
  if (!doctor.ok) {
    issues.push(`Make --doctor execute successfully: ${doctor.error ?? doctor.stderr}`.slice(0, 800));
  } else {
    const marker = doctor.stdout.indexOf("[Doctor]");
    if (marker < 0) {
      issues.push("Print a [Doctor] heading before the doctor JSON.");
    } else {
      const jsonStart = doctor.stdout.indexOf("{", marker);
      try {
        const report = JSON.parse(doctor.stdout.slice(jsonStart));
        if (!["healthy", "degraded"].includes(report.status)) {
          issues.push("Doctor JSON status must be healthy or degraded.");
        }
        if (!Number.isInteger(report.totalTools) || report.totalTools < 0) {
          issues.push("Doctor JSON totalTools must be a non-negative integer.");
        }
        if (!Number.isInteger(report.availableTools) || report.availableTools < 0) {
          issues.push("Doctor JSON availableTools must be a non-negative integer.");
        }
        if (!Array.isArray(report.missingTools)) {
          issues.push("Doctor JSON missingTools must be an array of tool names.");
        }
        if (
          Number.isInteger(report.totalTools) &&
          Number.isInteger(report.availableTools) &&
          Array.isArray(report.missingTools) &&
          report.availableTools + report.missingTools.length !== report.totalTools
        ) {
          issues.push("Doctor JSON tool counts must agree with missingTools.");
        }
      } catch {
        issues.push("Print one valid JSON object after the [Doctor] heading.");
      }
    }
  }

  return {
    valid: issues.length === 0,
    summary:
      issues.length === 0
        ? "The multi-file --doctor workflow and complete smoke test passed."
        : "The --doctor workflow is incomplete.",
    issues,
  };
}

async function createComplexWorkspace() {
  const outputRoot = process.env.MINIPHI_CHEETAH_COMPLEX_OUTPUT?.trim();
  if (!outputRoot) {
    return {
      workspace: await fs.mkdtemp(
        path.join(os.tmpdir(), "miniphi-cheetah-complex-"),
      ),
      persistent: false,
    };
  }
  const root = path.resolve(outputRoot);
  await fs.mkdir(root, { recursive: true });
  const workspace = path.join(
    root,
    `doctor-sample-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await fs.mkdir(workspace);
  return { workspace, persistent: true };
}

test(
  "live: Cheetah manages a complex multi-file MiniPhi sample without cross-project context",
  {
    skip: LIVE
      ? false
      : "set MINIPHI_LMSTUDIO_INTEGRATION=1 and MINIPHI_CHEETAH_INTEGRATION=1",
    timeout: TIMEOUT_MS,
  },
  async () => {
    const { workspace, persistent } = await createComplexWorkspace();
    const startedAt = performance.now();
    try {
      await fs.cp(SAMPLE_ROOT, workspace, { recursive: true });
      const client = new LMStudioRestClient({
        baseUrl: BASE_URL,
        defaultModel: MODEL,
        timeoutMs: 120000,
      });
      const sessionId = "get-started-doctor-complex";
      const contextEngine = new CheetahContextEngine({
        host: CHEETAH_HOST,
        port: CHEETAH_PORT,
        workspaceRoot: workspace,
        sessionId,
        required: true,
        timeoutMs: 5000,
        recallLimit: 48,
        recallHops: 3,
      });
      const actions = [];
      const contextEvents = [];
      const turnEvents = [];
      const validationEvents = [];
      const session = new AgentSession({
        client,
        cwd: workspace,
        baseDir: path.join(workspace, ".miniphi"),
        sessionId,
        model: MODEL,
        contextEngine,
        contextBudgetTokens: 3600,
        maxTurns: 14,
        maxActionsPerTurn: 4,
        approver: createHeadlessApprover({ policy: "allow" }),
        validateWorkspace: inspectDoctorWorkflow,
        sessionDeadline: Date.now() + TIMEOUT_MS - 30000,
      });
      session.on("action-result", (event) => actions.push(event));
      session.on("context-engine", (event) => contextEvents.push(event));
      session.on("status", (event) => turnEvents.push(event));
      session.on("validation", (event) => validationEvents.push(event));

      const result = await session.submitTask(TASK, [
        "src/system-info.js",
        "src/index.js",
        "src/tests/smoke.js",
        "README.md",
      ]);
      const elapsedMs = Math.round(performance.now() - startedAt);
      const finalValidation = await inspectDoctorWorkflow({ cwd: workspace });
      const writtenPaths = [
        ...new Set(
          result.edits
            .filter((entry) => entry.status === "written")
            .map((entry) => entry.action?.path)
            .filter(Boolean),
        ),
      ];
      const metrics = {
        endpoint: BASE_URL,
        model: MODEL,
        elapsedMs,
        turns: result.turns,
        actionCount: actions.length,
        actions: actions.map((entry) => ({
          turn: entry.turn,
          type: entry.action?.type ?? null,
          path: entry.action?.path ?? null,
          status: entry.status,
          error: entry.error ?? null,
        })),
        readonlyActions: actions.filter(
          (entry) =>
            entry.action?.type === "read_file" ||
            entry.action?.type === "list_dir" ||
            entry.action?.type === "search_text",
        ).length,
        writtenFiles: writtenPaths,
        validationRuns: validationEvents.length,
        validation: finalValidation,
        context: {
          database: result.context.engine.database,
          projectReference: result.context.engine.projectReference,
          sessionReference: result.context.engine.sessionReference,
          selections: result.context.engine.selections,
          queries: result.context.engine.queries,
          nodesMirrored: result.context.engine.nodesMirrored,
          nodesDeleted: result.context.engine.nodesDeleted,
          edgesMirrored: result.context.engine.edgesMirrored,
          recalledNodes: result.context.engine.recalledNodes,
          fallbacks: result.context.engine.sessionFallbacks,
          successfulPromptSelections: contextEvents.filter((entry) => entry.ok).length,
        },
        stopReason: result.stopReason,
      };
      console.log(`[cheetah-complex-live] ${JSON.stringify(metrics, null, 2)}`);

      assert.equal(result.status, "completed", `agent stopped with ${result.stopReason}`);
      assert.equal(finalValidation.valid, true, finalValidation.issues.join("; "));
      assert.ok(writtenPaths.length >= 4, "the workflow must edit at least four project files");
      assert.ok(result.turns >= 2, "the workload must exercise multiple prompt layers");
      assert.equal(result.context.engine.engine, "cheetah");
      assert.equal(result.context.engine.available, true);
      assert.equal(result.context.engine.sessionFallbacks, 0);
      assert.match(result.context.engine.projectReference, /^p_[a-f0-9]{20}$/);
      assert.match(
        result.context.engine.database,
        new RegExp(`${result.context.engine.projectReference}$`),
      );
      assert.ok(result.context.engine.queries >= 2);
      assert.ok(result.context.engine.recalledNodes >= 2);
      assert.ok(
        contextEvents.every(
          (entry) =>
            !entry.preferredNodeIds ||
            entry.preferredNodeIds.every((nodeId) => session.context.nodes.has(nodeId)),
        ),
        "all recalled local ids must pass the project/session namespace filter",
      );
    } finally {
      if (persistent) {
        console.log(`[cheetah-complex-live] preserved workspace: ${workspace}`);
      } else {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    }
  },
);
