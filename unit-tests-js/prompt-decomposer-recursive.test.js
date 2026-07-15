import test from "node:test";
import assert from "node:assert/strict";
import PromptDecomposer from "../src/libs/prompt-decomposer.js";

const TIMEOUT_ERROR = "Prompt decomposition exceeded 12s timeout.";

function parseUserBody(payload) {
  const userMessage = Array.isArray(payload?.messages)
    ? payload.messages.find((entry) => entry?.role === "user")
    : null;
  if (!userMessage || typeof userMessage.content !== "string") {
    return null;
  }
  try {
    return JSON.parse(userMessage.content);
  } catch {
    return null;
  }
}

function systemPromptOf(payload) {
  const systemMessage = Array.isArray(payload?.messages)
    ? payload.messages.find((entry) => entry?.role === "system")
    : null;
  return systemMessage?.content ?? "";
}

function planResponse(plan) {
  return {
    choices: [{ message: { content: JSON.stringify(plan) } }],
    tool_definitions: [],
  };
}

function shallowPlan({ subpromptSteps = ["1"], planId = "plan-shallow" } = {}) {
  return {
    schema_version: "prompt-plan@v1",
    plan_id: planId,
    summary: "Top-level strategy.",
    needs_more_context: false,
    missing_snippets: [],
    steps: [
      {
        id: "1",
        title: "Refactor parser",
        description: "Split the parser into tokenizer and AST builder.",
        requires_subprompt: subpromptSteps.includes("1"),
        recommendation: null,
        children: [],
      },
      {
        id: "2",
        title: "Run tests",
        description: "Execute npm test and record failures.",
        requires_subprompt: subpromptSteps.includes("2"),
        recommendation: "npm test",
        children: [],
      },
      {
        id: "3",
        title: "Update docs",
        description: "Document the new parser layout.",
        requires_subprompt: subpromptSteps.includes("3"),
        recommendation: null,
        children: [],
      },
    ],
    recommended_tools: ["npm test"],
    notes: null,
  };
}

function branchPlan({ planId = "plan-branch", withGrandchildSubprompt = false } = {}) {
  return {
    schema_version: "prompt-plan@v1",
    plan_id: planId,
    summary: "Branch expansion.",
    needs_more_context: false,
    missing_snippets: [],
    steps: [
      {
        id: "a",
        title: "Extract tokenizer",
        description: "Move token logic into tokenizer.js.",
        requires_subprompt: withGrandchildSubprompt,
        recommendation: null,
        children: [],
      },
      {
        id: "b",
        title: "Build AST module",
        description: "Create ast-builder.js consuming tokens.",
        requires_subprompt: false,
        recommendation: null,
        children: [],
      },
    ],
    recommended_tools: [],
    notes: null,
  };
}

/**
 * Stub REST client that answers the main decomposition with a shallow plan and
 * branch-expansion requests with per-branch canned responses.
 */
class RecursivePlanRestClient {
  constructor({ mainPlan, branchResponses = {}, branchErrors = {} } = {}) {
    this.mainPlan = mainPlan ?? shallowPlan();
    this.branchResponses = branchResponses;
    this.branchErrors = branchErrors;
    this.calls = [];
    this.branchCalls = [];
  }

  async createChatCompletion(payload) {
    this.calls.push(payload);
    const body = parseUserBody(payload);
    const branch = body?.parent?.branch ?? null;
    if (!branch) {
      return planResponse(this.mainPlan);
    }
    this.branchCalls.push({ branch, body, systemPrompt: systemPromptOf(payload) });
    if (this.branchErrors[branch]) {
      throw new Error(this.branchErrors[branch]);
    }
    const response = this.branchResponses[branch];
    if (typeof response === "string") {
      return { choices: [{ message: { content: response } }], tool_definitions: [] };
    }
    return planResponse(response ?? branchPlan());
  }
}

function buildPayload(overrides = undefined) {
  return {
    objective: "Refactor the parser module and fix failing tests",
    command: null,
    workspace: {
      classification: { label: "Source-code heavy workspace", domain: "code" },
      summary: "Node.js parser project",
      hintBlock: "File manifest:\n- src/parser.js",
      manifestPreview: [{ path: "src/parser.js", bytes: 2048 }],
      stats: { files: 6, directories: 2, codeFiles: 5 },
    },
    ...overrides,
  };
}

test("decompose expands requires_subprompt branches into renumbered child steps", async () => {
  const restClient = new RecursivePlanRestClient({
    mainPlan: shallowPlan({ subpromptSteps: ["1"] }),
    branchResponses: { 1: branchPlan() },
  });
  const decomposer = new PromptDecomposer({ restClient, timeoutMs: 12000 });

  const plan = await decomposer.decompose(buildPayload());
  assert.ok(plan);
  assert.equal(plan.planId, "plan-shallow");

  // Main request must ask for a shallow plan; branch request must carry parent context.
  assert.match(systemPromptOf(restClient.calls[0]), /SHALLOW plan/);
  assert.equal(restClient.branchCalls.length, 1);
  const branchCall = restClient.branchCalls[0];
  assert.equal(branchCall.branch, "1");
  assert.match(branchCall.systemPrompt, /expanding ONE branch/);
  assert.equal(branchCall.body.parent.plan_id, "plan-shallow");
  assert.equal(branchCall.body.expectations.branch_expansion, true);

  // Children merged and renumbered depth-first under the parent branch.
  const first = plan.plan.steps[0];
  assert.equal(first.children.length, 2);
  assert.deepEqual(
    first.children.map((child) => child.id),
    ["1.1", "1.2"],
  );
  assert.equal(first.children[0].title, "Extract tokenizer");

  // Derived fields must reflect the expanded tree.
  assert.match(plan.outline, /1\.1\. Extract tokenizer/);
  assert.ok(plan.segments.some((segment) => segment.id === "1.1"));

  assert.equal(plan.branchExpansions.length, 1);
  assert.equal(plan.branchExpansions[0].status, "expanded");
  assert.equal(plan.branchExpansions[0].childCount, 2);
});

test("decompose respects maxDepth when branch children request further subprompts", async () => {
  const restClient = new RecursivePlanRestClient({
    mainPlan: shallowPlan({ subpromptSteps: ["1"] }),
    branchResponses: { 1: branchPlan({ withGrandchildSubprompt: true }) },
  });
  const decomposer = new PromptDecomposer({ restClient, timeoutMs: 12000, maxDepth: 2 });

  const plan = await decomposer.decompose(buildPayload());
  assert.ok(plan);
  const statuses = plan.branchExpansions.map((entry) => entry.status);
  assert.deepEqual(statuses, ["expanded", "skipped-depth"]);
  const skipped = plan.branchExpansions.find((entry) => entry.status === "skipped-depth");
  assert.equal(skipped.branch, "1.1");
});

test("decompose stops expanding once the expansion budget is spent", async () => {
  const restClient = new RecursivePlanRestClient({
    mainPlan: shallowPlan({ subpromptSteps: ["1", "3"] }),
    branchResponses: { 1: branchPlan() },
  });
  const decomposer = new PromptDecomposer({ restClient, timeoutMs: 12000, maxExpansions: 1 });

  const plan = await decomposer.decompose(buildPayload());
  assert.ok(plan);
  const byBranch = Object.fromEntries(
    plan.branchExpansions.map((entry) => [entry.branch, entry.status]),
  );
  assert.equal(byBranch["1"], "expanded");
  assert.equal(byBranch["3"], "skipped-budget");
  assert.equal(restClient.branchCalls.length, 1);
});

test("invalid branch JSON fails only that branch and expansion continues", async () => {
  const restClient = new RecursivePlanRestClient({
    mainPlan: shallowPlan({ subpromptSteps: ["1", "3"] }),
    branchResponses: {
      1: "I think the plan should be: first refactor, then test.",
      3: branchPlan({ planId: "plan-branch-3" }),
    },
  });
  const decomposer = new PromptDecomposer({ restClient, timeoutMs: 12000 });

  const plan = await decomposer.decompose(buildPayload());
  assert.ok(plan);
  const byBranch = Object.fromEntries(
    plan.branchExpansions.map((entry) => [entry.branch, entry.status]),
  );
  assert.equal(byBranch["1"], "failed");
  assert.equal(byBranch["3"], "expanded");
  assert.equal(plan.plan.steps[0].children.length, 0);
  assert.deepEqual(
    plan.plan.steps[2].children.map((child) => child.id),
    ["3.1", "3.2"],
  );
});

test("a branch transport timeout halts further expansion", async () => {
  const restClient = new RecursivePlanRestClient({
    mainPlan: shallowPlan({ subpromptSteps: ["1", "3"] }),
    branchErrors: { 1: TIMEOUT_ERROR },
  });
  const decomposer = new PromptDecomposer({ restClient, timeoutMs: 12000 });

  const plan = await decomposer.decompose(buildPayload());
  assert.ok(plan);
  assert.equal(plan.branchExpansions.length, 1);
  assert.equal(plan.branchExpansions[0].status, "failed");
  assert.equal(restClient.branchCalls.length, 1, "branch 3 must not be attempted");
});

test("expandSubprompts:false keeps decompose to a single completion call", async () => {
  const restClient = new RecursivePlanRestClient({
    mainPlan: shallowPlan({ subpromptSteps: ["1"] }),
  });
  const decomposer = new PromptDecomposer({
    restClient,
    timeoutMs: 12000,
    expandSubprompts: false,
  });

  const plan = await decomposer.decompose(buildPayload());
  assert.ok(plan);
  assert.equal(restClient.calls.length, 1);
  assert.equal(plan.branchExpansions ?? null, null);
  assert.doesNotMatch(systemPromptOf(restClient.calls[0]), /SHALLOW plan/);
});

test("an exhausted session budget skips expansion with skipped-session telemetry", async () => {
  const restClient = new RecursivePlanRestClient({
    mainPlan: shallowPlan({ subpromptSteps: ["1"] }),
  });
  const decomposer = new PromptDecomposer({ restClient, timeoutMs: 12000 });

  const plan = await decomposer.decompose(
    buildPayload({ sessionDeadline: Date.now() + 1200 }),
  );
  assert.ok(plan);
  assert.equal(restClient.branchCalls.length, 0);
  assert.equal(plan.branchExpansions.length, 1);
  assert.equal(plan.branchExpansions[0].status, "skipped-session");
});
