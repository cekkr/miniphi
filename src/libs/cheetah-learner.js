import { parseStrictJsonObject } from "./core-utils.js";
import { buildStopReasonInfo } from "./lmstudio-error-utils.js";
import {
  topicId,
  probeBeforeWrite,
  writeFacts,
  writeLayeredMemory,
  logEpisode,
  recallAnchorFacts,
  recordOpenQuestion,
} from "./cheetah-knowledge-client.js";
import {
  segmentArticle,
  extractContextTags,
  extractMentionCandidates,
  questionCues,
  selectAnswerSpan,
  evidenceSupportRatio,
  contentWords,
  normalizeWords,
} from "./cheetah-memory-layers.js";
import { retrieveLayeredMemory, retrieveFollowUp } from "./cheetah-hippocampus.js";

/**
 * Orchestrates the "ignorant model" teach/recall loop: a schema-enforced LLM
 * call sits between the caller and the Cheetah adapter, with the model never
 * touching Cheetah directly (docs/prompts/cheetah-teach-layered.schema.json /
 * cheetah-recall-layered.schema.json). Mirrors src/commands/nitpick.js's
 * double-layer validation/fallback pattern exactly: one automatic schema-repair
 * retry lives inside LMStudioHandler.chatStream (maxSchemaRetries=1); a
 * deterministic fallback sits on top here, plus a parseStrictJsonObject()
 * belt-and-suspenders re-check.
 *
 * Both directions are *layered* (see cheetah-memory-layers.js and
 * cheetah-hippocampus.js). Teaching writes a gist, per-passage detail nodes,
 * shared context/mention nodes and contextual relations rather than one
 * sentence on one node; recall runs anchor + spreading-activation + lexical
 * retrieval, lets the model ask for more memory, and adjudicates the answer
 * against what was actually retrieved.
 */

const TEACH_SCHEMA_ID = "cheetah-teach-layered";
const RECALL_SCHEMA_ID = "cheetah-recall-layered";
// A composed answer has to be *made of* the evidence, not merely accompanied by
// a matching quote — the previous check accepted an unrelated answer paired
// with a correct-looking citation.
const MIN_ANSWER_SUPPORT = 0.6;

function normalizeStopReasonFields(payload = undefined) {
  const rawReason = payload?.stopReason ?? payload?.stop_reason ?? null;
  const rawCode = payload?.stopReasonCode ?? payload?.stop_reason_code ?? null;
  const rawDetail = payload?.stopReasonDetail ?? payload?.stop_reason_detail ?? null;
  const stopInfo = buildStopReasonInfo({
    error: rawDetail,
    fallbackReason: rawReason,
    fallbackCode: rawCode,
    fallbackDetail: rawDetail,
  });
  return {
    stopReason: stopInfo.reason ?? null,
    stopReasonCode: stopInfo.code ?? null,
    stopReasonDetail: stopInfo.detail ?? null,
  };
}

// Teach-fallback = write nothing (safe default). Recall-fallback = decline +
// raise a question (safe default for the anti-hallucination requirement,
// even under total LM failure).
function buildCheetahFallback(schemaId, { reason, originalQuestion } = {}) {
  const normalizedStop = normalizeStopReasonFields({
    stop_reason: reason,
    stop_reason_code: "analysis-error",
    stop_reason_detail: reason,
  });
  const base = {
    schema_version: "fallback-v1",
    stop_reason: normalizedStop.stopReason ?? "analysis-error",
    stop_reason_code: normalizedStop.stopReasonCode ?? "analysis-error",
    stop_reason_detail: normalizedStop.stopReasonDetail ?? reason ?? null,
  };
  if (schemaId.startsWith("cheetah-teach")) {
    return {
      ...base,
      thinking: `Fallback: ${reason ?? "unknown error"}. Writing nothing.`,
      subject_name: "",
      subject_type: "other",
      subject_context: "",
      context_tags: [],
      no_new_information: true,
      new_facts: [],
      related_subjects: [],
      known_facts: [],
    };
  }
  return {
    ...base,
    reasoning_steps: [`Fallback: ${reason ?? "unknown error"}. Declining to answer.`],
    grounded: false,
    answer: "I don't know.",
    confidence: "unknown",
    used_evidence_ids: [],
    evidence: [],
    needs_more_context: false,
    follow_up_lookups: [],
    open_question: {
      has_question: true,
      question_text: originalQuestion ?? "",
      topic_hint: "",
    },
  };
}

async function runCheetahPromptStep({
  handler,
  prompt,
  schemaId,
  label,
  metadata,
  mainPromptId,
  originalQuestion,
}) {
  handler.clearHistory();
  try {
    const raw = await handler.chatStream(prompt, undefined, undefined, undefined, {
      scope: "sub",
      label,
      schemaId,
      metadata,
      mainPromptId,
    });
    const parsed = parseStrictJsonObject(raw);
    if (!parsed) {
      return {
        response: buildCheetahFallback(schemaId, { reason: "invalid-json", originalQuestion }),
        raw,
        error: "invalid-json",
      };
    }
    const normalizedStop = normalizeStopReasonFields(parsed);
    const response = {
      ...parsed,
      stop_reason: normalizedStop.stopReason,
      stop_reason_code: normalizedStop.stopReasonCode,
      stop_reason_detail: normalizedStop.stopReasonDetail,
    };
    return { response, raw, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      response: buildCheetahFallback(schemaId, { reason: message, originalQuestion }),
      raw: null,
      error: message,
    };
  }
}

function buildSchemaBlock(schemaRegistry, schemaId) {
  // The prompt contract requires the exact schema, not a truncated preview;
  // response_format carries the same registry entry independently.
  //
  // The schema's own `title` is dropped from the prompt copy only. A model this
  // small reads any prominent proper-sounding string as content: live runs on
  // both schema generations produced `subject_name: "MiniPhi Cheetah ... teach
  // turn"`, i.e. it stored the schema's title as the article's subject.
  const schema = schemaRegistry?.getSchema?.(schemaId);
  if (!schema) {
    return schemaRegistry?.buildInstructionBlock?.(schemaId, { compact: true }) ?? "";
  }
  const { title, $schema, ...rest } = schema.definition ?? {};
  return ["```json", JSON.stringify(rest), "```"].join("\n");
}

/**
 * The teach prompt now has to teach the *model* how memory works, not just ask
 * for triples. A bare "extract (relation, object)" instruction is what produced
 * the previous generation's context-free store: the model returned isolated
 * pairs with nothing situating them, so a later reader could not tell what the
 * object meant or why it mattered.
 */
function buildLayeredTeachPrompt({ sourceText, subjectHint, schemaBlock, knownRelations }) {
  const subject = subjectHint?.subject ? `"${subjectHint.subject}"` : "the subject of this passage";
  const relationList = (Array.isArray(knownRelations) ? knownRelations : [])
    .map((entry) => entry?.type)
    .filter(Boolean);
  // Kept deliberately short. The turn used to restate every rule twice (once in
  // prose, once in the schema descriptions) and to ask for a free-text
  // `thinking` field; against a reasoning distill that cost thousands of
  // reasoning tokens per article and minutes of wall clock, for fields the
  // deterministic layer already produces.
  const lines = [
    `You are writing ${subject} into an external memory that another reader will search LATER, with none of this passage in front of them.`,
    "They will see only what you store, so what you store has to carry the context that makes it understandable on its own.",
    "",
    `SOURCE TEXT: ${sourceText}`,
    "",
    relationList.length
      ? `Already recorded in the memory about this subject: ${relationList.join(", ")}.`
      : "Already recorded in the memory about this subject: nothing yet.",
    "",
    subjectHint?.subject && !subjectHint.authoritative
      ? "If the passage is not actually about that subject, correct it in subject_name."
      : "",
    "Store three things:",
    "- subject_context: one short clause saying what kind of thing this is, in the SOURCE TEXT's own words.",
    "- context_tags: general category phrases it shares with OTHER subjects ('football stadium', 'state highway'). Common nouns only - these are the bridges between subjects, so never a proper name.",
    "- new_facts: what the passage states about it. Each fact needs a relation verb from the SOURCE TEXT, an object copied verbatim from it, the situating `context` a later reader needs, and `evidence_quote`, the verbatim fragment that states it.",
    "",
    "Rules:",
    "- Copying facts out of the SOURCE TEXT is the task. A passage that plainly states where, when, what or who must produce new_facts; an empty list because the facts feel obvious is a failure.",
    "- Never bring in anything the SOURCE TEXT does not say. Every object_name and evidence_quote must occur in it verbatim, and every relation must come from a verb written near that object.",
    "- Numbers, dates and names written in the SOURCE TEXT are exactly what to save; copy them as written.",
    "- Set no_new_information=true only if everything is already on the 'Already recorded' line above; never because you personally recognize the subject.",
    '- Set stop_reason to "completed". Answer directly, without deliberating at length.',
    "",
    "Return strict JSON only that matches this schema:",
    schemaBlock,
    "",
    // The last line is the task reminder, not the schema: a small model echoes
    // whatever it read last, and a run that ended on the schema filed articles
    // under the schema's own title.
    "Fill every field from SOURCE TEXT above, never from this instruction text or from the schema.",
  ];
  return lines.filter(Boolean).join("\n");
}

function readableName(id) {
  const raw = String(id ?? "");
  const afterColon = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const spaced = afterColon.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : raw;
}

/**
 * Render the retrieved layers as an id-tagged evidence block.
 *
 * Ids matter: the model is asked to cite them, which turns "did the model use
 * the evidence?" from a guess about string overlap into a checkable claim, and
 * gives it a vocabulary for saying which item was insufficient.
 */
function describeLayeredMemory(memory) {
  const lines = [];
  if (memory.anchors.length) {
    lines.push(
      `Memory anchor: ${memory.anchors.map((anchor) => anchor.name).join(", ")}`,
    );
  }
  const passages = Array.isArray(memory.passages) ? memory.passages : [];
  if (!passages.length && !memory.relations.length) {
    return "No memory items were retrieved for this question.";
  }
  for (const passage of passages) {
    const origin =
      passage.origin === "direct"
        ? "about the subject"
        : passage.origin === "follow_up"
          ? "fetched on your request"
          : "associated";
    const section =
      passage.section && passage.section !== "lead" ? `, section "${passage.section}"` : "";
    lines.push(`${passage.id} [${origin}: ${passage.subject}${section}] "${passage.text}"`);
  }
  for (const [index, relation] of memory.relations.slice(0, 4).entries()) {
    lines.push(`r${index + 1} [stored relation] ${relation.text}`);
  }
  return lines.join("\n");
}

function buildLayeredRecallPrompt({ question, memory, schemaBlock, round, previousGap }) {
  // Deliberately no worked example: live tiny-model runs copied example facts
  // instead of grounding on the real evidence.
  const lines = [
    "Answer a question using ONLY the memory items below - never your own training knowledge.",
    "",
    "MEMORY ITEMS RETRIEVED FOR THIS QUESTION (each has an id you must cite):",
    describeLayeredMemory(memory),
    "",
    `QUESTION: ${question}`,
    "",
    "How to reason over this memory:",
    "- Work out what the question is asking for (a place, a date, a role, a description, ...).",
    "- Go through the items and name, in reasoning_steps, which id supplies that thing.",
    "- If one item gives it, answer that exact question in one or two sentences using the item's own wording, set grounded=true, put its id in used_evidence_ids and copy the fragment you used into evidence.",
    "- Do not answer a wider question than the one asked, and do not pad the answer with parts of an item that are not about the question.",
  ];
  if (round === 1) {
    lines.push(
      "- If the items are about the right subject but none of them states what is asked, set needs_more_context=true and put what the memory should be searched for next into follow_up_lookups (a subject name, or a term). Do not guess.",
    );
  } else {
    lines.push(
      "- This is the final round: extra memory was already fetched for you. If it still does not state the answer, set grounded=false and answer that you don't know.",
    );
  }
  lines.push(
    "- If the items are empty or unrelated, set grounded=false, answer that you don't know, and fill in open_question.",
  );
  if (previousGap) {
    lines.push("", `You previously said the memory was missing: ${previousGap}`);
  }
  lines.push(
    "",
    'Set stop_reason to "completed".',
    "Return strict JSON only that matches this schema:",
    schemaBlock,
  );
  return lines.filter(Boolean).join("\n");
}

function stripQuestionPrefix(question) {
  const patterns = [
    /^what\s+do\s+you\s+know\s+about\s+/i,
    /^who\s+is\s+/i,
    /^who\s+was\s+/i,
    /^what\s+is\s+/i,
    /^what\s+was\s+/i,
    /^where\s+is\s+/i,
    /^tell\s+me\s+about\s+/i,
  ];
  let stripped = String(question ?? "").trim();
  for (const pattern of patterns) {
    stripped = stripped.replace(pattern, "");
  }
  return stripped.replace(/[?.!]+$/g, "").trim();
}

function normalizeGroundingText(value) {
  return normalizeWords(value).join(" ");
}

/**
 * Deterministic gate on model-proposed facts. `evidence_quote` is the stronger
 * check when the model supplies one (the whole fact has to be written in the
 * source); the relation-near-object check remains for turns that omit it.
 */
function filterSourceGroundedFacts(facts, snippetText) {
  const normalizedSource = ` ${normalizeGroundingText(snippetText)} `;
  const normalizedSentences = String(snippetText ?? "")
    .split(/(?<=[.!?])\s+/u)
    .map(normalizeGroundingText)
    .filter(Boolean);
  const relationStopWords = new Set([
    "a", "an", "and", "as", "at", "by", "for", "from", "has", "have", "in", "is",
    "of", "on", "or", "the", "to", "was", "were", "with",
  ]);
  const accepted = [];
  const rejected = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    const objectName = typeof fact?.object_name === "string" ? fact.object_name.trim() : "";
    const normalizedObject = normalizeGroundingText(objectName);
    if (!normalizedObject || !normalizedSource.includes(` ${normalizedObject} `)) {
      rejected.push({
        relation: fact?.relation ?? null,
        objectName: objectName || null,
        reason: "object-not-in-source",
      });
      continue;
    }
    const quote = typeof fact?.evidence_quote === "string" ? fact.evidence_quote.trim() : "";
    const normalizedQuote = normalizeGroundingText(quote);
    if (normalizedQuote && normalizedQuote.split(" ").length >= 3) {
      if (!normalizedSource.includes(` ${normalizedQuote} `)) {
        rejected.push({
          relation: fact?.relation ?? null,
          objectName,
          reason: "evidence-quote-not-in-source",
        });
        continue;
      }
      accepted.push(fact);
      continue;
    }
    const relationTokens = normalizeGroundingText(fact?.relation)
      .split(" ")
      .filter((token) => token.length >= 3 && !relationStopWords.has(token));
    const objectSentences = normalizedSentences.filter((sentence) =>
      ` ${sentence} `.includes(` ${normalizedObject} `),
    );
    const relationSupported = relationTokens.length > 0 && objectSentences.some((sentence) => {
      const sentenceTokens = sentence.split(" ");
      return relationTokens.every((relationToken) => {
        const prefix = relationToken.slice(0, Math.min(5, relationToken.length));
        return sentenceTokens.some((token) => token.startsWith(prefix));
      });
    });
    if (!relationSupported) {
      rejected.push({
        relation: fact?.relation ?? null,
        objectName,
        reason: "relation-not-supported-near-object",
      });
      continue;
    }
    accepted.push(fact);
  }
  return { accepted, rejected };
}

/** A phrase the model wrote is only stored when the source actually contains it. */
function verbatimInSource(value, sourceText) {
  const normalized = normalizeGroundingText(value);
  if (!normalized) {
    return false;
  }
  return ` ${normalizeGroundingText(sourceText)} `.includes(` ${normalized} `);
}

function isDeclineAnswer(answer) {
  return /\b(i\s+(?:do\s+not|don['’]?t)\s+know|unknown|not\s+known|no\s+answer)\b/i.test(
    String(answer ?? ""),
  );
}

function isBroadMemoryQuestion(question, subjectName) {
  const normalizedQuestion = normalizeGroundingText(question);
  const normalizedSubject = normalizeGroundingText(subjectName);
  if (!normalizedQuestion || !normalizedSubject) {
    return false;
  }
  return [
    `what do you know about ${normalizedSubject}`,
    `tell me about ${normalizedSubject}`,
    `describe ${normalizedSubject}`,
  ].includes(normalizedQuestion);
}

/**
 * Log the episode, ask the "teacher" turn, and write the layered memory the
 * article supports. Returns a structured record of what was learned/skipped
 * for the caller to report on.
 */
export async function teachFromText(
  text,
  {
    handler,
    cheetahClient,
    schemaRegistry,
    subjectHint = null,
    sequence,
    mainPromptId,
    source = "cheetah-learn",
    maxPromptChars = 900,
    maxPassages = 6,
  } = {},
) {
  const episode = await logEpisode(cheetahClient, text, { sequence });
  const passages = segmentArticle(episode.text, { maxSegments: maxPassages });
  const gistText = passages[0]?.text ?? episode.text.slice(0, 320);

  // The model reads a bounded excerpt (small models degrade fast on long
  // input), while segmentation/mention extraction run over the whole bounded
  // article — those are deterministic, so they cost nothing in reliability.
  let promptSource = "";
  for (const passage of passages) {
    if (promptSource && promptSource.length + passage.text.length > maxPromptChars) {
      break;
    }
    promptSource = promptSource ? `${promptSource} ${passage.text}` : passage.text;
  }
  if (!promptSource) {
    promptSource = episode.text.slice(0, maxPromptChars);
  }

  // Probe BEFORE prompting (GRAPH_LLM.md §4 step 2), using the hinted subject
  // id, and feed the histogram into the prompt as "already recorded in the
  // database". Without this, a model reliably answers from its own training
  // knowledge instead ("I already know Springfield is in Illinois") and
  // never writes anything - live-observed on the first proof run.
  const hintedSubjectId = subjectHint?.subject ? topicId(subjectHint.subject) : null;
  const preProbe = hintedSubjectId
    ? await probeBeforeWrite(cheetahClient, hintedSubjectId)
    : { exists: false, relationHistogram: [] };

  const schemaBlock = buildSchemaBlock(schemaRegistry, TEACH_SCHEMA_ID);
  const prompt = buildLayeredTeachPrompt({
    sourceText: promptSource,
    subjectHint,
    schemaBlock,
    knownRelations: preProbe.relationHistogram,
  });
  const step = await runCheetahPromptStep({
    handler,
    prompt,
    schemaId: TEACH_SCHEMA_ID,
    label: "cheetah-teach",
    metadata: { mode: "cheetah-learn", subContext: "teach" },
    mainPromptId,
  });
  const parsed = step.response;
  const modelSubjectName =
    typeof parsed.subject_name === "string" && parsed.subject_name.trim()
      ? parsed.subject_name.trim()
      : null;
  const canonicalSubjectName =
    subjectHint?.authoritative && typeof subjectHint.subject === "string"
      ? subjectHint.subject.trim()
      : null;
  const subjectName = canonicalSubjectName || modelSubjectName || subjectHint?.subject || "unknown";
  const subjectType = parsed.subject_type || "other";
  const subjectId = topicId(subjectName);

  const declaredFacts = Array.isArray(parsed.new_facts) ? parsed.new_facts : [];
  const groundedFacts = filterSourceGroundedFacts(declaredFacts, promptSource);

  // Context layer: the deterministic category first, then the model's own tags
  // when the source supports them. A category has to be a *shared* kind of
  // thing, so a proper name is rejected here and kept as a mention instead —
  // live-observed: a lake article proposed "Fairy Stone State Park" as its
  // category, which would have made a neighbouring park the lake's whole frame.
  const derivedTags = extractContextTags(subjectName, gistText);
  const modelTags = (Array.isArray(parsed.context_tags) ? parsed.context_tags : [])
    .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
    .filter(
      (tag) =>
        tag.length >= 3 &&
        tag.length <= 60 &&
        verbatimInSource(tag, promptSource) &&
        // A category is a common noun. Reject a tag whose words are all
        // capitalized ("Fairy Stone State Park") and a bare capitalized word
        // ("Mutual") — both are names of things, and as a category node they
        // would bridge subjects that have nothing in common.
        !tag.split(/\s+/).every((word) => /^[A-Z0-9]/.test(word)),
    );
  const contextTags = [];
  for (const tag of [...derivedTags, ...modelTags]) {
    const lowered = tag.toLocaleLowerCase("en");
    if (!contextTags.some((entry) => entry.toLocaleLowerCase("en") === lowered)) {
      contextTags.push(tag);
    }
  }

  // The model's own framing sentence is worth keeping when it is genuinely made
  // of the source's words, even though it is a paraphrase rather than a verbatim
  // span — it is the one place a re-worded summary is useful. Requiring near
  // total word support is what keeps it from becoming a hallucination surface.
  const subjectContextRaw =
    typeof parsed.subject_context === "string" ? parsed.subject_context.trim() : "";
  const subjectContextSupport = subjectContextRaw
    ? evidenceSupportRatio(subjectContextRaw, [promptSource])
    : 0;
  const subjectContext =
    subjectContextRaw && subjectContextSupport >= 0.85
      ? subjectContextRaw.slice(0, 200)
      : contextTags[0]
        ? `${subjectName} is ${/^[aeiou]/i.test(contextTags[0]) ? "an" : "a"} ${contextTags[0]}.`
        : null;

  const relatedSubjects = (Array.isArray(parsed.related_subjects) ? parsed.related_subjects : [])
    .map((entry) => (typeof entry?.name === "string" ? entry.name.trim() : ""))
    .filter((name) => name.length >= 3 && verbatimInSource(name, promptSource))
    .map((name) => ({ name, type: "entity", count: 1, strong: 1 }));
  // Mentions come from the segmented passages, not the raw article: navigation
  // sections are already dropped there.
  const cleanBody = passages.map((passage) => passage.text).join(" ") || episode.text;
  const derivedMentions = extractMentionCandidates(cleanBody, { subject: subjectName, limit: 8 });
  const mentions = [];
  for (const mention of [...relatedSubjects, ...derivedMentions]) {
    const lowered = mention.name.toLocaleLowerCase("en");
    if (!mentions.some((entry) => entry.name.toLocaleLowerCase("en") === lowered)) {
      mentions.push(mention);
    }
  }

  let batchResult = {
    applied: 0,
    created: 0,
    updated: 0,
    failed: 0,
    edgeCount: 0,
    passageNodes: 0,
    contextNodes: 0,
    mentionNodes: 0,
  };
  let memoryWritten = false;
  let probeResult = subjectId === hintedSubjectId ? preProbe : { exists: false, relationHistogram: [] };
  const shouldWriteAuthoritativeMemory = Boolean(canonicalSubjectName && episode.text);
  if (
    shouldWriteAuthoritativeMemory ||
    (!parsed.no_new_information && groundedFacts.accepted.length)
  ) {
    if (subjectId !== hintedSubjectId) {
      // The model corrected/renamed the subject away from the hint; the
      // pre-probe no longer applies, so probe again against the real id.
      probeResult = await probeBeforeWrite(cheetahClient, subjectId);
    }
    batchResult = await writeLayeredMemory(cheetahClient, {
      subjectId,
      subjectType,
      subjectName,
      subjectContext,
      gistText,
      passages,
      contextTags: contextTags.slice(0, 3),
      mentions,
      facts: parsed.no_new_information ? [] : groundedFacts.accepted,
      insertKey: episode.insertKey,
      source,
    });
    memoryWritten = true;
  }

  return {
    subjectId,
    subjectName,
    modelSubjectName,
    canonicalSubjectApplied: Boolean(canonicalSubjectName),
    subjectType,
    subjectContext,
    contextTags: contextTags.slice(0, 3),
    mentions: mentions.slice(0, 8).map((mention) => mention.name),
    passages: passages.map((passage) => ({
      ordinal: passage.ordinal,
      layer: passage.layer,
      section: passage.section,
      text: passage.text,
    })),
    insertKey: episode.insertKey,
    episodePairKey: episode.episodePairKey,
    thinking: parsed.thinking ?? null,
    noNewInformation: Boolean(parsed.no_new_information),
    alreadyKnownBeforeWrite: probeResult.exists,
    newFactsWritten: parsed.no_new_information ? 0 : groundedFacts.accepted.length,
    memoryWritten,
    rejectedFacts: groundedFacts.rejected,
    rejectedFactsCount: groundedFacts.rejected.length,
    knownFactsSkipped: Array.isArray(parsed.known_facts) ? parsed.known_facts : [],
    batchResult,
    stopReason: parsed.stop_reason ?? null,
    error: step.error,
    promptTrace: {
      schemaId: TEACH_SCHEMA_ID,
      prompt,
      responseRaw: step.raw,
      parsed,
      sourceGivenToModel: promptSource,
      episodeText: episode.text,
    },
  };
}

/** Which retrieved items the model actually cited, resolved back to their text. */
function resolveCitedPassages(memory, parsed) {
  const byId = new Map(memory.passages.map((passage) => [passage.id, passage]));
  const cited = [];
  for (const id of Array.isArray(parsed?.used_evidence_ids) ? parsed.used_evidence_ids : []) {
    const passage = byId.get(String(id ?? "").trim());
    if (passage && !cited.includes(passage)) {
      cited.push(passage);
    }
  }
  return cited;
}

function evidenceMatchesRetrieved(evidence, passageTexts) {
  return evidence.some((entry) => {
    const normalizedEvidence = normalizeGroundingText(entry);
    if (!normalizedEvidence || normalizedEvidence.split(" ").length < 2) {
      return false;
    }
    return passageTexts.some((text) => {
      const normalizedText = normalizeGroundingText(text);
      return (
        normalizedText.includes(normalizedEvidence) || normalizedEvidence.includes(normalizedText)
      );
    });
  });
}

/**
 * Cue tokens that are *not* just the subject's own name.
 *
 * This is what separates "the memory is about the right thing" from "the memory
 * answers the thing asked". A question like "When was Alpha founded?" against a
 * passage saying only where Alpha is shares the token `alpha` and nothing else;
 * without this split an extractive fallback happily returns the wrong sentence.
 */
function focusTokensFor(cues, anchors) {
  const anchorWords = new Set(
    anchors.flatMap((anchor) => normalizeWords(anchor.name)).concat(normalizeWords(cues.subject)),
  );
  return cues.tokens.filter((token) => !anchorWords.has(token));
}

/**
 * Resolve the anchors via the hippocampal ladder, ask the "recaller" turn with
 * the retrieved layers embedded as id-tagged context (the model never talks to
 * Cheetah directly), let it request one round of extra memory, adjudicate
 * groundedness, and record an open question whenever the answer isn't actually
 * grounded.
 */
export async function recallAnswer(
  question,
  {
    handler,
    cheetahClient,
    schemaRegistry,
    subjectHint = null,
    mainPromptId,
    recordMiss = true,
    maxPassages = 8,
    maxRounds = 2,
  } = {},
) {
  const guessedSubject = subjectHint ?? stripQuestionPrefix(question);
  const cheetahTrace = [];
  const memory = await retrieveLayeredMemory(cheetahClient, {
    question,
    subjectHint: guessedSubject,
    maxPassages,
    trace: cheetahTrace,
  });

  const schemaBlock = buildSchemaBlock(schemaRegistry, RECALL_SCHEMA_ID);
  const rounds = [];
  let parsed = null;
  let step = null;
  let round = 1;
  let previousGap = null;
  let followUps = [];

  while (round <= Math.max(1, maxRounds)) {
    const prompt = buildLayeredRecallPrompt({
      question,
      memory,
      schemaBlock,
      round,
      previousGap,
    });
    step = await runCheetahPromptStep({
      handler,
      prompt,
      schemaId: RECALL_SCHEMA_ID,
      label: "cheetah-recall",
      metadata: { mode: "cheetah-learn", subContext: "recall", round },
      mainPromptId,
      originalQuestion: question,
    });
    parsed = step.response;
    rounds.push({
      round,
      prompt,
      responseRaw: step.raw,
      parsed,
      evidenceShown: memory.passages.map((passage) => ({
        id: passage.id,
        subject: passage.subject,
        origin: passage.origin,
        text: passage.text,
      })),
      error: step.error,
    });

    const wantsMore =
      round < Math.max(1, maxRounds) &&
      parsed?.needs_more_context === true &&
      Array.isArray(parsed?.follow_up_lookups) &&
      parsed.follow_up_lookups.length > 0;
    if (!wantsMore) {
      break;
    }
    followUps = parsed.follow_up_lookups;
    previousGap = followUps
      .map((lookup) => `${lookup?.value ?? ""}${lookup?.why ? ` (${lookup.why})` : ""}`)
      .filter(Boolean)
      .join("; ");
    const extra = await retrieveFollowUp(cheetahClient, {
      lookups: followUps,
      question,
      knownTexts: memory.passages.map((passage) => passage.text),
      trace: cheetahTrace,
    });
    if (!extra.passages.length) {
      break;
    }
    // Renumber so the model sees one consistent id space across both rounds.
    memory.passages = [...memory.passages, ...extra.passages].map((passage, index) => ({
      ...passage,
      id: `e${index + 1}`,
    }));
    round += 1;
  }

  // Load-bearing anti-hallucination rule: never trust the model's own
  // `grounded` claim alone. Now it is checked three ways - the adapter's own
  // retrieval must have resolved something, the citation must point at a real
  // retrieved item, and the answer's own words must come from that item.
  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
    : [];
  const passageTexts = memory.passages.map((passage) => passage.text);
  const citedPassages = resolveCitedPassages(memory, parsed);
  const citationValid = citedPassages.length > 0;
  const evidenceMatched = evidenceMatchesRetrieved(evidence, passageTexts);
  const supportTexts = citationValid
    ? citedPassages.map((passage) => passage.text)
    : evidenceMatched
      ? passageTexts
      : [];
  const answerSupport = evidenceSupportRatio(answer, supportTexts);

  const modelClaimedGroundedButAnchorMissing = Boolean(parsed.grounded) && !memory.anchorResolved;
  const modelGrounded = Boolean(
    memory.resolved &&
      parsed.grounded === true &&
      answer &&
      !isDeclineAnswer(answer) &&
      (citationValid || evidenceMatched) &&
      answerSupport >= MIN_ANSWER_SUPPORT,
  );
  const modelClaimedGroundedButAnswerInvalid = Boolean(parsed.grounded) && !modelGrounded;

  const broad = memory.cues.isBroad || isBroadMemoryQuestion(question, guessedSubject);
  // What a broad question may fall back on: the anchor's own gist first, then
  // any other passage stored on the anchor, then — only when an anchor actually
  // resolved — a passage reached by spreading from it, which is anchor-adjacent
  // by construction. Lexical hits are deliberately excluded: they are the only
  // thing a never-taught subject can retrieve, so allowing them here is exactly
  // how a control question would get somebody else's article as its answer.
  const gistPassage =
    memory.passages.find((passage) => passage.origin === "direct" && passage.layer === "gist") ??
    memory.passages.find((passage) => passage.origin === "direct") ??
    (memory.anchorResolved
      ? (memory.passages.find((passage) => passage.origin === "associated") ?? null)
      : null);

  // Deterministic answer paths, in the order the memory supports them:
  // a broad question gets the stored gist; a specific one gets the extractive
  // span that actually covers what was asked. The span is what the previous
  // generation had no answer for - it declined rather than return a related
  // paragraph, which was right but left the answer on the table.
  let deterministicAnswer = null;
  let deterministicSource = null;
  let deterministicEvidence = null;
  if (!modelGrounded && broad && gistPassage) {
    deterministicAnswer = gistPassage.text;
    deterministicEvidence = gistPassage.text;
    deterministicSource = "deterministic-reference-fallback";
  } else if (!modelGrounded && !broad && memory.passages.length) {
    // Only a specific question gets an extractive span. For a broad question
    // the focus tokens are just the subject's own name, so any lexically
    // similar passage would qualify — that is how a never-taught subject would
    // get an answer assembled out of somebody else's article.
    const focusTokens = focusTokensFor(memory.cues, memory.anchors);
    const span = selectAnswerSpan(memory.passages, memory.cues, {
      focusTokens,
      requireTypeMatch: true,
      minScore: 0.6,
    });
    if (span) {
      deterministicAnswer = span.text;
      deterministicEvidence = span.text;
      deterministicSource = "deterministic-extractive-span";
    }
  }
  const deterministicFallbackUsed = Boolean(deterministicAnswer);
  const effectiveGrounded = modelGrounded || deterministicFallbackUsed;

  let openQuestion = null;
  if (!effectiveGrounded && recordMiss) {
    const questionText =
      parsed.open_question?.has_question && parsed.open_question?.question_text?.trim()
        ? parsed.open_question.question_text.trim()
        : question;
    const topicHint = parsed.open_question?.topic_hint?.trim() || guessedSubject || null;
    const recorded = await recordOpenQuestion(cheetahClient, { questionText, topicHint });
    openQuestion = { ...recorded, questionText, topicHint };
  }

  return {
    question,
    anchorId: memory.anchors[0]?.id ?? null,
    anchorResolved: memory.anchorResolved,
    retrievalResolved: memory.resolved,
    grounded: effectiveGrounded,
    modelGrounded,
    deterministicFallbackUsed,
    answerSource: modelGrounded ? "model" : (deterministicSource ?? "decline"),
    modelClaimedGroundedButAnchorMissing,
    modelClaimedGroundedButAnswerInvalid,
    answerSupport,
    citedEvidenceIds: citedPassages.map((passage) => passage.id),
    answer: modelGrounded ? answer : (deterministicAnswer ?? "I don't know."),
    confidence: effectiveGrounded
      ? modelGrounded
        ? (parsed.confidence ?? "unknown")
        : "certain"
      : "unknown",
    evidence: modelGrounded ? evidence : deterministicEvidence ? [deterministicEvidence] : [],
    reasoningSteps: Array.isArray(parsed.reasoning_steps) ? parsed.reasoning_steps : [],
    followUpLookups: followUps,
    thinking: parsed.thinking ?? null,
    openQuestion,
    stopReason: parsed.stop_reason ?? null,
    error: step?.error ?? null,
    memory: {
      anchors: memory.anchors,
      candidates: memory.candidates,
      passages: memory.passages,
      relations: memory.relations,
      relationHistogram: memory.relationHistogram,
      stats: memory.stats,
    },
    cheetahTrace,
    promptTrace: { schemaId: RECALL_SCHEMA_ID, rounds },
  };
}

export { recallAnchorFacts, writeFacts, contentWords, questionCues, readableName };
