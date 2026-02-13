import test from "node:test";
import assert from "node:assert/strict";
import PromptDecomposer from "../src/libs/prompt-decomposer.js";

const TIMEOUT_ERROR = "Prompt decomposition exceeded 12s timeout.";

function parseDecomposerMode(payload) {
  const userMessage = Array.isArray(payload?.messages)
    ? payload.messages.find((entry) => entry?.role === "user")
    : null;
  if (!userMessage || typeof userMessage.content !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(userMessage.content);
    const compactManifest =
      Array.isArray(parsed?.workspace?.manifestSample) && parsed.workspace.manifestSample.length === 0;
    return compactManifest ? "compact" : "full";
  } catch {
    return null;
  }
}

class TimeoutThenCompactSuccessRestClient {
  constructor() {
    this.calls = [];
    this.modes = [];
  }

  async createChatCompletion(payload) {
    this.calls.push(payload);
    const mode = parseDecomposerMode(payload);
    this.modes.push(mode);
    if (mode !== "compact") {
      throw new Error(TIMEOUT_ERROR);
    }
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              schema_version: "prompt-plan@v1",
              plan_id: "plan-compact-retry",
              summary: "Recovered with compact decomposition request.",
              needs_more_context: false,
              missing_snippets: [],
              steps: [
                {
                  id: "1",
                  title: "Inspect workspace",
                  description: "Check key files first.",
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
}

class AlwaysTimeoutRestClient {
  constructor() {
    this.calls = [];
    this.modes = [];
  }

  async createChatCompletion(payload) {
    this.calls.push(payload);
    this.modes.push(parseDecomposerMode(payload));
    throw new Error(TIMEOUT_ERROR);
  }
}

function buildDecomposePayload() {
  return {
    objective: "Plan benchmark actions",
    command: "node -v",
    workspace: {
      classification: { label: "Source-code heavy workspace", domain: "code" },
      summary: "Workspace summary",
      hintBlock: "File manifest:\n- src/index.js",
      planDirectives: "Prefer deterministic JSON actions",
      manifestPreview: [
        { path: "src/index.js", bytes: 120 },
        { path: "README.md", bytes: 80 },
      ],
      stats: { files: 12, directories: 4, codeFiles: 8 },
      capabilitySummary: "npm scripts available",
      navigationSummary: null,
    },
  };
}

test("PromptDecomposer retries full -> compact after timeout and returns compact plan", async () => {
  const restClient = new TimeoutThenCompactSuccessRestClient();
  const decomposer = new PromptDecomposer({
    restClient,
    timeoutMs: 12000,
    maxAttempts: 2,
  });

  const plan = await decomposer.decompose(buildDecomposePayload());
  assert.ok(plan);
  assert.equal(plan.planId, "plan-compact-retry");
  assert.equal(plan.requestMode, "compact");
  assert.equal(plan.attemptHistory.length, 2);
  assert.equal(plan.attemptHistory[0]?.result, "retry-compact");
  assert.equal(plan.attemptHistory[1]?.result, "ok");
  assert.deepEqual(restClient.modes, ["full", "compact"]);
  assert.equal(plan.stopReason, null);
});

test("PromptDecomposer records compact retry attempts when both requests timeout", async () => {
  const restClient = new AlwaysTimeoutRestClient();
  const decomposer = new PromptDecomposer({
    restClient,
    timeoutMs: 12000,
    maxAttempts: 2,
  });

  const plan = await decomposer.decompose(buildDecomposePayload());
  assert.ok(plan);
  assert.equal(plan.planId, "prompt-plan-fallback");
  assert.equal(plan.requestMode, "compact");
  assert.equal(plan.attemptHistory.length, 2);
  assert.equal(plan.attemptHistory[0]?.result, "retry-compact");
  assert.equal(plan.attemptHistory[1]?.result, "error");
  assert.deepEqual(restClient.modes, ["full", "compact"]);
  assert.equal(plan.stopReason, "timeout");
});
