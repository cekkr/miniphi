import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";
import { runGeneralPurposeBenchmark } from "../src/libs/benchmark-general.js";

class FakeBenchmarkRestClient {
  constructor() {
    this.calls = [];
  }

  async createChatCompletion(payload) {
    this.calls.push(payload);
    const schemaName = payload?.response_format?.json_schema?.name ?? "";
    if (schemaName === "prompt-plan") {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                schema_version: "prompt-plan@v1",
                plan_id: "plan-live-benchmark",
                summary: "Plan benchmark actions",
                needs_more_context: false,
                missing_snippets: [],
                steps: [
                  {
                    id: "1",
                    title: "Inspect workspace",
                    description: "Check files and scripts",
                    requires_subprompt: false,
                    recommendation: null,
                    children: [],
                  },
                ],
                recommended_tools: ["node -v"],
                notes: null,
              }),
            },
          },
        ],
        tool_definitions: [],
      };
    }

    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              schema_version: "benchmark-general-assessment@v1",
              summary: "Good baseline readiness across categories.",
              needs_more_context: false,
              missing_snippets: [],
              category_scores: {
                function_calling_tool_use: { score: 70, rationale: "Structured JSON and tool prompts are present." },
                general_assistant_reasoning: { score: 72, rationale: "Reasoning loops are validated with schema checks." },
                coding_software_engineering: { score: 78, rationale: "File-centric flows and tests are covered." },
                computer_interaction_gui_web: { score: 63, rationale: "Web tooling exists but needs broader task depth." },
              },
              action_plan: [
                {
                  priority: "high",
                  category: "computer_interaction_gui_web",
                  recommendation: "Expand browser-agent regression tasks with policy checks.",
                },
              ],
              stop_reason: null,
              notes: null,
            }),
          },
        },
      ],
      tool_definitions: [],
    };
  }
}

function parseAssessmentRequestMode(payload) {
  const userMessage = Array.isArray(payload?.messages)
    ? payload.messages.find((entry) => entry?.role === "user")
    : null;
  if (!userMessage || typeof userMessage.content !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(userMessage.content);
    return parsed?.request_mode ?? null;
  } catch {
    return null;
  }
}

class FakeDecomposerTimeoutRestClient extends FakeBenchmarkRestClient {
  async createChatCompletion(payload) {
    const schemaName = payload?.response_format?.json_schema?.name ?? "";
    if (schemaName === "prompt-plan") {
      this.calls.push(payload);
      throw new Error("Prompt decomposition exceeded 12s timeout.");
    }
    return super.createChatCompletion(payload);
  }
}

class FakeAssessmentRetryRestClient extends FakeBenchmarkRestClient {
  constructor() {
    super();
    this.assessmentModes = [];
  }

  async createChatCompletion(payload) {
    const schemaName = payload?.response_format?.json_schema?.name ?? "";
    if (schemaName === "prompt-plan") {
      return super.createChatCompletion(payload);
    }
    this.calls.push(payload);
    const mode = parseAssessmentRequestMode(payload);
    this.assessmentModes.push(mode);
    if (mode === "full") {
      throw new Error(
        "LM Studio REST request timed out waiting for a response after 12000ms (url: http://127.0.0.1:1234/api/v0/chat/completions).",
      );
    }
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              schema_version: "benchmark-general-assessment@v1",
              summary: "Recovered with compact benchmark assessment request.",
              needs_more_context: false,
              missing_snippets: [],
              category_scores: {
                function_calling_tool_use: { score: 68, rationale: "Compact retry preserved tool coverage scoring." },
                general_assistant_reasoning: { score: 71, rationale: "Compact retry still yielded valid structured output." },
                coding_software_engineering: { score: 76, rationale: "Repo-grounded scoring remained consistent." },
                computer_interaction_gui_web: { score: 62, rationale: "Web/GUI category remains the main gap." },
              },
              action_plan: [
                {
                  priority: "high",
                  category: "computer_interaction_gui_web",
                  recommendation: "Keep compact retry and add browser-plan specific probes.",
                },
              ],
              stop_reason: null,
              notes: "compact-retry-success",
            }),
          },
        },
      ],
      tool_definitions: [],
    };
  }
}

class FakeDualTimeoutAssessmentOnlyRestClient extends FakeBenchmarkRestClient {
  constructor() {
    super();
    this.assessmentModes = [];
  }

  async createChatCompletion(payload) {
    const schemaName = payload?.response_format?.json_schema?.name ?? "";
    if (schemaName === "prompt-plan") {
      this.calls.push(payload);
      throw new Error(
        "Prompt decomposition exceeded 12s timeout.",
      );
    }

    this.calls.push(payload);
    const mode = parseAssessmentRequestMode(payload);
    this.assessmentModes.push(mode);
    if (mode !== "assessment-only") {
      throw new Error(`Expected assessment-only request mode, received ${mode ?? "null"}.`);
    }

    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              schema_version: "benchmark-general-assessment@v1",
              summary: "Recovered with assessment-only fallback after upstream timeout pressure.",
              needs_more_context: false,
              missing_snippets: [],
              category_scores: {
                function_calling_tool_use: { score: 62, rationale: "Assessment-only pass used minimal telemetry." },
                general_assistant_reasoning: { score: 66, rationale: "Fallback still produced schema-valid reasoning." },
                coding_software_engineering: { score: 70, rationale: "Coding readiness can still be approximated from compact inputs." },
                computer_interaction_gui_web: { score: 58, rationale: "GUI/web signals remain thin in fallback mode." },
              },
              action_plan: [
                {
                  priority: "high",
                  category: "computer_interaction_gui_web",
                  recommendation: "Re-run benchmark with larger live LM budget for full context.",
                },
              ],
              stop_reason: null,
              notes: "assessment-only-fallback",
            }),
          },
        },
      ],
      tool_definitions: [],
    };
  }
}

async function findMiniPhiRoot(startDir) {
  let current = path.resolve(startDir);
  const { root } = path.parse(current);
  while (true) {
    const candidate = path.join(current, ".miniphi");
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // ignore
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return path.join(startDir, ".miniphi");
}

async function readLatestGeneralBenchmarkSummary(workspace) {
  const miniPhiRoot = await findMiniPhiRoot(workspace);
  const historyDir = path.join(miniPhiRoot, "history", "benchmarks");
  const files = (await fs.readdir(historyDir))
    .filter((entry) => entry.endsWith("-general-benchmark.json"))
    .sort();
  assert.ok(files.length > 0, "No benchmark summary file produced.");
  const latest = files[files.length - 1];
  const content = await fs.readFile(path.join(historyDir, latest), "utf8");
  return JSON.parse(content);
}

test("runGeneralPurposeBenchmark records live LM assessment details when enabled", async () => {
  const workspace = await createTempWorkspace("miniphi-benchmark-live-");
  const previousCwd = process.cwd();
  try {
    process.chdir(workspace);
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "index.js"), "console.log('ok');\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# workspace\n", "utf8");
    const restClient = new FakeBenchmarkRestClient();

    await runGeneralPurposeBenchmark({
      options: {
        task: "Live benchmark test",
        cmd: "node -v",
        cwd: workspace,
        timeout: "20000",
        "silence-timeout": "5000",
      },
      verbose: false,
      schemaRegistry: null,
      restClient,
      liveLmEnabled: true,
      resourceMonitorForcedDisabled: true,
      generateWorkspaceSnapshot: async () => ({
        summary: "Test workspace",
        classification: { label: "codebase", domain: "software" },
        navigationSummary: null,
        helperScript: null,
      }),
      globalMemory: null,
      schemaAdapterRegistry: null,
      mirrorPromptTemplateToGlobal: async () => {},
      emitFeatureDisableNotice: () => {},
    });

    assert.ok(restClient.calls.length >= 2, "Expected decomposer + assessment LM calls.");
    const summary = await readLatestGeneralBenchmarkSummary(workspace);
    assert.equal(summary.liveLm.requested, true);
    assert.equal(summary.liveLm.active, true);
    assert.equal(summary.liveLm.decompositionStopReason, null);
    assert.equal(summary.liveLm.decompositionRequestMode, "full");
    assert.equal(summary.liveLm.decompositionAttemptCount, 1);
    assert.equal(summary.liveLm.navigationTimeoutMs, null);
    assert.equal(summary.liveLm.decompositionTimeoutMs, 12000);
    assert.equal(summary.liveLm.assessmentStopReason, null);
    assert.equal(summary.liveLm.assessmentSchemaStatus, "ok");
    assert.ok(summary.liveLm.assessmentPromptExchangeId);
    assert.equal(summary.liveLm.assessmentTimeoutMs, 12000);
    assert.ok(summary.liveLm.timeoutBudget);
    assert.ok(summary.liveLm.timeoutBudget.navigator.requestTimeoutMs <= 12000);
    assert.ok(summary.liveLm.timeoutBudget.navigator.requestTimeoutMs >= 11000);
    assert.ok(summary.liveLm.timeoutBudget.decomposer.requestTimeoutMs <= 12000);
    assert.ok(summary.liveLm.timeoutBudget.decomposer.requestTimeoutMs >= 11000);
    assert.ok(summary.liveLm.timeoutBudget.assessment.requestTimeoutMs <= 12000);
    assert.ok(summary.liveLm.timeoutBudget.assessment.requestTimeoutMs >= 11000);
    assert.ok(summary.decompositionPlan);
    assert.ok(summary.decompositionPlan.promptExchangeId);
    assert.equal(summary.decompositionPlan.requestMode, "full");
    assert.equal(summary.decompositionPlan.attemptCount, 1);
    assert.ok(summary.lmAssessment);
    assert.equal(summary.lmAssessment.schema_version, "benchmark-general-assessment@v1");
    assert.equal(summary.command.command, "node -v");
  } finally {
    process.chdir(previousCwd);
    await removeTempWorkspace(workspace);
  }
});

test("runGeneralPurposeBenchmark still runs assessment when only decomposition times out", async () => {
  const workspace = await createTempWorkspace("miniphi-benchmark-live-timeout-");
  const previousCwd = process.cwd();
  try {
    process.chdir(workspace);
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "index.js"), "console.log('ok');\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# workspace\n", "utf8");
    const restClient = new FakeDecomposerTimeoutRestClient();

    await runGeneralPurposeBenchmark({
      options: {
        task: "Live benchmark timeout resilience",
        cmd: "node -v",
        cwd: workspace,
        timeout: "20000",
        "silence-timeout": "5000",
      },
      verbose: false,
      schemaRegistry: null,
      restClient,
      liveLmEnabled: true,
      resourceMonitorForcedDisabled: true,
      generateWorkspaceSnapshot: async () => ({
        summary: "Test workspace",
        classification: { label: "codebase", domain: "software" },
        navigationSummary: null,
        helperScript: null,
      }),
      globalMemory: null,
      schemaAdapterRegistry: null,
      mirrorPromptTemplateToGlobal: async () => {},
      emitFeatureDisableNotice: () => {},
    });

    const summary = await readLatestGeneralBenchmarkSummary(workspace);
    assert.equal(summary.liveLm.requested, true);
    assert.equal(summary.liveLm.active, true);
    assert.equal(summary.liveLm.decompositionStopReason, "timeout");
    assert.equal(summary.liveLm.decompositionRequestMode, "compact");
    assert.equal(summary.liveLm.decompositionAttemptCount, 2);
    assert.equal(summary.liveLm.decompositionTimeoutMs, 12000);
    assert.equal(summary.decompositionPlan.id, "prompt-plan-fallback");
    assert.equal(summary.decompositionPlan.requestMode, "compact");
    assert.equal(summary.decompositionPlan.attemptCount, 2);
    assert.equal(summary.lmAssessment.stop_reason, null);
    assert.equal(summary.liveLm.assessmentStopReason, null);
    assert.equal(summary.liveLm.assessmentSchemaStatus, "ok");
    assert.ok(summary.liveLm.assessmentPromptExchangeId);
    assert.equal(summary.lmAssessment.schema_version, "benchmark-general-assessment@v1");
  } finally {
    process.chdir(previousCwd);
    await removeTempWorkspace(workspace);
  }
});

test("runGeneralPurposeBenchmark retries assessment in compact mode after timeout", async () => {
  const workspace = await createTempWorkspace("miniphi-benchmark-live-assessment-retry-");
  const previousCwd = process.cwd();
  try {
    process.chdir(workspace);
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "index.js"), "console.log('ok');\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# workspace\n", "utf8");
    const restClient = new FakeAssessmentRetryRestClient();

    await runGeneralPurposeBenchmark({
      options: {
        task: "Live benchmark compact retry",
        cmd: "node -v",
        cwd: workspace,
        timeout: "20000",
        "silence-timeout": "5000",
      },
      verbose: false,
      schemaRegistry: null,
      restClient,
      liveLmEnabled: true,
      resourceMonitorForcedDisabled: true,
      generateWorkspaceSnapshot: async () => ({
        summary: "Test workspace",
        classification: { label: "codebase", domain: "software" },
        navigationSummary: null,
        helperScript: null,
      }),
      globalMemory: null,
      schemaAdapterRegistry: null,
      mirrorPromptTemplateToGlobal: async () => {},
      emitFeatureDisableNotice: () => {},
    });

    const summary = await readLatestGeneralBenchmarkSummary(workspace);
    assert.deepEqual(restClient.assessmentModes, ["full", "compact"]);
    assert.equal(summary.liveLm.requested, true);
    assert.equal(summary.liveLm.active, true);
    assert.equal(summary.liveLm.decompositionStopReason, null);
    assert.equal(summary.liveLm.decompositionRequestMode, "full");
    assert.equal(summary.liveLm.decompositionAttemptCount, 1);
    assert.equal(summary.liveLm.assessmentStopReason, null);
    assert.equal(summary.liveLm.assessmentSchemaStatus, "ok");
    assert.equal(summary.liveLm.assessmentRequestMode, "compact");
    assert.equal(summary.liveLm.assessmentAttemptCount, 2);
    assert.equal(summary.liveLm.assessmentTimeoutMs, 12000);
    assert.equal(summary.lmAssessment.notes, "compact-retry-success");
  } finally {
    process.chdir(previousCwd);
    await removeTempWorkspace(workspace);
  }
});

test("runGeneralPurposeBenchmark runs assessment-only fallback when navigator and decomposer both timeout", async () => {
  const workspace = await createTempWorkspace("miniphi-benchmark-live-assessment-only-");
  const previousCwd = process.cwd();
  try {
    process.chdir(workspace);
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "index.js"), "console.log('ok');\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# workspace\n", "utf8");
    const restClient = new FakeDualTimeoutAssessmentOnlyRestClient();

    await runGeneralPurposeBenchmark({
      options: {
        task: "Live benchmark assessment-only fallback",
        cmd: "node -v",
        cwd: workspace,
        timeout: "20000",
        "silence-timeout": "5000",
      },
      verbose: false,
      schemaRegistry: null,
      restClient,
      liveLmEnabled: true,
      resourceMonitorForcedDisabled: true,
      generateWorkspaceSnapshot: async () => ({
        summary: "Test workspace",
        classification: { label: "codebase", domain: "software" },
        navigationSummary: "Navigator unavailable (timeout).",
        helperScript: null,
        navigationHints: {
          raw: { stop_reason: "timeout" },
          requestMode: "compact",
          attemptHistory: [
            { mode: "full", result: "retry-compact", stop_reason: "timeout", timeout_ms: 12000 },
            { mode: "compact", result: "fallback-plan", stop_reason: "timeout", timeout_ms: 12000 },
          ],
          resolvedTimeoutMs: 12000,
        },
      }),
      globalMemory: null,
      schemaAdapterRegistry: null,
      mirrorPromptTemplateToGlobal: async () => {},
      emitFeatureDisableNotice: () => {},
    });

    const summary = await readLatestGeneralBenchmarkSummary(workspace);
    assert.deepEqual(restClient.assessmentModes, ["assessment-only"]);
    assert.equal(summary.liveLm.navigationStopReason, "timeout");
    assert.equal(summary.liveLm.decompositionStopReason, "timeout");
    assert.equal(summary.liveLm.decompositionRequestMode, "compact");
    assert.equal(summary.liveLm.assessmentRequestMode, "assessment-only");
    assert.equal(summary.liveLm.assessmentFallbackMode, "assessment-only");
    assert.equal(summary.liveLm.assessmentAttemptCount, 1);
    assert.equal(summary.liveLm.assessmentSchemaStatus, "ok");
    assert.equal(summary.liveLm.assessmentStopReason, null);
    assert.equal(summary.lmAssessment.notes, "assessment-only-fallback");
  } finally {
    process.chdir(previousCwd);
    await removeTempWorkspace(workspace);
  }
});

test("runGeneralPurposeBenchmark adapts per-stage live LM timeout budgets with tight session deadline", async () => {
  const workspace = await createTempWorkspace("miniphi-benchmark-live-timeout-budget-");
  const previousCwd = process.cwd();
  try {
    process.chdir(workspace);
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "index.js"), "console.log('ok');\n", "utf8");
    await fs.writeFile(path.join(workspace, "README.md"), "# workspace\n", "utf8");
    const restClient = new FakeBenchmarkRestClient();

    await runGeneralPurposeBenchmark({
      options: {
        task: "Live benchmark adaptive timeout budget",
        cmd: "node -v",
        cwd: workspace,
        timeout: "20000",
        "silence-timeout": "5000",
      },
      verbose: false,
      schemaRegistry: null,
      restClient,
      liveLmEnabled: true,
      liveLmTimeoutMs: 12000,
      liveLmPlanTimeoutMs: 12000,
      sessionDeadline: Date.now() + 4500,
      resourceMonitorForcedDisabled: true,
      generateWorkspaceSnapshot: async () => ({
        summary: "Test workspace",
        classification: { label: "codebase", domain: "software" },
        navigationSummary: null,
        helperScript: null,
      }),
      globalMemory: null,
      schemaAdapterRegistry: null,
      mirrorPromptTemplateToGlobal: async () => {},
      emitFeatureDisableNotice: () => {},
    });

    const summary = await readLatestGeneralBenchmarkSummary(workspace);
    const timeoutBudget = summary.liveLm.timeoutBudget;
    assert.ok(timeoutBudget);
    assert.ok(timeoutBudget.configuredSessionDeadline);
    assert.ok(timeoutBudget.navigator.requestTimeoutMs < 12000);
    assert.ok(timeoutBudget.decomposer.requestTimeoutMs < 12000);
    assert.ok(timeoutBudget.assessment.requestTimeoutMs < 12000);
    assert.equal(summary.liveLm.navigationTimeoutMs, null);
    assert.ok(summary.liveLm.decompositionTimeoutMs <= timeoutBudget.decomposer.requestTimeoutMs);
    assert.ok(summary.liveLm.assessmentTimeoutMs <= timeoutBudget.assessment.requestTimeoutMs);
  } finally {
    process.chdir(previousCwd);
    await removeTempWorkspace(workspace);
  }
});
