import { parseStrictJsonObject } from "./core-utils.js";
import { buildStopReasonInfo } from "./lmstudio-error-utils.js";
import {
  topicId,
  probeBeforeWrite,
  writeFacts,
  logEpisode,
  recallAnchorFacts,
  recordOpenQuestion,
} from "./cheetah-knowledge-client.js";

/**
 * Orchestrates the "ignorant model" teach/recall loop: a schema-enforced LLM
 * call sits between the caller and the Cheetah adapter, with the model never
 * touching Cheetah directly (docs/prompts/cheetah-teach.schema.json /
 * cheetah-recall.schema.json). Mirrors src/commands/nitpick.js's double-layer
 * validation/fallback pattern exactly: one automatic schema-repair retry
 * lives inside LMStudioHandler.chatStream (maxSchemaRetries=1); a
 * deterministic fallback sits on top here, plus a parseStrictJsonObject()
 * belt-and-suspenders re-check.
 */

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
  if (schemaId === "cheetah-teach") {
    return {
      ...base,
      thinking: `Fallback: ${reason ?? "unknown error"}. Writing nothing.`,
      subject_name: "",
      subject_type: "other",
      no_new_information: true,
      new_facts: [],
      known_facts: [],
    };
  }
  return {
    ...base,
    thinking: `Fallback: ${reason ?? "unknown error"}. Declining to answer.`,
    anchor_resolved: false,
    grounded: false,
    answer: "I don't know.",
    confidence: "unknown",
    evidence: [],
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
    return { response, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      response: buildCheetahFallback(schemaId, { reason: message, originalQuestion }),
      error: message,
    };
  }
}

function buildSchemaBlock(schemaRegistry, schemaId) {
  // The prompt contract requires the exact schema, not a truncated preview;
  // response_format carries the same registry entry independently.
  return schemaRegistry?.buildInstructionBlock(schemaId, { compact: true }) ?? "";
}

function buildTeachPrompt({ snippetText, subjectHint, schemaBlock, knownRelations }) {
  const lines = [
    "Extract facts from exactly one source snippet for an external database.",
    "The database starts empty. 'Already known' means recorded in the database list below, never facts from your training.",
    "Do not copy or invent facts from instructions, examples, or prior knowledge.",
    "",
    `SOURCE TEXT: ${snippetText}`,
  ];
  if (subjectHint?.subject) {
    lines.push(
      subjectHint.authoritative
        ? `Canonical source title: "${subjectHint.subject}". Use this exact value for subject_name; do not rename or shorten it.`
        : `Hint: this snippet is likely about "${subjectHint.subject}" - confirm or correct this.`,
    );
  }
  const relationList = Array.isArray(knownRelations) ? knownRelations : [];
  lines.push(
    relationList.length
      ? `Already recorded in the database about this subject: ${relationList
          .map((entry) => entry?.type)
          .filter(Boolean)
          .join(", ")}.`
      : "Already recorded in the database about this subject: nothing is recorded yet about this subject.",
  );
  lines.push(
    "",
    "Rules:",
    "- Extract AT MOST 3 new facts as (relation, object) pairs about the subject.",
    "- Every object_name MUST be copied verbatim as a contiguous phrase from SOURCE TEXT. If it does not occur in SOURCE TEXT, do not output it.",
    "- Build relation only from a verb written near that object in SOURCE TEXT. Do not infer a relation from prior knowledge.",
    "- Only set no_new_information=true if every fact in the snippet is already in the 'Already recorded' list above.",
    "- If the snippet hedges ('may', 'is thought to', 'probably'), set confidence to possible/probable rather than omitting it.",
    "- In `thinking`, explicitly say what you are choosing to save because the database does not have it yet.",
    "- Set stop_reason to \"completed\".",
    "",
    "Return strict JSON only that matches this schema:",
    schemaBlock,
  );
  return lines.filter(Boolean).join("\n");
}

function readableName(id) {
  const raw = String(id ?? "");
  const afterColon = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const spaced = afterColon.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : raw;
}

// Leads with the verbatim episode sentence the fact was taught from (already
// natural English, unambiguous) and only falls back to a synthesized
// subject/relation/object sentence when no reference text was stored - this
// is much easier for a small model to actually use than raw triples.
function describeAnchorFacts(anchorResult) {
  if (!anchorResult?.resolved) {
    return "No facts are recorded about this subject.";
  }
  const subjectName = anchorResult.props?.props?.name ?? readableName(anchorResult.nodeId);
  const facts = Array.isArray(anchorResult.facts) ? anchorResult.facts : [];
  const lines = [];
  const seenSentences = new Set();
  for (const fact of facts.slice(0, 6)) {
    const referenceTexts = Array.isArray(fact?.references)
      ? fact.references.map((reference) => reference?.text).filter(Boolean)
      : [];
    for (const sentence of referenceTexts) {
      if (!seenSentences.has(sentence)) {
        seenSentences.add(sentence);
        lines.push(`- "${sentence}"`);
      }
    }
    if (!referenceTexts.length) {
      for (const edge of Array.isArray(fact?.via) ? fact.via : []) {
        const relation = String(edge?.type ?? "related_to").replace(/_/g, " ");
        lines.push(`- ${subjectName} ${relation} ${readableName(fact?.id)}.`);
      }
    }
  }
  return lines.length ? lines.join("\n") : "No facts are recorded about this subject.";
}

function buildRecallPrompt({ question, anchorResult, schemaBlock }) {
  // Deliberately no worked example: live tiny-model runs copied example facts
  // instead of grounding on the real evidence.
  const factsBlock = describeAnchorFacts(anchorResult);
  const lines = [
    "Read the facts below, then answer the question using ONLY those facts - never your own training knowledge.",
    `Facts about the subject:\n${factsBlock}`,
    "",
    `Question: ${question}`,
    "",
    "Decide: do the facts above, read plainly, answer this exact question? If yes, set grounded=true, write a non-empty answer using their wording, and copy at least one used fact into evidence.",
    "If the facts above are empty, unrelated, or do not mention what the question asks, set grounded=false, answer that you don't know, and fill in open_question.",
    "",
    'Set stop_reason to "completed".',
    "Return strict JSON only that matches this schema:",
    schemaBlock,
  ];
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
  const words = String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu);
  return words?.join(" ") ?? "";
}

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
    if (
      !normalizedObject ||
      !normalizedSource.includes(` ${normalizedObject} `)
    ) {
      rejected.push({
        relation: fact?.relation ?? null,
        objectName: objectName || null,
        reason: "object-not-in-source",
      });
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
  ].includes(normalizedQuestion);
}

function retrievedReferenceTexts(anchorResult) {
  const texts = [];
  for (const fact of Array.isArray(anchorResult?.facts) ? anchorResult.facts : []) {
    for (const reference of Array.isArray(fact?.references) ? fact.references : []) {
      if (typeof reference?.text === "string" && reference.text.trim()) {
        texts.push(reference.text.trim());
      }
    }
  }
  return [...new Set(texts)];
}

/**
 * Log the episode, ask the "teacher" turn, and (unless the model declares
 * nothing new) probe then write the declared facts. Returns a structured
 * record of what was learned/skipped for the caller to report on.
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
  } = {},
) {
  const episode = await logEpisode(cheetahClient, text, { sequence });

  // Probe BEFORE prompting (GRAPH_LLM.md §4 step 2), using the hinted subject
  // id, and feed the histogram into the prompt as "already recorded in the
  // database". Without this, a model reliably answers from its own training
  // knowledge instead ("I already know Springfield is in Illinois") and
  // never writes anything - live-observed on the first proof run.
  const hintedSubjectId = subjectHint?.subject ? topicId(subjectHint.subject) : null;
  const preProbe = hintedSubjectId
    ? await probeBeforeWrite(cheetahClient, hintedSubjectId)
    : { exists: false, relationHistogram: [] };

  const schemaBlock = buildSchemaBlock(schemaRegistry, "cheetah-teach");
  const prompt = buildTeachPrompt({
    snippetText: episode.text,
    subjectHint,
    schemaBlock,
    knownRelations: preProbe.relationHistogram,
  });
  const step = await runCheetahPromptStep({
    handler,
    prompt,
    schemaId: "cheetah-teach",
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
  const subjectName =
    canonicalSubjectName ||
    modelSubjectName ||
    subjectHint?.subject ||
    "unknown";
  const subjectType = parsed.subject_type || "other";
  const subjectId = topicId(subjectName);

  let batchResult = { applied: 0, created: 0, updated: 0, failed: 0, edgeCount: 0 };
  let memoryWritten = false;
  let probeResult = subjectId === hintedSubjectId ? preProbe : { exists: false, relationHistogram: [] };
  const declaredFacts = Array.isArray(parsed.new_facts) ? parsed.new_facts : [];
  const groundedFacts = filterSourceGroundedFacts(declaredFacts, episode.text);
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
    batchResult = await writeFacts(cheetahClient, {
      subjectId,
      subjectType,
      subjectName,
      snippetText: episode.text,
      insertKey: episode.insertKey,
      newFacts: groundedFacts.accepted,
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
    insertKey: episode.insertKey,
    episodePairKey: episode.episodePairKey,
    thinking: parsed.thinking ?? null,
    noNewInformation: Boolean(parsed.no_new_information),
    alreadyKnownBeforeWrite: probeResult.exists,
    newFactsWritten: batchResult.edgeCount,
    memoryWritten,
    rejectedFacts: groundedFacts.rejected,
    rejectedFactsCount: groundedFacts.rejected.length,
    knownFactsSkipped: Array.isArray(parsed.known_facts) ? parsed.known_facts : [],
    batchResult,
    stopReason: parsed.stop_reason ?? null,
    error: step.error,
  };
}

/**
 * Resolve the anchor via the recall ladder, ask the "recaller" turn with the
 * already-fetched facts embedded as context (the model never talks to
 * Cheetah directly), adjudicate groundedness, and record an open question
 * whenever the answer isn't actually grounded.
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
  } = {},
) {
  const guessedSubject = subjectHint ?? stripQuestionPrefix(question);
  const anchorResult = await recallAnchorFacts(cheetahClient, { subjectName: guessedSubject });
  const schemaBlock = buildSchemaBlock(schemaRegistry, "cheetah-recall");
  const prompt = buildRecallPrompt({ question, anchorResult, schemaBlock });
  const step = await runCheetahPromptStep({
    handler,
    prompt,
    schemaId: "cheetah-recall",
    label: "cheetah-recall",
    metadata: { mode: "cheetah-learn", subContext: "recall" },
    mainPromptId,
    originalQuestion: question,
  });
  const parsed = step.response;

  // Load-bearing anti-hallucination rule: never trust the model's own
  // `grounded` claim alone. A claim of groundedness when the adapter's own
  // probe found nothing is logged as a distinct mismatch and treated as not
  // grounded.
  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
    : [];
  const referenceTexts = retrievedReferenceTexts(anchorResult);
  const evidenceMatchesReference = evidence.some((entry) => {
    const normalizedEvidence = normalizeGroundingText(entry);
    if (!normalizedEvidence) {
      return false;
    }
    return referenceTexts.some((reference) => {
      const normalizedReference = normalizeGroundingText(reference);
      return (
        normalizedReference.includes(normalizedEvidence) ||
        normalizedEvidence.includes(normalizedReference)
      );
    });
  });
  const modelClaimedGroundedButAnchorMissing = Boolean(parsed.grounded) && !anchorResult.resolved;
  const modelClaimedGroundedButAnswerInvalid = Boolean(
    parsed.grounded && (!answer || isDeclineAnswer(answer) || !evidenceMatchesReference),
  );
  const modelGrounded = Boolean(
    anchorResult.resolved &&
      parsed.grounded === true &&
      answer &&
      !isDeclineAnswer(answer) &&
      evidenceMatchesReference,
  );
  const deterministicEvidence = referenceTexts[0] ?? null;
  const deterministicFallbackUsed = Boolean(
    !modelGrounded &&
      anchorResult.resolved &&
      deterministicEvidence &&
      isBroadMemoryQuestion(question, guessedSubject),
  );
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
    anchorId: anchorResult.nodeId ?? null,
    anchorResolved: anchorResult.resolved,
    grounded: effectiveGrounded,
    modelGrounded,
    deterministicFallbackUsed,
    answerSource: modelGrounded
      ? "model"
      : deterministicFallbackUsed
        ? "deterministic-reference-fallback"
        : "decline",
    modelClaimedGroundedButAnchorMissing,
    modelClaimedGroundedButAnswerInvalid,
    answer: modelGrounded
      ? answer
      : deterministicFallbackUsed
        ? deterministicEvidence
        : "I don't know.",
    confidence: effectiveGrounded
      ? modelGrounded
        ? (parsed.confidence ?? "unknown")
        : "certain"
      : "unknown",
    evidence: modelGrounded
      ? evidence
      : deterministicFallbackUsed
        ? [deterministicEvidence]
        : [],
    thinking: parsed.thinking ?? null,
    openQuestion,
    stopReason: parsed.stop_reason ?? null,
    error: step.error,
  };
}
