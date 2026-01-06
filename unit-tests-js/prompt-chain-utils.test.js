import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEARNED_SCHEMA_VERSION,
  applyPromptTemplate,
  buildOptionHintBlock,
  mergeLearnedOptions,
  mergeOptionSets,
  normalizeOptionSets,
  normalizeOptionUpdates,
  resolveOptionSelections,
} from "../src/libs/prompt-chain-utils.js";

test("normalizeOptionSets trims ids and drops invalid entries", () => {
  const raw = {
    " tone ": {
      description: "  Style ",
      default: " crisp ",
      options: [
        { id: " crisp ", label: " Crisp " },
        { id: " " },
        null,
      ],
    },
    "": { options: [{ id: "skip" }] },
  };

  const normalized = normalizeOptionSets(raw);
  assert.deepEqual(Object.keys(normalized), ["tone"]);
  assert.equal(normalized.tone.default, "crisp");
  assert.equal(normalized.tone.options.length, 1);
  assert.equal(normalized.tone.options[0].id, "crisp");
  assert.equal(normalized.tone.options[0].label, "Crisp");
});

test("mergeOptionSets appends learned options without overwriting defaults", () => {
  const base = {
    focus: {
      description: "Base",
      default: "schema",
      options: [{ id: "schema", label: "Schema" }],
    },
  };
  const learned = {
    focus: {
      description: "Learned",
      default: "fallbacks",
      options: [{ id: "fallbacks", label: "Fallbacks" }],
    },
  };

  const merged = mergeOptionSets(base, learned);
  assert.equal(merged.focus.options.length, 2);
  assert.equal(merged.focus.default, "schema");
});

test("resolveOptionSelections prefers overrides then selected/default", () => {
  const sets = {
    focus: {
      options: [{ id: "schema" }, { id: "options" }],
      selected: "options",
      default: "schema",
    },
    tone: {
      options: [{ id: "crisp" }, { id: "supportive" }],
      default: "crisp",
    },
  };
  const selections = resolveOptionSelections(sets, { focus: "schema" });
  assert.equal(selections.focus, "schema");
  assert.equal(selections.tone, "crisp");
});

test("buildOptionHintBlock formats selected prompt hints", () => {
  const sets = {
    tone: {
      options: [
        { id: "crisp", label: "Crisp", prompt_hint: "Short, direct." },
        { id: "supportive", label: "Supportive", description: "Gentle guidance." },
      ],
    },
  };
  const hints = buildOptionHintBlock(sets, { tone: "crisp" });
  assert.match(hints, /tone=crisp: Short, direct\./);
});

test("applyPromptTemplate injects JSON-safe placeholders", () => {
  const template = `{"id": {{id_json}}, "payload": {{payload}}}`;
  const rendered = applyPromptTemplate(template, {
    id_json: JSON.stringify("alpha"),
    payload: { ok: true },
  });
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.id, "alpha");
  assert.equal(parsed.payload.ok, true);
});

test("normalizeOptionUpdates filters invalid updates", () => {
  const updates = normalizeOptionUpdates([
    { set: "tone", options: [{ id: "new", label: "New" }] },
    { set: " ", options: [{ id: "skip" }] },
  ]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].set, "tone");
});

test("mergeLearnedOptions appends new entries with metadata", () => {
  const updates = normalizeOptionUpdates([
    { set: "tone", options: [{ id: "urgent", label: "Urgent" }] },
  ]);
  const merged = mergeLearnedOptions(
    {},
    updates,
    { now: "2026-01-06T00:00:00Z", stepId: "compose" },
  );
  assert.equal(merged.schema_version, DEFAULT_LEARNED_SCHEMA_VERSION);
  assert.equal(merged.option_sets.tone.options.length, 1);
  assert.equal(merged.option_sets.tone.options[0].id, "urgent");
  assert.equal(merged.option_sets.tone.options[0].source_step, "compose");
  assert.equal(merged.option_sets.tone.options[0].added_at, "2026-01-06T00:00:00Z");
});
