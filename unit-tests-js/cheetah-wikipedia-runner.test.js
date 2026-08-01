import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWikipediaLearning } from "../src/libs/cheetah-wikipedia-runner.js";

async function makeDataset(root) {
  await fs.writeFile(
    path.join(root, "articles.json"),
    JSON.stringify([
      { id: "1", title: "Alpha", text: "Alpha is located in One." },
      { id: "2", title: "Beta", text: "Beta is located in Two." },
      { id: "3", title: "Gamma", text: "Gamma is located in Three." },
      { id: "4", title: "Delta", text: "Delta is located in Four." },
    ]),
    "utf8",
  );
}

test("Wikipedia learning checkpoints, resumes, and re-infers fixed retention subjects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-wikipedia-runner-"));
  const checkpointFile = path.join(root, "state", "checkpoint.json");
  const learned = new Set();
  const teachCalls = [];
  const recallCalls = [];
  const teachFn = async (_snippet, options) => {
    const subjectName = options.subjectHint.subject;
    teachCalls.push(options);
    learned.add(subjectName);
    return {
      subjectId: `topic:${subjectName.toLowerCase()}`,
      subjectName,
      modelSubjectName: "wrong model alias",
      canonicalSubjectApplied: true,
      noNewInformation: false,
      alreadyKnownBeforeWrite: false,
      newFactsWritten: 2,
      stopReason: "completed",
      error: null,
    };
  };
  const recallFn = async (question, options) => {
    recallCalls.push({ question, options });
    return {
      anchorResolved: learned.has(options.subjectHint),
      grounded: learned.has(options.subjectHint),
      modelGrounded: false,
      deterministicFallbackUsed: learned.has(options.subjectHint),
      answerSource: "deterministic-reference-fallback",
      answer: `${options.subjectHint} remembered`,
      confidence: "certain",
      error: null,
    };
  };

  try {
    await makeDataset(root);
    const first = await runWikipediaLearning({
      datasetPath: root,
      checkpointFile,
      database: "wikidata",
      modelKey: "smollm2-360m-instruct",
      maxArticles: 2,
      probeEvery: 2,
      probeCount: 2,
      teachFn,
      recallFn,
    });
    assert.equal(first.session.status, "paused");
    assert.equal(first.session.articlesSeen, 2);
    assert.equal(first.session.factsWritten, 4);
    assert.deepEqual(first.retentionSubjects, ["Alpha", "Beta"]);
    assert.equal(first.probes.length, 1);
    assert.equal(first.probes[0].metrics.groundedCount, 2);
    assert.equal(first.probes[0].metrics.modelGroundedCount, 0);
    assert.equal(first.probes[0].metrics.deterministicFallbackCount, 2);
    assert.equal(recallCalls.every((call) => call.options.recordMiss === false), true);

    const second = await runWikipediaLearning({
      datasetPath: root,
      checkpointFile,
      database: "wikidata",
      modelKey: "smollm2-360m-instruct",
      maxArticles: 2,
      probeEvery: 2,
      probeCount: 2,
      teachFn,
      recallFn,
    });
    assert.equal(second.session.articlesSeen, 2);
    assert.equal(second.cumulative.articlesSeen, 4);
    assert.equal(second.cumulative.factsWritten, 8);
    assert.deepEqual(teachCalls.map((call) => call.subjectHint.subject), ["Alpha", "Beta", "Gamma", "Delta"]);
    assert.equal(teachCalls.every((call) => call.subjectHint.authoritative === true), true);
    assert.equal(second.probes[0].changes.regressedGrounding.length, 0);

    const checkpoint = JSON.parse(await fs.readFile(checkpointFile, "utf8"));
    assert.equal(checkpoint.status, "completed");
    assert.equal(checkpoint.database, "wikidata");
    assert.equal(checkpoint.probeHistory.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Wikipedia learning stops after bounded no-progress and records a canonical reason", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-wikipedia-no-progress-"));
  try {
    await makeDataset(root);
    const result = await runWikipediaLearning({
      datasetPath: root,
      checkpointFile: path.join(root, "state", "checkpoint.json"),
      database: "wikidata",
      modelKey: "tiny",
      maxArticles: 4,
      maxNoProgress: 2,
      teachFn: async (_snippet, options) => ({
        subjectName: options.subjectHint.subject,
        newFactsWritten: 0,
        alreadyKnownBeforeWrite: false,
        noNewInformation: false,
        error: null,
      }),
      recallFn: async () => ({}),
    });
    assert.equal(result.session.status, "stopped");
    assert.equal(result.session.stopReason, "no-progress");
    assert.equal(result.session.stopReasonCode, "wikipedia-no-progress");
    assert.equal(result.session.articlesSeen, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Wikipedia learning stops after bounded model errors even when exact source memory was saved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-wikipedia-errors-"));
  try {
    await makeDataset(root);
    const result = await runWikipediaLearning({
      datasetPath: root,
      checkpointFile: path.join(root, "state", "checkpoint.json"),
      database: "wikidata",
      modelKey: "tiny",
      maxArticles: 4,
      maxErrors: 2,
      teachFn: async (_snippet, options) => ({
        subjectName: options.subjectHint.subject,
        memoryWritten: true,
        newFactsWritten: 0,
        noNewInformation: true,
        error: "invalid-json",
      }),
      recallFn: async () => ({ anchorResolved: true, grounded: true }),
    });
    assert.equal(result.session.status, "stopped");
    assert.equal(result.session.stopReason, "analysis-error");
    assert.equal(result.session.stopReasonCode, "wikipedia-max-errors");
    assert.equal(result.session.articlesSeen, 2);
    assert.equal(result.session.memoriesWritten, 2);
    assert.equal(result.session.errors, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
