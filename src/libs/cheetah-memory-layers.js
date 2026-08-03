/**
 * Deterministic text -> memory-layer utilities for the Cheetah knowledge base.
 *
 * The first cheetah-learn generation stored exactly one thing per article: the
 * clipped lead paragraph, hung off one `topic:<slug>` node, retrieved by
 * re-deriving that same slug from the question. That is an id lookup returning
 * a pre-made sentence — there is no context around the fact, no second layer to
 * fall back to, and nothing in the graph to traverse, so a question phrased any
 * other way (or about a detail below the lead) resolves nothing.
 *
 * This module is the deterministic half of the fix. It turns one article into
 * the several *layers* a hippocampal store needs — a gist, detail passages with
 * their section context, the aboutness/category tags that let unrelated topics
 * share a bridge node, the entities the passage mentions, and the years it
 * anchors to — plus the query-side primitives (cues, span selection, support
 * ratio) that read those layers back.
 *
 * Everything here is pure and model-free on purpose: the small model proposes,
 * this module disposes, exactly like `filterSourceGroundedFacts` already did
 * for semantic edges.
 */

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"'(\d])/u;
const SECTION_HEADER = /==+\s*([^=]{1,80}?)\s*==+/g;

// Wikipedia's tail sections are navigation, not knowledge: storing them fills
// the passage layer with link lists and donates "Category", "Protected" and
// similar markup words to the mention layer as if they were entities.
const BOILERPLATE_SECTION =
  /^(?:see also|external links?|references?|further reading|notes?|bibliography|sources?|citations?|gallery|categor(?:y|ies)|footnotes?)\b/i;

const STOP_WORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "between", "both", "but", "by",
  "can", "did", "do", "does", "during", "each", "for", "from", "had", "has",
  "have", "he", "her", "here", "hers", "him", "his", "how", "however", "i",
  "if", "in", "into", "is", "it", "its", "just", "many", "may", "me", "more",
  "most", "much", "must", "my", "no", "nor", "not", "now", "of", "off", "on",
  "once", "one", "only", "or", "other", "our", "out", "over", "own", "same",
  "she", "should", "so", "some", "such", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "two", "under", "until", "up", "very", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "why", "will", "with", "would",
  "you", "your",
]);

// Words that open a sentence for grammatical reasons rather than because they
// name something; a capitalized run starting with one of these is not evidence
// of a proper noun.
const WEAK_CAPITAL_STARTERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "he", "she", "they",
  "there", "here", "his", "her", "its", "their", "in", "on", "at", "by", "for",
  "from", "with", "as", "after", "before", "during", "when", "while", "however",
  "although", "because", "since", "both", "some", "many", "most", "several",
  "other", "another", "each", "every", "no", "not", "one", "two", "three",
  "later", "today", "originally", "currently", "following",
]);

const PLACE_HINT_WORDS = new Set([
  "city", "town", "village", "county", "country", "state", "province", "region",
  "district", "island", "river", "mountain", "lake", "street", "road",
  "located", "situated", "near", "north", "south", "east", "west",
]);

const PERSON_HINT_WORDS = new Set([
  "born", "he", "she", "his", "her", "author", "player", "singer", "actor",
  "writer", "politician", "journalist", "artist", "musician", "founder",
  "director", "professor", "scientist",
]);

/** Lowercased word tokens with punctuation and diacritics normalized away. */
export function normalizeWords(value) {
  return (
    String(value ?? "")
      .normalize("NFKD")
      .replace(/\p{Mn}/gu, "")
      .toLocaleLowerCase("en")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Content words only — what actually carries the meaning of a cue or answer. */
export function contentWords(value) {
  return normalizeWords(value).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitSentences(text) {
  return collapseWhitespace(text)
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Split one article into ordered memory passages.
 *
 * Layer names are load-bearing downstream: `gist` is what a broad "what do you
 * know about X" question is answered from and what a digest shows, while
 * `detail` passages are what a specific question's answer span is extracted
 * from. Section titles ride along so a retrieved detail keeps the context it
 * was written under instead of arriving as a free-floating sentence.
 */
export function segmentArticle(
  text,
  { maxSegments = 6, maxChars = 320, minChars = 30 } = {},
) {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return [];
  }

  const sections = [];
  let cursor = 0;
  let currentSection = "lead";
  SECTION_HEADER.lastIndex = 0;
  for (let match = SECTION_HEADER.exec(raw); match; match = SECTION_HEADER.exec(raw)) {
    const body = raw.slice(cursor, match.index);
    if (body.trim()) {
      sections.push({ section: currentSection, body });
    }
    currentSection = collapseWhitespace(match[1]) || "section";
    cursor = match.index + match[0].length;
  }
  const tail = raw.slice(cursor);
  if (tail.trim()) {
    sections.push({ section: currentSection, body: tail });
  }

  const passages = [];
  for (const { section, body } of sections) {
    if (BOILERPLATE_SECTION.test(section)) {
      continue;
    }
    const sentences = splitSentences(body);
    let buffer = [];
    let bufferLength = 0;
    const flush = () => {
      if (!buffer.length) {
        return;
      }
      const merged = buffer.join(" ").trim();
      buffer = [];
      bufferLength = 0;
      if (merged.length >= minChars) {
        passages.push({ section, text: merged.slice(0, maxChars * 2) });
      }
    };
    for (const sentence of sentences) {
      const clipped = sentence.length > maxChars * 2 ? `${sentence.slice(0, maxChars * 2)}` : sentence;
      if (bufferLength && bufferLength + clipped.length > maxChars) {
        flush();
      }
      buffer.push(clipped);
      bufferLength += clipped.length + 1;
      if (bufferLength >= maxChars) {
        flush();
      }
    }
    flush();
  }

  // The lead's first passage is the definition; everything else is detail. The
  // ordering here is also the write order, so a node truncated by the caller
  // keeps the most answer-dense passages.
  return passages.slice(0, Math.max(1, maxSegments)).map((passage, index) => ({
    ordinal: index,
    layer: index === 0 && passage.section === "lead" ? "gist" : "detail",
    section: passage.section,
    text: passage.text,
  }));
}

// "a type of computer program" has its category in the tail, not the head: a
// bare head-noun rule tags the article `type`, which every taxonomic article in
// the corpus would then share and which bridges nothing.
const CLASSIFIER_NOUNS = new Set([
  "type", "kind", "form", "sort", "group", "member", "part", "variety",
  "class", "category", "species", "genus", "family", "series", "number",
  "collection", "set", "piece", "unit", "branch",
]);

function headNounPhrase(phrase) {
  const cleaned = collapseWhitespace(phrase).replace(/^(?:an|a|the)\s+/i, "");
  // Capturing split: [segment, separator, segment, separator, ...]
  const parts = cleaned.split(/\s+(in|of|for|from|at|on|near|which|that|who|based)\s+/i);
  let chosen = parts[0] ?? "";
  const lastWord = chosen.split(/\s+/).filter(Boolean).pop()?.toLocaleLowerCase("en") ?? "";
  // Only `of` carries the category into the tail ("a type **of** computer
  // program"). After a relative pronoun the tail is a clause, not a category —
  // taking it turned "an American documentary television series that ran from
  // 1963" into the tag `ran`.
  if (CLASSIFIER_NOUNS.has(lastWord) && parts[1]?.toLowerCase() === "of" && parts[2]) {
    chosen = parts[2].replace(/^(?:an|a|the)\s+/i, "");
  }
  const words = chosen.split(/\s+/).filter(Boolean).slice(0, 4);
  return words.join(" ").replace(/[,;:.]+$/, "").trim();
}

/**
 * Category / "aboutness" phrases for one article.
 *
 * These become shared `context:<slug>` nodes, which is what gives the graph
 * bridges at all: two stadiums taught days apart both link to
 * `context:football_stadium`, so recall can reach one from the other even
 * though neither article mentions the other.
 */
export function extractContextTags(title, gistText, { limit = 3 } = {}) {
  const tags = [];
  const push = (value) => {
    const cleaned = collapseWhitespace(value).replace(/[,;:.]+$/, "");
    if (cleaned.length < 3 || cleaned.length > 60) {
      return;
    }
    const lowered = cleaned.toLocaleLowerCase("en");
    if (!tags.some((entry) => entry.toLocaleLowerCase("en") === lowered)) {
      tags.push(cleaned);
    }
  };

  const parenthetical = /\(([^)]{3,60})\)\s*$/.exec(collapseWhitespace(title));
  if (parenthetical) {
    push(parenthetical[1]);
  }

  const gist = collapseWhitespace(gistText);
  const definition = /\b(?:is|was|are|were)\s+(?:an|a|the)?\s*([^,.;:()]{3,80})/i.exec(gist);
  if (definition) {
    push(headNounPhrase(definition[1]));
  }
  const known = /\b(?:known as|refers to|is the name of)\s+(?:an|a|the)?\s*([^,.;:()]{3,80})/i.exec(gist);
  if (known) {
    push(headNounPhrase(known[1]));
  }
  return tags.slice(0, limit);
}

/**
 * Proper-noun and year mentions the passage links out to.
 *
 * A capitalized run that only ever appears sentence-initially is ordinary
 * English, not a name, so it is dropped unless the same surface also shows up
 * mid-sentence — without that test every article donates "The", "After" and
 * "However" to the graph.
 */
export function extractMentionCandidates(text, { subject = "", limit = 8 } = {}) {
  const flat = collapseWhitespace(text);
  const subjectWords = new Set(normalizeWords(subject));
  const pattern =
    /\b([A-Z][\p{L}\p{N}'’.-]{1,}(?:\s+(?:of|de|the|and|for|von|van|la|le)\s+|\s+)?(?:[A-Z][\p{L}\p{N}'’.-]{1,}(?:\s+(?:of|de|the|and|for|von|van|la|le)\s+|\s+)?){0,3})/gu;
  const seen = new Map();
  for (let match = pattern.exec(flat); match; match = pattern.exec(flat)) {
    // A capitalized run must not cross a sentence boundary. The name pattern
    // allows `.` so it can carry `U.S.` and initials, which let "…in Asia. It
    // walked on two legs" become the entity "Asia. It" — and, worse, a graph
    // node other articles could link to. Cut at the first period that is
    // followed by a space.
    let surface = collapseWhitespace(match[1])
      .split(/(?<=\.)\s+/u)[0]
      .replace(/[.,;:]+$/, "")
      // The pattern's connector group can end a run on the connector itself
      // ("Mongolia the"), because it is optional and does not require another
      // capitalized word after it.
      .replace(/\s+(?:of|de|the|and|for|von|van|la|le)$/i, "")
      .trim();
    // A run that opens on a grammatical word ("The U.S. Army", "In Mongolia")
    // carries that word into the entity id; drop it so the same name written
    // with and without an article lands on one node.
    const words = surface.split(/\s+/);
    if (words.length > 1 && WEAK_CAPITAL_STARTERS.has(words[0].toLocaleLowerCase("en"))) {
      surface = words.slice(1).join(" ");
    }
    if (surface.length < 3) {
      continue;
    }
    const before = flat.slice(Math.max(0, match.index - 2), match.index);
    const sentenceInitial = match.index === 0 || /[.!?]\s$/.test(before) || /^\s*$/.test(before);
    const firstWord = surface.split(/\s+/)[0].toLocaleLowerCase("en");
    const multiWord = surface.split(/\s+/).length > 1;
    if (WEAK_CAPITAL_STARTERS.has(firstWord) && !multiWord) {
      continue;
    }
    const key = surface.toLocaleLowerCase("en");
    const entry = seen.get(key) ?? { name: surface, type: "entity", count: 0, strong: 0 };
    entry.count += 1;
    if (!sentenceInitial) {
      entry.strong += 1;
    }
    seen.set(key, entry);
  }

  const mentions = [...seen.values()]
    .filter((entry) => entry.strong > 0 || entry.name.split(/\s+/).length > 1)
    .filter((entry) => {
      const words = normalizeWords(entry.name);
      if (!words.length) {
        return false;
      }
      // Drop the subject itself and any run made only of subject words.
      return !words.every((word) => subjectWords.has(word));
    })
    .sort((left, right) => right.strong - left.strong || right.count - left.count);

  const years = new Map();
  for (const match of flat.matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/g)) {
    years.set(match[1], (years.get(match[1]) ?? 0) + 1);
  }
  const yearMentions = [...years.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([year, count]) => ({ name: year, type: "year", count, strong: count }));

  return [...mentions.slice(0, Math.max(0, limit - yearMentions.length)), ...yearMentions];
}

/**
 * Everything the retrieval ladder needs to know about a question, derived
 * without a model call: which content words to match on, which capitalized
 * runs are candidate anchors, and what shape of answer the question wants.
 */
export function questionCues(question) {
  const raw = collapseWhitespace(question);
  const lowered = raw.toLocaleLowerCase("en");
  const broad = /^(?:what do you know about|tell me about|describe|who is|who was|what is|what was)\b/i.test(
    raw,
  );

  let type = "what";
  if (/^\s*where\b|\bwhere (?:is|was|are|were)\b/i.test(raw)) {
    type = "where";
  } else if (/^\s*when\b|\bwhen (?:is|was|did|were)\b|\bwhat year\b/i.test(raw)) {
    type = "when";
  } else if (/^\s*who\b/i.test(raw)) {
    type = "who";
  } else if (/^\s*how many\b|\bhow many\b/i.test(raw)) {
    type = "how_many";
  } else if (/^\s*why\b/i.test(raw)) {
    type = "why";
  } else if (/^\s*how\b/i.test(raw)) {
    type = "how";
  } else if (/^\s*which\b/i.test(raw)) {
    type = "which";
  }

  const stripped = raw
    .replace(
      /^(?:what do you know about|tell me about|describe|who is|who was|what is|what was|where is|where was|when was|when did|how many|which|why did|why was|how did)\s+/i,
      "",
    )
    .replace(/[?.!]+\s*$/, "")
    .trim();

  const phrases = [];
  for (const match of raw.matchAll(
    /\b([A-Z][\p{L}\p{N}'’.-]{1,}(?:\s+[A-Z0-9][\p{L}\p{N}'’.-]{0,}){0,4})/gu,
  )) {
    const surface = collapseWhitespace(match[1]).replace(/[.,;:?]+$/, "");
    const firstWord = surface.split(/\s+/)[0].toLocaleLowerCase("en");
    if (WEAK_CAPITAL_STARTERS.has(firstWord) && surface.split(/\s+/).length === 1) {
      continue;
    }
    if (surface.length >= 3 && !phrases.includes(surface)) {
      phrases.push(surface);
    }
  }
  if (stripped && !phrases.includes(stripped) && stripped.length <= 80) {
    phrases.unshift(stripped);
  }

  return {
    question: raw,
    subject: stripped || raw,
    type,
    isBroad: broad,
    tokens: contentWords(stripped || raw),
    allTokens: contentWords(raw),
    phrases: phrases.slice(0, 5),
    lowered,
  };
}

function typeBonus(sentence, cues) {
  const lowered = sentence.toLocaleLowerCase("en");
  if (cues.type === "when") {
    return /\b(1[0-9]{3}|20[0-9]{2})\b/.test(sentence) ? 1.2 : 0;
  }
  if (cues.type === "where") {
    const words = normalizeWords(sentence);
    return words.some((word) => PLACE_HINT_WORDS.has(word)) || /\bin\s+[A-Z]/.test(sentence)
      ? 0.8
      : 0;
  }
  if (cues.type === "who") {
    const words = normalizeWords(sentence);
    return words.some((word) => PERSON_HINT_WORDS.has(word)) ? 0.6 : 0;
  }
  if (cues.type === "how_many") {
    return /\b\d[\d,.]*\b/.test(lowered) ? 1.0 : 0;
  }
  return 0;
}

/** Cue overlap of one text, in [0,1] plus phrase/type bonuses. */
export function scoreTextAgainstCues(text, cues) {
  const words = new Set(normalizeWords(text));
  const wanted = cues.tokens.length ? cues.tokens : cues.allTokens;
  const matched = wanted.filter((token) => words.has(token));
  const coverage = wanted.length ? matched.length / wanted.length : 0;
  const loweredText = String(text ?? "").toLocaleLowerCase("en");
  const phraseHits = cues.phrases.filter(
    (phrase) => phrase.length >= 3 && loweredText.includes(phrase.toLocaleLowerCase("en")),
  ).length;
  return {
    coverage,
    matched,
    phraseHits,
    score: coverage * 2 + phraseHits * 0.8 + typeBonus(text, cues),
  };
}

/**
 * Deterministic extractive answer: the best 1-2 sentence window across the
 * retrieved passages.
 *
 * This is what closes the gap the previous benchmark ended on — a specific
 * question whose answer sits inside a retrieved paragraph used to be declined,
 * because the only fallback available was "return the whole paragraph", which
 * is wrong for a specific question. A span keeps the answer specific without
 * trusting the model's composition.
 */
export function selectAnswerSpan(
  passages,
  cues,
  { maxSentences = 2, minScore = 0.5, focusTokens = null, requireTypeMatch = false } = {},
) {
  // The focus tokens are the question's words that are *not* the subject's own
  // name. Scoring on the full cue set lets a passage pass on the subject alone,
  // which is exactly how "When was Alpha founded?" would get answered with
  // "Alpha is located in One." — related, and wrong.
  const focus = Array.isArray(focusTokens) ? focusTokens.filter(Boolean) : null;
  const typed = ["when", "where", "how_many"].includes(cues.type);
  const candidates = [];
  for (const passage of Array.isArray(passages) ? passages : []) {
    const sentences = splitSentences(passage?.text ?? "");
    for (let index = 0; index < sentences.length; index += 1) {
      for (let span = 1; span <= maxSentences && index + span <= sentences.length; span += 1) {
        const text = sentences.slice(index, index + span).join(" ");
        const scored = scoreTextAgainstCues(text, cues);
        const words = new Set(normalizeWords(text));
        const matchedFocus = focus ? focus.filter((token) => words.has(token)) : [];
        if (focus && focus.length && !matchedFocus.length) {
          continue;
        }
        if (requireTypeMatch && typed && typeBonus(text, cues) <= 0) {
          continue;
        }
        candidates.push({
          text,
          passageId: passage?.id ?? null,
          sourceLayer: passage?.layer ?? null,
          sourceSubject: passage?.subject ?? null,
          // A single sentence that covers the cues is better than two; the
          // length penalty keeps a span from growing to swallow the paragraph.
          score: scored.score - (span - 1) * 0.25 + matchedFocus.length * 0.6,
          coverage: scored.coverage,
          matched: scored.matched,
          matchedFocus,
        });
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0] ?? null;
  if (!best || best.score < minScore) {
    return null;
  }
  return best;
}

/**
 * Fraction of the answer's own content words that occur in the cited evidence.
 *
 * The previous grounding check only asked whether an `evidence` string matched
 * a retrieved reference — so a model could pair a correct-looking quote with an
 * answer about something else entirely and pass. This measures the answer.
 */
export function evidenceSupportRatio(answer, evidenceTexts) {
  const answerWords = contentWords(answer);
  if (!answerWords.length) {
    return 0;
  }
  const evidenceWords = new Set(
    (Array.isArray(evidenceTexts) ? evidenceTexts : [evidenceTexts]).flatMap((entry) =>
      normalizeWords(entry),
    ),
  );
  if (!evidenceWords.size) {
    return 0;
  }
  const supported = answerWords.filter((word) => evidenceWords.has(word));
  return supported.length / answerWords.length;
}

/** Overlap of two texts by content words — used to score answers against gold. */
export function contentOverlapRatio(candidate, reference) {
  const candidateWords = contentWords(candidate);
  if (!candidateWords.length) {
    return 0;
  }
  const referenceWords = new Set(contentWords(reference));
  if (!referenceWords.size) {
    return 0;
  }
  const hits = candidateWords.filter((word) => referenceWords.has(word));
  return hits.length / candidateWords.length;
}

export { STOP_WORDS };
