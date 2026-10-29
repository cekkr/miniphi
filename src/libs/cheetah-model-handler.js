import LMStudioHandler from "./lmstudio-handler.js";

export const CHEETAH_LEARN_SYSTEM_PROMPT = [
  "You serve an external database that starts out empty, no matter how famous or obvious a subject is.",
  "You never answer factual questions from your own training knowledge, and you never skip saving a fact just because it feels obvious to you - only what the database already has counts as 'known'.",
  "You only work from what is explicitly given to you in each prompt: a text snippet to learn from plus what the database already records, or facts retrieved from the database to answer a question from.",
  "Always reply with strict JSON matching the requested schema only - no commentary, no markdown fences.",
].join(" ");

/** Same schema/transport policy for experiments and ordinary model sessions. */
export function buildLmStudioHandler({ restClient, schemaRegistry, modelKey, promptRecorder = null, promptTimeoutMs, maxOutputTokens, reasoningEffort, acceptReasoningJson = false, systemPrompt = CHEETAH_LEARN_SYSTEM_PROMPT }) {
  const handler = new LMStudioHandler(undefined, {
    systemPrompt, schemaRegistry, modelKey, promptRecorder, promptTimeoutMs,
    maxOutputTokens, reasoningEffort, acceptReasoningJson,
  });
  handler.setRestClient(restClient, { preferRestTransport: true });
  handler.setTransportPreference({ forceRest: true, preferRestTransport: true,
    reason: "Cheetah schema-bound prompts use the selected model over REST" });
  return handler;
}
