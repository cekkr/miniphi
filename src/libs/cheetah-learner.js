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
  return schemaRegistry?.buildInstructionBlock(schemaId, { compact: true, maxLength: 1800 }) ?? "";
}

function buildTeachPrompt({ snippetText, subjectHint, schemaBlock, knownRelations }) {
  const lines = [
    "You are teaching an external database that starts out knowing NOTHING about any subject, no matter how famous.",
    "CRITICAL RULE: 'already known' means ALREADY RECORDED IN THE DATABASE below - it never means facts you personally recognize from training. If the database list below says nothing is recorded, you MUST extract the facts as new, even if they are obvious common knowledge to you.",
    "",
    "Worked example:",
    'Snippet: "Paris is the capital of France."',
    "Already recorded in the database: nothing is recorded yet about this subject.",
    'Correct output: no_new_information=false, new_facts=[{"relation":"capital_of","object_name":"France","object_type":"place"}]',
    "(Note: even though 'Paris is the capital of France' is common knowledge, the DATABASE did not have it, so it still counts as new and must be saved.)",
    "",
    "Now do the same for the real snippet below.",
    "",
    `Snippet: ${snippetText}`,
  ];
  if (subjectHint?.subject) {
    lines.push(`Hint: this snippet is likely about "${subjectHint.subject}" - confirm or correct this.`);
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
  // Deliberately no worked example here (unlike buildTeachPrompt): a live
  // proof run showed the tiny model echoing the example's unrelated content
  // ("Paris is the capital of France") verbatim as its answer instead of
  // using the real facts below - a worked example helps teach's extraction
  // task but actively hurts this one at this model size.
  const factsBlock = describeAnchorFacts(anchorResult);
  const lines = [
    "Read the facts below, then answer the question using ONLY those facts - never your own training knowledge.",
    `Facts about the subject:\n${factsBlock}`,
    "",
    `Question: ${question}`,
    "",
    "Decide: do the facts above, read plainly, answer this exact question? If yes, set grounded=true and write the answer using their wording.",
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

/**
 * Log the episode, ask the "teacher" turn, and (unless the model declares
 * nothing new) probe then write the declared facts. Returns a structured
 * record of what was learned/skipped for the caller to report on.
 */
export async function teachFromText(
  text,
  { handler, cheetahClient, schemaRegistry, subjectHint = null, sequence, mainPromptId } = {},
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
  const subjectName =
    (typeof parsed.subject_name === "string" && parsed.subject_name.trim()) ||
    subjectHint?.subject ||
    "unknown";
  const subjectType = parsed.subject_type || "other";
  const subjectId = topicId(subjectName);

  let batchResult = { applied: 0, created: 0, updated: 0, failed: 0, edgeCount: 0 };
  let probeResult = subjectId === hintedSubjectId ? preProbe : { exists: false, relationHistogram: [] };
  const declaredFacts = Array.isArray(parsed.new_facts) ? parsed.new_facts : [];
  if (!parsed.no_new_information && declaredFacts.length) {
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
      newFacts: declaredFacts,
    });
  }

  return {
    subjectId,
    subjectName,
    subjectType,
    insertKey: episode.insertKey,
    episodePairKey: episode.episodePairKey,
    thinking: parsed.thinking ?? null,
    noNewInformation: Boolean(parsed.no_new_information),
    alreadyKnownBeforeWrite: probeResult.exists,
    newFactsWritten: batchResult.edgeCount,
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
  { handler, cheetahClient, schemaRegistry, subjectHint = null, mainPromptId } = {},
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
  const modelClaimedGroundedButAnchorMissing = Boolean(parsed.grounded) && !anchorResult.resolved;
  const effectiveGrounded = Boolean(anchorResult.resolved && parsed.grounded === true);

  let openQuestion = null;
  if (!effectiveGrounded) {
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
    modelClaimedGroundedButAnchorMissing,
    answer: parsed.answer ?? "I don't know.",
    confidence: parsed.confidence ?? "unknown",
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    thinking: parsed.thinking ?? null,
    openQuestion,
    stopReason: parsed.stop_reason ?? null,
    error: step.error,
  };
}
