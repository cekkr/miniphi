#!/usr/bin/env node
// Controlled prompt ablation. Runtime extraction/retrieval stays in src/libs;
// the baseline removes only the new templates/instructions, never the schema.
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
import { learnGraphText } from "../src/libs/cheetah-graph-learning.js";
import { answerGraphConcepts, KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT } from "../src/libs/cheetah-knowledge-assessment.js";
import { resolveContextWindow } from "../src/libs/model-catalog.js";
import { deriveContextBudget, estimateTokens } from "../src/libs/context-graph.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, token, i, all) => {
  if (token.startsWith("--")) out.push([token.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]);
  return out;
}, []));
const repeats = Number(args.repeats ?? 2);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error("--repeats must be 1..3");
const root = path.resolve(args.output ?? `.miniphi/cheetah/response-structure/${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const reportFile = path.join(root, "report.json");
try { await fs.access(reportFile); throw new Error("Choose a fresh --output directory"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const manifestRaw = await fs.readFile("docs/benchmarks/webnlg-study-cases.json", "utf8");
const manifest = JSON.parse(manifestRaw);
const selected = args["case-ids"] ? String(args["case-ids"]).split(",") : ["02-music", "07-demography", "11-shipbuilding", "17-botany"];
if (!selected.length || selected.length > 4 || new Set(selected).size !== selected.length) throw new Error("--case-ids requires 1..4 distinct manifest ids");
const cases = selected.map(id => manifest.cases.find(c => c.id === id));
if (cases.some(c => !c)) throw new Error("Missing frozen case");
const armNames = args.arms === undefined || args.arms === "both" ? ["schema-only", "templates"] : [args.arms];
if (armNames.some(arm => !["schema-only", "templates"].includes(arm))) throw new Error("--arms must be both, schema-only or templates");
const sha = data => createHash("sha256").update(data).digest("hex");
if (sha(await fs.readFile("thirds/cheetah/studies/datasets/web_nlg/train.json")) !== manifest.dataset_sha256) throw new Error("Dataset fingerprint mismatch");
const runtimeFiles = ["src/libs/cheetah-graph-learning.js", "src/libs/cheetah-knowledge-assessment.js", "src/libs/cheetah-prompt-contract.js", "src/libs/prompt-schema-registry.js", "src/libs/lmstudio-handler.js"];
const runtimeHashes = Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, sha(await fs.readFile(file))])));
const model = args.model ?? "qwen3-4b-thinking-2507-mlx";
const baseUrl = args["base-url"] ?? process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234";
const report = { version: 1, startedAt: new Date().toISOString(), model, baseUrl, repeats, armNames,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runtimeHashes,
  manifestSha256: sha(manifestRaw), definitions: cases, trials: [],
  protocol: "Same model/runtime/schemas, fresh graph per arm/repeat, restart after teaching, two frozen question wordings. Alternate arm order each repeat. Baseline removes response_templates and response_instructions only. Expected aliases never enter inference.",
};
const save = () => fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
let events = null;
const fetch = createNodeHttpFetch();
const restClient = new LMStudioRestClient({ baseUrl, defaultModel: model, timeoutMs: 180000,
  fetchImpl: async (url, init) => {
    const event = { startedAt: new Date().toISOString(), request: { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null } };
    events?.push(event);
    try { const response = await fetch(url, init); event.response = { status: response.status, body: JSON.parse(await response.text()) }; event.finishedAt = new Date().toISOString(); return response; }
    catch (error) { event.error = error.message; event.finishedAt = new Date().toISOString(); throw error; }
  },
});
const context = await resolveContextWindow({ restClient, modelId: model });
if (!context.loadedContextLength) throw new Error("Load the requested model before benchmarking");
report.loadedContextTokens = context.loadedContextLength;
class SchemaOnlyRegistry extends PromptSchemaRegistry {
  buildResponseContract(id, options) {
    const { response_templates, response_instructions, ...contract } = super.buildResponseContract(id, options);
    return contract;
  }
}
const normalize = value => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/(?<=\d),(?=\d)/g, "").replace(/(\d)\.0\b/g, "$1").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function score(definition, result) {
  const answers = result?.results?.filter(r => r.recalled.grounded).map(r => r.recalled.answer) ?? [];
  const matched = definition.expected_facets.filter(f => f.answers.some(alias => answers.some(answer => ` ${normalize(answer)} `.includes(` ${normalize(alias)} `)))).length;
  return { matched, total: definition.expected_facets.length, complete: matched === definition.expected_facets.length,
    groundedAnswers: answers.map(normalize).sort(), questionRepairs: result?.results?.filter(r => r.concept.questionRepair).length ?? 0 };
}
const deadline = Date.now() + 30 * 60000;
let server, client;
async function start(dataDir) {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  server = await startCheetahServer({ port, dataDir, binaryPath: path.resolve("thirds/cheetah/cheetah-server"), build: false });
  client = new CheetahTcpClient({ port, database: "webnlg_structure", timeoutMs: 5000 });
}
async function stop() { await client?.close(); await server?.stop(); client = null; server = null; }
async function record(trial, phase, definition, run) {
  if (Date.now() >= deadline) throw new Error("session-timeout");
  const entry = { phase, caseId: definition?.id ?? "untaught-control", startedAt: new Date().toISOString(), exchanges: [] };
  trial.records.push(entry); events = entry.exchanges;
  try { entry.result = await run(); if (phase.startsWith("ask_")) entry.score = score(definition, entry.result); }
  catch (error) { entry.error = error.message; if (phase.startsWith("ask_")) entry.score = score(definition, null); }
  entry.finishedAt = new Date().toISOString(); events = null; await save();
  console.log(JSON.stringify({ arm: trial.arm, repeat: trial.repeat, phase, case: entry.caseId, score: entry.score, written: entry.result?.written, error: entry.error }));
}
try {
  for (let repeat = 1; repeat <= repeats; repeat += 1) for (const arm of repeat % 2 ? armNames : [...armNames].reverse()) {
    const trial = { arm, repeat, startedAt: new Date().toISOString(), records: [], lifecycle: [] }; report.trials.push(trial);
    const dir = path.join(root, `${arm}-${repeat}`); const dataDir = path.join(dir, "data");
    const registry = arm === "templates" ? new PromptSchemaRegistry() : new SchemaOnlyRegistry();
    const recorder = new PromptRecorder(dir); await recorder.prepare();
    const makeHandler = assessment => {
      const maxOutputTokens = Math.min(4096, Math.floor(context.loadedContextLength * 0.4));
      const handler = buildLmStudioHandler({ restClient, schemaRegistry: registry, modelKey: model, promptRecorder: recorder,
        acceptReasoningJson: true, maxOutputTokens, promptTimeoutMs: 120000,
        ...(assessment ? { systemPrompt: KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT } : {}),
      });
      handler.graphPromptBudgetTokens = deriveContextBudget({ contextLength: context.loadedContextLength,
        reservedTokens: estimateTokens(handler.systemPrompt) + 650, reservedOutputTokens: maxOutputTokens });
      return handler;
    };
    const answer = question => answerGraphConcepts(question, { handler: makeHandler(false), assessmentHandler: makeHandler(true), cheetahClient: client, schemaRegistry: registry, maxRounds: 6, deadline });
    try {
      await start(dataDir); trial.lifecycle.push({ event: "start", at: new Date().toISOString() });
      for (const definition of cases) await record(trial, "learn", definition, () => learnGraphText(definition.sources.map(s => s.text).join(" "), {
        handler: makeHandler(false), cheetahClient: client, schemaRegistry: registry, entityHints: [definition.entity],
        sourceId: definition.sources.map(s => s.id).join("+"), deadline,
      }));
      await stop(); trial.lifecycle.push({ event: "stop", at: new Date().toISOString() });
      await start(dataDir); trial.lifecycle.push({ event: "restart", at: new Date().toISOString() });
      for (const wording of ["a", "b"]) for (const definition of cases) await record(trial, `ask_${wording}`, definition, () => answer(definition[`question_${wording}`]));
      await record(trial, "control", null, () => answer("What is the motto of NeverTaught Research Institute ZQ7419?"));
    } finally { await stop(); trial.lifecycle.push({ event: "stop", at: new Date().toISOString() }); trial.finishedAt = new Date().toISOString(); await save(); }
  }
  report.summary = {};
  for (const arm of armNames) {
    const records = report.trials.filter(t => t.arm === arm).flatMap(t => t.records);
    const scored = records.filter(r => r.score);
    const requests = records.flatMap(r => r.exchanges).filter(e => e.request.body?.messages);
    const registry = new PromptSchemaRegistry();
    const valid = requests.filter(e => {
      const message = e.response?.body?.choices?.[0]?.message;
      const schemaId = e.request.body.response_format.json_schema.schema.$id.split("@")[0];
      return registry.validateOutcome(schemaId, message?.content || message?.reasoning_content || "")?.status === "ok";
    }).length;
    const groups = cases.flatMap(c => ["a", "b"].map(wording => scored.filter(r => r.caseId === c.id && r.phase === `ask_${wording}`)));
    report.summary[arm] = { matched: scored.reduce((n, r) => n + r.score.matched, 0), total: scored.reduce((n, r) => n + r.score.total, 0),
      completeQuestions: scored.filter(r => r.score.complete).length, questions: scored.length,
      modelCalls: requests.length, schemaValidResponses: valid, invalidResponses: requests.length - valid,
      questionRepairs: scored.reduce((n, r) => n + r.score.questionRepairs, 0),
      stableAnswerSets: repeats > 1 ? groups.filter(group => group.length === repeats && group.every(r => JSON.stringify(r.score.groundedAnswers) === JSON.stringify(group[0].score.groundedAnswers))).length : null,
      repeatedQuestionGroups: repeats > 1 ? groups.length : null,
      controlsDeclined: records.filter(r => r.phase === "control" && r.result?.results?.length && r.result.results.every(x => !x.recalled.grounded)).length,
      runtimeErrors: records.filter(r => r.error).length,
    };
  }
  for (const file of runtimeFiles) if (sha(await fs.readFile(file)) !== runtimeHashes[file]) throw new Error("Runtime changed during benchmark");
  report.stopReason = null;
} catch (error) { report.error = error.message; report.stopReason = error.message.includes("timeout") ? "session-timeout" : "analysis-error"; process.exitCode = 1; }
finally { events = null; await stop(); report.finishedAt = new Date().toISOString(); await save(); }
console.log(JSON.stringify({ reportFile, summary: report.summary, error: report.error }, null, 2));
