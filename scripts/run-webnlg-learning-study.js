#!/usr/bin/env node
// Instrumentation only: all extraction, confidence/decomposition and retrieval
// decisions are implemented in src/libs. Never repair predictions in this harness.
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { LMStudioRestClient, createNodeHttpFetch } from "../src/libs/lmstudio-api.js";
import { CheetahTcpClient, startCheetahServer, decodeCheetahPayload } from "../src/libs/cheetah-binder.js";
import { buildLmStudioHandler } from "../src/commands/cheetah-learn.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import PromptRecorder from "../src/libs/prompt-recorder.js";
import { learnGraphText, reasonGraph } from "../src/libs/cheetah-graph-learning.js";
import { answerGraphConcepts, KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT } from "../src/libs/cheetah-knowledge-assessment.js";
import { resolveContextWindow } from "../src/libs/model-catalog.js";
import { deriveContextBudget, estimateTokens } from "../src/libs/context-graph.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, token, i, all) => {
  if (token.startsWith("--")) out.push([token.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]);
  return out;
}, []));
const manifestFile = path.resolve(args.manifest ?? "docs/benchmarks/webnlg-study-cases.json");
const manifestRaw = await fs.readFile(manifestFile, "utf8");
const manifest = JSON.parse(manifestRaw);
const datasetBytes = await fs.readFile("thirds/cheetah/studies/datasets/web_nlg/train.json");
if (createHash("sha256").update(datasetBytes).digest("hex") !== manifest.dataset_sha256) throw new Error("Study dataset fingerprint mismatch");
const limit = Number(args.limit ?? 20);
if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("--limit must be 1..20");
const durationMinutes = Number(args["duration-minutes"] ?? 60);
if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 180) throw new Error("--duration-minutes must be greater than 0 and at most 180");
const cases = manifest.cases.slice(0, limit);
const model = args.model ?? "qwen3-4b-thinking-2507-mlx";
const baseUrl = args["base-url"] ?? process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234";
const root = path.resolve(args.output ?? `.miniphi/cheetah/webnlg-study/${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const stateFile = path.join(root, "study.json");
const fingerprint = createHash("sha256").update(manifestRaw).digest("hex");
const runtimeHash = createHash("sha256");
for (const file of ["src/libs/cheetah-graph-identity.js", "src/libs/cheetah-graph-io.js", "src/libs/cheetah-graph-correlations.js", "src/libs/wordnet-lexicon.js", "src/libs/wordnet-installer.js", "src/libs/cheetah-graph-learning.js", "src/libs/cheetah-knowledge-assessment.js", "src/libs/cheetah-prompt-contract.js", "src/libs/prompt-schema-registry.js", "src/libs/lmstudio-handler.js"]) {
  runtimeHash.update(file).update(await fs.readFile(file));
}
let state = { version: 1, model, baseUrl, manifestSha256: fingerprint, caseIds: cases.map(c => c.id), startedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  runtimeSha256: runtimeHash.digest("hex"),
  cases: Object.fromEntries(cases.map(c => [c.id, { definition: c }])), lifecycle: [] };
let dataDir = path.join(root, "data");
if (args["continue-study"]) {
  if (limit !== 20) throw new Error("--continue-study requires --limit 20");
  const priorPath = path.resolve(args["continue-study"]);
  const previous = JSON.parse(await fs.readFile(priorPath, "utf8"));
  if (previous.manifestSha256 !== fingerprint || previous.model !== model || previous.caseIds.length !== 20 || !previous.finishedAt) throw new Error("Cannot continue a mismatched or unfinished study");
  if (previous.initialStudy) throw new Error("This study is already a continuation; resume its --output directory instead");
  state.cases = previous.cases;
  state.initialStudy = { path: priorPath, startedAt: previous.startedAt, finishedAt: previous.finishedAt, runtimeSha256: previous.runtimeSha256, lifecycle: previous.lifecycle };
  state.initialBonus = previous.bonus; state.initialControl = previous.control;
  dataDir = path.join(path.dirname(priorPath), "data");
}
try {
  const previous = JSON.parse(await fs.readFile(stateFile, "utf8"));
  if (previous.manifestSha256 !== fingerprint || previous.model !== model || JSON.stringify(previous.caseIds) !== JSON.stringify(state.caseIds) || previous.runtimeSha256 !== state.runtimeSha256) throw new Error("Study resume identity mismatch");
  state = previous;
} catch (error) { if (error.code !== "ENOENT") throw error; }
// A saved continuation must resume its original graph and repair phases even
// when the operator supplies only --output on the next invocation.
const continuing = Boolean(state.initialStudy);
dataDir = state.dataDirectory ?? (continuing ? path.join(path.dirname(state.initialStudy.path), "data") : dataDir);
state.dataDirectory = dataDir;
const save = async () => { await fs.writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2)); await fs.rename(`${stateFile}.tmp`, stateFile); };
await save();
let currentEvents = null;
const fetch = createNodeHttpFetch();
const fetchImpl = async (url, init) => {
  const event = { kind: "lmstudio", startedAt: new Date().toISOString(), request: { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null } };
  currentEvents?.push(event);
  try {
    const response = await fetch(url, init);
    const raw = await response.text();
    event.response = { status: response.status, body: JSON.parse(raw) };
    event.finishedAt = new Date().toISOString();
    return response;
  } catch (error) { event.error = error.message; event.finishedAt = new Date().toISOString(); throw error; }
};
const restClient = new LMStudioRestClient({ baseUrl, defaultModel: model, fetchImpl, timeoutMs: 180000 });
const context = await resolveContextWindow({ restClient, modelId: model });
if (!context?.loadedContextLength) throw new Error("Load the requested model explicitly before running the study");
state.loadedContextTokens = context.loadedContextLength;
const schemaRegistry = new PromptSchemaRegistry();
const recorder = new PromptRecorder(root);
await recorder.prepare();
function makeHandler(assessment = false) {
  const maxOutputTokens = Math.min(4096, Math.floor(context.loadedContextLength * 0.4));
  const handler = buildLmStudioHandler({ restClient, schemaRegistry, modelKey: model, promptRecorder: recorder,
    acceptReasoningJson: true, maxOutputTokens, promptTimeoutMs: 120000,
    ...(assessment ? { systemPrompt: KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT } : {}),
  });
  handler.graphPromptBudgetTokens = deriveContextBudget({ contextLength: context.loadedContextLength,
    reservedTokens: estimateTokens(handler.systemPrompt) + 650, reservedOutputTokens: maxOutputTokens });
  return handler;
}
let server, rawClient;
const tcpEvents = async (commands) => {
  const event = { kind: "cheetah", startedAt: new Date().toISOString(), request: { commands } };
  currentEvents?.push(event);
  const responses = await rawClient.execute(commands);
  event.response = responses.map(response => ({ ...response, decodedPayload: decodeCheetahPayload(response) }));
  event.finishedAt = new Date().toISOString();
  return responses;
};
const cheetahClient = { database: "webnlg_study", execute: tcpEvents,
  async putValue(key, payload, options) {
    const event = { kind: "cheetah-value", startedAt: new Date().toISOString(), request: { operation: "putValue", key, payload, options: options ?? null } };
    currentEvents?.push(event);
    const absoluteKey = await rawClient.putValue(key, payload, options);
    event.response = { absoluteKey }; event.finishedAt = new Date().toISOString();
    return absoluteKey;
  },
};
async function start() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  server = await startCheetahServer({ port, dataDir, binaryPath: path.resolve("thirds/cheetah/cheetah-server"), build: false });
  rawClient = new CheetahTcpClient({ port, database: cheetahClient.database, timeoutMs: 5000 });
  state.lifecycle.push({ event: "server-start", at: new Date().toISOString(), port });
}
async function stop() {
  await rawClient?.close(); await server?.stop();
  state.lifecycle.push({ event: "server-stop", at: new Date().toISOString() });
}
const deadline = Date.now() + durationMinutes * 60000;
async function phase(name, run) {
  for (const definition of cases) {
    if (state.cases[definition.id][name]) continue;
    if (Date.now() >= deadline) throw new Error("session-timeout");
    const record = { startedAt: new Date().toISOString(), events: [] };
    currentEvents = record.events;
    try { record.result = await run(definition); }
    catch (error) { record.error = error.message; }
    record.finishedAt = new Date().toISOString();
    state.cases[definition.id][name] = record;
    currentEvents = null;
    await save();
    const result = record.result;
    console.log(JSON.stringify({ phase: name, case: definition.id, written: result?.written,
      concepts: result?.results?.map(r => ({ aspect: r.concept.aspect, answer: r.recalled.answer, grounded: r.recalled.grounded, confidence: r.recalled.modelConfidence })), error: record.error }));
  }
}
try {
  await start();
  const answer = (question) => answerGraphConcepts(question, { assessmentHandler: makeHandler(true), handler: makeHandler(), cheetahClient, schemaRegistry, maxRounds: 6, deadline });
  if (!continuing) await phase("before", definition => answer(definition.question_a));
  await phase(continuing ? "source_repair" : "learn", definition => learnGraphText(definition.sources.map(s => s.text).join(" "), {
    handler: makeHandler(), cheetahClient, schemaRegistry, sourceId: definition.sources.map(s => s.id).join("+"),
    entityHints: [definition.entity], deadline,
  }));
  await stop(); await save(); await start();
  if (!continuing) await phase("retest_a", definition => answer(definition.question_a));
  await phase(continuing ? "retest_repaired" : "retest_b", definition => answer(definition.question_b));
  if (!state.bonus && limit === 20) {
    const record = { startedAt: new Date().toISOString(), events: [] }; currentEvents = record.events;
    record.result = await reasonGraph("Which botanical family does the ingredient of Ajoblanco belong to?", { handler: makeHandler(), cheetahClient, schemaRegistry, maxRounds: 8, deadline, diagnosticConfidence: true, focusEntity: "Ajoblanco" });
    record.finishedAt = new Date().toISOString(); state.bonus = record; currentEvents = null;
  }
  if (!state.control && limit === 20) {
    const record = { startedAt: new Date().toISOString(), events: [] }; currentEvents = record.events;
    record.result = await answer("What is the motto of NeverTaught Research Institute ZQ7419?");
    record.finishedAt = new Date().toISOString(); state.control = record; currentEvents = null;
  }
  state.stopReason = null; state.stopReasonCode = null;
} catch (error) { state.error = error.message; state.stopReason = error.message.includes("timeout") ? "session-timeout" : "analysis-error"; state.stopReasonCode = state.stopReason; }
finally { currentEvents = null; await stop(); state.finishedAt = new Date().toISOString(); await save(); }
console.log(`Study saved: ${stateFile}`);
if (state.stopReason) process.exitCode = 1;
