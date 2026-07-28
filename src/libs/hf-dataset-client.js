const DEFAULT_DATASETS_SERVER_BASE = "https://datasets-server.huggingface.co";
const DEFAULT_DATASET = "rahular/simple-wikipedia";
const DEFAULT_CONFIG = "default";
const DEFAULT_SPLIT = "train";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ROW_LENGTH = 50;

// Simple Wikipedia's defining sentence is always first ("X is/was a/an Y ...");
// this heuristic is only ever a *hint* fed into the teach prompt for the model
// to confirm or correct, never trusted as ground truth on its own.
const SUBJECT_PATTERN =
  /^(?:The |A |An )?([A-Z][\w'.-]*(?:\s+(?:of|de|da|van|del|di)?\s*[A-Z][\w'.-]*){0,4})\s+(?:is|was|are|were|refers to|means)\b/;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9"'“])/;

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

/**
 * Thin REST client over the free, public datasets-server.huggingface.co JSON
 * API. No Python/parquet dependency: rows come back as plain JSON pages.
 */
export class HfDatasetClient {
  constructor(options = undefined) {
    this.baseUrl =
      typeof options?.baseUrl === "string" && options.baseUrl.trim()
        ? options.baseUrl.trim().replace(/\/+$/, "")
        : DEFAULT_DATASETS_SERVER_BASE;
    this.dataset =
      typeof options?.dataset === "string" && options.dataset.trim()
        ? options.dataset.trim()
        : DEFAULT_DATASET;
    this.config =
      typeof options?.config === "string" && options.config.trim()
        ? options.config.trim()
        : DEFAULT_CONFIG;
    this.split =
      typeof options?.split === "string" && options.split.trim()
        ? options.split.trim()
        : DEFAULT_SPLIT;
    this.timeoutMs = toPositiveInteger(options?.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "Global fetch implementation not found. Provide options.fetchImpl when constructing HfDatasetClient.",
      );
    }
  }

  async getInfo() {
    const url = `${this.baseUrl}/info?dataset=${encodeURIComponent(this.dataset)}&config=${encodeURIComponent(this.config)}`;
    return this._get(url);
  }

  /**
   * @param {{offset?: number, length?: number}} [options]
   * @returns {Promise<{rows: Array<{rowIdx: number|null, text: string, truncated: boolean}>, numRowsTotal: number|null}>}
   */
  async getRows({ offset = 0, length = DEFAULT_ROW_LENGTH } = {}) {
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLength = toPositiveInteger(length, DEFAULT_ROW_LENGTH);
    const url =
      `${this.baseUrl}/rows?dataset=${encodeURIComponent(this.dataset)}` +
      `&config=${encodeURIComponent(this.config)}&split=${encodeURIComponent(this.split)}` +
      `&offset=${safeOffset}&length=${safeLength}`;
    const data = await this._get(url);
    const rows = Array.isArray(data?.rows)
      ? data.rows.map((entry) => ({
          rowIdx: Number.isFinite(entry?.row_idx) ? entry.row_idx : null,
          text: typeof entry?.row?.text === "string" ? entry.row.text : "",
          truncated: Array.isArray(entry?.truncated_cells)
            ? entry.truncated_cells.includes("text")
            : false,
        }))
      : [];
    return {
      rows,
      numRowsTotal: Number.isFinite(data?.num_rows_total) ? data.num_rows_total : null,
    };
  }

  async _get(url) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const response = await this.fetchImpl(url, { signal: controller?.signal });
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (!response.ok) {
        const message = data?.error ?? text ?? `HTTP ${response.status}`;
        throw new Error(
          `HF datasets-server request failed (${response.status} ${response.statusText}): ${message}`,
        );
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(
          `HF datasets-server request timed out after ${this.timeoutMs}ms (url: ${url}).`,
        );
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * Clips raw dataset text to its first 1-3 sentences. The dataset has no
 * title column, and Simple Wikipedia's defining sentence is always first, so
 * a tiny model should never be handed a full article body to extract from.
 */
export function clipSnippet(text, { maxSentences = 3, maxChars = 480 } = {}) {
  if (typeof text !== "string" || !text.trim()) {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentenceCap = Number.isFinite(maxSentences) && maxSentences > 0 ? maxSentences : 3;
  const charCap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 480;
  const sentences = normalized.split(SENTENCE_SPLIT_RE).filter(Boolean);
  let clipped = sentences.slice(0, sentenceCap).join(" ") || normalized;
  if (clipped.length > charCap) {
    clipped = `${clipped.slice(0, charCap).trim()}...`;
  }
  return clipped;
}

/**
 * Deterministic "X is/was a/an Y ..." heuristic over the first sentence.
 * Returns null when nothing matches; callers must treat the result as a hint
 * for the model to confirm/correct, never as ground truth.
 */
export function guessSubjectFromText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  const firstSentenceMatch = normalized.match(/^[^.!?]*[.!?]/);
  const firstSentence = firstSentenceMatch ? firstSentenceMatch[0] : normalized;
  const match = firstSentence.match(SUBJECT_PATTERN);
  if (!match) {
    return null;
  }
  const subject = match[1].trim();
  if (!subject || subject.length > 80) {
    return null;
  }
  return { subject, matched: true };
}

/**
 * Fetches a "teach" window and a far, non-overlapping "eval-unknown" window
 * so evaluation can test both grounded recall (taught topics) and correct
 * decline (topics never taught) without any post-hoc dedup — disjointness is
 * by construction of the offset ranges.
 *
 * @returns {Promise<{
 *   teachRows: Array<{rowIdx, text, truncated, subjectHint}>,
 *   evalKnownRows: Array<{rowIdx, text, truncated, subjectHint}>,
 *   evalUnknownRows: Array<{rowIdx, text, truncated, subjectHint}>,
 * }>}
 */
export async function fetchDisjointSamples(
  client,
  {
    teachOffset = 0,
    teachLimit = 20,
    evalOffset = 100000,
    evalKnownCount = 10,
    evalUnknownCount = 10,
  } = {},
) {
  const teach = await client.getRows({ offset: teachOffset, length: teachLimit });
  const teachRows = teach.rows.map((row) => ({ ...row, subjectHint: guessSubjectFromText(row.text) }));
  const evalKnownRows = teachRows.slice(0, Math.min(evalKnownCount, teachRows.length));
  const unknown = await client.getRows({ offset: evalOffset, length: evalUnknownCount });
  const evalUnknownRows = unknown.rows.map((row) => ({
    ...row,
    subjectHint: guessSubjectFromText(row.text),
  }));
  return { teachRows, evalKnownRows, evalUnknownRows };
}

export { DEFAULT_DATASET, DEFAULT_CONFIG, DEFAULT_SPLIT };
