import { createHash } from "node:crypto";
import {
  buildNodeGet, buildNodeSet, buildEdgeGet, buildEdgeSetBatch,
  buildTraversal, decodeCheetahPayload,
} from "./cheetah-binder.js";
import { logEpisode, recordOpenQuestion } from "./cheetah-knowledge-client.js";
import { classifyLmStudioError } from "./lmstudio-error-utils.js";
import { estimateTokens } from "./context-graph.js";

function failureReason(error) {
  if (error.message === "session-timeout") return "session-timeout";
  if (error.message === "invalid-response") return "invalid-response";
  if (error.message.startsWith("Cheetah")) return "analysis-error";
  return classifyLmStudioError(error.message)?.code ?? "invalid-response";
}

// Separate from both session context and the historical topic:<slug> store.
// Normalization is explicit: case/whitespace variants merge, punctuation does not.
export function graphName(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

export function graphEntityId(name) {
  return `knowledge:${createHash("sha256").update(graphName(name)).digest("hex")}`;
}

function containsName(text, name) {
  const haystack = graphName(text);
  const needle = graphName(name);
  if (!needle) return false;
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    const before = haystack[offset - 1] ?? "";
    const after = haystack[offset + needle.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}

function checkDeadline(deadline) {
  if (Date.now() >= deadline) throw new Error("session-timeout");
}

async function execute(client, commands, trace, deadline) {
  checkDeadline(deadline);
  const responses = await client.execute(commands);
  for (let i = 0; i < commands.length; i += 1) {
    const response = responses[i];
    trace.push({ command: commands[i], response: response ?? null });
    if (!response?.ok && !/\b(?:node|edge)_not_found\b/.test(response?.raw ?? "")) {
      throw new Error(`Cheetah command failed: ${response?.raw ?? "missing response"}`);
    }
  }
  return responses;
}

// Handler supplies response_format and persists full exchanges (reasoning,
// response text, tool_calls and tool_definitions). Validate again at this boundary.
async function promptStep({ handler, schemaRegistry, schemaId, payload, trace, deadline }) {
  checkDeadline(deadline);
  const schema = schemaRegistry.getSchema(schemaId);
  if (!schema) throw new Error(`Missing schema ${schemaId}`);
  const compactPayload = payload.evidence ? { ...payload,
    evidence: payload.evidence.map(({ edgeId, src, ...entry }) => entry),
    observations: payload.observations.slice(-6),
  } : payload;
  const prompt = JSON.stringify({ ...compactPayload, schema_id: schemaId, response_schema: schema.definition });
  if (estimateTokens(prompt) > (handler.graphPromptBudgetTokens ?? 2400)) {
    trace.push({ schemaId, validation: "context-overflow", estimatedTokens: estimateTokens(prompt) });
    throw new Error("context-overflow: graph prompt exceeds loaded context budget");
  }
  // chatStream has at most four bounded attempts. Reserve that budget before
  // entering it, including its schema repair and hung-generation retry.
  handler.setPromptTimeout?.(Math.max(1000, Math.min(handler.promptTimeoutMs ?? 180000, Math.floor((deadline - Date.now()) / 4))), { allowShorter: true });
  handler.clearHistory();
  const raw = await handler.chatStream(prompt, undefined, undefined, undefined, {
    scope: "sub", label: schemaId, schemaId,
    metadata: { mode: "cheetah-graph", schemaId },
  });
  const outcome = schemaRegistry.validateOutcome(schemaId, raw);
  trace.push({ schemaId, prompt, response: raw, validation: outcome?.status ?? "missing-schema" });
  if (outcome?.status !== "ok") throw new Error("invalid-response");
  checkDeadline(deadline);
  return outcome.parsed;
}

/** Source overlap is a conservative claim filter, not a proof of entailment. */
export function filterGraphClaims(facts, text) {
  const accepted = [], rejected = [];
  const source = graphName(text);
  for (const fact of facts ?? []) {
    let reason = null;
    const quote = graphName(fact.quote);
    if (!quote || !source.includes(quote)) reason = "quote-not-in-source";
    else if (!containsName(quote, fact.subject) || !containsName(quote, fact.object)) reason = "endpoint-not-in-quote";
    else if (graphName(fact.subject) === graphName(fact.object)) reason = "self-claim";
    else if (/\b(?:not|never|no|may|might|possibly|perhaps|could)\b/u.test(quote)) reason = "uncertain-or-negated-quote";
    else {
      // At least one informative relation stem must occur in that same quote.
      const stems = fact.relation.split("_").filter((word) => !["is", "was", "has", "of", "in", "at", "by", "to", "the", "a"].includes(word));
      if (!stems.length || !stems.every((stem) => quote.includes(stem.slice(0, Math.min(5, stem.length))))) reason = "relation-not-in-quote";
    }
    (reason ? rejected : accepted).push(reason ? { ...fact, reason } : fact);
  }
  return { accepted, rejected };
}

export async function learnGraphText(text, {
  handler, cheetahClient, schemaRegistry, sourceId = "text", deadline = Date.now() + 300000,
} = {}) {
  const trace = [];
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 4000) throw new Error("Graph source must contain 1..4000 UTF-8 bytes");
  checkDeadline(deadline);
  const episode = await logEpisode(cheetahClient, text);
  let response;
  try {
    response = await promptStep({ handler, schemaRegistry, trace, deadline,
      schemaId: "cheetah-graph-extract",
      payload: {
        task: "Extract directed subject/relation/object claims from SOURCE only. Copy subject and object from one exact quote. Extract ALL subjects, not only the first. Relations are snake_case verbs or roles written in that quote (e.g. located_in, born_in, language, leader). Save explicit noun-based facts too. No background knowledge. No negated or speculative claims. Empty facts only if unsupported. stop_reason=completed; needs_more_context=false; missing_snippets=[].",
        source_id: sourceId, source_text: text,
      },
    });
  } catch (error) {
    const stopReason = failureReason(error);
    return { sourceId, written: 0, updated: 0, rejected: [], trace, episode, stopReason, stopReasonCode: stopReason, fallback: true, error: error.message };
  }
  const filtered = filterGraphClaims(response.facts, text);
  // Probe exact edges before writing. Familiarity in model weights is irrelevant.
  const claims = [...new Map(filtered.accepted.map((fact) => [
    JSON.stringify([graphEntityId(fact.subject), fact.relation, graphEntityId(fact.object)]), fact,
  ])).values()];
  const probes = claims.length ? await execute(cheetahClient, claims.map((fact) => buildEdgeGet({
    from: graphEntityId(fact.subject), to: graphEntityId(fact.object), type: fact.relation, directed: true,
  })), trace, deadline) : [];
  const fresh = claims.filter((_, index) => !probes[index]?.ok);
  const names = new Map();
  for (const fact of fresh) for (const name of [fact.subject, fact.object]) names.set(graphEntityId(name), name);
  const nodeIds = [...names.keys()];
  const nodes = nodeIds.length ? await execute(cheetahClient, nodeIds.map(buildNodeGet), trace, deadline) : [];
  if (nodeIds.length) await execute(cheetahClient, nodeIds.map((id, index) => {
    const previous = decodeCheetahPayload(nodes[index]);
    const references = [...(previous?.references ?? []), { id: createHash("sha256").update(text).digest("hex"), text, source: sourceId }];
    return buildNodeSet({ id, labels: ["learned_entity"], props: { ...previous?.props, name: previous?.props?.name ?? names.get(id) },
      references: [...new Map(references.map((ref) => [ref.id, ref])).values()].slice(-8) });
  }), trace, deadline);
  let written = 0;
  if (fresh.length) {
    const [result] = await execute(cheetahClient, [buildEdgeSetBatch(fresh.map((fact) => ({
      from: graphEntityId(fact.subject), to: graphEntityId(fact.object), type: fact.relation,
      directed: true, weight: 1, props: { ...fact, src: episode.insertKey, source_id: sourceId, grounding: "source-overlap" },
    })))], trace, deadline);
    written = Number(result.fields?.applied ?? 0);
    if (written !== fresh.length || Number(result.fields?.failed ?? 0) > 0) throw new Error("Cheetah partial graph write");
  }
  return { sourceId, episode, claims, rejected: filtered.rejected, written, known: claims.length - fresh.length,
    trace, fallback: false, stopReason: null, stopReasonCode: null };
}

function supportedPath(answer, ids, evidence, roots) {
  if (!answer || !ids.length || new Set(ids).size !== ids.length) return false;
  let frontier = new Set(roots);
  for (const id of ids) {
    const edge = evidence.find((item) => item.id === id);
    if (!edge || !frontier.has(graphName(edge.start))) return false;
    frontier = new Set([graphName(edge.end)]);
  }
  return frontier.has(graphName(answer));
}

function matchesRequestedKind(question, ids, evidence) {
  const kind = question.match(/\b(?:which|what)\s+(country|city|capital|language|leader|currency)\b/iu)?.[1]?.toLocaleLowerCase("en");
  if (!kind) return true;
  const terminal = evidence.find((edge) => edge.id === ids.at(-1));
  // A connected place-name alone is not proof of a requested country/city.
  // Require the source to identify that role; otherwise fetch another hop.
  return terminal && containsName(`${terminal.relation.replace(/_/g, " ")} ${terminal.quote}`, kind);
}

/** Model-directed discovery followed by exact, cited edge-chain answers. */
export async function reasonGraph(question, {
  handler, cheetahClient, schemaRegistry, maxRounds = 4, deadline = Date.now() + 600000,
} = {}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 8) throw new Error("maxRounds must be 1..8");
  if (typeof question !== "string" || !question.trim() || question.length > 1000) throw new Error("Question must contain 1..1000 characters");
  const trace = [], evidence = [], observations = [], roots = new Set(), seen = new Set();
  let stopReason = "max-turns", proposed = null, rounds = 0, requireLookup = true;
  try {
    for (let round = 0; round < maxRounds; round += 1) {
      rounds += 1;
      proposed = await promptStep({ handler, schemaRegistry, trace, deadline,
        schemaId: requireLookup ? "cheetah-graph-query" : "cheetah-graph-reason",
        payload: {
          task: requireLookup
            ? (round === 0
              ? "Choose a graph lookup for the named entity in QUESTION. Copy its name from QUESTION. relation='' discovers all stored relations. direction=out normally; in if asking who has a relation TO that entity. The database has not been read yet: request a lookup, never assume it is empty. needs_more_context=true; missing_snippets=[]; stop_reason=completed."
              : "Your answer lacked a connected citation chain. Fetch the missing relation by looking up an AVAILABLE ENDPOINT below, using its exact name, relation='' and direction=out. Do not repeat a previous lookup. needs_more_context=true; missing_snippets=[]; stop_reason=completed.")
            : "Answer ONLY from graph evidence. relation='' discovers available edges; direction=out normally, in for reverse questions. To answer a chain question, request the returned intermediate entity next. A location is not necessarily the requested country; fetch that location's relations if its country is still missing. Only names in QUESTION or returned evidence may be looked up. No background knowledge. When ready, answer_entity is the exact final endpoint name, evidence_ids is the ordered connected chain from the question entity to that answer, lookups=[], needs_more_context=false. If unknown, answer_entity=''. No prose answers. stop_reason=completed; missing_snippets=[].",
          question, round: round + 1, rounds_remaining: maxRounds - round - 1, evidence, observations,
          available_endpoints: [...new Set(evidence.map((edge) => edge.end))],
        },
      });
      requireLookup = false;
      if (proposed.answer_entity && !proposed.needs_more_context &&
          supportedPath(proposed.answer_entity, proposed.evidence_ids, evidence, roots) &&
          matchesRequestedKind(question, proposed.evidence_ids, evidence)) {
        const endpoint = evidence.find((entry) => entry.id === proposed.evidence_ids.at(-1)).end;
        return { question, answer: endpoint, grounded: true, evidenceIds: proposed.evidence_ids,
          evidence, rounds, trace, stopReason: null, stopReasonCode: null };
      }
      if (!proposed.lookups.length) {
        if (proposed.answer_entity && evidence.length && round < maxRounds - 1) {
          observations.push({ rejected_answer: proposed.answer_entity, reason: "answer-lacks-connected-citations-or-requested-role", required_action: "lookup-observed-endpoint" });
          requireLookup = true;
          continue;
        }
        stopReason = proposed.answer_entity ? "invalid-response" : "no-actions";
        break;
      }
      if (round === maxRounds - 1) break;
      let progress = false;
      for (const lookup of proposed.lookups) {
        const name = graphName(lookup.entity);
        const isRoot = containsName(question, lookup.entity);
        const allowed = isRoot || evidence.some((edge) => [edge.subject, edge.object].some((value) => graphName(value) === name));
        const signature = JSON.stringify([name, lookup.relation, lookup.direction]);
        if (!allowed || seen.has(signature)) { observations.push({ lookup, rejected: allowed ? "repeated-lookup" : "entity-not-observed" }); continue; }
        seen.add(signature);
        if (isRoot) roots.add(name);
        if (lookup.relation && !/^[a-z][a-z_]{0,63}$/.test(lookup.relation)) { observations.push({ lookup, rejected: "invalid-relation" }); continue; }
        const id = graphEntityId(lookup.entity);
        const [response] = await execute(cheetahClient, [buildTraversal({ id, type: lookup.relation || null, direction: lookup.direction, limit: 16 })], trace, deadline);
        const edges = decodeCheetahPayload(response);
        const returned = [];
        let omitted = 0;
        for (const edge of Array.isArray(edges) ? edges : []) {
          const p = edge.props;
          if (!edge.id || !p?.subject || !p?.object || !p?.quote || p.grounding !== "source-overlap") continue;
          if (edge.from !== graphEntityId(p.subject) || edge.to !== graphEntityId(p.object) || edge.type !== p.relation) continue;
          const start = lookup.direction === "in" ? p.object : p.subject;
          const end = lookup.direction === "in" ? p.subject : p.object;
          if (graphName(start) !== name) continue;
          let item = evidence.find((entry) => entry.edgeId === edge.id && entry.start === start);
          if (!item) {
            if (evidence.length >= 16) { omitted += 1; continue; }
            item = { id: `e${evidence.length + 1}`, edgeId: edge.id, subject: p.subject, relation: edge.type,
              object: p.object, start, end, quote: p.quote, sourceId: p.source_id, src: p.src };
            evidence.push(item);
          }
          returned.push(item.id);
        }
        observations.push({ lookup, returned, evidence_omitted: omitted,
          truncated: omitted > 0 || (response.fields?.next_cursor !== "*" && Boolean(response.fields?.next_cursor)) });
        progress = true;
      }
      if (!progress) { stopReason = "no-progress"; break; }
    }
  } catch (error) {
    stopReason = failureReason(error);
    observations.push({ error: error.message });
  }
  let openQuestion = null;
  try {
    openQuestion = await recordOpenQuestion(cheetahClient, { questionText: question });
  } catch (error) {
    observations.push({ open_question_error: error.message });
    stopReason = "analysis-error";
  }
  return { question, answer: "I don't know.", grounded: false, evidence, evidenceIds: [], rounds, trace, observations,
    proposed, openQuestion, stopReason, stopReasonCode: stopReason };
}
