import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLineRangeFromChunk,
  buildTruncationChunkKey,
  computeTruncationProgress,
  describeTruncationChunk,
  ensureTruncationProgressEntry,
  findNextIncompleteChunk,
  selectTruncationChunk,
  sortTruncationChunks,
} from "../src/libs/truncation-utils.js";

function buildPlan() {
  return {
    plan: {
      chunkingPlan: [
        {
          goal: "First chunk",
          priority: 2,
          startLine: 1,
          endLine: 120,
          context: "intro",
        },
        {
          goal: "Second chunk",
          priority: 1,
          startLine: 121,
          endLine: 240,
        },
        {
          label: "Third chunk",
          index: 2,
          startLine: 241,
          endLine: 360,
        },
      ],
    },
  };
}

test("sortTruncationChunks orders by priority then index", () => {
  const plan = buildPlan();
  const sorted = sortTruncationChunks(plan);
  assert.equal(sorted[0].goal, "Second chunk");
  assert.equal(sorted[1].goal, "First chunk");
  assert.equal(sorted[2].label, "Third chunk");
});

test("selectTruncationChunk matches priority, index, or goal text", () => {
  const plan = buildPlan();
  assert.equal(selectTruncationChunk(plan).goal, "Second chunk");
  assert.equal(selectTruncationChunk(plan, "1").goal, "Second chunk");
  assert.equal(selectTruncationChunk(plan, "2").goal, "First chunk");
  assert.equal(selectTruncationChunk(plan, "Third").label, "Third chunk");
});

test("buildTruncationChunkKey prefers id and encodes line ranges", () => {
  const withId = { id: "chunk-alpha" };
  assert.equal(buildTruncationChunkKey(withId), "chunk-alpha");
  const withoutId = { goal: "Alpha Beta", startLine: 5, endLine: 9 };
  assert.equal(buildTruncationChunkKey(withoutId), "alpha-beta@5-9");
});

test("buildLineRangeFromChunk returns null when no line bounds exist", () => {
  assert.equal(buildLineRangeFromChunk(null), null);
  assert.equal(buildLineRangeFromChunk({}), null);
  assert.deepEqual(buildLineRangeFromChunk({ startLine: 4 }), { startLine: 4, endLine: null });
});

test("ensureTruncationProgressEntry initializes tracking entries", () => {
  const progress = {};
  const chunk = { goal: "Alpha", startLine: 1, endLine: 10 };
  const entry = ensureTruncationProgressEntry(progress, "alpha", chunk);
  assert.ok(entry);
  assert.equal(entry.label, "Alpha");
  assert.deepEqual(entry.range, { startLine: 1, endLine: 10 });
  assert.ok(progress.chunks.alpha);
});

test("computeTruncationProgress counts completed chunks", () => {
  const plan = buildPlan();
  const progress = {};
  const firstKey = buildTruncationChunkKey(plan.plan.chunkingPlan[0]);
  ensureTruncationProgressEntry(progress, firstKey, plan.plan.chunkingPlan[0]);
  progress.chunks[firstKey].completedAt = new Date().toISOString();
  const stats = computeTruncationProgress(plan, progress);
  assert.equal(stats.total, 3);
  assert.equal(stats.completed, 1);
});

test("findNextIncompleteChunk skips completed chunk keys", () => {
  const plan = buildPlan();
  const progress = {};
  const ordered = sortTruncationChunks(plan);
  const firstKey = buildTruncationChunkKey(ordered[0]);
  ensureTruncationProgressEntry(progress, firstKey, ordered[0]);
  progress.chunks[firstKey].completedAt = new Date().toISOString();
  const next = findNextIncompleteChunk(plan, progress, firstKey);
  assert.ok(next);
  assert.notEqual(buildTruncationChunkKey(next), firstKey);
});

test("describeTruncationChunk includes line ranges and context", () => {
  const chunk = { goal: "Alpha", startLine: 3, endLine: 7, context: "parse errors" };
  const description = describeTruncationChunk(chunk);
  assert.ok(description.includes("Alpha"));
  assert.ok(description.includes("lines 3-7"));
  assert.ok(description.includes("parse errors"));
});
