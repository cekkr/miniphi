import { createHash } from "node:crypto";
import { buildRecall, buildNodeGet, buildNodeSet, buildEdgeGet, buildEdgeSetBatch, decodeCheetahPayload } from "./cheetah-binder.js";
import { graphName, graphEntityId, containsGraphName } from "./cheetah-graph-identity.js";
import { executeGraphCommands as execute, checkGraphDeadline } from "./cheetah-graph-io.js";
import { getWordNetLexicon } from "./wordnet-lexicon.js";
import { contentWords } from "./cheetah-memory-layers.js";

const hash = value => createHash("sha256").update(value).digest("hex");
export const graphClaimId = fact => `claim:${hash(JSON.stringify([graphEntityId(fact.subject), fact.relation, graphEntityId(fact.object)]))}`;
export const graphCueId = (term, language = "eng") => `wncue:${hash(`${language}:${graphName(term)}`)}`;
const cueTypes = ["wordnet_cue_for", "claim_subject", "claim_object"];
const normalizeTerm = term => graphName(term).replace(/_/g, " ");
const usefulTerm = term => typeof term === "string" && term.length <= 80 && contentWords(term).length > 0 && !/[<>\d]/u.test(term) && term.split(/\s+/u).length <= 5;
function roleAnchors(fact) {
  const canonical = fact.relation.replace(/_/g, " ");
  const object = graphName(fact.object).replace(/^(?:the|an|a)\s+/u, "");
  const last = fact.object.match(/\b([a-z][a-z-]+)$/u)?.[1];
  const preferred = ["part_of", "member_of", "belongs_to", "is_a"].includes(fact.relation) && last && object !== last ? [last] : [];
  const words = (fact.quote.match(/[\p{L}][\p{L}'-]*/gu) ?? []).filter(word => word === word.toLowerCase() && usefulTerm(word) &&
    !containsGraphName(fact.subject, word) && graphName(word) !== object);
  return [...new Set([...preferred, canonical, ...words].map(normalizeTerm).filter(term => usefulTerm(term) && containsGraphName(fact.quote, term)))].slice(0, 16);
}
function includesEntity(term, fact) {
  const names = [fact.subject, fact.object, ...[fact.subject, fact.object].flatMap(name => (name.match(/\b[\p{Lu}][\p{L}-]{2,}/gu) ?? []))];
  return names.some(name => containsGraphName(term, name));
}

/** Related vocabulary is a non-factual graph index. Never write guessed triples. */
export async function learnGraphCorrelations(claims, {
  lexicon = getWordNetLexicon(), cheetahClient, sourceId, episode, deadline = Date.now() + 300000,
} = {}) {
  const trace = [], rejected = [];
  const targets = claims.slice(0, 4).map(fact => ({ id: graphClaimId(fact), fact, anchors: roleAnchors(fact) }));
  if (!targets.length) return { written: 0, known: 0, trace, rejected, stopReason: null };
  try {
    await lexicon.load?.();
    const seeds = [...new Set(targets.map(t => t.fact.relation.replace(/_/g, " ")))];
    const [precheck] = await execute(cheetahClient, [buildRecall({ seeds, hops: 1, precision: 0.1, limit: 6, branchLimit: 16, budget: 128,
      type: cueTypes, includeSeeds: true, references: false })], trace, deadline);
    const ids = [...new Set([...(decodeCheetahPayload(precheck)?.associations ?? []).map(a => a.id).filter(id => id?.startsWith("claim:")).slice(0, 6), ...targets.map(t => t.id)])];
    const prior = ids.length ? await execute(cheetahClient, ids.map(buildNodeGet), trace, deadline) : [];
    const known = new Map(prior.map(decodeCheetahPayload).filter(n => n?.id && n.props?.correlationVersion === 2 && n.props?.lexiconFingerprint === lexicon.fingerprint).map(n => [n.id, n]));
    const proposals = new Map(), lexicalLookups = [];
    for (const target of targets) {
      const anchor = target.anchors[0];
      if (!anchor) continue;
      let expansion;
      for (const candidate of target.anchors) {
        checkGraphDeadline(deadline);
        const found = await lexicon.expand(candidate, { context: target.fact.quote, limit: 15 });
        lexicalLookups.push({ claim: target.id, anchor: candidate, ...found });
        if (found.terms.length) { expansion = { anchor: candidate, ...found }; break; }
      }
      const sourceAnchor = expansion?.anchor ?? anchor;
      const terms = [{ term: sourceAnchor, language: "eng", confidence: 1, kind: "source_anchor" }];
      for (const item of expansion?.terms ?? []) {
        const term = normalizeTerm(item.term);
        if (!usefulTerm(term) || includesEntity(term, target.fact)) { rejected.push({ ...item, reason: "invalid-or-entity-cue" }); continue; }
        terms.push({ ...item, term, confidence: item.kind.includes("derivation") ? 0.8 : 0.95 });
      }
      proposals.set(target.id, [...new Map(terms.map(item => [`${item.language}:${item.term}`, item])).values()].slice(0, 16));
    }
    let written = 0, alreadyKnown = 0, newCueNodes = 0, reusedCueNodes = 0;
    for (const target of targets) {
      checkGraphDeadline(deadline);
      const proposed = proposals.get(target.id) ?? [];
      const terms = [...new Set([...proposed.map(item => item.term)])].slice(0, 16);
      if (!terms.length) continue;
      const fact = target.fact;
      await execute(cheetahClient, [buildNodeSet({ id: target.id, labels: ["retrieval_concept"], props: {
        name: `${fact.subject} ${fact.relation.replace(/_/g, " ")} ${fact.object}`, terms,
        correlationVersion: 2, lexicalProvider: "wordnet", lexiconFingerprint: lexicon.fingerprint, factual: false, from: graphEntityId(fact.subject), to: graphEntityId(fact.object),
        relation: fact.relation, quote: fact.quote, source_id: sourceId,
      }, references: [{ id: hash(fact.quote), text: fact.quote, source: sourceId }] })], trace, deadline);
      const links = [
        { from: target.id, to: graphEntityId(fact.subject), type: "claim_subject", directed: true, weight: 1, props: { factual: false } },
        { from: target.id, to: graphEntityId(fact.object), type: "claim_object", directed: true, weight: 1, props: { factual: false } },
      ];
      const eligible = proposed.filter(item => terms.includes(item.term));
      const probes = eligible.length ? await execute(cheetahClient, eligible.map(item => buildEdgeGet({ from: graphCueId(item.term, item.language), to: target.id, type: "wordnet_cue_for", directed: true })), trace, deadline) : [];
      for (const [i, item] of eligible.entries()) {
        if (probes[i]?.ok) { alreadyKnown += 1; continue; }
        const id = graphCueId(item.term, item.language);
        // Probe before adding a lexical cue. Dataset terms do not establish
        // identity equivalence between real-world entities.
        const [existing] = await execute(cheetahClient, [buildNodeGet(id)], trace, deadline);
        if (!existing.ok) {
          await execute(cheetahClient, [buildNodeSet({ id, labels: ["retrieval_cue"], props: { name: item.term, factual: false, origin: "wordnet", language: item.language } })], trace, deadline);
          newCueNodes += 1;
        } else reusedCueNodes += 1;
        links.push({ from: id, to: target.id, type: "wordnet_cue_for", directed: true, weight: item.confidence, confidence: item.confidence,
          props: { factual: false, kind: item.kind, language: item.language, synset: item.synset, targetSynset: item.targetSynset, lexiconFingerprint: lexicon.fingerprint, source_id: sourceId, anchor: proposed[0]?.term, src: episode?.insertKey } });
        written += 1;
      }
      const [receipt] = await execute(cheetahClient, [buildEdgeSetBatch(links)], trace, deadline);
      if (Number(receipt.fields?.applied) !== links.length || Number(receipt.fields?.failed ?? 0)) throw new Error("Cheetah partial correlation write");
    }
    return { written, known: alreadyKnown, knownConcepts: known.size, newCueNodes, reusedCueNodes, concepts: targets.length, omittedClaims: Math.max(0, claims.length - targets.length), rejected, trace, lexicalLookups, provenance: lexicon.provenance, precheck: decodeCheetahPayload(precheck), stopReason: null };
  } catch (error) {
    const stopReason = error.message.includes("timeout") ? "session-timeout" : "analysis-error";
    return { written: 0, known: 0, rejected, trace, error: error.message, setupHint: "node scripts/install-wordnet.js", fallback: true, stopReason };
  }
}

/** Multi-cue recall produces candidates; only a fresh exact edge read is evidence. */
export async function recallGraphCorrelations(question, {
  cheetahClient, lexicon = getWordNetLexicon(), focusEntity = null, aspect = "", searchTerms = [], deadline = Date.now() + 300000,
} = {}) {
  const trace = [];
  await lexicon.load?.();
  const queryTerms = [...new Set([aspect, ...searchTerms, ...contentWords(question)].filter(usefulTerm))].slice(0, 12);
  const lexicalLookups = [];
  for (const term of queryTerms) {
    checkGraphDeadline(deadline);
    lexicalLookups.push(await lexicon.expand(term, { context: question, limit: 8 }));
  }
  const extra = [...new Set(lexicalLookups.flatMap(r => r.terms.map(t => t.term)).filter(usefulTerm))].slice(0, 24);
  const seeds = [...new Set([...(focusEntity ? [graphEntityId(focusEntity)] : []), aspect, ...extra, ...contentWords(question)].filter(Boolean))].slice(0, 32);
  if (!seeds.length) return { facts: [], candidates: [], trace };
  const [response] = await execute(cheetahClient, [buildRecall({ seeds, hops: 2, precision: 0.08, limit: 64, branchLimit: 24, budget: 384,
    type: cueTypes, includeSeeds: true, references: false })], trace, deadline);
  const associations = (decodeCheetahPayload(response)?.associations ?? []).filter(a => a.id?.startsWith("claim:")).slice(0, 8);
  const nodes = associations.length ? await execute(cheetahClient, associations.map(a => buildNodeGet(a.id)), trace, deadline) : [];
  const cueText = `${aspect} ${extra.join(" ")}`;
  const intentTerms = new Set([...contentWords(cueText), ...extra]);
  const questionTerms = new Set(contentWords(question).filter(term => !["name", "identify", "retrieve", "requested"].includes(term) && !containsGraphName(focusEntity ?? "", term)));
  const candidates = nodes.map((node, i) => ({ node: decodeCheetahPayload(node), association: associations[i] })).filter(({ node }) => node?.props?.correlationVersion === 2 && node.props.lexicalProvider === "wordnet" && node.props.lexiconFingerprint === lexicon.fingerprint)
    .map(({ node, association }) => {
      const matched = (node.props.terms ?? []).filter(term => containsGraphName(cueText, term) || containsGraphName(question, term));
      const relevantSources = (association.sources ?? []).filter(source => intentTerms.has(normalizeTerm(source.seed)) || questionTerms.has(normalizeTerm(source.seed)));
      const activation = Math.max(0, ...relevantSources.map(source => (Number(source.activation) || 0) * (intentTerms.has(normalizeTerm(source.seed)) ? 2 : 1)));
      const relevance = matched.reduce((score, term) => score + (containsGraphName(cueText, term) ? 2 : 1), 0) + activation;
      return { id: node.id, ...node.props, score: association.score, relevance, matched_terms: [...new Set([...matched, ...relevantSources.map(source => source.seed)])], sources: association.sources };
    }).sort((a, b) => b.relevance - a.relevance || b.score - a.score || a.id.localeCompare(b.id));
  const anchored = candidates.filter(c => c.relevance > 0 && (!focusEntity || [c.from, c.to].includes(graphEntityId(focusEntity))));
  const best = anchored[0]?.relevance ?? 0;
  const selected = anchored.filter(c => c.relevance === best).slice(0, 4);
  const facts = [];
  for (const candidate of selected) {
    const [read] = await execute(cheetahClient, [buildEdgeGet({ from: candidate.from, to: candidate.to, type: candidate.relation, directed: true })], trace, deadline);
    const edge = decodeCheetahPayload(read), p = edge?.props;
    if (!edge?.id || !p?.subject || !p?.object || !p?.quote || p.grounding !== "source-overlap" ||
        edge.from !== graphEntityId(p.subject) || edge.to !== graphEntityId(p.object) || edge.type !== candidate.relation ||
        graphName(p.quote) !== graphName(candidate.quote)) continue;
    facts.push({ edge, matched_terms: candidate.matched_terms, conceptId: candidate.id });
  }
  return { facts, candidates, seeds, lexicalLookups, provenance: lexicon.provenance, trace, precheck: decodeCheetahPayload(response) };
}
