import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CheetahTcpClient, buildNodeGet, buildNodeSet, buildNeighbors, buildEdgeSetBatch, decodeCheetahPayload } from "./cheetah-binder.js";
import { resolveKnowledgeLookupConfig, ensureAskerAnchor, listOpenQuestions, resolveOpenQuestion, slugify } from "./cheetah-knowledge-client.js";
import { learnGraphText } from "./cheetah-graph-learning.js";
import { answerGraphConcepts, KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT } from "./cheetah-knowledge-assessment.js";
import { buildLmStudioHandler } from "./cheetah-model-handler.js";
import { deriveContextBudget, estimateTokens } from "./context-graph.js";
import PromptSchemaRegistry from "./prompt-schema-registry.js";
import { getWordNetLexicon } from "./wordnet-lexicon.js";
import { resolveContextWindow } from "./model-catalog.js";
import PromptRecorder from "./prompt-recorder.js";
import { buildStopReasonInfo } from "./lmstudio-error-utils.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const integer = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(max, Math.floor(Number(value))) : fallback;
const enabled = (value) => value === true || /^(1|true|on|yes)$/iu.test(String(value));

/** A separate opt-in from session-context recall and the legacy topic lookup. */
export function resolveKnowledgeConfig(configData = {}, env = process.env) {
  const section = configData?.knowledge ?? {};
  const connection = resolveKnowledgeLookupConfig({ knowledgeLookup: { cheetah: {
    ...section.cheetah, database: section.cheetah?.database ?? "miniphi_webnlg",
  } } }, env);
  return { ...connection, enabled: enabled(env.MINIPHI_KNOWLEDGE ?? section.enabled),
    correlate: enabled(section.correlate), wordnetDirectory: section.wordnetDirectory,
    learnFromInputs: section.learnFromInputs !== false,
    wordnetLanguages: section.wordnetLanguages ?? "eng,ita,fra,spa",
    maxActions: integer(section.maxActions, 6, 16), maxRounds: integer(section.maxRounds, 4, 8),
    timeoutMs: integer(section.timeoutMs, 120000, 600000),
    connectTimeoutMs: connection.timeoutMs,
  };
}

const compactCheck = (result) => ({
  question: result.question,
  concepts: result.results.map(({ concept, recalled }) => ({
    question: concept.question, prior_answer: concept.prior_answer,
    self_confidence: concept.self_confidence, diagnostic_only: true,
    answer: recalled.grounded ? recalled.answer : null, grounded: recalled.grounded,
    correction: recalled.grounded && concept.prior_answer.trim().toLowerCase() !== recalled.answer.trim().toLowerCase(),
    evidence_ids: recalled.evidenceIds,
    evidence: recalled.evidence.filter(e => recalled.evidenceIds.includes(e.id)).map(({ id, subject, relation, object, quote, sourceId }) => ({ id, subject, relation, object, quote, source_id: sourceId })),
    stop_reason: buildStopReasonInfo({ fallbackReason: recalled.stopReason }).code,
    stop_reason_detail: recalled.stopReason,
  })),
  needs_more_context: result.needsLearning, missing_snippets: [],
  stop_reason: result.stopReason ?? result.results.find(r => !r.recalled.grounded)?.recalled.stopReason ?? null,
});

/**
 * Model-independent reuse of the tested graph pipeline. Sources come from the
 * caller's actual observations; the model may select an id, never supply its
 * own purported source text. Diagnostic mistakes live outside factual edges.
 */
export class KnowledgeRuntime {
  constructor({ client, cheetahClient, config, model, contextLength, schemaRegistry = new PromptSchemaRegistry(), trace = null, baseDir = null, sessionId = "knowledge", promptRecorder = null, sessionDeadline = null } = {}) {
    Object.assign(this, { client, cheetahClient, config, model, contextLength, schemaRegistry, trace, baseDir, sessionId, promptRecorder, sessionDeadline });
    this.promptRecorder = promptRecorder ?? (baseDir ? new PromptRecorder(baseDir) : null);
    this.sources = new Map();
    this.sourceSequence = 0;
    this.learned = new Set();
    this.records = [];
    this.actions = 0;
    this.revision = 0;
    this.promptCache = new Map();
    this.windowModel = model;
    this.lexicon = config.correlate ? getWordNetLexicon({ directory: config.wordnetDirectory, languages: config.wordnetLanguages }) : undefined;
  }

  configure({ model, contextLength } = {}) {
    if (model) this.model = model;
    this.contextLength = contextLength ?? null;
    this.windowModel = model;
  }

  async contextWindow(model, deadline = this.sessionDeadline ?? Infinity) {
    if (model !== this.windowModel || !this.contextLength) {
      // Inventory calls need a much shorter deadline than generation. A view
      // of the client supplies that timeout without changing its main policy.
      const inventory = Object.create(this.client);
      inventory.timeoutMs = Math.max(1, Math.min(this.config.connectTimeoutMs, deadline - Date.now()));
      const window = await resolveContextWindow({ restClient: inventory, modelId: model });
      this.contextLength = window?.loadedContextLength ?? null;
      this.windowModel = model;
    }
    return this.contextLength ?? 4000;
  }

  // Split by UTF-8 bytes, keeping every page independently source-addressable.
  observe({ text, source, kind }) {
    if (!["workspace", "web", "validation"].includes(kind) || typeof text !== "string" || !text.trim()) return [];
    let remaining = text;
    const sources = [];
    for (let page = 0; remaining && page < 4; page += 1) {
      let end = Math.min(remaining.length, 4000);
      while (Buffer.byteLength(remaining.slice(0, end), "utf8") > 4000) end -= 1;
      if (end < remaining.length && /[\uD800-\uDBFF]/u.test(remaining[end - 1])) end -= 1;
      const boundary = Math.max(remaining.lastIndexOf("\n", end - 1), remaining.lastIndexOf(". ", end - 1) + 1);
      if (end < remaining.length && boundary > end / 2) end = boundary;
      const snippet = remaining.slice(0, end);
      remaining = remaining.slice(end);
      const fingerprint = hash(`${source}\0${page}\0${snippet}`);
      const known = [...this.sources.values()].find(entry => entry.fingerprint === fingerprint);
      const id = known?.id ?? `source:s${++this.sourceSequence}`;
      const entry = { id, fingerprint, text: snippet, source, kind, page, truncated: Boolean(remaining) };
      this.sources.set(id, entry);
      sources.push({ source_id: id, source, page, bytes: Buffer.byteLength(snippet), truncated: entry.truncated });
    }
    while (this.sources.size > 64) this.sources.delete(this.sources.keys().next().value);
    return sources;
  }

  _handler(model, assessment = false) {
    const runtime = this;
    const recorder = { async record(exchange) {
      const persisted = await runtime.promptRecorder?.record(exchange);
      await runtime.trace?.record({ kind: "knowledge", label: exchange.label,
        request: exchange.request, response: exchange.response, error: exchange.error,
        validation: exchange.response?.schemaValidation });
      return persisted;
    } };
    const window = this.contextLength ?? 4000;
    const maxOutputTokens = Math.min(4096, Math.floor(window * 0.4));
    const handler = buildLmStudioHandler({ restClient: this.client, schemaRegistry: this.schemaRegistry,
      modelKey: model, maxOutputTokens, promptTimeoutMs: this.config.timeoutMs,
      acceptReasoningJson: true, promptRecorder: recorder,
      ...(assessment ? { systemPrompt: KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT } : {}),
    });
    handler.graphPromptBudgetTokens = deriveContextBudget({ contextLength: window,
      reservedTokens: estimateTokens(handler.systemPrompt), reservedOutputTokens: maxOutputTokens });
    return handler;
  }

  async _run(operation, request, work) {
    const model = request.model ?? this.model;
    const deadline = Math.min(request.sessionDeadline ?? this.sessionDeadline ?? Infinity, Date.now() + this.config.timeoutMs);
    let response;
    if (deadline <= Date.now()) response = { ok: false, stop_reason: "session-timeout" };
    else if (this.actions >= this.config.maxActions) response = { ok: false, stop_reason: "max-actions" };
    else if (operation !== "questions" && (typeof model !== "string" || !model.trim())) response = { ok: false, stop_reason: "invalid-response", error: "A selected model is required" };
    else {
      this.actions += 1;
      try {
        await this.contextWindow(model, deadline);
        response = await work({ model, deadline });
      }
      catch (error) { response = { ok: false, stop_reason: buildStopReasonInfo({ error: error.message }).code ?? "analysis-error", error: error.message }; }
    }
    const stop = buildStopReasonInfo({ fallbackReason: response.stop_reason });
    response.stop_reason_detail = response.stop_reason ?? null;
    response.stop_reason = stop.code;
    response.stop_reason_code = stop.code;
    this.records.push({ operation, model, at: new Date().toISOString(), response });
    await this.persist().catch(() => {});
    return response;
  }

  async check(request = {}) {
    return this._run("check", request, async ({ model, deadline }) => {
      const question = request.question?.trim();
      if (!question || question.length > 1000 || !model) return { ok: false, stop_reason: "invalid-response", error: "knowledge_check requires a question (1..1000 characters) and a selected model" };
      await ensureAskerAnchor(this.cheetahClient);
      const result = await answerGraphConcepts(question, {
        assessmentHandler: this._handler(model, true), handler: this._handler(model),
        cheetahClient: this.cheetahClient, schemaRegistry: this.schemaRegistry,
        deadline, maxRounds: this.config.maxRounds, correlate: this.config.correlate, lexicon: this.lexicon,
      });
      const response = { ok: !result.assessment.stopReason, ...compactCheck(result) };
      // Full graph traces are persisted separately; the next prompt only gets
      // source evidence and diagnostics, never the graph's entire prompt log.
      this.records.push({ operation: "graph-trace", model, result });
      for (const concept of response.concepts.filter(c => c.grounded)) {
        // Resolve only an existing question, never create a resolved placeholder.
        const id = `hypothesis:${slugify(concept.question).slice(0, 60)}`;
        const [previous] = await this.cheetahClient.execute([buildNodeGet(id)]);
        if (previous?.ok && decodeCheetahPayload(previous)?.props?.question === concept.question) await resolveOpenQuestion(this.cheetahClient, id);
      }
      for (const concept of response.concepts.filter(c => c.correction && c.prior_answer)) {
        await this.recordLesson({ model, kind: "knowledge-correction", detail: concept.question,
          rule: `A previous remembered answer (${concept.prior_answer}) differed from the cited graph endpoint (${concept.answer}). Check the source before reuse.` }).catch(() => {});
      }
      response.model_limits = await this.limits(model, question).catch(() => []);
      return response;
    });
  }

  async learn(request = {}) {
    return this._run("learn", request, async ({ model, deadline }) => {
      const source = this.sources.get(request.sourceId);
      if (!source) return { ok: false, stop_reason: "invalid-response", error: "Unknown source_id; read a workspace file or research a source first" };
      if (this.learned.has(source.id)) return { ok: true, source_id: source.id, duplicate: true, written: 0, stop_reason: null };
      const result = await learnGraphText(source.text, { handler: this._handler(model),
        cheetahClient: this.cheetahClient, schemaRegistry: this.schemaRegistry,
        sourceId: `${source.source}#${source.id}`, deadline,
        correlate: this.config.correlate, lexicon: this.lexicon });
      this.records.push({ operation: "graph-trace", model, result });
      if (!result.fallback) { this.learned.add(source.id); this.revision += 1; }
      return { ok: !result.fallback, source_id: source.id, written: result.written, known: result.known ?? 0,
        rejected: result.rejected, stop_reason: result.stopReason, error: result.error ?? null };
    });
  }

  async questions(request = {}) {
    return this._run("questions", request, async () => {
      await ensureAskerAnchor(this.cheetahClient);
      return { ok: true, ...await listOpenQuestions(this.cheetahClient, { limit: 12 }), stop_reason: null };
    });
  }

  async recordLesson({ model = this.model, kind, detail, rule }) {
    if (!model) return;
    const owner = `model:${hash(model)}`;
    const id = `model-limit:${hash(`${model}\0${kind}\0${detail}`)}`;
    const commands = [buildNodeSet({ id: owner, labels: ["model_diagnostics"], props: { model, factual: false } }),
      buildNodeSet({ id, labels: ["model_limit"], props: { model, kind, detail: String(detail).slice(0, 1200), rule: String(rule).slice(0, 1200), factual: false } }),
      buildEdgeSetBatch([{ from: owner, to: id, type: "observed_limit", directed: true, props: { model, factual: false } }])];
    const responses = await this.cheetahClient.execute(commands);
    if (responses.some(r => !r.ok)) throw new Error("Cheetah diagnostic write failed");
  }

  async limits(model, question) {
    const [response] = await this.cheetahClient.execute([buildNeighbors({ id: `model:${hash(model)}`, type: "observed_limit", direction: "out", limit: 16 })]);
    const edges = decodeCheetahPayload(response);
    const words = question.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [];
    const nodes = Array.isArray(edges) && edges.length ? await this.cheetahClient.execute(edges.slice(0, 16).map(e => buildNodeGet(e.to))) : [];
    return nodes.map(decodeCheetahPayload).map(n => n?.props).filter(p => p?.model === model && p.factual === false && words.some(w => `${p.detail} ${p.rule}`.toLowerCase().includes(w))).slice(0, 3);
  }

  stats() { return { enabled: true, model: this.model, database: this.cheetahClient.database,
    actions: this.actions, maxActions: this.config.maxActions, sources: this.sources.size, learned: this.learned.size }; }

  /** Headless callers retain their exact response contract; evidence is input. */
  async enrichPrompt(prompt, { model = this.model, question, sessionDeadline, maxTokens = 800 } = {}) {
    if (!question?.trim() || question.length > 1000 || maxTokens < 200) return prompt;
    let original;
    try { original = JSON.parse(prompt); } catch { original = null; }
    // Analyzer envelopes contain observed input, independently of the model's
    // answer. Learn one bounded page; never learn arbitrary prompt instructions.
    if (this.config.learnFromInputs && typeof original?.payload?.data === "string") {
      const [source] = this.observe({ text: original.payload.data,
        source: original.payload.dataset?.source ?? original.payload.dataset?.label ?? "headless-input", kind: "validation" });
      if (source && !this.learned.has(source.source_id)) await this.learn({ sourceId: source.source_id, model, sessionDeadline });
    }
    const key = `${model}\0${this.revision}\0${question}`;
    if (!this.promptCache.has(key)) this.promptCache.set(key, await this.check({ question, model, sessionDeadline }));
    const checked = this.promptCache.get(key);
    if (!checked.ok) return prompt;
    let context = { instruction: "Use the cited source evidence to correct factual errors. Model priors and limits are diagnostics only. An unknown requires a source or a clarifying question; preserve the original response schema.",
      concepts: checked.concepts.map(({ prior_answer, self_confidence, ...concept }) => concept),
      model_limits: checked.model_limits, needs_more_context: checked.needs_more_context };
    if (estimateTokens(JSON.stringify(context)) > maxTokens) {
      // Never cut a JSON document or its citation chain in the middle.
      context = { instruction: context.instruction, needs_more_context: true, concepts: [], stop_reason: "context-overflow" };
    }
    return JSON.stringify(original && typeof original === "object" && !Array.isArray(original)
      ? { ...original, knowledge_context: context } : { original_prompt: prompt, knowledge_context: context });
  }

  async persist() {
    if (!this.baseDir) return;
    const directory = path.join(this.baseDir, "knowledge", this.sessionId);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "runtime.json"), JSON.stringify({ ...this.stats(), records: this.records }, null, 2));
  }

  async close() { try { await this.persist().catch(() => {}); } finally { await this.cheetahClient.close?.(); } }
}

export async function createKnowledgeRuntime(options = {}) {
  const config = resolveKnowledgeConfig(options.configData, options.env);
  if (!config.enabled || !options.client) return null;
  const cheetahClient = options.cheetahClient ?? new CheetahTcpClient({ ...config, timeoutMs: config.connectTimeoutMs });
  try {
    const [probe] = await cheetahClient.execute(["SYSTEM_STATS"]);
    if (!probe?.ok) throw new Error("Cheetah health probe failed");
    const promptRecorder = options.promptRecorder ?? (options.baseDir ? new PromptRecorder(options.baseDir) : null);
    return new KnowledgeRuntime({ ...options, cheetahClient, config, promptRecorder });
  } catch (error) {
    await cheetahClient.close?.();
    if (options.baseDir) {
      const directory = path.join(options.baseDir, "knowledge", options.sessionId ?? "knowledge");
      const stop = buildStopReasonInfo({ error: error.message });
      await fs.mkdir(directory, { recursive: true }).then(() => fs.writeFile(path.join(directory, "runtime.json"),
        JSON.stringify({ enabled: false, fallback: true, stopReason: stop.code, stopReasonCode: stop.code,
          stopReasonDetail: error.message, records: [] }, null, 2))).catch(() => {});
    }
    return null;
  }
}
