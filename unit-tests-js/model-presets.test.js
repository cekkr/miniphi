import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_KEY, resolveModelConfig } from "../src/libs/model-presets.js";

test("resolveModelConfig normalizes aliases and applies preset defaults when context is not explicit", () => {
  const selection = resolveModelConfig({
    model: "devstral",
    contextLength: 32768,
    contextIsExplicit: false,
  });
  assert.equal(selection.modelKey, "mistralai/devstral-small-2-2512");
  assert.equal(selection.contextLength, 131072);
  assert.equal(selection.clampedToPreset, false);
  assert.equal(selection.normalizedFromAlias, true);
});

test("resolveModelConfig clamps explicit context to preset limits for coding models", () => {
  const selection = resolveModelConfig({
    model: "ibm/granite-4-h-tiny",
    contextLength: 50000,
    contextIsExplicit: true,
  });
  assert.equal(selection.contextLength, 32768);
  assert.equal(selection.clampedToPreset, true);
});

test("resolveModelConfig honors explicit context for unknown models", () => {
  const selection = resolveModelConfig({
    model: "custom/model",
    contextLength: 16000,
    contextIsExplicit: true,
  });
  assert.equal(selection.modelKey, "custom/model");
  assert.equal(selection.preset, null);
  assert.equal(selection.contextLength, 16000);
  assert.equal(selection.clampedToPreset, false);
});

test("resolveModelConfig falls back to defaults when model is omitted", () => {
  const selection = resolveModelConfig({ contextLength: 10000, contextIsExplicit: true });
  assert.equal(selection.modelKey, DEFAULT_MODEL_KEY);
  assert.equal(selection.contextLength, 10000);
  assert.equal(selection.usedDefaultModel, true);
});

test("resolveModelConfig prefers preset defaults when context is implicit", () => {
  const selection = resolveModelConfig({
    model: "ibm/granite-4-h-tiny",
    contextLength: 8000,
    contextIsExplicit: false,
  });
  assert.equal(selection.contextLength, 16384);
  assert.equal(selection.clampedToPreset, false);
});
