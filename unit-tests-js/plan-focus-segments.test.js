import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRequestedPlanBranchFocus,
  buildFocusedPlanSegments,
} from "../src/libs/core-utils.js";

function buildPlan() {
  return {
    steps: [
      {
        id: "1",
        title: "Collect context",
        description: "Gather constraints and objective.",
        requires_subprompt: false,
        recommendation: null,
        children: [
          {
            id: "1.1",
            title: "List assumptions",
            description: "Enumerate assumptions.",
            requires_subprompt: false,
            recommendation: null,
            children: [],
          },
          {
            id: "1.2",
            title: "Plan decomposition",
            description: "Define nested sub-prompts.",
            requires_subprompt: true,
            recommendation: "prompt-decomposer",
            children: [
              {
                id: "1.2.1",
                title: "Select branch",
                description: "Pick focus branch.",
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
        title: "Execute",
        description: "Run primary analysis.",
        requires_subprompt: false,
        recommendation: null,
        children: [],
      },
      {
        id: "3",
        title: "Review",
        description: "Critique and revise.",
        requires_subprompt: true,
        recommendation: "critic-model",
        children: [],
      },
    ],
  };
}

test("buildFocusedPlanSegments honors requested branch and includes lineage", () => {
  const focus = buildFocusedPlanSegments(buildPlan(), {
    branch: "1.2",
    limit: 8,
  });

  assert.equal(focus.branch, "1.2");
  assert.equal(focus.matchedRequestedBranch, true);
  assert.equal(focus.reason, "requested-branch");
  assert.deepEqual(
    focus.segments.map((segment) => segment.id),
    ["1", "1.2", "1.2.1"],
  );
  assert.equal(focus.nextSubpromptBranch, "3");
  assert.ok(typeof focus.block === "string" && focus.block.includes("1.2. Plan decomposition"));
});

test("buildFocusedPlanSegments falls back to nearest parent branch when requested branch is missing", () => {
  const focus = buildFocusedPlanSegments(buildPlan(), {
    branch: "1.2.9",
    limit: 8,
  });

  assert.equal(focus.branch, "1.2");
  assert.equal(focus.matchedRequestedBranch, false);
  assert.equal(focus.reason, "requested-parent-branch");
  assert.deepEqual(
    focus.segments.map((segment) => segment.id),
    ["1", "1.2", "1.2.1"],
  );
});

test("buildFocusedPlanSegments auto-selects first subprompt branch when none is requested", () => {
  const focus = buildFocusedPlanSegments(buildPlan(), {
    limit: 8,
  });

  assert.equal(focus.branch, "1.2");
  assert.equal(focus.reason, "auto-subprompt-branch");
  assert.deepEqual(focus.availableSubpromptBranches, ["1.2", "3"]);
});

test("applyRequestedPlanBranchFocus overrides persisted focus state on branch resume", () => {
  const planResult = {
    branch: "1",
    focusBranch: "1",
    focusReason: "requested-branch",
    focusMatchedRequestedBranch: true,
    focusSegments: [{ id: "1" }],
    focusSegmentBlock: "- 1. root",
    nextSubpromptBranch: "1.2",
    availableSubpromptBranches: ["1.2", "3"],
  };
  applyRequestedPlanBranchFocus(planResult, "1.3");
  assert.equal(planResult.branch, "1.3");
  assert.equal(planResult.focusBranch, "1.3");
  assert.equal(planResult.focusReason, null);
  assert.equal(planResult.focusMatchedRequestedBranch, false);
  assert.equal(planResult.focusSegments, null);
  assert.equal(planResult.focusSegmentBlock, null);
  assert.equal(planResult.nextSubpromptBranch, null);
  assert.equal(planResult.availableSubpromptBranches, null);
});
