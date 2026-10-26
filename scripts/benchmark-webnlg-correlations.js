#!/usr/bin/env node
// Instrumentation only: both arms use the same taught/restarted factual graph.
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { LMStudioRestClient, createNodeHttpFetch } from "../src/libs/lmstudio-api.js";
import { CheetahTcpClient, startCheetahServer } from "../src/libs/cheetah-binder.js";
import { buildLmStudioHandler } from "../src/commands/cheetah-learn.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import PromptRecorder from "../src/libs/prompt-recorder.js";
import { learnGraphText, reasonGraph } from "../src/libs/cheetah-graph-learning.js";
import { recallGraphCorrelations } from "../src/libs/cheetah-graph-correlations.js";
import { answerGraphConcepts, KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT } from "../src/libs/cheetah-knowledge-assessment.js";
import { getWordNetLexicon } from "../src/libs/wordnet-lexicon.js";
import { resolveContextWindow } from "../src/libs/model-catalog.js";
import { deriveContextBudget, estimateTokens } from "../src/libs/context-graph.js";
const args = Object.fromEntries(process.argv.slice(2).reduce((out, token, i, all) => {
  if (token.startsWith("--")) out.push([token.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]);
  return out;
}, []));
const root = path.resolve(args.output ?? `.miniphi/cheetah/correlations/${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const reportFile = path.join(root, "report.json");
try { await fs.access(reportFile); throw new Error("Choose a fresh output directory"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const sha = value => createHash("sha256").update(value).digest("hex");
const manifestRaw = await fs.readFile("docs/benchmarks/webnlg-study-cases.json", "utf8"), manifest = JSON.parse(manifestRaw);
if (sha(await fs.readFile("thirds/cheetah/studies/datasets/web_nlg/train.json")) !== manifest.dataset_sha256) throw new Error("Dataset mismatch");
const ids = args["case-ids"] ? String(args["case-ids"]).split(",") : manifest.cases.map(c => c.id);
const cases = ids.map(id => manifest.cases.find(c => c.id === id));
if (cases.some(c => !c) || new Set(ids).size !== ids.length || !ids.length) throw new Error("Unknown or duplicate case ids");
// Frozen before inference; never supplied during teaching/vocabulary proposal.
const withheld = {
  "02-music": "Identify Aaron Deer's instrument and place of provenance.",
  "07-demography": "How many inhabitants are registered for Antioch California?",
  "11-shipbuilding": "Name the shipwright responsible for A-Rosa Luna and the motor propelling A-Rosa Luna.",
  "17-botany": "Identify Almond's botanical lineage family and systematic order.",
};
const runtimeFiles = ["src/libs/wordnet-lexicon.js", "src/libs/wordnet-installer.js","src/libs/cheetah-graph-learning.js", "src/libs/cheetah-graph-correlations.js", "src/libs/cheetah-graph-identity.js", "src/libs/cheetah-graph-io.js", "src/libs/cheetah-knowledge-assessment.js", "src/libs/cheetah-prompt-contract.js", "src/libs/prompt-schema-registry.js", "src/libs/lmstudio-handler.js", "src/commands/cheetah-learn.js"];
const runtimeHashes = Object.fromEntries(await Promise.all(runtimeFiles.map(async f => [f, sha(await fs.readFile(f))])));
const model = args.model ?? "qwen3-4b-thinking-2507-mlx", baseUrl = args["base-url"] ?? process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234";
const lexicon = getWordNetLexicon({ directory: args["wordnet-dir"], languages: args["wordnet-languages"] ?? "eng,ita,fra,spa" }); await lexicon.load();
const report = { version: 2, lexicon: lexicon.provenance, lexiconFingerprint: lexicon.fingerprint, startedAt: new Date().toISOString(), model, baseUrl, runtimeHashes,
  cheetahRevision: execFileSync("git", ["-C", "thirds/cheetah", "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), manifestSha256: sha(manifestRaw),
  protocol: "Teach once with WordNet/OMW correlation pre-check and non-factual lexical cues (no LM vocabulary calls), restart Cheetah, compare baseline and correlated retrieval on identical factual edges. Alternate arm order by case. Question B is unchanged from the twenty-case manifest; separate withheld synonym questions never enter learning. Fresh model histories per prompt. Alias scoring is evaluator-only source coverage, not entailment.",
  definitions: cases, withheld, records: [], lifecycle: [],
};
const save = () => fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
let events = null;
const fetch = createNodeHttpFetch();
const restClient = new LMStudioRestClient({ baseUrl, defaultModel: model, timeoutMs: 180000, fetchImpl: async (url, init) => {
  const e = { kind: "lmstudio", at: new Date().toISOString(), request: { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null } }; events?.push(e);
  try { const response = await fetch(url, init); e.response = { status: response.status, body: JSON.parse(await response.text()) }; return response; }
  catch (error) { e.error = error.message; throw error; }
} });
const context = await resolveContextWindow({ restClient, modelId: model });
if (!context.loadedContextLength) throw new Error("Load the exact model before benchmarking");
report.loadedContextTokens = context.loadedContextLength;
const registry = new PromptSchemaRegistry(), recorder = new PromptRecorder(root); await recorder.prepare();
function handler(kind = "facts") {
  const maxOutputTokens = Math.min(4096, Math.floor(context.loadedContextLength * 0.4));
  const h = buildLmStudioHandler({ restClient, schemaRegistry: registry, modelKey: model, promptRecorder: recorder,
    acceptReasoningJson: true, promptTimeoutMs: 120000, maxOutputTokens,
    ...(kind === "assessment" ? { systemPrompt: KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT } : {}),
  });
  h.graphPromptBudgetTokens = deriveContextBudget({ contextLength: context.loadedContextLength, reservedTokens: estimateTokens(h.systemPrompt) + 650, reservedOutputTokens: maxOutputTokens });
  return h;
}
const duration = Number(args["duration-minutes"] ?? 45);
if (!Number.isFinite(duration) || duration < 1 || duration > 90) throw new Error("duration-minutes must be 1..90");
const deadline = Date.now() + duration * 60000;
let server, rawClient;
const client = { database: "webnlg_correlations", async execute(commands) {
  const e = { kind: "cheetah", at: new Date().toISOString(), request: { commands } }; events?.push(e);
  const result = await rawClient.execute(commands); e.response = result; return result;
}, async putValue(key, payload, options) {
  const e = { kind: "cheetah-value", at: new Date().toISOString(), request: { key, payload, options: options ?? null } }; events?.push(e);
  const result = await rawClient.putValue(key, payload, options); e.response = { absoluteKey: result }; return result;
} };
async function start() {
  const listener = net.createServer(); await new Promise(r => listener.listen(0, "127.0.0.1", r)); const port = listener.address().port; await new Promise(r => listener.close(r));
  server = await startCheetahServer({ port, dataDir: path.join(root, "data"), binaryPath: path.resolve("thirds/cheetah/cheetah-server"), build: false });
  rawClient = new CheetahTcpClient({ port, database: client.database, timeoutMs: 5000 });
  report.lifecycle.push({ event: "start", at: new Date().toISOString(), port });
}
async function stop() { if (rawClient) { await rawClient.close(); rawClient = null; } if (server) { await server.stop(); server = null; report.lifecycle.push({ event: "stop", at: new Date().toISOString() }); } }
const normalize = value => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/(?<=\d),(?=\d)/g, "").replace(/(\d)\.0\b/g, "$1").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
async function record(phase, definition, arm, question, run) {
  if (Date.now() >= deadline) throw new Error("session-timeout");
  const entry = { phase, caseId: definition?.id ?? "untaught", arm, question, startedAt: new Date().toISOString(), events: [] }; report.records.push(entry); events = entry.events;
  try { entry.result = await run(); } catch (error) { entry.error = error.message; }
  if (definition && phase !== "learn") {
    const answers = entry.result?.results?.filter(r => r.recalled.grounded).map(r => r.recalled.answer) ?? [];
    const facets = definition.expected_facets.map(f => ({ aspect: f.aspect, matched: f.answers.some(alias => answers.some(a => ` ${normalize(a)} `.includes(` ${normalize(alias)} `))) }));
    entry.score = { matched: facets.filter(f => f.matched).length, total: facets.length, facets, complete: facets.every(f => f.matched) };
  }
  entry.finishedAt = new Date().toISOString(); events = null; await save();
  console.log(JSON.stringify({ phase, case: entry.caseId, arm, score: entry.score, written: entry.result?.written, cues: entry.result?.correlations?.written,
    correlationError: entry.result?.correlations?.error, error: entry.error }));
}
try {
  if (args["reuse-state"]) {
    const sourceFile = path.resolve(args["reuse-state"]), raw = await fs.readFile(sourceFile, "utf8"), previous = JSON.parse(raw);
    if (previous.stopReason !== null || previous.lexiconFingerprint !== report.lexiconFingerprint || previous.manifestSha256 !== report.manifestSha256 || previous.cheetahRevision !== report.cheetahRevision) throw new Error("Incompatible learning origin");
    const sourceLearning = cases.map(c => previous.records.find(r => r.phase === "learn" && r.caseId === c.id));
    if (sourceLearning.some(r => !r?.finishedAt || r.error || r.result?.fallback)) throw new Error("Incomplete learning origin");
    await fs.cp(path.join(path.dirname(sourceFile), "data"), path.join(root, "data"), { recursive: true, errorOnExist: true, force: false });
    report.reusedLearning = { sourceFile, sha256: sha(raw), runtimeHashes: previous.runtimeHashes, startedAt: previous.startedAt, finishedAt: previous.finishedAt };
    report.protocol += " This continuation copies the completed prior Cheetah database and retains its original learning records/timestamps. No source is retaught.";
    report.records.push(...structuredClone(sourceLearning));
    report.lifecycle.push({ event: "copy-completed-database", at: new Date().toISOString(), sourceFile });
  }
  await start();
  if (!report.reusedLearning) for (const c of cases) await record("learn", c, "shared", null, () => learnGraphText(c.sources.map(s => s.text).join(" "), {
    handler: handler(), lexicon, correlate: true, entityHints: [c.entity], cheetahClient: client, schemaRegistry: registry,
    sourceId: c.sources.map(s => s.id).join("+"), deadline,
  }));
  await stop(); await start();
  const answer = (q, arm) => answerGraphConcepts(q, { handler: handler(), assessmentHandler: handler("assessment"), cheetahClient: client, schemaRegistry: registry, deadline, maxRounds: 6, lexicon, correlate: arm === "correlated" });
  for (const [i, c] of cases.entries()) for (const [phase, q] of [["question_b", c.question_b], ...(withheld[c.id] ? [["withheld", withheld[c.id]]] : [])]) {
    for (const arm of i % 2 ? ["correlated", "baseline"] : ["baseline", "correlated"]) await record(phase, c, arm, q, () => answer(q, arm));
  }
  const control = "What is the motto of NeverTaught Research Institute ZQ7419?";
  for (const arm of ["baseline", "correlated"]) await record("control", null, arm, control, () => answer(control, arm));
  if (cases.some(c => c.id === "17-botany")) for (const arm of ["baseline", "correlated"]) {
    const q = "What genus does Almond belong to?";
    await record("role_control", null, arm, q, () => answer(q, arm));
  }
  if (cases.some(c => c.id === "17-botany")) {
    for (const [language, family, order, question] of [
      ["ita", "famiglia", "ordine", "Qual è la famiglia botanica di Almond?"],
      ["fra", "famille", "ordre", "Quelle est la famille botanique de Almond ?"],
      ["spa", "familia", "orden", "¿Cuál es la familia botánica de Almond?"],
    ]) {
      for (const term of [family, order]) await record("multilingual_recall", null, language, `Almond ${term}`, () => recallGraphCorrelations(`Almond ${term}`, {
        cheetahClient: client, lexicon, focusEntity: "Almond", aspect: term, deadline,
      }));
      await record("multilingual_answer", null, language, question, () => reasonGraph(question, {
        handler: handler(), cheetahClient: client, schemaRegistry: registry, correlate: true, lexicon, focusEntity: "Almond", aspect: family, deadline, maxRounds: 4,
      }));
    }
  }
  report.summary = {};
  for (const arm of ["baseline", "correlated"]) {
    const records = report.records.filter(r => r.arm === arm);
    report.summary[arm] = Object.fromEntries(["question_b", "withheld"].map(phase => {
      const rows = records.filter(r => r.phase === phase);
      return [phase, { matched: rows.reduce((n, r) => n + r.score.matched, 0), total: rows.reduce((n, r) => n + r.score.total, 0),
        complete: rows.filter(r => r.score.complete).length, cases: rows.length,
        correlationHits: rows.flatMap(r => r.result?.results ?? []).filter(r => r.recalled.correlations?.facts?.length).length,
        modelCalls: rows.flatMap(r => r.events).filter(e => e.kind === "lmstudio" && e.request.body?.messages).length }];
    }));
    report.summary[arm].controlsDeclined = records.filter(r => r.phase === "control" && r.result?.results?.length && r.result.results.every(x => !x.recalled.grounded)).length;
    report.summary[arm].unsupportedRolesDeclined = records.filter(r => r.phase === "role_control" && r.result?.results?.length && r.result.results.every(x => !x.recalled.grounded)).length;
  }
  report.learning = { newCueLinks: report.records.filter(r => r.phase === "learn").reduce((n, r) => n + (r.result?.correlations?.written ?? 0), 0),
    knownCueLinks: report.records.filter(r => r.phase === "learn").reduce((n, r) => n + (r.result?.correlations?.known ?? 0), 0),
    failures: report.records.filter(r => r.phase === "learn" && (r.error || r.result?.fallback || r.result?.correlations?.fallback)).map(r => ({ caseId: r.caseId, error: r.error ?? r.result?.correlations?.error ?? r.result?.error })) };
  for (const file of runtimeFiles) if (sha(await fs.readFile(file)) !== runtimeHashes[file]) throw new Error("Runtime changed during benchmark");
  report.stopReason = null;
} catch (error) { report.error = error.message; report.stopReason = error.message.includes("timeout") ? "session-timeout" : "analysis-error"; process.exitCode = 1; }
finally { events = null; await stop(); report.finishedAt = new Date().toISOString(); await save(); }
console.log(JSON.stringify({ reportFile, summary: report.summary, learning: report.learning, error: report.error }, null, 2));
