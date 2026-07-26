import { createHash } from "node:crypto";
import { buildJsonSchemaResponseFormat } from "./json-schema-utils.js";
import { estimateTokens } from "./context-graph.js";

export const CONTEXT_REFERENCE_SCHEMA_ID = "context-reference-selection";
const SCHEMA_VERSION = "context-reference-selection@v1";
const DEFAULT_MAX_CANDIDATES = 48;
const DEFAULT_MAX_SELECTED = 8;
const DEFAULT_BUDGET_TOKENS = 480;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TIMEOUT_MS = 45000;

const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 20);

const taskTerms = (task) =>
  new Set(
    String(task ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.filter((term) => term.length >= 4) ?? [],
  );

const boundedCandidates = (candidates, maxCandidates, task) => {
  const seen = new Set();
  const terms = taskTerms(task);
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => {
      if (
        !candidate ||
        typeof candidate.id !== "string" ||
        !candidate.id.trim() ||
        typeof candidate.text !== "string" ||
        !candidate.text.trim()
      ) {
        return false;
      }
      if (seen.has(candidate.id) || seen.has(candidate.text)) {
        return false;
      }
      seen.add(candidate.id);
      seen.add(candidate.text);
      return true;
    })
    .sort(
      (left, right) =>
        [...terms].filter((term) => right.text.toLowerCase().includes(term)).length -
          [...terms].filter((term) => left.text.toLowerCase().includes(term)).length ||
        (Number(right.score) || 0) - (Number(left.score) || 0) ||
        (Number(left.distance) || 0) - (Number(right.distance) || 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, maxCandidates)
    .map((candidate) => ({
      id: candidate.id,
      sentence: candidate.text.trim(),
      source_node: candidate.sourceNodeId ?? null,
      source: candidate.source ?? null,
      association_score: Number(candidate.score) || 0,
      distance: Number(candidate.distance) || 0,
    }));
};

const deterministicSelection = (candidates, maxSelected, reason) => ({
  schema_version: SCHEMA_VERSION,
  selected_references: candidates.slice(0, maxSelected).map((candidate) => candidate.id),
  needs_more_context: candidates.length === 0,
  missing_snippets: [],
  stop_reason: reason,
});

const normalizeSelection = (payload, candidates, maxSelected) => {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected = [];
  const seen = new Set();
  for (const item of Array.isArray(payload?.selected_references)
    ? payload.selected_references
    : []) {
    const candidate = candidatesById.get(item);
    if (!candidate || seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    selected.push(candidate);
    if (selected.length >= maxSelected) {
      break;
    }
  }
  return selected;
};

/**
 * Uses the session's already-selected LM Studio model to choose and order
 * Cheetah's complete reference sentences. The model may select candidate ids
 * only; it cannot rewrite evidence. Invalid JSON receives one schema reminder,
 * then a deterministic ranking fallback keeps the agent loop bounded.
 */
export default class ContextReferenceComposer {
  constructor(options = undefined) {
    this.client = options?.client ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.model = typeof options?.model === "string" ? options.model : null;
    this.reasoning = options?.reasoning ?? null;
    this.maxCandidates = Number.isFinite(options?.maxCandidates)
      ? Math.max(1, Math.floor(options.maxCandidates))
      : DEFAULT_MAX_CANDIDATES;
    this.maxSelected = Number.isFinite(options?.maxSelected)
      ? Math.max(1, Math.min(12, Math.floor(options.maxSelected)))
      : DEFAULT_MAX_SELECTED;
    this.budgetTokens = Number.isFinite(options?.budgetTokens)
      ? Math.max(64, Math.floor(options.budgetTokens))
      : DEFAULT_BUDGET_TOKENS;
    this.maxTokens = Number.isFinite(options?.maxTokens)
      ? Math.max(128, Math.floor(options.maxTokens))
      : DEFAULT_MAX_TOKENS;
    this.timeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(1000, Math.floor(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
  }

  _schema() {
    return this.schemaRegistry?.getSchema(CONTEXT_REFERENCE_SCHEMA_ID) ?? null;
  }

  async compose({ task, candidates, turn = 0, sessionDeadline = null } = {}) {
    const bounded = boundedCandidates(candidates, this.maxCandidates, task);
    const schema = this._schema();
    const startedAt = new Date().toISOString();
    const audit = {
      schemaVersion: SCHEMA_VERSION,
      turn,
      model: this.model,
      startedAt,
      candidateFingerprint: fingerprint(bounded),
      candidates: bounded,
      attempts: [],
      fallback: null,
    };
    if (!bounded.length) {
      const response = deterministicSelection([], this.maxSelected, "no-candidates");
      audit.fallback = response.stop_reason;
      return { selected: [], response, audit };
    }
    if (!this.client || !schema || !this.schemaRegistry) {
      const response = deterministicSelection(
        bounded,
        this.maxSelected,
        "selector-unavailable",
      );
      audit.fallback = response.stop_reason;
      return {
        selected: normalizeSelection(response, bounded, this.maxSelected),
        response,
        audit,
      };
    }

    const schemaBlock = this.schemaRegistry.buildInstructionBlock(
      CONTEXT_REFERENCE_SCHEMA_ID,
      { compact: true },
    );
    const responseFormat = buildJsonSchemaResponseFormat(
      schema.definition,
      CONTEXT_REFERENCE_SCHEMA_ID,
    );
    const system = `You select grounded memory sentences for MiniPhi.
Reply with ONLY JSON matching the exact schema below. Select the smallest useful
set of candidate ids for the current task, ordered by usefulness. Never rewrite
or synthesize sentence text; only return candidate ids. Prefer complete,
specific evidence over generic policy or task restatements.

Exact JSON schema:
${schemaBlock}`;
    const user = JSON.stringify({
      task: String(task ?? ""),
      candidates: bounded,
    });
    let lastError = "invalid-response";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = Number.isFinite(sessionDeadline)
        ? Math.floor(sessionDeadline - Date.now())
        : null;
      if (remainingMs !== null && remainingMs <= 0) {
        lastError = "session-timeout";
        break;
      }
      const messages = [
        { role: "system", content: system },
        {
          role: "user",
          content:
            attempt === 0
              ? user
              : `${user}\n\nYour previous response was invalid. Return only schema-valid JSON.`,
        },
      ];
      let completion = null;
      let responseText = "";
      try {
        completion = await this.client.createChatCompletion({
          messages,
          temperature: 0,
          max_tokens: this.maxTokens,
          timeoutMs:
            remainingMs === null
              ? this.timeoutMs
              : Math.max(1000, Math.min(this.timeoutMs, remainingMs)),
          response_format: responseFormat,
          ...(this.model ? { model: this.model } : {}),
          ...(this.reasoning?.model?.resolved &&
            typeof this.client?.setDefaultReasoning !== "function"
            ? { reasoning: this.reasoning.model.resolved }
            : {}),
        });
        const message = completion?.choices?.[0]?.message ?? null;
        responseText = typeof message?.content === "string" ? message.content : "";
        const validation = this.schemaRegistry.validate(
          CONTEXT_REFERENCE_SCHEMA_ID,
          responseText,
        );
        audit.attempts.push({
          attempt: attempt + 1,
          request: {
            messages,
            response_format: responseFormat,
            model: this.model,
            tool_definitions: null,
          },
          response: {
            text: responseText,
            reasoning_content:
              typeof message?.reasoning_content === "string"
                ? message.reasoning_content
                : null,
            tool_calls: message?.tool_calls ?? null,
            usage: completion?.usage ?? null,
            reasoning: completion?.miniphi_reasoning ?? null,
          },
          validation: {
            valid: Boolean(validation?.valid),
            status: validation?.status ?? null,
            error: validation?.error ?? null,
            preambleDetected: Boolean(validation?.preambleDetected),
          },
        });
        if (validation?.valid && validation.parsed) {
          const selected = normalizeSelection(
            validation.parsed,
            bounded,
            this.maxSelected,
          );
          if (selected.length || validation.parsed.needs_more_context) {
            return {
              selected,
              response: validation.parsed,
              audit: {
                ...audit,
                finishedAt: new Date().toISOString(),
                selectedReferenceIds: selected.map((item) => item.id),
              },
            };
          }
          lastError = "valid response selected no known candidate ids";
        } else {
          lastError = validation?.error ?? "schema validation failed";
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        audit.attempts.push({
          attempt: attempt + 1,
          request: {
            messages,
            response_format: responseFormat,
            model: this.model,
            tool_definitions: null,
          },
          response: {
            text: responseText,
            reasoning_content: null,
            tool_calls: null,
            usage: completion?.usage ?? null,
            reasoning: completion?.miniphi_reasoning ?? null,
          },
          validation: {
            valid: false,
            status: "request-failed",
            error: lastError,
            preambleDetected: false,
          },
        });
      }
    }
    const response = deterministicSelection(
      bounded,
      this.maxSelected,
      `invalid-response: ${lastError}`,
    );
    const selected = normalizeSelection(response, bounded, this.maxSelected);
    audit.fallback = response.stop_reason;
    audit.finishedAt = new Date().toISOString();
    audit.selectedReferenceIds = selected.map((item) => item.id);
    return { selected, response, audit };
  }

  render(selected) {
    const lines = [];
    let usedTokens = 0;
    for (const reference of Array.isArray(selected) ? selected : []) {
      const line = `- [${reference.id}] ${reference.sentence} (source: ${reference.source ?? reference.source_node ?? "unknown"})`;
      const tokens = estimateTokens(line);
      if (lines.length && usedTokens + tokens > this.budgetTokens) {
        break;
      }
      lines.push(line);
      usedTokens += tokens;
    }
    if (!lines.length) {
      return "";
    }
    return [
      "### Cheetah-recalled complete sentence references",
      "These are verbatim grounded memory sentences selected by this session's model:",
      ...lines,
    ].join("\n");
  }
}
