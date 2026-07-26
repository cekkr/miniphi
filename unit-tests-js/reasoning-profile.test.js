import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReasoningProfile,
  resolveReasoningProfile,
} from "../src/libs/reasoning-profile.js";

const adjustableModel = {
  id: "reasoner",
  capabilityDetails: {
    reasoning: {
      allowedOptions: ["off", "low", "medium", "high"],
      default: "medium",
    },
  },
};

test("reasoning profiles default to high and increase decomposition monotonically", () => {
  assert.equal(normalizeReasoningProfile(), "high");
  const resolutions = ["off", "low", "medium", "high"].map((profile) =>
    resolveReasoningProfile({ profile, model: adjustableModel }),
  );
  assert.deepEqual(
    resolutions.map((entry) => entry.agent.maxExpansions),
    [0, 1, 2, 4],
  );
  assert.deepEqual(
    resolutions.map((entry) => entry.model.resolved),
    ["off", "low", "medium", "high"],
  );
});

test("on/off models map enabled profiles to on while preserving agent effort", () => {
  const model = {
    capabilityDetails: {
      reasoning: { allowedOptions: ["off", "on"], default: "on" },
    },
  };
  const medium = resolveReasoningProfile({ profile: "medium", model });
  assert.equal(medium.model.resolved, "on");
  assert.equal(medium.model.exact, false);
  assert.equal(medium.agent.maxExpansions, 2);
});

test("models without advertised reasoning still receive decomposition controls", () => {
  const high = resolveReasoningProfile({ profile: "high", model: { id: "plain" } });
  assert.equal(high.model.supported, false);
  assert.equal(high.model.resolved, null);
  assert.equal(high.agent.maxExpansions, 4);
});

test("explicit low-level planner overrides remain authoritative", () => {
  const resolved = resolveReasoningProfile({
    profile: "low",
    model: adjustableModel,
    maxExpansions: 7,
    maxDepth: 5,
  });
  assert.equal(resolved.agent.maxExpansions, 7);
  assert.equal(resolved.agent.maxDepth, 5);
  assert.equal(resolved.agent.overrides.maxExpansions, true);
  assert.equal(resolved.agent.overrides.maxDepth, true);

  const disabled = resolveReasoningProfile({
    profile: "high",
    expandSubprompts: false,
  });
  assert.equal(disabled.agent.expandSubprompts, false);
  assert.equal(disabled.agent.maxExpansions, 0);
});

test("invalid reasoning profile is rejected", () => {
  assert.throws(
    () => normalizeReasoningProfile("extreme"),
    /Expected one of: off, low, medium, high/,
  );
});
