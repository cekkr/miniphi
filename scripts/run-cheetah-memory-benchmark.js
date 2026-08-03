#!/usr/bin/env node
/**
 * End-to-end layered-memory benchmark.
 *
 * Phase 1 teaches N randomly sampled Wikipedia articles into a Cheetah
 * knowledge base through the layered teach path. Phase 2 builds questions with
 * gold answers taken from those same articles (deterministically — see
 * cheetah-question-generator.js). Phase 3 answers every question twice: once
 * closed-book with no memory at all, and once through the hippocampal recall
 * ladder, keeping every prompt, every Cheetah command, every decoded response
 * and both answers so the report can show the whole path from question to
 * answer rather than a summary of it.
 *
 * Usage:
 *   node scripts/run-cheetah-memory-benchmark.js \
 *     --dataset-path "E:\\Models\\datasets\\wiki-data-2021" \
 *     --base-url http://192.168.56.1:1234 \
 *     --model qwen3.5-0.8b-claude-4.6-opus-reasoning-distilled \
 *     --database wikimem --learn-count 500 --sample-count 50 --reset-database
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";
import LMStudioHandler from "../src/libs/lmstudio-handler.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import PromptRecorder from "../src/libs/prompt-recorder.js";
import { CheetahTcpClient } from "../src/libs/cheetah-binder.js";
import { ensureAskerAnchor } from "../src/libs/cheetah-knowledge-client.js";
import { teachFromText, recallAnswer } from "../src/libs/cheetah-learner.js";
import { sampleRandomWikipediaArticles } from "../src/libs/local-wikipedia-dataset.js";
import { clipSnippet } from "../src/libs/hf-dataset-client.js";
import {
  buildQuestionsForArticle,
  buildControlQuestion,
  selectBenchmarkQuestions,
  scoreAnswer,
} from "../src/libs/cheetah-question-generator.js";
import { parseStrictJsonObject } from "../src/libs/core-utils.js";

const DEFAULTS = {
  datasetPath: "E:\\Models\\datasets\\wiki-data-2021",
  baseUrl: "http://192.168.56.1:1234",
  model: "qwen3.5-0.8b-claude-4.6-opus-reasoning-distilled",
  database: "wikimem",
  learnCount: 500,
  sampleCount: 50,
  controlCount: 8,
  seed: 20260803,
  maxArticleChars: 2400,
};

const LEARN_SYSTEM_PROMPT = [
  "You serve an external memory that starts out empty, no matter how famous or obvious a subject is.",
  "You never answer factual questions from your own training knowledge, and you never skip saving a fact just because it feels obvious to you - only what the memory already has counts as 'known'.",
  "You only work from what is explicitly given to you in each prompt: a passage to learn from plus what the memory already records, or memory items retrieved to answer a question from.",
  "Always reply with strict JSON matching the requested schema only - no commentary, no markdown fences.",
].join(" ");

const CLOSED_BOOK_SYSTEM_PROMPT = [
  "You are answering a closed-book factual benchmark with no external memory and no retrieved context.",
  "Use only knowledge already present in your own weights.",
  "Always reply with strict JSON matching the requested schema only - no commentary, no markdown fences.",
].join(" ");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function numberOption(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

/** Deterministic PRNG so a run can be reproduced from its recorded seed. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildHandler({
  restClient,
  schemaRegistry,
  modelKey,
  promptRecorder,
  systemPrompt,
  promptTimeoutMs,
  maxOutputTokens,
  reasoningEffort,
}) {
  const handler = new LMStudioHandler(undefined, {
    systemPrompt,
    schemaRegistry,
    modelKey,
    promptRecorder,
    promptTimeoutMs,
    maxOutputTokens,
    reasoningEffort,
  });
  handler.setRestClient(restClient, { preferRestTransport: true });
  handler.setTransportPreference({
    forceRest: true,
    preferRestTransport: true,
    reason: "cheetah memory benchmark is REST-only",
  });
  return handler;
}

function buildClosedBookPrompt({ trialId, question, schemaRegistry }) {
  const schemaBlock = schemaRegistry.buildInstructionBlock("model-benchmark-trial", {
    compact: true,
  });
  return [
    "You are running a closed-book MiniPhi factual benchmark without external memory or retrieved context.",
    "Use only knowledge already present in the model weights. If unsure, use the exact decline phrase: I do not know.",
    `Trial id: ${trialId}`,
    `Question: ${question}`,
    "Return exactly one JSON object and no prose.",
    `Set schema_version to model-benchmark-trial@v1 and trial_id to ${trialId}.`,
    "Set evidence to [], needs_more_context to false, missing_snippets to [], and stop_reason to completed.",
    "Exact JSON schema:",
    schemaBlock,
  ].join("\n");
}

/**
 * Make sure the model is actually loaded before the run starts.
 *
 * Diagnosed the hard way on the reference host: with the model unloaded, every
 * `/v1/chat/completions` request tries to JIT-load it and simply never returns,
 * while `/api/v1/models` keeps answering in milliseconds — which reads exactly
 * like a wedged server and is not one. An explicit `POST /api/v1/models/load`
 * takes ~2.4s, after which the same completion answers in under a second. So the
 * run loads the model itself rather than relying on JIT, and warms it with one
 * small completion so the first real turn is not paying for a cold start.
 */
async function ensureModelLoaded({ restClient, modelKey, contextLength }) {
  let loadedInstances = [];
  try {
    const catalog = await restClient.listModelsNativeV1();
    const entry = (catalog?.models ?? []).find((model) => model.key === modelKey);
    loadedInstances = entry?.loaded_instances ?? [];
  } catch (error) {
    console.log(`[bench] model catalog unavailable: ${error instanceof Error ? error.message : error}`);
  }
  if (loadedInstances.length) {
    console.log(`[bench] ${modelKey} already loaded (${loadedInstances.length} instance)`);
  } else {
    const started = Date.now();
    const result = await restClient.loadModelV1({
      model: modelKey,
      ...(Number.isFinite(contextLength) ? { context_length: contextLength } : {}),
    });
    console.log(
      `[bench] loaded ${modelKey} in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `(status=${result?.status ?? "unknown"}, instance=${result?.instance_id ?? "?"})`,
    );
  }
  const warmStarted = Date.now();
  const warm = await restClient.createChatCompletion({
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    model: modelKey,
    stream: false,
    max_tokens: 200,
    timeoutMs: 120000,
  });
  const usage = warm?.usage ?? {};
  console.log(
    `[bench] warm-up ok in ${((Date.now() - warmStarted) / 1000).toFixed(1)}s ` +
      `(completion=${usage.completion_tokens ?? "?"} tokens, ` +
      `reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 0})`,
  );
}

async function appendJsonl(file, record) {
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

async function readJsonl(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Run `work` over `items` with at most `concurrency` in flight.
 *
 * The reference host serves this model with `parallel: 4`, and a teach turn is
 * almost entirely generation latency, so a sequential loop leaves most of the
 * server idle — 500 articles one at a time is hours of waiting on a machine
 * that could be answering four at once.
 */
async function mapWithConcurrency(items, concurrency, work) {
  const queue = [...items.entries()];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      const [index, item] = next;
      await work(item, index);
    }
  });
  await Promise.all(workers);
}

async function runLearningPhase({
  datasetPath,
  rng,
  learnCount,
  controlCount,
  maxArticleChars,
  handlers,
  cheetahClient,
  schemaRegistry,
  outDir,
  concurrency,
}) {
  console.log(`[bench] sampling ${learnCount + controlCount} random articles from ${datasetPath}`);
  const sample = await sampleRandomWikipediaArticles(datasetPath, {
    count: learnCount + controlCount,
    rng,
    minTextChars: 240,
  });
  console.log(
    `[bench] sampled ${sample.articles.length} articles in ${sample.attempts} seeks across the dump`,
  );

  const controls = sample.articles.slice(learnCount).map((item) => ({
    title: String(item.article.title ?? "").trim(),
    fileName: item.fileName,
    articleId: item.article.id ?? null,
  }));
  await fs.writeFile(
    path.join(outDir, "controls.json"),
    JSON.stringify(controls, null, 2),
    "utf8",
  );

  const learnedFile = path.join(outDir, "learned.jsonl");
  // The sample is drawn from a seeded PRNG, so a resumed run redraws exactly
  // the same articles and only has to skip the ones already on disk. This is
  // what makes a 500-article run survivable on a host that stalls: the work
  // done before the stall is kept.
  const alreadyLearned = new Set(
    (await readJsonl(learnedFile)).map((entry) => entry.title).filter(Boolean),
  );
  if (alreadyLearned.size) {
    console.log(`[bench] resuming: ${alreadyLearned.size} articles already taught`);
  }
  const teachable = sample.articles
    .slice(0, learnCount)
    .filter((item) => !alreadyLearned.has(String(item.article.title ?? "").trim()));
  let completed = 0;
  let learnedCount = 0;
  let factCount = 0;
  let rejectedCount = 0;
  let passageNodes = 0;
  let edgeCount = 0;
  let errorCount = 0;
  const startedAt = Date.now();

  await mapWithConcurrency(teachable, concurrency, async (item, position) => {
    const handler = handlers[position % handlers.length];
    const sequence = position + 1;
    const title = String(item.article.title ?? "").trim();
    const text = clipSnippet(item.article.text, {
      maxSentences: 16,
      maxChars: maxArticleChars,
    });
    completed += 1;
    if (!title || !text) {
      return;
    }
    let record;
    try {
      record = await teachFromText(text, {
        handler,
        cheetahClient,
        schemaRegistry,
        subjectHint: { subject: title, matched: true, authoritative: true },
        sequence,
        source: `wikipedia-2021:${item.fileName}#${item.article.id ?? item.articleOrdinal}`,
      });
    } catch (error) {
      errorCount += 1;
      console.log(`[bench][teach] ${title} FAILED: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (record.error) {
      errorCount += 1;
    }
    if (record.memoryWritten) {
      learnedCount += 1;
    }
    factCount += record.newFactsWritten;
    rejectedCount += record.rejectedFactsCount;
    passageNodes += record.batchResult?.passageNodes ?? 0;
    edgeCount += record.batchResult?.edgeCount ?? 0;

    await appendJsonl(learnedFile, {
      title,
      subjectId: record.subjectId,
      subjectName: record.subjectName,
      subjectType: record.subjectType,
      subjectContext: record.subjectContext,
      contextTags: record.contextTags,
      mentions: record.mentions,
      passages: record.passages,
      newFactsWritten: record.newFactsWritten,
      rejectedFacts: record.rejectedFacts,
      thinking: record.thinking,
      memoryWritten: record.memoryWritten,
      batchResult: record.batchResult,
      error: record.error,
      source: {
        fileName: item.fileName,
        articleId: item.article.id ?? null,
        articleOrdinal: item.articleOrdinal,
        byteOffset: item.byteOffset,
      },
      sourceText: text,
      promptTrace: record.promptTrace,
    });

    if (completed % 10 === 0 || completed === teachable.length) {
      const elapsed = (Date.now() - startedAt) / 1000;
      console.log(
        `[bench][teach] ${completed}/${teachable.length} learned=${learnedCount} ` +
          `facts=${factCount} rejected=${rejectedCount} passageNodes=${passageNodes} ` +
          `edges=${edgeCount} errors=${errorCount} ${elapsed.toFixed(0)}s`,
      );
    }
  });

  return {
    controls,
    learnedFile,
    stats: {
      sampled: sample.articles.length,
      seeks: sample.attempts,
      attempted: teachable.length,
      learnedCount,
      resumedCount: alreadyLearned.size,
      factCount,
      rejectedCount,
      passageNodes,
      edgeCount,
      errorCount,
      elapsedSeconds: (Date.now() - startedAt) / 1000,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const datasetPath = String(options["dataset-path"] ?? DEFAULTS.datasetPath);
  const baseUrl = String(options["base-url"] ?? DEFAULTS.baseUrl);
  const modelKey = String(options.model ?? DEFAULTS.model);
  const database = String(options.database ?? DEFAULTS.database);
  const learnCount = numberOption(options["learn-count"], DEFAULTS.learnCount);
  const sampleCount = numberOption(options["sample-count"], DEFAULTS.sampleCount);
  const controlCount = numberOption(options["control-count"], DEFAULTS.controlCount);
  const seed = numberOption(options.seed, DEFAULTS.seed);
  const maxArticleChars = numberOption(options["max-article-chars"], DEFAULTS.maxArticleChars);
  const skipLearning = options["skip-learning"] === true;
  const resumeSamples = options["resume-samples"] === true;
  const resetDatabase = options["reset-database"] === true;

  const sessionId = String(options["session-id"] ?? new Date().toISOString().replace(/[:.]/g, "-"));
  const outDir = path.resolve(
    String(options["out-dir"] ?? path.join(".miniphi", "cheetah", "memory-benchmark", sessionId)),
  );
  await fs.mkdir(outDir, { recursive: true });
  console.log(`[bench] session ${sessionId}`);
  console.log(`[bench] output ${outDir}`);

  const restClient = new LMStudioRestClient({ baseUrl, defaultModel: modelKey });
  const schemaRegistry = new PromptSchemaRegistry();
  const promptRecorder = new PromptRecorder();
  await promptRecorder.prepare();
  const cheetahClient = new CheetahTcpClient({
    host: String(options["cheetah-host"] ?? "127.0.0.1"),
    port: numberOption(options["cheetah-port"], 4455),
    database,
    timeoutMs: numberOption(options["cheetah-timeout-ms"], 15000),
  });

  // One handler per worker: LMStudioHandler carries per-conversation state, so
  // two concurrent turns cannot share one.
  const concurrency = numberOption(options.concurrency, 4);
  const promptTimeoutMs = numberOption(options["prompt-timeout-ms"], 240000);
  // A reasoning distill will happily spend thousands of tokens restating the
  // schema; the cap bounds one turn's cost and, with it, the host wedge that a
  // long run of unbounded generations reliably produces on this endpoint.
  const maxOutputTokens = numberOption(options["max-output-tokens"], 2200);
  // Accepted by the reference host even though this model advertises no
  // reasoning capability, and measurably shorter chains on the real teach
  // prompt. Pass `--reasoning-effort ""` to send nothing.
  const reasoningEffort =
    options["reasoning-effort"] === undefined ? "low" : String(options["reasoning-effort"] || "");
  const learnHandlers = Array.from({ length: concurrency }, () =>
    buildHandler({
      restClient,
      schemaRegistry,
      modelKey,
      promptRecorder,
      systemPrompt: LEARN_SYSTEM_PROMPT,
      promptTimeoutMs,
      maxOutputTokens,
      reasoningEffort,
    }),
  );
  const closedBookHandlers = Array.from({ length: concurrency }, () =>
    buildHandler({
      restClient,
      schemaRegistry,
      modelKey,
      promptRecorder,
      systemPrompt: CLOSED_BOOK_SYSTEM_PROMPT,
      promptTimeoutMs,
      maxOutputTokens: Math.min(maxOutputTokens, 1200),
      reasoningEffort,
    }),
  );

  const runStartedAt = new Date().toISOString();
  let learning = null;
  try {
    await ensureModelLoaded({
      restClient,
      modelKey,
      contextLength: numberOption(options["context-length"], null),
    });
    await ensureAskerAnchor(cheetahClient);
    if (resetDatabase && !skipLearning) {
      await cheetahClient.resetDatabase();
      await ensureAskerAnchor(cheetahClient);
      console.log(`[bench] reset Cheetah database ${database}`);
    }

    const rng = mulberry32(seed);
    if (skipLearning) {
      const learned = await readJsonl(path.join(outDir, "learned.jsonl"));
      const controls = JSON.parse(
        await fs.readFile(path.join(outDir, "controls.json"), "utf8").catch(() => "[]"),
      );
      learning = {
        controls,
        learnedFile: path.join(outDir, "learned.jsonl"),
        stats: { resumed: true, learnedCount: learned.length },
      };
      console.log(`[bench] resumed ${learned.length} learned articles from disk`);
    } else {
      learning = await runLearningPhase({
        datasetPath,
        rng,
        learnCount,
        controlCount,
        maxArticleChars,
        handlers: learnHandlers,
        cheetahClient,
        schemaRegistry,
        outDir,
        concurrency,
      });
      console.log(`[bench] learning phase: ${JSON.stringify(learning.stats)}`);
    }

    // ---- Phase 2: deterministic questions with gold answers ----------------
    // Sorted by provenance, not by the order teaching happened to finish in, so
    // a resumed learning phase still yields the same question set.
    const learned = (await readJsonl(learning.learnedFile)).sort((left, right) =>
      `${left.source?.fileName}#${left.source?.articleId}`.localeCompare(
        `${right.source?.fileName}#${right.source?.articleId}`,
        "en",
      ),
    );
    const answerable = learned.filter((entry) => entry.memoryWritten);
    const candidates = answerable.map((entry) =>
      buildQuestionsForArticle({
        title: entry.title,
        subjectId: entry.subjectId,
        subjectType: entry.subjectType,
        passages: entry.passages,
        text: entry.sourceText,
      }),
    );
    const selected = selectBenchmarkQuestions(candidates, { total: sampleCount });
    const controlQuestions = (learning.controls ?? [])
      .filter((control) => control.title)
      .slice(0, controlCount)
      .map((control) => buildControlQuestion(control));
    const questions = [...selected, ...controlQuestions];
    await fs.writeFile(
      path.join(outDir, "questions.json"),
      JSON.stringify(questions, null, 2),
      "utf8",
    );
    console.log(
      `[bench] built ${selected.length} answerable + ${controlQuestions.length} control questions`,
    );

    // ---- Phase 3: closed book vs. layered memory ---------------------------
    const samplesFile = path.join(outDir, "samples.jsonl");
    const existingSamples = resumeSamples ? await readJsonl(samplesFile) : [];
    if (!resumeSamples) {
      await fs.writeFile(samplesFile, "", "utf8");
    } else if (existingSamples.length) {
      console.log(`[bench] resuming: ${existingSamples.length} samples already answered`);
    }
    const answeredTrials = new Set(existingSamples.map((sample) => sample.trialId));
    const learnedByTitle = new Map(learned.map((entry) => [entry.title, entry]));
    const samples = [];
    // Sample order in the report comes from `index`, not from completion order:
    // the closed-book and memory turns for one question stay paired and
    // sequential, but different questions run in parallel like the teach phase.
    await mapWithConcurrency(questions, concurrency, async (question, position) => {
      const index = position + 1;
      const trialId = `mem-${String(index).padStart(3, "0")}`;
      const closedBook = closedBookHandlers[position % closedBookHandlers.length];
      const recallHandler = learnHandlers[position % learnHandlers.length];
      if (answeredTrials.has(trialId)) {
        return;
      }

      const closedBookPrompt = buildClosedBookPrompt({
        trialId,
        question: question.question,
        schemaRegistry,
      });
      let closedBookRaw = null;
      let closedBookAnswer = "";
      let closedBookError = null;
      try {
        closedBook.clearHistory();
        closedBookRaw = await closedBook.chatStream(
          closedBookPrompt,
          undefined,
          undefined,
          undefined,
          {
            scope: "sub",
            label: "closed-book",
            schemaId: "model-benchmark-trial",
            metadata: { mode: "cheetah-memory-benchmark", trialId },
          },
        );
        const parsed = parseStrictJsonObject(closedBookRaw);
        closedBookAnswer = typeof parsed?.answer === "string" ? parsed.answer.trim() : "";
      } catch (error) {
        closedBookError = error instanceof Error ? error.message : String(error);
      }

      let memoryRecord = null;
      let memoryError = null;
      try {
        memoryRecord = await recallAnswer(question.question, {
          handler: recallHandler,
          cheetahClient,
          schemaRegistry,
          subjectHint: question.subject,
          // Evaluation must not train on its own test traffic.
          recordMiss: false,
        });
      } catch (error) {
        memoryError = error instanceof Error ? error.message : String(error);
      }

      const closedBookScore = scoreAnswer(closedBookAnswer, question);
      const memoryScore = scoreAnswer(memoryRecord?.answer ?? "", question);
      const teachRecord = learnedByTitle.get(question.subject) ?? null;

      const sample = {
        index,
        trialId,
        kind: question.kind,
        expect: question.expect,
        subject: question.subject,
        subjectId: question.subjectId,
        question: question.question,
        goldAnswer: question.goldAnswer,
        goldSentence: question.goldSentence,
        learning: teachRecord
          ? {
              source: teachRecord.source,
              sourceText: teachRecord.sourceText,
              teachPrompt: teachRecord.promptTrace?.prompt ?? null,
              teachResponseRaw: teachRecord.promptTrace?.responseRaw ?? null,
              teachParsed: teachRecord.promptTrace?.parsed ?? null,
              storedPassages: teachRecord.passages,
              contextTags: teachRecord.contextTags,
              mentions: teachRecord.mentions,
              acceptedFacts: teachRecord.newFactsWritten,
              rejectedFacts: teachRecord.rejectedFacts,
              graphWrite: teachRecord.batchResult,
            }
          : null,
        closedBook: {
          prompt: closedBookPrompt,
          responseRaw: closedBookRaw,
          answer: closedBookAnswer,
          error: closedBookError,
          score: closedBookScore,
        },
        withMemory: memoryRecord
          ? {
              cheetahTrace: memoryRecord.cheetahTrace,
              retrievedPassages: memoryRecord.memory?.passages ?? [],
              relations: memoryRecord.memory?.relations ?? [],
              anchors: memoryRecord.memory?.anchors ?? [],
              retrievalStats: memoryRecord.memory?.stats ?? null,
              recallRounds: memoryRecord.promptTrace?.rounds ?? [],
              reasoningSteps: memoryRecord.reasoningSteps,
              followUpLookups: memoryRecord.followUpLookups,
              answer: memoryRecord.answer,
              answerSource: memoryRecord.answerSource,
              anchorResolved: memoryRecord.anchorResolved,
              grounded: memoryRecord.grounded,
              modelGrounded: memoryRecord.modelGrounded,
              answerSupport: memoryRecord.answerSupport,
              citedEvidenceIds: memoryRecord.citedEvidenceIds,
              evidence: memoryRecord.evidence,
              error: memoryRecord.error,
              score: memoryScore,
            }
          : { error: memoryError, score: memoryScore },
      };
      samples.push(sample);
      await appendJsonl(samplesFile, sample);

      console.log(
        `[bench][${index}/${questions.length}] ${question.kind} "${question.question}" ` +
          `closed=${closedBookScore.correct ? "OK" : closedBookScore.abstained ? "abstain" : "wrong"} ` +
          `memory=${memoryScore.correct ? "OK" : memoryScore.abstained ? "abstain" : "wrong"} ` +
          `(${memoryRecord?.answerSource ?? "error"})`,
      );
    });
    samples.push(...existingSamples);
    samples.sort((left, right) => left.index - right.index);

    // ---- Report ------------------------------------------------------------
    const answerableSamples = samples.filter((sample) => sample.expect === "answerable");
    const controlSamples = samples.filter((sample) => sample.expect === "decline");
    const byKind = {};
    for (const sample of answerableSamples) {
      const bucket = (byKind[sample.kind] ??= {
        count: 0,
        closedBookCorrect: 0,
        memoryCorrect: 0,
        anchorResolved: 0,
      });
      bucket.count += 1;
      bucket.closedBookCorrect += sample.closedBook.score.correct ? 1 : 0;
      bucket.memoryCorrect += sample.withMemory.score?.correct ? 1 : 0;
      bucket.anchorResolved += sample.withMemory.anchorResolved ? 1 : 0;
    }
    const answerSources = {};
    for (const sample of answerableSamples) {
      const key = sample.withMemory.answerSource ?? "error";
      answerSources[key] = (answerSources[key] ?? 0) + 1;
    }

    const report = {
      schemaVersion: "miniphi-cheetah-memory-benchmark@v1",
      sessionId,
      startedAt: runStartedAt,
      finishedAt: new Date().toISOString(),
      config: {
        datasetPath,
        baseUrl,
        modelKey,
        database,
        learnCount,
        sampleCount,
        controlCount,
        seed,
        maxArticleChars,
      },
      learning: learning.stats,
      totals: {
        samples: samples.length,
        answerable: answerableSamples.length,
        controls: controlSamples.length,
        closedBookCorrect: answerableSamples.filter((sample) => sample.closedBook.score.correct)
          .length,
        closedBookAbstained: answerableSamples.filter((sample) => sample.closedBook.score.abstained)
          .length,
        memoryCorrect: answerableSamples.filter((sample) => sample.withMemory.score?.correct).length,
        memoryAbstained: answerableSamples.filter((sample) => sample.withMemory.score?.abstained)
          .length,
        anchorResolved: answerableSamples.filter((sample) => sample.withMemory.anchorResolved)
          .length,
        modelComposed: answerableSamples.filter((sample) => sample.withMemory.modelGrounded).length,
        controlDeclined: controlSamples.filter(
          (sample) => sample.withMemory.score?.abstained || !sample.withMemory.grounded,
        ).length,
        controlClosedBookHallucinated: controlSamples.filter(
          (sample) => !sample.closedBook.score.abstained && sample.closedBook.answer,
        ).length,
      },
      answerSources,
      byKind,
    };
    await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(`[bench] report: ${JSON.stringify(report.totals)}`);
    console.log(`[bench] per-kind: ${JSON.stringify(byKind)}`);
    console.log(`[bench] answer sources: ${JSON.stringify(answerSources)}`);
    console.log(`[bench] wrote ${samplesFile}`);
  } finally {
    await cheetahClient.close();
  }
}

main().catch((error) => {
  console.error(`[bench] fatal: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
