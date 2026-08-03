import {
  buildNeighborTypes,
  buildNodeGet,
  buildRecall,
  decodeCheetahPayload,
} from "./cheetah-binder.js";
import { topicId } from "./cheetah-knowledge-client.js";
import { questionCues, scoreTextAgainstCues, contentWords } from "./cheetah-memory-layers.js";

/**
 * The retrieval half of the layered knowledge memory: a bounded, multi-stage
 * associative recall instead of the single `GRAPH_NODE_GET topic:<slug(question)>`
 * the first generation used.
 *
 * The old ladder could only succeed when the question's wording slugged to the
 * exact stored title, and it could only ever return that one node's one stored
 * sentence. Here retrieval runs the three things a cue-driven store actually
 * needs:
 *
 *   1. **pattern completion** — every capitalized run in the question is tried
 *      as an anchor, not just the whole stripped question;
 *   2. **spreading activation** — resolved anchors seed a two-hop `GRAPH_RECALL`
 *      so neighbouring topics, shared `context:` categories and shared years
 *      contribute their own passages;
 *   3. **lexical reinstatement** — when no id resolves, the question's content
 *      words seed a recall against the derived term index, which is why the
 *      writer stores several passages per topic rather than one.
 *
 * Everything retrieved is consolidated into ranked, id-tagged evidence records
 * so the model can cite `e3` and the adapter can check what `e3` actually said.
 * Every command issued and every decoded response is appended to `trace`, which
 * is what the benchmark prints as the MiniPhi->Cheetah conversation.
 */

const MAX_TRACE_RAW = 220;

function summarizeRaw(raw) {
  const text = String(raw ?? "");
  // The wire carries node/association JSON as one long base64 `payload=`; the
  // decoded object is recorded separately, so the raw line is kept only for its
  // status/count fields.
  const shortened = text.replace(/payload=[A-Za-z0-9+/=]+/g, "payload=<base64>");
  return shortened.length > MAX_TRACE_RAW ? `${shortened.slice(0, MAX_TRACE_RAW)}...` : shortened;
}

function pushTrace(trace, stage, command, response, decoded) {
  if (!Array.isArray(trace)) {
    return;
  }
  trace.push({
    stage,
    command,
    response: summarizeRaw(response?.raw),
    ok: Boolean(response?.ok),
    decoded: decoded ?? null,
  });
}

function readableName(id) {
  const raw = String(id ?? "");
  const afterColon = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const spaced = afterColon.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : raw;
}

function nodeName(record, fallbackId) {
  const props = record?.props ?? {};
  const name = typeof props.name === "string" && props.name.trim() ? props.name.trim() : null;
  return name ?? readableName(record?.id ?? fallbackId);
}

/**
 * Reference `source` carries `<provenance>#<layer>:<section>` for layered
 * writes; older single-reference nodes have no suffix and read as a gist.
 */
function referenceLayer(reference) {
  const source = String(reference?.source ?? "");
  const marker = source.lastIndexOf("#");
  if (marker < 0) {
    return { layer: "gist", section: "lead" };
  }
  const tail = source.slice(marker + 1);
  const [layer, ...sectionParts] = tail.split(":");
  const knownLayer = ["gist", "detail"].includes(layer) ? layer : "gist";
  return { layer: knownLayer, section: sectionParts.join(":") || "lead" };
}

function collectPassages(record, { subject, origin, distance = 0 }) {
  const references = Array.isArray(record?.references) ? record.references : [];
  return references
    .filter((reference) => typeof reference?.text === "string" && reference.text.trim())
    .map((reference) => {
      const { layer, section } = referenceLayer(reference);
      return {
        subject,
        subjectId: record?.id ?? null,
        layer,
        section,
        origin,
        distance,
        text: reference.text.trim(),
        source: reference.source ?? null,
      };
    });
}

function relationSentences(record, associations) {
  const sentences = [];
  for (const association of Array.isArray(associations) ? associations : []) {
    for (const edge of Array.isArray(association?.via) ? association.via : []) {
      const from = readableName(edge?.from ?? record?.id);
      const to = readableName(edge?.to ?? association?.id);
      const relation = String(edge?.type ?? "related_to").replace(/_/g, " ");
      sentences.push({
        text: `${from} ${relation} ${to}.`,
        from: edge?.from ?? null,
        to: edge?.to ?? null,
        type: edge?.type ?? null,
      });
    }
  }
  const seen = new Set();
  return sentences.filter((entry) => {
    if (seen.has(entry.text)) {
      return false;
    }
    seen.add(entry.text);
    return true;
  });
}

function candidateSubjects(cues, subjectHint) {
  const candidates = [];
  const push = (value) => {
    const cleaned = String(value ?? "").trim();
    if (!cleaned) {
      return;
    }
    const id = topicId(cleaned);
    if (!candidates.some((entry) => entry.id === id)) {
      candidates.push({ name: cleaned, id });
    }
  };
  push(subjectHint);
  push(cues.subject);
  for (const phrase of cues.phrases) {
    push(phrase);
  }
  return candidates;
}

/**
 * Rank consolidated passages. Direct-anchor gist first (it answers the broad
 * question), then whatever actually covers the question's cues, with associated
 * and lexical material discounted by how far it sits from the anchor.
 */
function rankPassages(passages, cues, limit) {
  const originWeight = { direct: 1.6, associated: 0.7, lexical: 0.9, follow_up: 1.1 };
  const scored = passages.map((passage) => {
    const scoring = scoreTextAgainstCues(passage.text, cues);
    const layerWeight = passage.layer === "gist" ? (cues.isBroad ? 1.2 : 0.35) : 0.15;
    return {
      ...passage,
      cueCoverage: scoring.coverage,
      score:
        scoring.score +
        (originWeight[passage.origin] ?? 0.5) +
        layerWeight -
        passage.distance * 0.35,
    };
  });
  scored.sort((left, right) => right.score - left.score);
  const seen = new Set();
  const unique = [];
  for (const passage of scored) {
    const key = passage.text.slice(0, 160);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(passage);
    if (unique.length >= limit) {
      break;
    }
  }
  return unique.map((passage, index) => ({ ...passage, id: `e${index + 1}` }));
}

async function fetchNodes(client, ids, trace, stage) {
  if (!ids.length) {
    return new Map();
  }
  const commands = ids.map((id) => buildNodeGet(id));
  const responses = await client.execute(commands);
  const records = new Map();
  responses.forEach((response, index) => {
    const decoded = response?.ok ? decodeCheetahPayload(response) : null;
    pushTrace(
      trace,
      stage,
      commands[index],
      response,
      decoded
        ? {
            id: decoded.id,
            name: decoded?.props?.name ?? null,
            labels: decoded.labels ?? [],
            references: (decoded.references ?? []).map((reference) => ({
              id: reference.id,
              source: reference.source,
              text: reference.text,
            })),
          }
        : null,
    );
    if (decoded && typeof decoded === "object") {
      // A stored record always carries its own id, but keep the requested one
      // as the fallback so a partial payload still resolves as an anchor.
      records.set(ids[index], { ...decoded, id: decoded.id ?? ids[index] });
    }
  });
  return records;
}

/**
 * Two-hop spreading activation from the resolved anchors. `expand=none` keeps
 * the seeds exact (they are ids, so lexical resolution could only add noise);
 * `references=1` hydrates each reached node's stored passages in the same round
 * trip rather than costing one `GRAPH_NODE_GET` per neighbour.
 */
async function spreadFromAnchors(client, anchorIds, trace, { hops, limit }) {
  if (!anchorIds.length) {
    return { associations: [], payload: null };
  }
  const command = buildRecall({
    seeds: anchorIds,
    hops,
    precision: 0.25,
    limit,
    direction: "both",
    expand: "none",
    includeSeeds: false,
    references: true,
    referenceLimit: 4,
  });
  const [response] = await client.execute([command]);
  const payload = response?.ok ? decodeCheetahPayload(response) : null;
  const associations = Array.isArray(payload?.associations) ? payload.associations : [];
  pushTrace(trace, "spread", command, response, {
    associationCount: associations.length,
    associations: associations.slice(0, 8).map((association) => ({
      id: association.id,
      distance: association.distance,
      score: association.score,
      via: (association.via ?? []).map((edge) => `${edge.from} -[${edge.type}]-> ${edge.to}`),
      referenceCount: (association.references ?? []).length,
    })),
  });
  return { associations, payload };
}

/**
 * Lexical reinstatement against the derived term index. Seeds must be single
 * tokens: `GRAPH_*` splits its arguments on whitespace, so a multi-word phrase
 * cannot travel in `seeds=`.
 */
async function lexicalRecall(client, cues, trace, { limit }) {
  const seeds = [...new Set([...cues.tokens, ...cues.allTokens])]
    .filter((token) => token.length >= 3)
    .slice(0, 6);
  if (!seeds.length) {
    return { associations: [], seeds: [] };
  }
  const command = buildRecall({
    seeds,
    hops: 1,
    precision: 0.2,
    limit,
    direction: "both",
    includeSeeds: true,
    references: true,
    referenceLimit: 4,
  });
  const [response] = await client.execute([command]);
  const payload = response?.ok ? decodeCheetahPayload(response) : null;
  const associations = Array.isArray(payload?.associations) ? payload.associations : [];
  pushTrace(trace, "lexical", command, response, {
    seeds,
    resolvedSeeds: (payload?.seeds ?? []).map((seed) => ({
      term: seed.term,
      matches: (seed.matches ?? []).slice(0, 3).map((match) => match.id),
    })),
    associationCount: associations.length,
    associations: associations.slice(0, 8).map((association) => ({
      id: association.id,
      score: association.score,
      referenceCount: (association.references ?? []).length,
    })),
  });
  return { associations, seeds, payload };
}

async function relationHistogram(client, anchorId, trace) {
  const command = buildNeighborTypes({
    id: anchorId,
    direction: "out",
    limit: 16,
    weighted: true,
  });
  const [response] = await client.execute([command]);
  const decoded = response?.ok ? decodeCheetahPayload(response) : null;
  const histogram = Array.isArray(decoded) ? decoded : [];
  pushTrace(trace, "histogram", command, response, histogram);
  return histogram;
}

/**
 * Run the full ladder for one question and return ranked, id-tagged evidence.
 */
export async function retrieveLayeredMemory(
  client,
  {
    question,
    subjectHint = null,
    maxAnchors = 3,
    maxPassages = 8,
    hops = 2,
    spreadLimit = 10,
    lexicalLimit = 8,
    trace = [],
  } = {},
) {
  const cues = questionCues(question);
  const candidates = candidateSubjects(cues, subjectHint).slice(0, Math.max(1, maxAnchors));
  const anchorRecords = await fetchNodes(
    client,
    candidates.map((candidate) => candidate.id),
    trace,
    "anchor",
  );

  const anchors = [];
  const passages = [];
  for (const candidate of candidates) {
    const record = anchorRecords.get(candidate.id);
    if (!record) {
      continue;
    }
    const name = nodeName(record, candidate.id);
    anchors.push({ id: record.id, name, labels: record.labels ?? [] });
    passages.push(...collectPassages(record, { subject: name, origin: "direct", distance: 0 }));
  }

  let histogram = [];
  let associations = [];
  if (anchors.length) {
    histogram = await relationHistogram(client, anchors[0].id, trace);
    const spread = await spreadFromAnchors(
      client,
      anchors.map((anchor) => anchor.id),
      trace,
      { hops, limit: spreadLimit },
    );
    associations = spread.associations;
  }

  let lexical = { associations: [], seeds: [] };
  // Lexical reinstatement is not only the "anchor missing" fallback: a resolved
  // anchor whose passages do not cover the question still needs it, which is
  // the case the previous ladder had no answer for at all.
  const directCoverage = passages.length
    ? Math.max(...passages.map((passage) => scoreTextAgainstCues(passage.text, cues).coverage))
    : 0;
  if (!anchors.length || directCoverage < 0.6) {
    lexical = await lexicalRecall(client, cues, trace, { limit: lexicalLimit });
  }

  const associatedIds = [];
  for (const association of [...associations, ...lexical.associations]) {
    if (!association?.id || anchors.some((anchor) => anchor.id === association.id)) {
      continue;
    }
    const origin = associations.includes(association) ? "associated" : "lexical";
    const name = readableName(association.id);
    passages.push(
      ...collectPassages(association, {
        subject: name,
        origin,
        distance: Number(association.distance ?? 1) || 1,
      }),
    );
    if (associatedIds.length < 4 && !associatedIds.includes(association.id)) {
      associatedIds.push(association.id);
    }
  }

  // Associations carry references but not props, so the top few are hydrated to
  // recover their real display names (`topic:m_137_michigan_highway` alone reads
  // as "M 137 michigan highway").
  const hydrated = await fetchNodes(client, associatedIds, trace, "hydrate");
  for (const [id, record] of hydrated) {
    const name = nodeName(record, id);
    for (const passage of passages) {
      // Match on the node id only. A `passage.subject === readableName(id)`
      // fallback also lived here and mislabelled evidence across subjects
      // whenever two slugs produced the same readable form — an observed run
      // labelled a Microceratus passage "Asia. It". The text and ids were
      // right, but that label is what the model reads as the passage's subject.
      if (passage.subjectId === id) {
        passage.subject = name;
      }
    }
  }

  const ranked = rankPassages(passages, cues, maxPassages);
  const relations = relationSentences({ id: anchors[0]?.id ?? null }, associations).slice(0, 8);

  return {
    question,
    cues,
    resolved: anchors.length > 0 || ranked.length > 0,
    anchorResolved: anchors.length > 0,
    anchors,
    candidates,
    passages: ranked,
    relations,
    relationHistogram: histogram,
    trace,
    stats: {
      candidateCount: candidates.length,
      anchorCount: anchors.length,
      associationCount: associations.length,
      lexicalAssociationCount: lexical.associations.length,
      passageCount: ranked.length,
      directCoverage,
    },
  };
}

/**
 * Second-round retrieval for the model's own follow-up requests, so a turn that
 * says "I need X" gets X instead of being declined. Subjects are tried as exact
 * anchors first and fall back to a lexical recall over their tokens.
 */
export async function retrieveFollowUp(
  client,
  { lookups = [], question, knownTexts = [], maxPassages = 4, trace = [] } = {},
) {
  const cues = questionCues(question);
  const subjectLookups = [];
  const termLookups = [];
  for (const lookup of Array.isArray(lookups) ? lookups : []) {
    const value = typeof lookup === "string" ? lookup : lookup?.value;
    const cleaned = String(value ?? "").trim();
    if (!cleaned || cleaned.length > 90) {
      continue;
    }
    const kind = typeof lookup === "object" && lookup?.kind === "term" ? "term" : "subject";
    if (kind === "term") {
      termLookups.push(cleaned);
    } else {
      subjectLookups.push(cleaned);
    }
  }
  if (!subjectLookups.length && !termLookups.length) {
    return { passages: [], trace, requested: [] };
  }

  const ids = [...new Set(subjectLookups.map((name) => topicId(name)))].slice(0, 4);
  const records = await fetchNodes(client, ids, trace, "follow_up_anchor");
  const passages = [];
  for (const [id, record] of records) {
    passages.push(
      ...collectPassages(record, { subject: nodeName(record, id), origin: "follow_up", distance: 1 }),
    );
  }

  const terms = [
    ...new Set([
      ...termLookups.flatMap((term) => contentWords(term)),
      ...(records.size ? [] : subjectLookups.flatMap((name) => contentWords(name))),
    ]),
  ].slice(0, 6);
  if (terms.length) {
    const command = buildRecall({
      seeds: terms,
      hops: 1,
      precision: 0.2,
      limit: 6,
      direction: "both",
      includeSeeds: true,
      references: true,
      referenceLimit: 3,
    });
    const [response] = await client.execute([command]);
    const payload = response?.ok ? decodeCheetahPayload(response) : null;
    const associations = Array.isArray(payload?.associations) ? payload.associations : [];
    pushTrace(trace, "follow_up_lexical", command, response, {
      seeds: terms,
      associationCount: associations.length,
      associations: associations.slice(0, 6).map((association) => association.id),
    });
    for (const association of associations) {
      passages.push(
        ...collectPassages(association, {
          subject: readableName(association.id),
          origin: "follow_up",
          distance: 1,
        }),
      );
    }
  }

  const knownKeys = new Set(knownTexts.map((text) => String(text ?? "").slice(0, 160)));
  const fresh = passages.filter((passage) => !knownKeys.has(passage.text.slice(0, 160)));
  return {
    passages: rankPassages(fresh, cues, maxPassages),
    requested: [...subjectLookups, ...termLookups],
    trace,
  };
}

export { readableName };
