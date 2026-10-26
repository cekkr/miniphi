import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { learnGraphText, reasonGraph, graphName } from "./cheetah-graph-learning.js";

function label(value) {
  return graphName(String(value).replace(/^"|"$/g, "").replace(/_/g, " "));
}

/** Endpoint coverage only: natural predicates are not RDF ontology labels. */
export function scoreWebNlgClaims(gold, claims) {
  const expected = new Set(gold.map((triple) => {
    const parts = triple.split(" | ");
    if (parts.length !== 3) throw new Error("Malformed WebNLG triple");
    return JSON.stringify([label(parts[0]), label(parts[2])]);
  }));
  const predicted = new Set(claims.map((fact) => JSON.stringify([label(fact.subject), label(fact.object)])));
  return { expectedPairs: expected.size, predictedPairs: predicted.size,
    matchingPairs: [...predicted].filter((pair) => expected.has(pair)).length };
}

async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
}

export async function runWebNlgLearning({
  datasetPath, checkpointFile, handler, cheetahClient, schemaRegistry, modelKey,
  limit = 20, offset = 0, resume = true, question = null, maxRounds = 4,
  sessionTimeoutMs = 900000, onProgress = () => {},
} = {}) {
  for (const [name, value, min, max] of [["limit", limit, 1, 13211], ["offset", offset, 0, 13210], ["maxRounds", maxRounds, 1, 8], ["sessionTimeoutMs", sessionTimeoutMs, 1000, 86400000]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
  }
  const deadline = Date.now() + sessionTimeoutMs;
  const file = path.join(path.resolve(datasetPath), "train.json");
  if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error("WebNLG train export exceeds 64 MiB");
  const raw = await fs.readFile(file, "utf8");
  const data = JSON.parse(raw);
  if (data.language !== "en" || !Array.isArray(data.values)) throw new Error("Expected English WebNLG values export");
  const identity = { dataset: createHash("sha256").update(raw).digest("hex"), database: cheetahClient.database, modelKey, offset };
  let state = { version: 1, identity, nextIndex: offset, records: [], answers: [], totals: { processed: 0, written: 0, known: 0, rejected: 0, expectedPairs: 0, predictedPairs: 0, matchingPairs: 0 } };
  if (resume && checkpointFile) {
    try {
      const previous = JSON.parse(await fs.readFile(checkpointFile, "utf8"));
      if (JSON.stringify(previous.identity) !== JSON.stringify(identity)) throw new Error("WebNLG checkpoint identity mismatch; choose a new checkpoint or --no-resume");
      if (!Number.isInteger(previous.nextIndex) || previous.nextIndex < offset || previous.nextIndex > data.values.length || !Array.isArray(previous.records) || !Array.isArray(previous.answers)) throw new Error("Invalid WebNLG checkpoint");
      state = { ...previous, totals: previous.totals ?? previous.records.filter((record) => !record.fallback).reduce((totals, record) => {
        for (const [key, value] of Object.entries({ processed: 1, written: record.written, known: record.known ?? 0, rejected: record.rejected.length, ...record.metrics })) totals[key] += value;
        return totals;
      }, { ...state.totals }) };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  let processed = 0, stopReason = null;
  try {
    while (processed < limit && state.nextIndex < data.values.length) {
      if (Date.now() >= deadline) { stopReason = "session-timeout"; break; }
      const row = data.values[state.nextIndex];
      if (!Array.isArray(row.input) || !row.input.length || !Array.isArray(row.target) || typeof row.target[0] !== "string" || !row["webnlg-id"]?.startsWith("train/")) throw new Error(`Invalid WebNLG row ${state.nextIndex}`);
      // No RDF labels or endpoint hints cross into the learner. Gold is scored AFTER.
      const result = await learnGraphText(row.target[0], { handler, cheetahClient, schemaRegistry,
        sourceId: row["webnlg-id"], deadline });
      const metrics = scoreWebNlgClaims(row.input, result.claims ?? []);
      const record = { index: state.nextIndex, text: row.target[0], gold: row.input, ...result, metrics };
      if (checkpointFile) await save(path.join(`${checkpointFile}.rows`, `${state.nextIndex}.json`), record);
      state.records.push(record);
      state.records = state.records.slice(-50);
      if (result.fallback) { stopReason = result.stopReason; break; }
      state.nextIndex += 1;
      processed += 1;
      for (const [key, count] of Object.entries({ processed: 1, written: result.written, known: result.known, rejected: result.rejected.length, ...metrics })) state.totals[key] += count;
      if (checkpointFile) await save(checkpointFile, state);
      await onProgress({ index: state.nextIndex - 1, result, metrics });
    }
    if (!stopReason && question) {
      const answer = await reasonGraph(question, { handler, cheetahClient, schemaRegistry, deadline, maxRounds });
      state.answers.push(answer);
      state.answers = state.answers.slice(-20);
    }
  } catch (error) {
    stopReason = error.message === "session-timeout" ? "session-timeout" : "analysis-error";
    state.error = error.message;
  }
  state.finishedAt = new Date().toISOString();
  state.stopReason = stopReason;
  state.stopReasonCode = stopReason;
  state.session = { processed, inputExhausted: state.nextIndex === data.values.length };
  if (checkpointFile) await save(checkpointFile, state);
  return state;
}
