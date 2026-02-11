import test from "node:test";
import assert from "node:assert/strict";
import PromptDecomposer from "../src/libs/prompt-decomposer.js";

function buildResumePlan() {
  return {
    plan: {
      plan_id: "plan-resume-1",
      summary: "Resume nested plan",
      schema_version: "prompt-plan@v1",
      needs_more_context: false,
      missing_snippets: [],
      steps: [
        {
          id: "1",
          title: "Prepare",
          description: "Gather workspace context.",
          requires_subprompt: false,
          recommendation: null,
          children: [
            {
              id: "1.1",
              title: "Scope",
              description: "Define scope.",
              requires_subprompt: false,
              recommendation: null,
              children: [],
            },
            {
              id: "1.2",
              title: "Branch decomposition",
              description: "Split into nested branches.",
              requires_subprompt: true,
              recommendation: "prompt-decomposer",
              children: [],
            },
          ],
        },
        {
          id: "2",
          title: "Execute",
          description: "Run analysis.",
          requires_subprompt: false,
          recommendation: null,
          children: [],
        },
      ],
      recommended_tools: ["node src/index.js workspace"],
      notes: null,
    },
  };
}

function buildResponsePlan() {
  return {
    schema_version: "prompt-plan@v1",
    plan_id: "plan-new-1",
    summary: "Nested plan ready.",
    needs_more_context: false,
    missing_snippets: [],
    steps: [
      {
        id: "1",
        title: "Context",
        description: "Collect context",
        requires_subprompt: false,
        recommendation: null,
        children: [
          {
            id: "1.2",
            title: "Deep focus",
            description: "Focus this branch",
            requires_subprompt: true,
            recommendation: "helper",
            children: [
              {
                id: "1.2.1",
                title: "Leaf",
                description: "Analyze leaf",
                requires_subprompt: false,
                recommendation: null,
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: "2",
        title: "Finalize",
        description: "Summarize",
        requires_subprompt: false,
        recommendation: null,
        children: [],
      },
    ],
    recommended_tools: ["npm test"],
    notes: null,
  };
}

test("PromptDecomposer request body includes nested focus hints", () => {
  const decomposer = new PromptDecomposer({
    restClient: {
      createChatCompletion: async () => {
        throw new Error("not used");
      },
    },
  });

  const payload = {
    objective: "Refactor nested prompt routing",
    command: "npm test",
    planBranch: "1.2",
    resumePlan: buildResumePlan(),
    workspace: {
      summary: "Workspace summary",
      hintBlock: "Hint block",
      planDirectives: "Keep JSON strict",
      classification: { domain: "code", label: "Code" },
    },
  };

  const body = decomposer._buildRequestBody(payload, { compact: false });

  assert.equal(body.expectations.nested_subprompts, true);
  assert.equal(body.expectations.focusBranch, "1.2");
  assert.equal(body.focus.branch, "1.2");
  assert.equal(body.focus.reason, "requested-branch");
  assert.equal(body.focus.matched_requested_branch, true);
  assert.equal(body.resume.focus_branch, "1.2");
  assert.ok(Array.isArray(body.focus.steps));
  assert.ok(body.focus.steps.some((step) => step.id === "1.2"));
});

test("PromptDecomposer parse result exposes focused branch metadata", () => {
  const decomposer = new PromptDecomposer({
    restClient: {
      createChatCompletion: async () => {
        throw new Error("not used");
      },
    },
  });

  const responseText = JSON.stringify(buildResponsePlan());
  const parsed = decomposer._parsePlan(responseText, {
    objective: "Analyze focused branch",
    planBranch: "1.2",
  });

  assert.equal(parsed.branch, "1.2");
  assert.equal(parsed.focusBranch, "1.2");
  assert.equal(parsed.focusMatchedRequestedBranch, true);
  assert.equal(parsed.focusReason, "requested-branch");
  assert.deepEqual(
    parsed.focusSegments.map((segment) => segment.id),
    ["1", "1.2", "1.2.1"],
  );
  assert.ok(typeof parsed.focusSegmentBlock === "string" && parsed.focusSegmentBlock.length > 0);
});

test("PromptDecomposer parse auto-focuses subprompt branch when planBranch is omitted", () => {
  const decomposer = new PromptDecomposer({
    restClient: {
      createChatCompletion: async () => {
        throw new Error("not used");
      },
    },
  });

  const responseText = JSON.stringify(buildResponsePlan());
  const parsed = decomposer._parsePlan(responseText, {
    objective: "Analyze default focus branch",
  });

  assert.equal(parsed.branch, null);
  assert.equal(parsed.focusBranch, "1.2");
  assert.equal(parsed.focusReason, "auto-subprompt-branch");
  assert.equal(parsed.focusMatchedRequestedBranch, false);
  assert.equal(parsed.nextSubpromptBranch, null);
  assert.deepEqual(parsed.availableSubpromptBranches, ["1.2"]);
});
