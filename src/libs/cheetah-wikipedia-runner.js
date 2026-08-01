import fs from "node:fs/promises";
import path from "node:path";
import { clipSnippet } from "./hf-dataset-client.js";
import { streamWikipediaArticles } from "./local-wikipedia-dataset.js";
import { teachFromText, recallAnswer } from "./cheetah-learner.js";

const CHECKPOINT_SCHEMA = "miniphi-cheetah-wikipedia@v1";
const DEFAULT_RECENT_RESULTS = 20;
const DEFAULT_PROBE_HISTORY = 100;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function cleanTitle(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 240) : "";
}

function emptyCounters() {
  return {
    articlesSeen: 0,
    articlesPrompted: 0,
    articlesLearned: 0,
    articlesAlreadyKnown: 0,
    articlesWithoutFacts: 0,
    articlesSkipped: 0,
    memoriesWritten: 0,
    factsWritten: 0,
    factsRejected: 0,
    inferenceProbes: 0,
    errors: 0,
  };
}

function freshCheckpoint({ datasetPath, database, modelKey }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: CHECKPOINT_SCHEMA,
    datasetPath,
    database,
    modelKey,
    createdAt: now,
    updatedAt: now,
    status: "running",
    stopReason: null,
    stopReasonCode: null,
    stopReasonDetail: null,
    position: null,
    counters: emptyCounters(),
    retentionSubjects: [],
    recentResults: [],
    probeHistory: [],
  };
}

async function readCheckpoint(checkpointFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Cannot read Wikipedia checkpoint ${checkpointFile}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function writeCheckpoint(checkpointFile, checkpoint) {
  await fs.mkdir(path.dirname(checkpointFile), { recursive: true });
  const temporaryFile = `${checkpointFile}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(checkpoint, null, 2), "utf8");
  try {
    await fs.rename(temporaryFile, checkpointFile);
  } catch (error) {
    // Windows can transiently reject rename-over-existing with EPERM when an
    // indexer/virus scanner has the destination open. Keep the completed temp
    // file as the source and fall back to an overwrite copy rather than lose
    // the last successfully processed article's resume point.
    if (!["EPERM", "EEXIST"].includes(error?.code)) {
      throw error;
    }
    await fs.copyFile(temporaryFile, checkpointFile);
    await fs.unlink(temporaryFile);
  }
}

function validateCheckpoint(checkpoint, { datasetPath, database }) {
  if (!checkpoint) {
    return;
  }
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA) {
    throw new Error(
      `Unsupported Wikipedia checkpoint schema ${checkpoint.schemaVersion ?? "unknown"}.`,
    );
  }
  if (path.resolve(checkpoint.datasetPath) !== datasetPath) {
    throw new Error(
      `Checkpoint dataset mismatch: expected ${datasetPath}, found ${checkpoint.datasetPath}.`,
    );
  }
  if (checkpoint.database !== database) {
    throw new Error(
      `Checkpoint database mismatch: expected ${database}, found ${checkpoint.database}.`,
    );
  }
}

function summarizeTeachRecord(record, source) {
  return {
    source,
    subjectId: record?.subjectId ?? null,
    subjectName: record?.subjectName ?? null,
    modelSubjectName: record?.modelSubjectName ?? null,
    canonicalSubjectApplied: Boolean(record?.canonicalSubjectApplied),
    noNewInformation: Boolean(record?.noNewInformation),
    alreadyKnownBeforeWrite: Boolean(record?.alreadyKnownBeforeWrite),
    memoryWritten: Boolean(record?.memoryWritten),
    newFactsWritten: Number(record?.newFactsWritten ?? 0),
    rejectedFactsCount: Number(record?.rejectedFactsCount ?? 0),
    rejectedFacts: Array.isArray(record?.rejectedFacts) ? record.rejectedFacts : [],
    stopReason: record?.stopReason ?? null,
    error: record?.error ?? null,
  };
}

function compareProbeResults(previousResults, currentResults) {
  const previousBySubject = new Map(
    (Array.isArray(previousResults) ? previousResults : []).map((entry) => [entry.subject, entry]),
  );
  const changes = {
    newlyResolved: [],
    newlyGrounded: [],
    regressedResolution: [],
    regressedGrounding: [],
    answerChanged: [],
  };
  for (const current of currentResults) {
    const previous = previousBySubject.get(current.subject);
    if (!previous) {
      continue;
    }
    if (!previous.anchorResolved && current.anchorResolved) {
      changes.newlyResolved.push(current.subject);
    }
    if (!previous.grounded && current.grounded) {
      changes.newlyGrounded.push(current.subject);
    }
    if (previous.anchorResolved && !current.anchorResolved) {
      changes.regressedResolution.push(current.subject);
    }
    if (previous.grounded && !current.grounded) {
      changes.regressedGrounding.push(current.subject);
    }
    if (previous.answer && current.answer && previous.answer !== current.answer) {
      changes.answerChanged.push(current.subject);
    }
  }
  return changes;
}

async function runInferenceProbe({
  checkpoint,
  subjects,
  handler,
  cheetahClient,
  schemaRegistry,
  recallFn,
}) {
  const results = [];
  for (const subject of subjects) {
    const question = `What do you know about ${subject}?`;
    try {
      const record = await recallFn(question, {
        handler,
        cheetahClient,
        schemaRegistry,
        subjectHint: subject,
        recordMiss: false,
      });
      results.push({
        subject,
        question,
        anchorResolved: Boolean(record?.anchorResolved),
        grounded: Boolean(record?.grounded),
        modelGrounded: Boolean(record?.modelGrounded),
        deterministicFallbackUsed: Boolean(record?.deterministicFallbackUsed),
        answerSource: record?.answerSource ?? null,
        answer: record?.answer ?? null,
        confidence: record?.confidence ?? "unknown",
        error: record?.error ?? null,
      });
    } catch (error) {
      results.push({
        subject,
        question,
        anchorResolved: false,
        grounded: false,
        modelGrounded: false,
        deterministicFallbackUsed: false,
        answerSource: null,
        answer: null,
        confidence: "unknown",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const previous = checkpoint.probeHistory?.at(-1) ?? null;
  const resolvedCount = results.filter((entry) => entry.anchorResolved).length;
  const groundedCount = results.filter((entry) => entry.grounded).length;
  const modelGroundedCount = results.filter((entry) => entry.modelGrounded).length;
  const deterministicFallbackCount = results.filter(
    (entry) => entry.deterministicFallbackUsed,
  ).length;
  const fallbackCount = results.filter((entry) => entry.error).length;
  return {
    at: new Date().toISOString(),
    afterArticlesSeen: checkpoint.counters.articlesSeen,
    afterFactsWritten: checkpoint.counters.factsWritten,
    subjects,
    results,
    metrics: {
      count: results.length,
      resolvedCount,
      retrievalResolvedRate: rate(resolvedCount, results.length),
      groundedCount,
      effectiveGroundedRate: rate(groundedCount, results.length),
      modelGroundedCount,
      modelGroundedRate: rate(modelGroundedCount, results.length),
      deterministicFallbackCount,
      fallbackCount,
    },
    changes: compareProbeResults(previous?.results, results),
  };
}

/**
 * Learn a bounded slice of a local Wikipedia dump, checkpointing after every
 * article and periodically re-running model inference over fixed early
 * subjects. Probe misses are read-only: evaluation never creates open-question
 * nodes or otherwise trains on its own test traffic.
 */
export async function runWikipediaLearning({
  datasetPath,
  checkpointFile,
  database,
  modelKey,
  handler,
  cheetahClient,
  schemaRegistry,
  maxArticles = 100,
  probeEvery = 10,
  probeCount = 3,
  maxErrors = 5,
  maxNoProgress = 10,
  maxSentences = 2,
  maxChars = 700,
  maxArticleBytes,
  resume = true,
  verbose = false,
  onProgress = null,
  teachFn = teachFromText,
  recallFn = recallAnswer,
} = {}) {
  const resolvedDatasetPath = path.resolve(String(datasetPath ?? ""));
  const resolvedCheckpointFile = path.resolve(String(checkpointFile ?? ""));
  if (!datasetPath) {
    throw new Error("Wikipedia learning requires datasetPath.");
  }
  if (!checkpointFile) {
    throw new Error("Wikipedia learning requires checkpointFile.");
  }
  if (!database) {
    throw new Error("Wikipedia learning requires a Cheetah database name.");
  }

  const sessionLimit = positiveInteger(maxArticles, 100);
  const safeProbeEvery = positiveInteger(probeEvery, 10);
  const safeProbeCount = positiveInteger(probeCount, 3);
  const safeMaxErrors = positiveInteger(maxErrors, 5);
  const safeMaxNoProgress = positiveInteger(maxNoProgress, 10);
  const existingCheckpoint = resume ? await readCheckpoint(resolvedCheckpointFile) : null;
  validateCheckpoint(existingCheckpoint, {
    datasetPath: resolvedDatasetPath,
    database,
  });
  const checkpoint = existingCheckpoint ??
    freshCheckpoint({ datasetPath: resolvedDatasetPath, database, modelKey });
  checkpoint.modelKey = modelKey;
  checkpoint.status = "running";
  checkpoint.stopReason = null;
  checkpoint.stopReasonCode = null;
  checkpoint.stopReasonDetail = null;
  checkpoint.counters = { ...emptyCounters(), ...(checkpoint.counters ?? {}) };
  checkpoint.retentionSubjects = Array.isArray(checkpoint.retentionSubjects)
    ? checkpoint.retentionSubjects.slice(0, safeProbeCount)
    : [];
  checkpoint.recentResults = Array.isArray(checkpoint.recentResults)
    ? checkpoint.recentResults.slice(-DEFAULT_RECENT_RESULTS)
    : [];
  checkpoint.probeHistory = Array.isArray(checkpoint.probeHistory)
    ? checkpoint.probeHistory.slice(-DEFAULT_PROBE_HISTORY)
    : [];

  const session = {
    startedAt: new Date().toISOString(),
    articlesSeen: 0,
    articlesPrompted: 0,
    articlesLearned: 0,
    memoriesWritten: 0,
    factsWritten: 0,
    factsRejected: 0,
    errors: 0,
    probes: [],
  };
  let consecutiveErrors = 0;
  let consecutiveNoProgress = 0;
  let lastProbeArticlesSeen = checkpoint.counters.articlesSeen;
  let stoppedEarly = false;
  let reachedSessionLimit = false;

  const persist = async () => {
    checkpoint.updatedAt = new Date().toISOString();
    await writeCheckpoint(resolvedCheckpointFile, checkpoint);
  };

  const probe = async () => {
    const subjects = checkpoint.retentionSubjects.slice(0, safeProbeCount);
    if (!subjects.length) {
      return null;
    }
    const probeRecord = await runInferenceProbe({
      checkpoint,
      subjects,
      handler,
      cheetahClient,
      schemaRegistry,
      recallFn,
    });
    checkpoint.counters.inferenceProbes += 1;
    checkpoint.probeHistory = [...checkpoint.probeHistory, probeRecord].slice(
      -DEFAULT_PROBE_HISTORY,
    );
    session.probes.push(probeRecord);
    lastProbeArticlesSeen = checkpoint.counters.articlesSeen;
    await persist();
    if (typeof onProgress === "function") {
      await onProgress({ type: "probe", probe: probeRecord, checkpoint });
    }
    return probeRecord;
  };

  for await (const item of streamWikipediaArticles(resolvedDatasetPath, {
    position: checkpoint.position,
    maxArticleBytes,
  })) {
    if (session.articlesSeen >= sessionLimit) {
      reachedSessionLimit = true;
      break;
    }

    session.articlesSeen += 1;
    checkpoint.counters.articlesSeen += 1;
    checkpoint.position = {
      fileName: item.fileName,
      nextByteOffset: item.nextByteOffset,
      nextArticleOrdinal: item.articleOrdinal + 1,
    };

    const source = {
      dataset: "wikipedia-2021",
      fileName: item.fileName,
      articleId: item.article?.id ?? null,
      articleOrdinal: item.articleOrdinal,
    };
    const title = cleanTitle(item.article?.title);
    const snippet = clipSnippet(item.article?.text, {
      maxSentences: positiveInteger(maxSentences, 2),
      maxChars: positiveInteger(maxChars, 700),
    });

    if (item.error || !title || !snippet) {
      checkpoint.counters.articlesSkipped += 1;
      checkpoint.recentResults = [
        ...checkpoint.recentResults,
        {
          source,
          subjectName: title || null,
          newFactsWritten: 0,
          error: item.error ?? (!title ? "missing-title" : "missing-text"),
        },
      ].slice(-DEFAULT_RECENT_RESULTS);
      await persist();
      continue;
    }

    let record;
    try {
      record = await teachFn(snippet, {
        handler,
        cheetahClient,
        schemaRegistry,
        subjectHint: { subject: title, matched: true, authoritative: true },
        sequence: checkpoint.counters.articlesSeen,
        source: `wikipedia-2021:${item.fileName}#${item.article?.id ?? item.articleOrdinal}`,
      });
      checkpoint.counters.articlesPrompted += 1;
      session.articlesPrompted += 1;
    } catch (error) {
      record = {
        subjectName: title,
        newFactsWritten: 0,
        alreadyKnownBeforeWrite: false,
        noNewInformation: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const factsWritten = Math.max(0, Number(record?.newFactsWritten ?? 0));
    const factsRejected = Math.max(0, Number(record?.rejectedFactsCount ?? 0));
    const memoryWritten = Boolean(record?.memoryWritten);
    const learned = memoryWritten || factsWritten > 0;
    const alreadyKnown = Boolean(record?.alreadyKnownBeforeWrite && record?.noNewInformation);
    const inferenceError = Boolean(record?.error);
    checkpoint.counters.factsWritten += factsWritten;
    checkpoint.counters.factsRejected += factsRejected;
    checkpoint.counters.memoriesWritten += memoryWritten ? 1 : 0;
    session.factsWritten += factsWritten;
    session.factsRejected += factsRejected;
    session.memoriesWritten += memoryWritten ? 1 : 0;

    if (factsWritten === 0) {
      checkpoint.counters.articlesWithoutFacts += 1;
    }

    if (inferenceError) {
      checkpoint.counters.errors += 1;
      session.errors += 1;
      consecutiveErrors += 1;
    } else {
      consecutiveErrors = 0;
    }

    if (learned) {
      checkpoint.counters.articlesLearned += 1;
      session.articlesLearned += 1;
      consecutiveNoProgress = 0;
    } else if (alreadyKnown) {
      checkpoint.counters.articlesAlreadyKnown += 1;
      consecutiveNoProgress = 0;
    } else {
      consecutiveNoProgress += 1;
    }

    if (
      (learned || record?.alreadyKnownBeforeWrite) &&
      checkpoint.retentionSubjects.length < safeProbeCount &&
      !checkpoint.retentionSubjects.includes(title)
    ) {
      checkpoint.retentionSubjects.push(title);
    }

    checkpoint.recentResults = [
      ...checkpoint.recentResults,
      summarizeTeachRecord(record, source),
    ].slice(-DEFAULT_RECENT_RESULTS);
    await persist();

    if (verbose && typeof onProgress === "function") {
      await onProgress({
        type: "article",
        article: summarizeTeachRecord(record, source),
        checkpoint,
      });
    }

    if (
      checkpoint.counters.articlesSeen - lastProbeArticlesSeen >= safeProbeEvery &&
      checkpoint.retentionSubjects.length
    ) {
      await probe();
    }

    if (consecutiveErrors >= safeMaxErrors) {
      checkpoint.status = "stopped";
      checkpoint.stopReason = "analysis-error";
      checkpoint.stopReasonCode = "wikipedia-max-errors";
      checkpoint.stopReasonDetail = `${consecutiveErrors} consecutive inference errors`;
      stoppedEarly = true;
      break;
    }
    if (consecutiveNoProgress >= safeMaxNoProgress) {
      checkpoint.status = "stopped";
      checkpoint.stopReason = "no-progress";
      checkpoint.stopReasonCode = "wikipedia-no-progress";
      checkpoint.stopReasonDetail =
        `${consecutiveNoProgress} consecutive articles produced no source memory or semantic facts`;
      stoppedEarly = true;
      break;
    }
  }

  if (
    checkpoint.retentionSubjects.length &&
    checkpoint.counters.articlesSeen > lastProbeArticlesSeen
  ) {
    await probe();
  }

  if (!stoppedEarly) {
    checkpoint.status = reachedSessionLimit ? "paused" : "completed";
    checkpoint.stopReason = null;
    checkpoint.stopReasonCode = null;
    checkpoint.stopReasonDetail = null;
  }
  session.finishedAt = new Date().toISOString();
  session.status = checkpoint.status;
  session.stopReason = checkpoint.stopReason;
  session.stopReasonCode = checkpoint.stopReasonCode;
  await persist();

  return {
    schemaVersion: CHECKPOINT_SCHEMA,
    datasetPath: resolvedDatasetPath,
    checkpointFile: resolvedCheckpointFile,
    database,
    modelKey,
    session,
    cumulative: checkpoint.counters,
    retentionSubjects: checkpoint.retentionSubjects,
    probes: session.probes,
    position: checkpoint.position,
  };
}

export { CHECKPOINT_SCHEMA };
