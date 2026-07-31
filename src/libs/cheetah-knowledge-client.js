import {
  buildEdgeSet,
  buildEdgeSetBatch,
  buildNeighborTypes,
  buildNeighbors,
  buildNodeGet,
  buildNodeSet,
  buildRecall,
  decodeCheetahPayload,
} from "./cheetah-binder.js";

/**
 * The Cheetah "adapter" for the ignorant-model teach/recall loop documented in
 * thirds/cheetah/studies/GRAPH_LLM.md. Built entirely on top of the reusable
 * `CheetahTcpClient` passed in by the caller — this module never opens its own
 * TCP connection, it only knows how to shape commands and interpret responses.
 *
 * The command spellings and their encodings come from the Cheetah submodule's
 * own Node binder (`buildNodeSet`, `buildRecall`, …). What lives here is the
 * knowledge-base shape on top of them: type-agnostic `topic:` anchors, the
 * episodic INSERT/PAIR_SET log, and the open-question convention.
 *
 * Per the GRAPH_LLM.md §10 adapter contract, the model itself never touches
 * this protocol: it only ever emits structured JSON (facts, probes, answers)
 * that these functions translate into real Cheetah commands. Ids are always
 * slugged and props are always base64-encoded here, never left to the model.
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4455;
export const DEFAULT_DATABASE = "miniphi_knowledge";
export const DEFAULT_KNOWLEDGE_LOOKUP_TIMEOUT_MS = 1500;
// Every open question hangs off this one fixed anchor so listing them is a
// single global call instead of a fan-out over every taught topic.
export const ASKER_ID = "agent:miniphi_learner";

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function parseBooleanSetting(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Resolves whether the interactive coding agent should also get a
 * `knowledge_lookup` action reading from the same Cheetah database
 * `cheetah-learn` writes to. Opt-in and off by default (same "memory is the
 * default, Cheetah is opt-in" philosophy as `resolveCheetahContextConfig` in
 * cheetah-context-engine.js) so a normal `miniphi` run never pays a startup
 * reachability-probe cost unless the operator has actually asked for it.
 */
export function resolveKnowledgeLookupConfig(configData = undefined, env = process.env) {
  const section =
    configData?.knowledgeLookup && typeof configData.knowledgeLookup === "object"
      ? configData.knowledgeLookup
      : {};
  const cheetahSection =
    section.cheetah && typeof section.cheetah === "object" ? section.cheetah : section;
  return {
    enabled: parseBooleanSetting(env.MINIPHI_KNOWLEDGE_LOOKUP ?? section.enabled, false),
    host: String(env.MINIPHI_KNOWLEDGE_HOST ?? cheetahSection.host ?? DEFAULT_HOST).trim() || DEFAULT_HOST,
    port: toPositiveInteger(env.MINIPHI_KNOWLEDGE_PORT ?? cheetahSection.port, DEFAULT_PORT),
    database:
      typeof (env.MINIPHI_KNOWLEDGE_DATABASE ?? cheetahSection.database) === "string" &&
      (env.MINIPHI_KNOWLEDGE_DATABASE ?? cheetahSection.database).trim()
        ? (env.MINIPHI_KNOWLEDGE_DATABASE ?? cheetahSection.database).trim()
        : DEFAULT_DATABASE,
    timeoutMs: toPositiveInteger(
      env.MINIPHI_KNOWLEDGE_TIMEOUT_MS ?? cheetahSection.timeoutMs,
      DEFAULT_KNOWLEDGE_LOOKUP_TIMEOUT_MS,
    ),
  };
}

/**
 * Composes a `recallAnchorFacts` call into the single async-function shape
 * `AgentSession.knowledgeLookup` expects (mirrors
 * `createVisionReviewAction` in vision-reviewer.js): returns `null` when not
 * configured, otherwise an async function that always resolves to
 * `{ok:true, response}` or `{ok:false, error}`, never throws.
 */
export function createKnowledgeLookupAction({ cheetahClient } = {}) {
  if (!cheetahClient) {
    return null;
  }
  return async function knowledgeLookupAction({ subject } = {}) {
    try {
      const result = await recallAnchorFacts(cheetahClient, { subjectName: subject });
      return { ok: true, response: result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

function stripAccents(text) {
  // \p{Mn} = Unicode "nonspacing mark" (combining diacritics) after NFD
  // decomposition; avoids embedding raw combining-mark literals in source.
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "");
}

export function slugify(text) {
  const slug = stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "unknown";
}

/**
 * Every taught subject is anchored at a type-agnostic id: the model's chosen
 * type becomes a graph label, not part of the id. This is what lets `ask`/
 * `eval` re-derive the same anchor from just the subject name at question
 * time, with no alias hop and no dependency on the model picking the same
 * type twice across calls.
 */
export function topicId(subjectName) {
  return `topic:${slugify(subjectName)}`;
}

export function entityId(type, name) {
  return `${slugify(type)}:${slugify(name)}`;
}

// Props and references are always base64, uniformly — question/fact text
// almost always contains spaces — but that encoding now belongs to the Cheetah
// binder's command builders, which take plain objects. Nothing here should
// hand-encode a `key=value` argument.

// The protocol is one-line-per-command; collapse anything that would break
// that (or corrupt the declared INSERT byte length) into single spaces.
export function sanitizeForInsert(text) {
  return String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function responseError(response) {
  return typeof response?.raw === "string" && response.raw.startsWith("ERROR") ? response.raw : null;
}

function requireSuccess(response, context) {
  const error = responseError(response);
  if (error) {
    throw new Error(`Cheetah ${context} failed: ${error}`);
  }
  if (!response?.ok) {
    throw new Error(`Cheetah ${context} failed: ${response?.raw ?? "no response"}`);
  }
  return response;
}

export async function ensureAskerAnchor(client) {
  const [response] = await client.execute([buildNodeSet({ id: ASKER_ID, labels: "agent" })]);
  requireSuccess(response, "ensureAskerAnchor");
  return { id: ASKER_ID };
}

let localEpisodeSequence = 0;

/**
 * Episodic log: verbatim text first, so a later pass can re-extract with a
 * better prompt. Captures `key=` from the INSERT response itself — per
 * GRAPH_LLM.md §3, a client-side counter would point at unrelated payloads
 * because the key is a single monotonic counter shared with graph records.
 */
export async function logEpisode(client, text, { sequence } = {}) {
  const sanitized = sanitizeForInsert(text);
  const byteLength = Buffer.byteLength(sanitized, "utf8");
  const [insertResponse] = await client.execute([`INSERT:${byteLength} ${sanitized}`]);
  requireSuccess(insertResponse, "logEpisode insert");
  const insertKey = insertResponse.fields?.key;
  if (!insertKey) {
    throw new Error("Cheetah INSERT did not return a key.");
  }
  const seq = Number.isFinite(sequence) ? sequence : localEpisodeSequence++;
  const seqLabel = String(seq).padStart(6, "0");
  const episodePairKey = `episode:${new Date().toISOString().replace(/[-:.]/g, "")}/${seqLabel}`;
  const [pairResponse] = await client.execute([`PAIR_SET ${episodePairKey} ${insertKey}`]);
  requireSuccess(pairResponse, "logEpisode pair_set");
  return { insertKey, episodePairKey, text: sanitized };
}

/**
 * Cheap "is this already known" check before writing (GRAPH_LLM.md §4 step 2)
 * — a histogram, not a hydration. A missing/empty result is a legitimate,
 * cheap answer for a brand-new topic, not a failure.
 */
export async function probeBeforeWrite(client, subjectId) {
  const [response] = await client.execute([
    buildNeighborTypes({ id: subjectId, direction: "out", limit: 16, weighted: true }),
  ]);
  if (!response?.ok) {
    return { exists: false, relationHistogram: [] };
  }
  const payload = decodeCheetahPayload(response);
  const relationHistogram = Array.isArray(payload) ? payload : [];
  return { exists: relationHistogram.length > 0, relationHistogram };
}

/**
 * One round trip: upserts the subject node (+ any new object nodes) and
 * batch-writes the declared new facts as edges, with provenance
 * (`props.src` = the episodic INSERT key) on every edge.
 */
export async function writeFacts(
  client,
  { subjectId, subjectType, subjectName, snippetText, insertKey, newFacts },
) {
  const commands = [];
  const references = snippetText
    ? [{ id: "src-1", text: snippetText, source: "simple-wikipedia", ordinal: 0 }]
    : [];
  commands.push(
    buildNodeSet({
      id: subjectId,
      labels: slugify(subjectType),
      props: { name: subjectName },
      references,
    }),
  );

  const seenObjectIds = new Set();
  const edges = [];
  for (const fact of Array.isArray(newFacts) ? newFacts : []) {
    const objectName = typeof fact?.object_name === "string" ? fact.object_name.trim() : "";
    if (!objectName) {
      continue;
    }
    const objectType = fact?.object_type ?? "other";
    const objectId = entityId(objectType, objectName);
    if (!seenObjectIds.has(objectId)) {
      seenObjectIds.add(objectId);
      commands.push(
        buildNodeSet({
          id: objectId,
          labels: slugify(objectType),
          props: { name: objectName },
        }),
      );
    }
    const edge = {
      from: subjectId,
      to: objectId,
      type: slugify(fact?.relation) || "related_to",
      props: { src: insertKey },
    };
    if (typeof fact?.confidence === "string" && fact.confidence.trim()) {
      edge.confidence = fact.confidence.trim();
    }
    edges.push(edge);
  }
  if (edges.length) {
    commands.push(buildEdgeSetBatch(edges, { continueOnError: true }));
  }

  const responses = await client.execute(commands);
  for (const response of responses) {
    requireSuccess(response, "writeFacts");
  }
  const batchResponse = edges.length ? responses[responses.length - 1] : null;
  return {
    applied: Number(batchResponse?.fields?.applied ?? 0),
    created: Number(batchResponse?.fields?.created ?? 0),
    updated: Number(batchResponse?.fields?.updated ?? 0),
    failed: Number(batchResponse?.fields?.failed ?? 0),
    edgeCount: edges.length,
  };
}

function seedTermsFromName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 4);
}

/**
 * The bounded recall ladder (max 3 round trips): exact anchor lookup, then a
 * histogram + evidence-hydrating GRAPH_RECALL when the anchor exists but has
 * relations, then a free-text/lexical GRAPH_RECALL fallback (rung 6 of the
 * GRAPH_LLM.md ladder) when the anchor id itself isn't found. `GRAPH_RECALL`
 * is reused in place of a separate GRAPH_NEIGHBORS call because it hydrates
 * evidence text (`references=1`) in the same round trip.
 */
export async function recallAnchorFacts(client, { subjectName }) {
  const nodeId = topicId(subjectName);
  const [nodeResponse] = await client.execute([buildNodeGet(nodeId)]);
  if (nodeResponse?.ok) {
    const props = decodeCheetahPayload(nodeResponse);
    const [histResponse] = await client.execute([
      buildNeighborTypes({ id: nodeId, direction: "out", limit: 16, weighted: true }),
    ]);
    const histogram = histResponse?.ok ? decodeCheetahPayload(histResponse) ?? [] : [];
    if (!Array.isArray(histogram) || histogram.length === 0) {
      return { resolved: true, via: "direct", nodeId, props, facts: [] };
    }
    const [recallResponse] = await client.execute([
      buildRecall({
        seeds: nodeId,
        hops: 1,
        precision: 0.3,
        limit: 8,
        direction: "both",
        // The anchor id is exact, so lexical/synonym resolution can only add noise.
        expand: "none",
        includeSeeds: false,
        references: true,
        referenceLimit: 4,
      }),
    ]);
    const recallPayload = recallResponse?.ok ? decodeCheetahPayload(recallResponse) : null;
    const facts = Array.isArray(recallPayload?.associations) ? recallPayload.associations : [];
    return { resolved: true, via: "direct", nodeId, props, facts };
  }

  const seedTerms = seedTermsFromName(subjectName);
  if (!seedTerms.length) {
    return { resolved: false, via: "none", nodeId, props: null, facts: [] };
  }
  // Omit `expand=` here so the default lexical + synonym resolution applies
  // (only `expand=exact` turns that off).
  const [recallResponse] = await client.execute([
    buildRecall({
      seeds: seedTerms,
      hops: 1,
      precision: 0.3,
      limit: 5,
      direction: "both",
      references: true,
      referenceLimit: 4,
    }),
  ]);
  if (!recallResponse?.ok) {
    return { resolved: false, via: "none", nodeId, props: null, facts: [] };
  }
  const recallPayload = decodeCheetahPayload(recallResponse);
  const facts = Array.isArray(recallPayload?.associations) ? recallPayload.associations : [];
  const matchedId = recallPayload?.seeds?.[0]?.matches?.[0]?.id ?? facts[0]?.id ?? null;
  if (!facts.length && !matchedId) {
    return { resolved: false, via: "none", nodeId, props: null, facts: [] };
  }
  return { resolved: true, via: "recall", nodeId: matchedId ?? nodeId, props: null, facts };
}

/**
 * Records an open question exactly like GRAPH_LLM.md turn 5:
 * `agent -[:unsure_about]-> hypothesis:<slug>`. Idempotent — re-raising the
 * same question text just re-upserts the same hypothesis id.
 */
export async function recordOpenQuestion(client, { questionText, topicHint = null } = {}) {
  const slug = slugify(questionText).slice(0, 60) || `q_${Date.now()}`;
  const hypothesisId = `hypothesis:${slug}`;
  const props = {
    question: questionText,
    status: "open",
    topic_hint: topicHint,
    created_at: new Date().toISOString(),
  };
  const commands = [
    buildNodeSet({ id: hypothesisId, labels: "hypothesis", props }),
    buildEdgeSet({
      from: ASKER_ID,
      to: hypothesisId,
      type: "unsure_about",
      props: { status: "open", question: questionText },
    }),
  ];
  const responses = await client.execute(commands);
  for (const response of responses) {
    requireSuccess(response, "recordOpenQuestion");
  }
  return { hypothesisId };
}

/**
 * Resolves an open question by flipping `props.status` open -> resolved
 * (the same "demoted, not deleted" philosophy the engine already uses for
 * ruled-out beliefs), rather than deleting the edge — so a resolved question
 * still answers "what got resolved" from the DB itself, and the existing
 * cursor-pageable `GRAPH_NEIGHBORS` listing keeps working unchanged.
 */
export async function resolveOpenQuestion(client, hypothesisId) {
  const [nodeResponse] = await client.execute([buildNodeGet(hypothesisId)]);
  const existing = nodeResponse?.ok ? decodeCheetahPayload(nodeResponse) : null;
  const props = {
    ...(existing?.props ?? {}),
    status: "resolved",
    resolved_at: new Date().toISOString(),
  };
  const commands = [
    buildNodeSet({ id: hypothesisId, props }),
    buildEdgeSet({
      from: ASKER_ID,
      to: hypothesisId,
      type: "unsure_about",
      props: { status: "resolved", question: props.question ?? null },
    }),
  ];
  const responses = await client.execute(commands);
  for (const response of responses) {
    requireSuccess(response, "resolveOpenQuestion");
  }
  return { hypothesisId, status: "resolved" };
}

/**
 * The cheap, cursor-pageable listing "miniphi can retrieve them from cheetah
 * db" requires: one call off the fixed asker anchor, filtered client-side on
 * `props.status`. `GRAPH_NEIGHBORS` is already cursor-resumable
 * (`next_cursor=`), so paging beyond one page is just passing it back in.
 */
export async function listOpenQuestions(client, { status = "open", limit = 20, cursor = "*" } = {}) {
  const [response] = await client.execute([
    buildNeighbors({
      id: ASKER_ID,
      direction: "out",
      type: "unsure_about",
      limit,
      // `*` means "from the beginning" as an input, so it is simply omitted.
      cursor: cursor && cursor !== "*" ? cursor : null,
    }),
  ]);
  if (!response?.ok) {
    return { items: [], nextCursor: "*", count: 0 };
  }
  const edges = decodeCheetahPayload(response);
  const items = (Array.isArray(edges) ? edges : [])
    .filter((edge) => (edge?.props?.status ?? "open") === status)
    .map((edge) => ({
      hypothesisId: edge.to,
      question: edge?.props?.question ?? null,
      status: edge?.props?.status ?? "open",
    }));
  return {
    items,
    nextCursor: response.fields?.next_cursor ?? "*",
    count: items.length,
  };
}
