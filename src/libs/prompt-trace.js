import fs from "node:fs/promises";
import path from "node:path";

/**
 * Complete, operator-readable debug log of every model exchange a run performs.
 *
 * `.miniphi/agent-sessions/<id>/*.json` already keeps *outcomes* — the context
 * graph, the selected references, the result — but nothing kept the thing an
 * operator actually needs when a run goes wrong: the exact bytes that were sent
 * and the exact bytes that came back, for the main turn prompt *and* for every
 * subprompt (subtask planning, reference selection, vision review, page region
 * analysis). Reconstructing a failed run from outcomes alone means guessing at
 * the prompt, which is how "the model is bad" and "we sent it a 4k budget and
 * asked for a 300-line file" become indistinguishable.
 *
 * Layout, under `.miniphi/prompt-trace/<sessionId>/`:
 *   - `index.jsonl`  one compact line per exchange (grep/jq target)
 *   - `NNNN-<kind>.json`  the complete exchange, nothing elided
 *   - `transcript.md`  the same exchanges appended in reading order
 *   - `media/NNNN-<n>.png`  images lifted out of the messages
 *
 * Images are written to `media/` and replaced in the recorded messages by their
 * relative path: a base64 screenshot inlined into JSON makes the trace unusable
 * for the human it exists for, and keeps a second copy of every screenshot.
 */

const DEFAULT_MAX_TEXT_CHARS = 400000;

const nowIso = () => new Date().toISOString();

const pad = (value) => String(value).padStart(4, "0");

const slug = (value) =>
  String(value ?? "exchange")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "exchange";

/** Rough token estimate, same 4-chars-per-token rule the context graph uses. */
const estimateTokens = (text) =>
  typeof text === "string" && text ? Math.ceil(text.length / 4) : 0;

const messageText = (content) => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (part?.type === "text" ? String(part.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
};

export class PromptTrace {
  /**
   * @param {{
   *   baseDir?: string|null,        // the `.miniphi` directory
   *   sessionId?: string,
   *   enabled?: boolean,
   *   maxTextChars?: number,
   *   logger?: Function|null,
   * }} [options]
   */
  constructor(options = undefined) {
    this.baseDir = options?.baseDir ?? null;
    this.sessionId = options?.sessionId ?? `session-${Date.now()}`;
    this.enabled = options?.enabled !== false && Boolean(this.baseDir);
    this.maxTextChars =
      Number.isFinite(options?.maxTextChars) && options.maxTextChars > 0
        ? Math.floor(options.maxTextChars)
        : DEFAULT_MAX_TEXT_CHARS;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.dir = this.baseDir
      ? path.join(this.baseDir, "prompt-trace", this.sessionId)
      : null;
    this._sequence = 0;
    this._ready = null;
    this._counts = new Map();
    this._totals = { exchanges: 0, promptTokens: 0, completionTokens: 0, failures: 0 };
  }

  /** True when a call to `record` will actually write something. */
  get active() {
    return Boolean(this.enabled && this.dir);
  }

  async _ensureDir() {
    if (!this.active) {
      return null;
    }
    if (!this._ready) {
      this._ready = fs
        .mkdir(path.join(this.dir, "media"), { recursive: true })
        .then(() => this.dir)
        .catch(() => {
          // A trace that cannot be written must never break the run it traces.
          this.enabled = false;
          return null;
        });
    }
    return this._ready;
  }

  /**
   * Splits message content into a recordable form plus the images to write out.
   * The messages themselves stay complete except for image payloads, which are
   * replaced by `{ type: "image_file", file: "media/0007-1.png", bytes: N }`.
   */
  _extractMedia(messages, sequence) {
    const media = [];
    const recorded = (Array.isArray(messages) ? messages : []).map((message) => {
      if (typeof message?.content === "string" || !Array.isArray(message?.content)) {
        return { role: message?.role ?? "user", content: message?.content ?? "" };
      }
      const parts = message.content.map((part) => {
        const url = part?.type === "image_url" ? part?.image_url?.url ?? "" : "";
        const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(url);
        if (!match) {
          return part;
        }
        const extension = match[1].split("/")[1].replace(/[^a-z0-9]/gi, "") || "png";
        const file = path.join("media", `${pad(sequence)}-${media.length + 1}.${extension}`);
        const buffer = Buffer.from(match[2], "base64");
        media.push({ file, buffer });
        return { type: "image_file", file, mime: match[1], bytes: buffer.length };
      });
      return { role: message.role ?? "user", content: parts };
    });
    return { recorded, media };
  }

  _clip(text) {
    if (typeof text !== "string") {
      return text;
    }
    return text.length > this.maxTextChars
      ? `${text.slice(0, this.maxTextChars)}\n[trace truncated at ${this.maxTextChars} chars of ${text.length}]`
      : text;
  }

  /**
   * Records one complete model exchange.
   *
   * Every field is optional so a caller can trace a failure that never reached
   * the wire; `kind` is what makes the trace navigable, so it is required in
   * practice ("agent-turn", "subprompt-plan", "context-references",
   * "visual-review", "page-regions", …).
   *
   * @returns {Promise<{sequence:number,file:string}|null>}
   */
  async record(entry = {}) {
    if (!this.active) {
      return null;
    }
    const dir = await this._ensureDir();
    if (!dir) {
      return null;
    }
    this._sequence += 1;
    const sequence = this._sequence;
    const kind = slug(entry.kind ?? "exchange");
    this._counts.set(kind, (this._counts.get(kind) ?? 0) + 1);

    const { recorded, media } = this._extractMedia(entry.request?.messages, sequence);
    for (const item of media) {
      await fs.writeFile(path.join(dir, item.file), item.buffer).catch(() => {});
    }

    const promptChars = recorded.reduce(
      (total, message) => total + messageText(message.content).length,
      0,
    );
    const responseText = this._clip(entry.response?.text ?? "");
    const usage = entry.response?.usage ?? null;
    const failed = entry.error != null || entry.validation?.valid === false;

    this._totals.exchanges += 1;
    this._totals.promptTokens += Number(usage?.prompt_tokens ?? Math.ceil(promptChars / 4)) || 0;
    this._totals.completionTokens += Number(usage?.completion_tokens ?? 0) || 0;
    if (failed) {
      this._totals.failures += 1;
    }

    const record = {
      sequence,
      kind: entry.kind ?? kind,
      label: entry.label ?? null,
      at: entry.at ?? nowIso(),
      sessionId: this.sessionId,
      turn: entry.turn ?? null,
      attempt: entry.attempt ?? null,
      subtask: entry.subtask ?? null,
      parent: entry.parent ?? null,
      elapsedMs: entry.elapsedMs ?? null,
      request: {
        model: entry.request?.model ?? null,
        temperature: entry.request?.temperature ?? null,
        top_p: entry.request?.top_p ?? null,
        max_tokens: entry.request?.max_tokens ?? null,
        context_length: entry.request?.context_length ?? null,
        reasoning: entry.request?.reasoning ?? null,
        timeoutMs: entry.request?.timeoutMs ?? null,
        response_format: entry.request?.response_format ?? null,
        tool_definitions: entry.request?.tool_definitions ?? null,
        samplingProfile: entry.request?.samplingProfile ?? null,
        estimatedPromptTokens: Math.ceil(promptChars / 4),
        messages: recorded.map((message) => ({
          role: message.role,
          content:
            typeof message.content === "string" ? this._clip(message.content) : message.content,
        })),
      },
      response: {
        text: responseText,
        reasoning: this._clip(entry.response?.reasoning ?? "") || null,
        finish_reason: entry.response?.finish_reason ?? null,
        usage,
        tool_calls: entry.response?.tool_calls ?? null,
      },
      validation: entry.validation ?? null,
      outcome: entry.outcome ?? null,
      error: entry.error ? String(entry.error).slice(0, 4000) : null,
    };

    const file = `${pad(sequence)}-${kind}.json`;
    await fs.writeFile(path.join(dir, file), JSON.stringify(record, null, 2), "utf8").catch(() => {});
    await fs
      .appendFile(
        path.join(dir, "index.jsonl"),
        `${JSON.stringify({
          sequence,
          at: record.at,
          kind: record.kind,
          label: record.label,
          turn: record.turn,
          attempt: record.attempt,
          model: record.request.model,
          temperature: record.request.temperature,
          max_tokens: record.request.max_tokens,
          promptTokens: usage?.prompt_tokens ?? record.request.estimatedPromptTokens,
          completionTokens: usage?.completion_tokens ?? estimateTokens(responseText),
          finish_reason: record.response.finish_reason,
          valid: record.validation?.valid ?? null,
          elapsedMs: record.elapsedMs,
          error: record.error,
          file,
        })}\n`,
        "utf8",
      )
      .catch(() => {});
    await fs.appendFile(path.join(dir, "transcript.md"), this._markdown(record), "utf8").catch(() => {});
    return { sequence, file: path.join(dir, file) };
  }

  /** The same exchange rendered for a human reading top to bottom. */
  _markdown(record) {
    const lines = [];
    const header = [
      `## ${pad(record.sequence)} · ${record.kind}`,
      record.label ? ` — ${record.label}` : "",
      record.turn != null ? ` (turn ${record.turn}${record.attempt ? `, attempt ${record.attempt}` : ""})` : "",
    ].join("");
    lines.push(header, "");
    lines.push(
      [
        `- at: ${record.at}`,
        `- model: ${record.request.model ?? "?"}`,
        `- temperature: ${record.request.temperature ?? "default"} · top_p: ${record.request.top_p ?? "default"} · max_tokens: ${record.request.max_tokens ?? "default"}`,
        record.request.samplingProfile ? `- sampling profile: ${record.request.samplingProfile}` : null,
        record.request.reasoning ? `- reasoning: ${JSON.stringify(record.request.reasoning)}` : null,
        `- prompt tokens: ${record.response.usage?.prompt_tokens ?? `~${record.request.estimatedPromptTokens}`} · completion tokens: ${record.response.usage?.completion_tokens ?? "?"} · finish: ${record.response.finish_reason ?? "?"}`,
        record.elapsedMs != null ? `- elapsed: ${record.elapsedMs} ms` : null,
        record.validation
          ? `- validation: ${record.validation.valid ? "valid" : `INVALID — ${record.validation.error ?? record.validation.status ?? "?"}`}`
          : null,
        record.error ? `- error: ${record.error}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "",
    );
    for (const message of record.request.messages) {
      const body =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) =>
                part?.type === "image_file"
                  ? `[image ${part.file} · ${part.bytes} bytes]`
                  : String(part?.text ?? ""),
              )
              .join("\n");
      lines.push(`### → ${message.role}`, "", "```", body, "```", "");
    }
    if (record.response.reasoning) {
      lines.push("### ← reasoning", "", "```", record.response.reasoning, "```", "");
    }
    lines.push("### ← response", "", "```", record.response.text || "(empty)", "```", "");
    lines.push("---", "");
    return lines.join("\n");
  }

  /** Counts by kind plus token totals, for the run report. */
  stats() {
    return {
      enabled: this.active,
      dir: this.dir,
      exchanges: this._totals.exchanges,
      failures: this._totals.failures,
      promptTokens: this._totals.promptTokens,
      completionTokens: this._totals.completionTokens,
      byKind: Object.fromEntries(this._counts),
    };
  }

  /** Writes the summary file; call once at the end of a run. */
  async finalize(extra = undefined) {
    if (!this.active) {
      return null;
    }
    const dir = await this._ensureDir();
    if (!dir) {
      return null;
    }
    const summary = { ...this.stats(), finishedAt: nowIso(), ...(extra ?? {}) };
    await fs
      .writeFile(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2), "utf8")
      .catch(() => {});
    return summary;
  }
}

/** No-op trace, so callers never need a null check around `trace.record(...)`. */
export const NULL_PROMPT_TRACE = {
  active: false,
  async record() {
    return null;
  },
  stats() {
    return { enabled: false, exchanges: 0, failures: 0, completionTokens: 0, byKind: {} };
  },
  async finalize() {
    return null;
  },
};

export function createPromptTrace(options = undefined) {
  const trace = new PromptTrace(options);
  return trace.active ? trace : NULL_PROMPT_TRACE;
}

export default PromptTrace;
