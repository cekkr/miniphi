import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTaskIntent,
  selectModelForIntent,
  selectNitpickModels,
} from "../src/libs/model-selector.js";
import { DEFAULT_MODEL_KEY } from "../src/libs/model-presets.js";

test("classifyTaskIntent detects coding, writing, research, and analysis tasks", () => {
  assert.equal(classifyTaskIntent({ task: "Fix the bug in the parser module" }).intent, "coding");
  assert.equal(classifyTaskIntent({ task: "Draft an overview of the release" }).intent, "writing");
  assert.equal(
    classifyTaskIntent({ task: "Research sources and citations for the memo" }).intent,
    "research",
  );
  assert.equal(
    classifyTaskIntent({ task: "Diagnose the root cause of the crash" }).intent,
    "analysis",
  );
});

test("classifyTaskIntent falls back to mode, workspace domain, then command text", () => {
  assert.equal(classifyTaskIntent({ mode: "run" }).intent, "analysis");
  assert.equal(
    classifyTaskIntent({ workspaceContext: { classification: { domain: "code" } } }).intent,
    "coding",
  );
  assert.equal(
    classifyTaskIntent({ workspaceContext: { classification: { domain: "docs" } } }).intent,
    "writing",
  );
  assert.equal(classifyTaskIntent({ command: "npm run lint" }).intent, "coding");
  assert.equal(classifyTaskIntent({}).intent, "general");
});

test("classifyTaskIntent prioritizes research keywords over coding keywords", () => {
  const { intent } = classifyTaskIntent({ task: "Research how to refactor the build" });
  assert.equal(intent, "research");
});

test("selectModelForIntent picks a coding preset for coding intent", () => {
  const selected = selectModelForIntent({
    intent: "coding",
    candidates: ["microsoft/phi-4-reasoning-plus", "mistralai/devstral-small-2-2512"],
  });
  assert.equal(selected, "mistralai/devstral-small-2-2512");
});

test("selectModelForIntent falls back when candidates are empty", () => {
  assert.equal(selectModelForIntent({ intent: "coding", candidates: [] }), DEFAULT_MODEL_KEY);
  assert.equal(
    selectModelForIntent({ intent: "coding", candidates: [], fallback: "custom-model" }),
    "custom-model",
  );
});

test("selectNitpickModels avoids assigning the same writer and critic", () => {
  const { writerModel, criticModel, intent } = selectNitpickModels({
    task: "Write an essay about local AI agents",
    candidates: ["microsoft/phi-4-reasoning-plus", "mistralai/devstral-small-2-2512"],
  });
  assert.equal(intent, "writing");
  assert.notEqual(writerModel, criticModel);
});

test("selectNitpickModels honors explicit writer/critic overrides", () => {
  const { writerModel, criticModel } = selectNitpickModels({
    task: "Write an essay",
    writerModel: "writer-x",
    criticModel: "critic-y",
  });
  assert.equal(writerModel, "writer-x");
  assert.equal(criticModel, "critic-y");
});
