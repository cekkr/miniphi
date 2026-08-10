import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildJsonSchemaResponseFormat } from "./json-schema-utils.js";
import { resolveSampling } from "./sampling-profiles.js";
import { NULL_PROMPT_TRACE } from "./prompt-trace.js";

export const ERROR_LESSON_SCHEMA_ID = "error-lesson";
const SCHEMA_VERSION = "error-lesson@v1";
const DEFAULT_TIMEOUT_MS = 240000;
const DEFAULT_MAX_TOKENS = 1024;
// How many times the same failure has to recur before it is worth a model call.
// Once is a mistake; twice is a pattern, and a pattern is what deserves a rule.
const REPEAT_THRESHOLD = 2;
const MAX_LESSONS_PER_RUN = 6;
/**
 * Failure kinds that can never teach a durable lesson.
 *
 * A missed `edit_file` anchor is a mistake about MiniPhi's own edit mechanics,
 * not a fact about the world, and `_repairHint` already answers it precisely.
 * Asking a model to explain one produces invention: observed live, a repeated
 * `anchor-not-found` yielded "always check DOM elements exist before accessing
 * their properties" — fluent, plausible, and about nothing that happened.
 * Lessons are for the environment (a package that cannot build here, an API
 * that behaves unlike its documentation), which is what survives a run.
 */
const MECHANICAL_FAILURE_KINDS = new Set([
  "edit:anchor-not-found",
  "edit:anchor-ambiguous",
  "edit:invalid-content",
  "edit:partial-content",
  "edit:conflicting-action",
  "edit:missing-file",
  "edit:duplicate",
]);

/** Words too common to count as evidence that a lesson is about the failure. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "not", "are", "was", "you",
  "your", "its", "it", "a", "an", "of", "to", "in", "on", "is", "be", "or", "as", "by",
  "error", "failed", "failure", "when", "before", "after", "any", "all", "use", "using",
]);

const significantTerms = (text) =>
  new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9:_.-]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );

// Below this the evidence is too thin to judge relevance from. A failure whose
// whole detail is "gyp failed" gives two usable words; rejecting a correct
// lesson because it does not repeat one of them would be worse than the
// hallucination the guard exists to catch.
const MIN_EVIDENCE_TERMS = 4;

/**
 * True when a derived lesson is plausibly *about* the failure it was derived
 * from. Cheap and deliberately lenient — it only catches a lesson with no
 * lexical connection to the evidence at all, which is the signature of the
 * model answering a question it was not asked.
 */
export function lessonMatchesFailure(lesson, observation) {
  const evidence = significantTerms(
    `${observation?.kind ?? ""} ${observation?.detail ?? ""} ${(observation?.samples ?? []).join(" ")}`,
  );
  if (evidence.size < MIN_EVIDENCE_TERMS) {
    return true;
  }
  const claimed = significantTerms(`${lesson?.title ?? ""} ${lesson?.cause ?? ""} ${lesson?.rule ?? ""}`);
  for (const term of claimed) {
    if (evidence.has(term)) {
      return true;
    }
  }
  return false;
}

const signatureOf = (kind, detail) =>
  createHash("sha256")
    .update(`${kind}::${String(detail ?? "").toLowerCase().replace(/\d+/g, "#").slice(0, 400)}`)
    .digest("hex")
    .slice(0, 16);

const slug = (value) =>
  String(value ?? "lesson")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "lesson";

/**
 * Turns repeated failures into durable rules instead of repeated failures.
 *
 * MiniPhi already tells the model what went wrong — the repair hints in
 * `agent-session.js` are careful and specific. What it never did was *keep* any
 * of it. Every correction lived in a `contract` node with a TTL of one or two
 * turns, so the same run relearned the same lesson, and the next run started
 * from zero. The photos-social sample rediscovered "native SQLite drivers do
 * not build on Node 24 here" so many times that the constraint was eventually
 * hard-coded into the task text by hand, which is the operator doing the
 * agent's learning for it.
 *
 * This module closes that loop:
 *
 *   observe → (repeat) → ask the model for the *rule*, not the symptom →
 *   persist to `.miniphi/memory` (durable, text, syncs between machines) and to
 *   the Cheetah knowledge base (queryable by `knowledge_lookup`) → re-inject
 *   into the live session immediately.
 *
 * A lesson is only asked for when a failure recurs, so an ordinary one-off
 * mistake costs nothing, and only persisted when the model itself judges it a
 * property of the environment rather than of this task.
 */
export class ErrorLearner {
  constructor(options = undefined) {
    this.client = options?.client ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.model =
      typeof options?.model === "string" && options.model.trim() ? options.model.trim() : null;
    this.localMemory = options?.localMemory ?? null;
    this.knowledgeClient = options?.knowledgeClient ?? null;
    this.webResearch = typeof options?.webResearch === "function" ? options.webResearch : null;
    this.trace = options?.trace ?? NULL_PROMPT_TRACE;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.baseDir = options?.baseDir ?? null;
    this.projectId = options?.projectId ?? null;
    this.timeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(1000, Math.floor(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    this.maxTokens = Number.isFinite(options?.maxTokens)
      ? Math.floor(options.maxTokens)
      : DEFAULT_MAX_TOKENS;
    this.repeatThreshold = Number.isFinite(options?.repeatThreshold)
      ? Math.max(1, Math.floor(options.repeatThreshold))
      : REPEAT_THRESHOLD;
    this.maxLessons = Number.isFinite(options?.maxLessons)
      ? Math.max(0, Math.floor(options.maxLessons))
      : MAX_LESSONS_PER_RUN;

    this._observations = new Map();
    this._lessons = [];
    this._learned = new Set();
    this._stats = {
      observed: 0,
      distinct: 0,
      lessons: 0,
      persisted: 0,
      researched: 0,
      failed: 0,
      rejected: 0,
    };
  }

  _log(message) {
    if (this.logger) {
      this.logger(`[error-learning] ${message}`);
    }
  }

  /**
   * Records one failure. Cheap and synchronous: this runs on every rejected
   * action, so it must not cost a model call.
   *
   * @returns {{signature:string, count:number, shouldLearn:boolean}}
   */
  observe({ kind, detail, path: filePath = null, turn = null, context = null } = {}) {
    const signature = signatureOf(kind, detail);
    const existing = this._observations.get(signature);
    this._stats.observed += 1;
    if (existing) {
      existing.count += 1;
      existing.lastTurn = turn;
      if (context && existing.samples.length < 3) {
        existing.samples.push(String(context).slice(0, 1200));
      }
    } else {
      this._observations.set(signature, {
        signature,
        kind,
        detail: String(detail ?? "").slice(0, 1200),
        path: filePath,
        count: 1,
        firstTurn: turn,
        lastTurn: turn,
        samples: context ? [String(context).slice(0, 1200)] : [],
      });
      this._stats.distinct += 1;
    }
    const record = this._observations.get(signature);
    return {
      signature,
      count: record.count,
      shouldLearn:
        !MECHANICAL_FAILURE_KINDS.has(kind) &&
        record.count >= this.repeatThreshold &&
        !this._learned.has(signature) &&
        this._lessons.length < this.maxLessons,
    };
  }

  /** Failures that have recurred enough to be worth a rule, most frequent first. */
  pending() {
    return [...this._observations.values()]
      .filter(
        (record) =>
          !MECHANICAL_FAILURE_KINDS.has(record.kind) &&
          record.count >= this.repeatThreshold &&
          !this._learned.has(record.signature),
      )
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Derives and persists a lesson for one recurring failure.
   *
   * @returns {Promise<{ok:boolean, lesson?:object, error?:string}>}
   */
  async learn(observation, { sessionDeadline = null, mission = null } = {}) {
    if (!observation || this._learned.has(observation.signature)) {
      return { ok: false, error: "already learned" };
    }
    if (this._lessons.length >= this.maxLessons) {
      return { ok: false, error: "lesson budget exhausted" };
    }
    this._learned.add(observation.signature);

    const schema = this.schemaRegistry?.getSchema(ERROR_LESSON_SCHEMA_ID) ?? null;
    if (!this.client || !this.model || !schema) {
      return { ok: false, error: "error learner unavailable" };
    }

    const derived = await this._deriveLesson(observation, { sessionDeadline, mission });
    if (!derived.ok) {
      this._stats.failed += 1;
      return derived;
    }
    let lesson = derived.lesson;

    // A cause the model is unsure of is exactly the case where one search is
    // worth more than a confident rule that is wrong.
    if (
      this.webResearch &&
      lesson.confidence === "low" &&
      typeof lesson.research_query === "string" &&
      lesson.research_query.trim()
    ) {
      const research = await this.webResearch(lesson.research_query.trim(), { maxResults: 4 }).catch(
        () => null,
      );
      if (research) {
        this._stats.researched += 1;
        const confirmed = await this._deriveLesson(observation, {
          sessionDeadline,
          mission,
          research: typeof research === "string" ? research : JSON.stringify(research).slice(0, 4000),
        });
        if (confirmed.ok) {
          lesson = confirmed.lesson;
        }
      }
    }

    if (!lessonMatchesFailure(lesson, observation)) {
      this._stats.rejected += 1;
      this._log(
        `discarded a lesson with no connection to the failure it came from: "${lesson.title}"`,
      );
      return { ok: false, error: "lesson does not describe the observed failure" };
    }

    const entry = {
      ...lesson,
      signature: observation.signature,
      kind: observation.kind,
      occurrences: observation.count,
      path: observation.path ?? null,
      learnedAt: new Date().toISOString(),
    };
    this._lessons.push(entry);
    this._stats.lessons += 1;

    if (entry.durable) {
      await this._persist(entry);
    } else {
      this._log(`lesson "${entry.title}" judged task-specific; kept in-session only`);
    }
    return { ok: true, lesson: entry };
  }

  async _deriveLesson(observation, { sessionDeadline, mission, research = null }) {
    const schemaBlock = this.schemaRegistry.buildInstructionBlock(ERROR_LESSON_SCHEMA_ID, {
      compact: true,
    });
    const responseFormat = buildJsonSchemaResponseFormat(
      this.schemaRegistry.getSchema(ERROR_LESSON_SCHEMA_ID).definition,
      ERROR_LESSON_SCHEMA_ID,
    );
    const system = [
      "You are MiniPhi's post-mortem analyst. A coding agent hit the same failure more than once in one run.",
      "Your job is to state the rule that would have prevented it, in a form a later run can act on before the failure happens.",
      "Distinguish a property of the environment, platform or library (durable: true) from a mistake specific to this one task (durable: false).",
      "Do not restate the error message. Name the mechanism.",
      "If you are not certain of the cause, say so with confidence 'low' and give a research_query that would settle it.",
      "Reply with ONLY the JSON object. No prose, no fences.",
      "",
      "Exact JSON schema:",
      schemaBlock,
    ].join("\n");
    const user = [
      mission ? `The run's mission: ${String(mission).slice(0, 600)}` : null,
      `Failure kind: ${observation.kind}`,
      `Seen ${observation.count} time(s)${observation.path ? ` on ${observation.path}` : ""}.`,
      `Reported detail:\n${observation.detail}`,
      observation.samples.length
        ? `Surrounding evidence:\n${observation.samples.join("\n---\n")}`
        : null,
      research ? `Web research results:\n${research}` : null,
      "State the lesson as JSON now.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const sampling = resolveSampling("summary");
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const remainingMs = Number.isFinite(sessionDeadline)
      ? Math.floor(sessionDeadline - Date.now())
      : null;
    if (remainingMs !== null && remainingMs <= 0) {
      return { ok: false, error: "session-timeout" };
    }
    const startedAt = Date.now();
    let completion = null;
    let text = "";
    let error = null;
    try {
      completion = await this.client.createChatCompletion({
        model: this.model,
        messages,
        temperature: sampling.temperature,
        top_p: sampling.top_p,
        max_tokens: this.maxTokens,
        response_format: responseFormat,
        timeoutMs:
          remainingMs === null
            ? this.timeoutMs
            : Math.max(1000, Math.min(this.timeoutMs, remainingMs)),
      });
      text = completion?.choices?.[0]?.message?.content ?? "";
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const validation = error ? null : this.schemaRegistry.validate(ERROR_LESSON_SCHEMA_ID, text);
    await this.trace.record({
      kind: "error-lesson",
      label: `${observation.kind} x${observation.count}`,
      elapsedMs: Date.now() - startedAt,
      request: {
        model: this.model,
        messages,
        response_format: responseFormat,
        temperature: sampling.temperature,
        top_p: sampling.top_p,
        max_tokens: this.maxTokens,
        samplingProfile: sampling.samplingProfile,
      },
      response: {
        text,
        finish_reason: completion?.choices?.[0]?.finish_reason ?? null,
        usage: completion?.usage ?? null,
      },
      validation: validation
        ? { valid: Boolean(validation.valid), status: validation.status ?? null, error: validation.error ?? null }
        : null,
      error,
    });
    if (validation?.valid && validation.parsed) {
      return { ok: true, lesson: validation.parsed };
    }
    return { ok: false, error: error ?? validation?.error ?? "invalid-response" };
  }

  /**
   * Writes the lesson everywhere it can outlive the run: the durable `.miniphi`
   * corpus (text, syncs between machines, served by LocalContextMemory) and the
   * Cheetah knowledge base (queryable mid-run by `knowledge_lookup`).
   */
  async _persist(lesson) {
    const sentence = `MiniPhi lesson (${lesson.kind}): ${lesson.rule} It applies when ${lesson.applies_when} The cause is ${lesson.cause}`;

    if (this.localMemory) {
      await this.localMemory
        .remember({
          title: lesson.title,
          text: sentence,
          source: "error-learning",
          tags: ["lesson", lesson.kind, lesson.confidence ?? "medium"],
          importance: 0.9,
          projectId: this.projectId,
        })
        .catch((error) => this._log(`local memory write failed: ${error?.message ?? error}`));
    }

    if (this.baseDir) {
      const notes = path.join(this.baseDir, "memory", "notes", "lessons.md");
      const block = [
        `## ${lesson.title}`,
        "",
        `- **Seen:** ${lesson.occurrences} time(s) as \`${lesson.kind}\`${lesson.path ? ` on \`${lesson.path}\`` : ""} (${lesson.learnedAt})`,
        `- **Cause:** ${lesson.cause}`,
        `- **Rule:** ${lesson.rule}`,
        `- **Applies when:** ${lesson.applies_when}`,
        lesson.verification ? `- **Verify:** ${lesson.verification}` : null,
        `- **Confidence:** ${lesson.confidence ?? "medium"}`,
        "",
      ]
        .filter(Boolean)
        .join("\n");
      await fs
        .mkdir(path.dirname(notes), { recursive: true })
        .then(() => fs.appendFile(notes, `${block}\n`, "utf8"))
        .catch((error) => this._log(`notes write failed: ${error?.message ?? error}`));
    }

    if (this.knowledgeClient) {
      try {
        const { writeFacts, topicId, logEpisode } = await import("./cheetah-knowledge-client.js");
        const subjectName = `MiniPhi lesson: ${lesson.title}`;
        // The episode carries the exact sentence, which is what
        // `recallAnchorFacts` returns verbatim; the node carries the anchor a
        // later `knowledge_lookup` resolves by name. No proposed edges: a
        // lesson has no object entity to relate the subject to, and inventing
        // one would put an unsupported triple in the knowledge base.
        const episode = await logEpisode(this.knowledgeClient, sentence).catch(() => null);
        await writeFacts(this.knowledgeClient, {
          subjectId: topicId(subjectName),
          subjectType: "topic",
          subjectName,
          snippetText: sentence,
          insertKey: episode?.insertKey ?? null,
          newFacts: [],
          source: "miniphi-error-learning",
        });
        this._stats.persisted += 1;
      } catch (error) {
        this._log(`cheetah write failed: ${error?.message ?? error}`);
      }
    } else {
      this._stats.persisted += 1;
    }
  }

  /** Lessons learned this run, for the contract layer and the run report. */
  lessons() {
    return this._lessons.slice();
  }

  stats() {
    return { ...this._stats, lessonTitles: this._lessons.map((lesson) => lesson.title) };
  }
}

export default ErrorLearner;
