import { graphName, reasonGraph, runGraphPrompt } from "./cheetah-graph-learning.js";

export const KNOWLEDGE_ASSESSMENT_SYSTEM_PROMPT = "You assess your remembered factual knowledge without external sources. Decompose questions into atomic concepts and report a short uncertainty basis and self-confidence. These are diagnostic claims, never authoritative facts. Reply only with JSON matching the exact requested schema.";

/** Self-report is a diagnostic, never a fact or permission to write knowledge. */
export async function assessGraphKnowledge(question, {
  handler, schemaRegistry, deadline = Date.now() + 300000,
} = {}) {
  const trace = [];
  try {
    // Bound simple and explicitly conjoined questions before the small model
    // invents extra facets just to fill the schema's maximum array length.
    const explicitParts = Math.min(3, question.split(/\band\b|;\s*/iu).length);
    const schemaId = explicitParts === 1 ? "cheetah-knowledge-assessment-single" : explicitParts === 2 ? "cheetah-knowledge-assessment-pair" : "cheetah-knowledge-assessment";
    const response = await runGraphPrompt({ handler, schemaRegistry, deadline, trace,
      schemaId,
      payload: {
        task: "Split QUESTION into one atomic concept per requested fact (at most 3). For a compound question, do not omit its second part. Each entity must be copied as an exact name from QUESTION; do not append the aspect to it. Write a standalone question for each concept. Before consulting memory, report prior_answer from your own remembered knowledge (empty if unknown), self_confidence 0..1, and a short basis explaining uncertainty. This is a closed-book diagnostic, not a factual answer to the user. No source text or database results are available. Do not invent confidence or confuse familiarity with evidence. needs_more_context=true; missing_snippets=[]; stop_reason=completed.",
        question, requested_concept_count: explicitParts,
      },
    });
    const concepts = response.concepts.filter((concept) => concept.entity.trim() &&
      graphName(question).includes(graphName(concept.entity)) &&
      Number.isFinite(concept.self_confidence) && concept.self_confidence >= 0 && concept.self_confidence <= 1).map((concept) => {
      if (graphName(concept.question).includes(graphName(concept.entity)) && !/we are given|the task is|decompose the question/iu.test(concept.question)) return concept;
      return { ...concept, original_question: concept.question,
        question: `For ${concept.entity}, retrieve the ${concept.aspect} requested in: ${question}`,
        questionRepair: "entity-missing-or-meta-instruction" };
    });
    if (!concepts.length) throw new Error("No question-grounded concepts");
    return { question, concepts, trace, stopReason: null, stopReasonCode: null };
  } catch (error) {
    return { question, concepts: [], trace, error: error.message,
      stopReason: error.message.includes("timeout") ? "session-timeout" : "invalid-response",
      stopReasonCode: error.message.includes("timeout") ? "session-timeout" : "invalid-response" };
  }
}

/** Rebuild each concept's context independently; never pass prior answers as evidence. */
export async function answerGraphConcepts(question, {
  assessmentHandler, handler, cheetahClient, schemaRegistry,
  maxRounds = 6, deadline = Date.now() + 900000,
} = {}) {
  const assessment = await assessGraphKnowledge(question, { handler: assessmentHandler, schemaRegistry, deadline });
  const results = [];
  for (const concept of assessment.concepts) {
    const recalled = await reasonGraph(concept.question, { handler, cheetahClient, schemaRegistry,
      maxRounds, deadline, rootQuestion: question, focusEntity: concept.entity, aspect: concept.aspect,
      diagnosticConfidence: true });
    results.push({ concept, recalled, memoryGap: !recalled.grounded });
  }
  return { question, assessment, results, needsLearning: !results.length || results.some((r) => r.memoryGap),
    stopReason: assessment.stopReason, stopReasonCode: assessment.stopReasonCode };
}
