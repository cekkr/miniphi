import test from "node:test";
import assert from "node:assert/strict";
import ApiNavigator from "../src/libs/api-navigator.js";

const TIMEOUT_ERROR =
  "LM Studio REST request timed out waiting for a response after 12000ms (url: http://127.0.0.1:1234/api/v0/chat/completions).";

function parseNavigatorRequestMode(payload) {
  const userMessage = Array.isArray(payload?.messages)
    ? payload.messages.find((entry) => entry?.role === "user")
    : null;
  if (!userMessage || typeof userMessage.content !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(userMessage.content);
    const hasCompactWorkspace = parsed?.workspace?.stats === null;
    const hasCompactManifest = Array.isArray(parsed?.manifest) && parsed.manifest.length === 0;
    return hasCompactWorkspace && hasCompactManifest ? "compact" : "full";
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
    const mode = parseNavigatorRequestMode(payload);
    this.modes.push(mode);
    if (mode !== "compact") {
      throw new Error(TIMEOUT_ERROR);
    }
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              schema_version: "navigation-plan@v1",
              navigation_summary: "Compact retry succeeded.",
              needs_more_context: false,
              missing_snippets: [],
              recommended_paths: ["src/index.js"],
              file_types: ["js"],
              focus_commands: ["node -v"],
              actions: [],
              helper_script: null,
              notes: null,
              stop_reason: null,
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
    this.modes.push(parseNavigatorRequestMode(payload));
    throw new Error(TIMEOUT_ERROR);
  }
}

function buildNavigatorPayload() {
  return {
    objective: "Plan benchmark navigation",
    cwd: process.cwd(),
    executeHelper: false,
    workspace: {
      classification: { label: "Source-code heavy workspace", domain: "code" },
      summary: "Workspace summary",
      stats: { codeFiles: 12, directories: 4 },
      highlights: ["src/index.js", "README.md"],
      hintBlock: "File manifest:\n- src/index.js",
      manifestPreview: [
        { path: "src/index.js", bytes: 120 },
        { path: "README.md", bytes: 80 },
      ],
    },
    capabilities: {
      summary: "npm scripts and node available",
      details: { scripts: ["test", "lint"] },
    },
  };
}

test("ApiNavigator retries with compact payload after timeout and records attempt metadata", async () => {
  const restClient = new TimeoutThenCompactSuccessRestClient();
  const navigator = new ApiNavigator({
    restClient,
    navigationRequestTimeoutMs: 12000,
  });

  const hints = await navigator.generateNavigationHints(buildNavigatorPayload());
  assert.ok(hints);
  assert.equal(hints.summary, "Compact retry succeeded.");
  assert.equal(hints.requestMode, "compact");
  assert.equal(hints.attemptCount, 2);
  assert.deepEqual(restClient.modes, ["full", "compact"]);
  assert.equal(hints.attemptHistory[0]?.result, "retry-compact");
  assert.equal(hints.attemptHistory[1]?.result, "ok");
  assert.equal(hints.raw?.stop_reason ?? null, null);
});

test("ApiNavigator records compact retry attempts when both requests timeout", async () => {
  const restClient = new AlwaysTimeoutRestClient();
  const navigator = new ApiNavigator({
    restClient,
    navigationRequestTimeoutMs: 12000,
  });

  const hints = await navigator.generateNavigationHints(buildNavigatorPayload());
  assert.ok(hints);
  assert.equal(hints.requestMode, "compact");
  assert.equal(hints.attemptCount, 2);
  assert.deepEqual(restClient.modes, ["full", "compact"]);
  assert.equal(hints.attemptHistory[0]?.result, "retry-compact");
  assert.equal(hints.attemptHistory[1]?.result, "error");
  assert.equal(hints.raw?.stop_reason, "timeout");
  assert.match(hints.summary ?? "", /Navigator unavailable \(timeout\)/);
});
