import { createHash } from "node:crypto";

const DEFAULT_MAX_REFERENCES = 12;
const DEFAULT_MAX_REFERENCE_CHARS = 640;
const DEFAULT_MAX_FRAGMENT_CHARS = 360;

const terminalPunctuation = /[.!?](?:["')\]]*)$/u;

const normalizeWhitespace = (value) =>
  String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();

const referenceId = (label, sentence) =>
  `ref_${createHash("sha256")
    .update(`${label}\u0000${sentence}`, "utf8")
    .digest("hex")
    .slice(0, 20)}`;

const splitLongFragment = (fragment, maxChars = DEFAULT_MAX_FRAGMENT_CHARS) => {
  if (fragment.length <= maxChars) {
    return [fragment];
  }
  const words = fragment.split(/\s+/u).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
      continue;
    }
    chunks.push(current);
    current = word;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
};

const segmentSentences = (text) => {
  if (!text) {
    return [];
  }
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    return [...segmenter.segment(text)]
      .map((entry) => normalizeWhitespace(entry.segment))
      .filter(Boolean);
  }
  return (
    text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/gu) ?? []
  )
    .map(normalizeWhitespace)
    .filter(Boolean);
};

const completeSentence = (fragment, label) => {
  const normalized = normalizeWhitespace(fragment).replace(/\n+/g, " ");
  if (!normalized) {
    return "";
  }
  if (terminalPunctuation.test(normalized) && normalized.split(/\s+/u).length >= 3) {
    return normalized;
  }
  return `The context node ${JSON.stringify(label)} contains this exact reference: ${JSON.stringify(
    normalized,
  )}.`;
};

// A line that opens with list, quote, heading, table or fence markup — or one
// that reads like code — is its own unit and must never be glued to the line
// above it, however the previous line ended.
const STRUCTURAL_LINE = /^(?:[-*+•>#|]|\d+[.)]\s|```|~~~|\s*[}\])];?$)/u;
const CODE_LIKE_LINE = /[{};=<>]\s*$|^\s{2,}\S|\b(?:function|const|let|var|import|export|class|def|return)\b/u;

const isStructural = (line) => STRUCTURAL_LINE.test(line) || CODE_LIKE_LINE.test(line);

/**
 * Rejoins a hard-wrapped prose paragraph into whole sentences.
 *
 * Wrapping a paragraph at ~100 columns is invisible to a reader and fatal to
 * line-wise segmentation: every sentence that spans a wrap becomes two
 * fragments, and both are then stored as quoted half-sentences. Markdown notes
 * are wrapped that way as a matter of course, which is why the store that reads
 * them asks for this. Source lines and terse tool output must keep the
 * line-wise treatment, so it stays opt-in.
 */
const unwrapParagraph = (lines) => {
  const joined = [];
  for (const line of lines) {
    const previous = joined.at(-1);
    if (
      previous &&
      !terminalPunctuation.test(previous) &&
      !isStructural(previous) &&
      !isStructural(line)
    ) {
      joined[joined.length - 1] = `${previous} ${line}`;
      continue;
    }
    joined.push(line);
  }
  return joined;
};

/**
 * Turns arbitrary context (including source lines and terse tool output) into
 * bounded, self-contained reference sentences. Existing prose survives
 * verbatim; fragments are quoted inside a grammatical sentence rather than
 * persisted as orphaned words.
 *
 * Set `unwrapProse` when the input is authored prose (a markdown note, a
 * summary) rather than lines that mean something individually.
 */
export function buildCompleteReferenceSentences({
  text,
  label = "context",
  source = "runtime",
  maxReferences = DEFAULT_MAX_REFERENCES,
  maxReferenceChars = DEFAULT_MAX_REFERENCE_CHARS,
  unwrapProse = false,
} = {}) {
  const normalizedText = normalizeWhitespace(text);
  const normalizedLabel = normalizeWhitespace(label) || "context";
  if (!normalizedText) {
    return [];
  }
  const fragments = [];
  for (const paragraph of normalizedText.split(/\n{2,}/u)) {
    const rawLines = paragraph.split("\n").map(normalizeWhitespace).filter(Boolean);
    const lines = unwrapProse ? unwrapParagraph(rawLines) : rawLines;
    for (const line of lines) {
      const sentences = segmentSentences(line);
      for (const sentence of sentences.length ? sentences : [line]) {
        fragments.push(...splitLongFragment(sentence));
      }
    }
  }

  const references = [];
  const seen = new Set();
  for (const fragment of fragments) {
    let sentence = completeSentence(fragment, normalizedLabel);
    if (!sentence) {
      continue;
    }
    if (sentence.length > maxReferenceChars) {
      const quoted = splitLongFragment(fragment, Math.max(80, maxReferenceChars - 120))[0];
      sentence = completeSentence(quoted, normalizedLabel);
    }
    if (!sentence || sentence.length > maxReferenceChars || seen.has(sentence)) {
      continue;
    }
    seen.add(sentence);
    references.push({
      id: referenceId(normalizedLabel, sentence),
      text: sentence,
      source: normalizeWhitespace(source) || "runtime",
      ordinal: references.length,
    });
    if (references.length >= Math.max(1, Math.floor(maxReferences))) {
      break;
    }
  }
  return references;
}

export function normalizeReferenceSentences(
  references,
  { label = "context", source = "runtime" } = {},
) {
  if (!Array.isArray(references)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const raw of references.slice(0, DEFAULT_MAX_REFERENCES)) {
    const text = normalizeWhitespace(raw?.text);
    if (!text || seen.has(text)) {
      continue;
    }
    const sentence = terminalPunctuation.test(text)
      ? text
      : completeSentence(text, label);
    if (!sentence || sentence.length > DEFAULT_MAX_REFERENCE_CHARS) {
      continue;
    }
    seen.add(sentence);
    out.push({
      id:
        typeof raw?.id === "string" && raw.id.trim()
          ? raw.id.trim()
          : referenceId(label, sentence),
      text: sentence,
      source:
        typeof raw?.source === "string" && raw.source.trim()
          ? raw.source.trim()
          : source,
      ordinal: Number.isFinite(raw?.ordinal)
        ? Math.max(0, Math.floor(raw.ordinal))
        : out.length,
    });
  }
  return out.sort((left, right) =>
    left.ordinal === right.ordinal
      ? left.id.localeCompare(right.id)
      : left.ordinal - right.ordinal,
  );
}
