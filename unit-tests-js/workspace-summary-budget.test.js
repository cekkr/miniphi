import test from "node:test";
import assert from "node:assert/strict";
import EfficientLogAnalyzer from "../src/libs/efficient-log-analyzer.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

class FakeCli {
  async executeCommand() {
    return { code: 0 };
  }
}

class FakePhi {
  constructor(responseText) {
    this.responseText = responseText;
    this.prompts = [];
  }

  setPromptTimeout(_timeoutMs) {}

  setNoTokenTimeout(_timeoutMs) {}

  async getContextWindow() {
    return 131072;
  }

  async chatStream(prompt, onToken) {
    this.prompts.push(prompt);
    if (onToken) {
      onToken(this.responseText);
    }
  }
}

class FakeSummarizer {}

function buildResponseJson() {
  return JSON.stringify({
    task: "Summarize workspace",
    root_cause: null,
    summary: "Workspace summary completed.",
    summary_updates: [],
    evidence: [],
    recommended_fixes: [],
    next_steps: [],
    needs_more_context: false,
    missing_snippets: [],
    truncation_strategy: null,
  });
}

test("analyzeDatasetLines enforces prompt budget cap for workspace-summary scope", async () => {
  const phi = new FakePhi(buildResponseJson());
  const analyzer = new EfficientLogAnalyzer(phi, new FakeCli(), new FakeSummarizer(), {
    schemaRegistry: new PromptSchemaRegistry(),
    schemaId: "log-analysis",
  });

  const lines = Array.from(
    { length: 260 },
    (_entry, index) => `workspace-line-${index} ${"data ".repeat(18)}`.trim(),
  );
  const workspaceContext = {
    summary: `Summary ${"S ".repeat(900)}`,
    classification: { domain: "code", label: "Source-code heavy workspace" },
    hintBlock: `Hint ${"H ".repeat(800)}`,
    planDirectives: "Audit optimization hotspots across the runtime pipeline.",
    manifestPreview: Array.from({ length: 24 }, (_entry, index) => ({
      path: `src/file-${index}.js`,
      bytes: 900 + index,
    })),
    readmeSnippet: `README ${"R ".repeat(700)}`,
    capabilitySummary: `Capabilities ${"C ".repeat(700)}`,
    navigationBlock: `Navigation ${"N ".repeat(700)}`,
    commandLibraryBlock: `Library ${"L ".repeat(800)}`,
    promptTemplateBlock: `Templates ${"T ".repeat(800)}`,
  };

  const result = await analyzer.analyzeDatasetLines(lines, "Summarize workspace", {
    streamOutput: false,
    workspaceContext,
    promptContext: {
      schemaId: "log-analysis",
      scope: "workspace-summary",
    },
    promptBudgetCapTokens: 2200,
    contextBudgetRatio: 0.18,
  });

  assert.equal(phi.prompts.length, 1);
  const prompt = phi.prompts[0];
  const estimatedTokens = Math.max(1, Math.ceil(prompt.length / 3));
  assert.ok(
    estimatedTokens <= 2200,
    `Expected workspace summary prompt to stay <=2200 tokens, got ${estimatedTokens}.`,
  );
  assert.equal(result.schemaValid, true);
});
