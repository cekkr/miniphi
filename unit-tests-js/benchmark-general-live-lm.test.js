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
    assert.equal(summary.liveLm.assessmentStopReason, null);
    assert.equal(summary.liveLm.assessmentSchemaStatus, "ok");
    assert.ok(summary.liveLm.assessmentPromptExchangeId);
    assert.ok(summary.decompositionPlan);
    assert.ok(summary.decompositionPlan.promptExchangeId);
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
    assert.equal(summary.decompositionPlan.id, "prompt-plan-fallback");
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
