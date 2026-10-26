import { createHash } from "node:crypto";
import {
  buildNodeGet, buildNodeSet, buildEdgeGet, buildEdgeSetBatch,
  buildTraversal, buildRecall, decodeCheetahPayload,
} from "./cheetah-binder.js";
import { logEpisode, recordOpenQuestion } from "./cheetah-knowledge-client.js";
import { classifyLmStudioError } from "./lmstudio-error-utils.js";
import { estimateTokens } from "./context-graph.js";
import { contentWords } from "./cheetah-memory-layers.js";

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
export async function runGraphPrompt({ handler, schemaRegistry, schemaId, payload, trace, deadline }) {
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
export function filterGraphClaims(facts, text, { entityHints = [] } = {}) {
  const accepted = [], rejected = [];
  const source = graphName(text);
  for (const fact of facts ?? []) {
    let reason = null;
    const quote = graphName(fact.quote);
    if (!quote || !source.includes(quote)) reason = "quote-not-in-source";
    else if (!containsName(quote, fact.subject) || !containsName(quote, fact.object)) reason = "endpoint-not-in-quote";
    else if (entityHints.some((hint) => containsName(fact.subject, hint) && graphName(fact.subject) !== graphName(hint))) reason = "decorated-subject-anchor";
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
  entityHints = [], repairEmpty = true,
} = {}) {
  const trace = [];
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 4000) throw new Error("Graph source must contain 1..4000 UTF-8 bytes");
  checkDeadline(deadline);
  const episode = await logEpisode(cheetahClient, text);
  const hints = entityHints.filter((name) => typeof name === "string" && name.length <= 200 && containsName(text, name)).slice(0, 8);
  const extractionRejections = [];
  let response;
  try {
    const payload = {
      task: "Decompose SOURCE into atomic directed subject/relation/object claims. Subject and object are complete entity names or literal values, never a whole clause such as 'X has a population'. Copy both from one exact quote. When a hinted entity occurs within your subject, use that exact hinted name without articles or role phrases. Preserve full qualifiers of object names and currencies. Relations are snake_case verbs OR roles written in that quote (located_in, author, population, motto, stages). A role can run against word order: in 'Y is the author of X', store X -> author -> Y. Extract every explicit statement, including numbers and noun-based facts. No background knowledge, negated or speculative claims. Empty facts only if no supported claim exists. stop_reason=completed; needs_more_context=false; missing_snippets=[].",
      source_id: sourceId, source_text: text, entity_hints: hints,
    };
    response = await runGraphPrompt({ handler, schemaRegistry, trace, deadline,
      schemaId: "cheetah-graph-extract",
      payload,
    });
    const first = filterGraphClaims(response.facts, text, { entityHints: hints });
    extractionRejections.push(...first.rejected);
    if (repairEmpty && (first.accepted.length === 0 || first.rejected.length > 0) && !/\b(?:not|never|might|perhaps)\b/iu.test(text)) {
      const repair = await runGraphPrompt({ handler, schemaRegistry, trace, deadline,
        schemaId: "cheetah-graph-extract-repair",
        payload: { ...payload, task: `${payload.task} Some previous claims were empty or failed source/identity checks. Re-read the source and repair the rejected claims. Extract at least one supported atomic claim; use a role noun from the source instead of bare 'is'/'has'.`,
          previous_candidates: response.facts.slice(0, 4).map(({ quote, ...fact }) => fact),
          rejection_reasons: first.rejected.map((fact) => fact.reason) },
      });
      response = { ...repair, facts: [...first.accepted, ...repair.facts] };
    }
  } catch (error) {
    const stopReason = failureReason(error);
    return { sourceId, written: 0, updated: 0, rejected: [], trace, episode, stopReason, stopReasonCode: stopReason, fallback: true, error: error.message };
  }
  const filtered = filterGraphClaims(response.facts, text, { entityHints: hints });
  extractionRejections.push(...filtered.rejected);
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
  const rejected = [...new Map(extractionRejections.map(fact => [JSON.stringify(fact), fact])).values()];
  return { sourceId, episode, claims, rejected, written, known: claims.length - fresh.length,
    trace, fallback: false, stopReason: null, stopReasonCode: null };
}

function supportedPath(answer, ids, evidence, roots) {
  if (!answer || !ids.length || ids.some(id => !evidence.some(e => e.id === id))) return null;
  const cited = evidence.filter(e => ids.includes(e.id));
  const queue = [...roots].map(node => ({ node, path: [] }));
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current.path.length && current.node === graphName(answer)) return current.path;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    for (const edge of cited) if (graphName(edge.start) === current.node) {
      queue.push({ node: graphName(edge.end), path: [...current.path, edge.id] });
    }
  }
  return null;
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
  rootQuestion = question, focusEntity = null, aspect = null, diagnosticConfidence = false,
} = {}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 8) throw new Error("maxRounds must be 1..8");
  if (typeof question !== "string" || !question.trim() || question.length > 1000) throw new Error("Question must contain 1..1000 characters");
  const trace = [], evidence = [], observations = [], roots = new Set(), seen = new Set();
  let stopReason = "max-turns", proposed = null, rounds = 0, requireLookup = true;
  try {
    if (focusEntity) {
      const [exact] = await execute(cheetahClient, [buildNodeGet(graphEntityId(focusEntity))], trace, deadline);
      if (!exact.ok) {
        // Recover a partial or clause-shaped model anchor from names actually
        // stored in Cheetah. A candidate must still occur in the user's parent
        // question, so a model's prior guess cannot invent a new graph root.
        const seeds = [...new Set(contentWords(rootQuestion))].slice(0, 8);
        if (seeds.length) {
          const [recall] = await execute(cheetahClient, [buildRecall({ seeds, hops: 1, limit: 8,
            branchLimit: 16, budget: 256, direction: "both", includeSeeds: true, references: false })], trace, deadline);
          const ids = (decodeCheetahPayload(recall)?.associations ?? []).map(item => item.id).filter(id => id?.startsWith("knowledge:")).slice(0, 8);
          const nodes = ids.length ? await execute(cheetahClient, ids.map(buildNodeGet), trace, deadline) : [];
          const candidates = nodes.map(decodeCheetahPayload).filter(node => node?.props?.name &&
            node.id === graphEntityId(node.props.name) && containsName(rootQuestion, node.props.name));
          candidates.sort((a, b) => b.props.name.length - a.props.name.length);
          if (candidates.length) {
            observations.push({ entity_completion: { proposed: focusEntity, resolved: candidates[0].props.name, basis: "stored-name-in-parent-question" } });
            focusEntity = candidates[0].props.name;
          }
        }
      }
    }
    for (let round = 0; round < maxRounds; round += 1) {
      rounds += 1;
      const entityCandidates = new Map();
      if (focusEntity && containsName(rootQuestion, focusEntity)) entityCandidates.set("focus", focusEntity);
      for (const item of evidence) {
        entityCandidates.set(`${item.id}_subject`, item.subject);
        entityCandidates.set(`${item.id}_object`, item.object);
      }
      const focusedQuery = Boolean(entityCandidates.has("focus"));
      proposed = await runGraphPrompt({ handler, schemaRegistry, trace, deadline,
        schemaId: requireLookup ? focusedQuery ? "cheetah-focused-query" : "cheetah-graph-query" : diagnosticConfidence ? "cheetah-concept-reason" : "cheetah-graph-reason",
        payload: {
          task: requireLookup
            ? (round === 0
              ? "Choose a graph lookup for the named entity in QUESTION. Copy its name from QUESTION. relation='' discovers all stored relations. direction=out normally; in if asking who has a relation TO that entity. The database has not been read yet: request a lookup, never assume it is empty. needs_more_context=true; missing_snippets=[]; stop_reason=completed."
              : "Your answer lacked a connected citation chain. Fetch the missing relation by looking up an AVAILABLE ENDPOINT below, using its exact name, relation='' and direction=out. Do not repeat a previous lookup. needs_more_context=true; missing_snippets=[]; stop_reason=completed.")
            : "Answer ONLY from graph evidence. relation='' discovers available edges; direction=out normally, in for reverse questions. To answer a chain question, request the returned intermediate entity next. A location is not necessarily the requested country; fetch that location's relations if its country is still missing. Only names in QUESTION or returned evidence may be looked up. No background knowledge. When ready, answer_entity is the exact final endpoint name, evidence_ids is the ordered connected chain from the question entity to that answer, lookups=[], needs_more_context=false. If unknown, answer_entity=''. No prose answers. stop_reason=completed; missing_snippets=[].",
          question, parent_question: rootQuestion, focus_entity: focusEntity, requested_aspect: aspect,
          confidence_instruction: diagnosticConfidence ? "Report self_confidence between 0 and 1 for support by these retrieved items, plus a short reasoning_summary naming the missing or supporting evidence. Confidence alone never licenses an answer." : undefined,
          entity_reference_instruction: focusedQuery ? "In lookups[].entity use a candidate id from entity_candidates (initially focus), not a retyped name. MiniPhi resolves that id to the exact name. To follow an intermediate endpoint, choose its eN_object or eN_subject id." : undefined,
          entity_candidates: focusedQuery ? [...entityCandidates].map(([id, name]) => ({ id, name })) : undefined,
          round: round + 1, rounds_remaining: maxRounds - round - 1, evidence, observations,
          available_endpoints: [...new Set(evidence.map((edge) => edge.end))],
        },
      });
      requireLookup = false;
      const citationPath = proposed.answer_entity ? supportedPath(proposed.answer_entity, proposed.evidence_ids, evidence, roots) : null;
      if (proposed.answer_entity && !proposed.needs_more_context && citationPath &&
          matchesRequestedKind(question, citationPath, evidence)) {
        const endpoint = evidence.find((entry) => entry.id === citationPath.at(-1)).end;
        return { question, answer: endpoint, grounded: true, evidenceIds: citationPath,
          proposedEvidenceIds: proposed.evidence_ids,
          citationRepair: JSON.stringify(citationPath) === JSON.stringify(proposed.evidence_ids) ? null : "connected-subpath-of-cited-evidence",
          modelConfidence: proposed.self_confidence ?? null, reasoningSummary: proposed.reasoning_summary ?? null,
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
        const resolvedEntity = entityCandidates.get(lookup.entity) ?? lookup.entity;
        const name = graphName(resolvedEntity);
        const isRoot = containsName(rootQuestion, resolvedEntity);
        const allowed = isRoot || evidence.some((edge) => [edge.subject, edge.object].some((value) => graphName(value) === name));
        // Predicate wording is a model hint, not protocol syntax. Normalize
        // harmless spacing; malformed hints degrade to untyped discovery.
        const normalizedRelation = String(lookup.relation ?? "").trim().toLowerCase().replace(/\s+/gu, "_");
        const relation = /^[a-z][a-z_]{0,63}$/.test(normalizedRelation) ? normalizedRelation : "";
        const signature = JSON.stringify([name, relation, lookup.direction]);
        if (!allowed || seen.has(signature)) { observations.push({ lookup, rejected: allowed ? "repeated-lookup" : "entity-not-observed" }); continue; }
        seen.add(signature);
        if (isRoot) roots.add(name);
        const id = graphEntityId(resolvedEntity);
        let direction = lookup.direction;
        let [response] = await execute(cheetahClient, [buildTraversal({ id, type: relation || null, direction, limit: 16 })], trace, deadline);
        let edges = decodeCheetahPayload(response);
        // A small model invents predicate spellings and often follows the wrong
        // direction on copular/passive statements. Discover actual adjacency
        // before treating a typed miss as missing knowledge. At most 3 queries.
        const discovery = [];
        if ((!Array.isArray(edges) || !edges.length) && relation) {
          [response] = await execute(cheetahClient, [buildTraversal({ id, direction, limit: 16 })], trace, deadline);
          edges = decodeCheetahPayload(response);
          discovery.push("untyped");
        }
        if (!Array.isArray(edges) || !edges.length) {
          direction = direction === "in" ? "out" : "in";
          [response] = await execute(cheetahClient, [buildTraversal({ id, direction, limit: 16 })], trace, deadline);
          edges = decodeCheetahPayload(response);
          discovery.push("reverse");
        }
        const returned = [];
        let omitted = 0;
        for (const edge of Array.isArray(edges) ? edges : []) {
          const p = edge.props;
          if (!edge.id || !p?.subject || !p?.object || !p?.quote || p.grounding !== "source-overlap") continue;
          if (edge.from !== graphEntityId(p.subject) || edge.to !== graphEntityId(p.object) || edge.type !== p.relation) continue;
          const start = direction === "in" ? p.object : p.subject;
          const end = direction === "in" ? p.subject : p.object;
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
        observations.push({ lookup, resolved_entity: resolvedEntity, actual_direction: direction, discovery, returned, evidence_omitted: omitted,
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
    modelConfidence: proposed?.self_confidence ?? null, reasoningSummary: proposed?.reasoning_summary ?? null,
    proposed, openQuestion, stopReason, stopReasonCode: stopReason };
}
