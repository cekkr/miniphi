import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import { learnGraphText, reasonGraph, graphEntityId, filterGraphClaims } from "../src/libs/cheetah-graph-learning.js";
import { runWebNlgLearning, scoreWebNlgClaims } from "../src/libs/cheetah-webnlg-runner.js";
import { assessGraphKnowledge, answerGraphConcepts } from "../src/libs/cheetah-knowledge-assessment.js";
import { recallGraphCorrelations, graphClaimId } from "../src/libs/cheetah-graph-correlations.js";

const schemaRegistry = new PromptSchemaRegistry();
const payload = (value) => ({ ok: true, fields: { payload: Buffer.from(JSON.stringify(value)).toString("base64"), next_cursor: "*" } });
const ok = () => ({ ok: true, fields: {} });
const missing = (kind) => ({ ok: false, raw: `ERROR,${kind}_not_found` });
function memoryClient() {
  const nodes = new Map(), edges = new Map(), calls = [];
  const field = (line, name) => line.match(new RegExp(`(?:^| )${name}=([^ ]+)`))?.[1];
  const decode = (line, name) => JSON.parse(Buffer.from(field(line, name), "base64").toString());
  const key = (e) => JSON.stringify([e.from, e.to, e.type]);
  return { database: "test_graph", nodes, edges, calls,
    async putValue(name, value) { calls.push({ name, value }); return calls.length; },
    async execute(commands) {
      return commands.map((line) => {
        calls.push(line);
        if (line.startsWith("GRAPH_NODE_GET")) return nodes.has(field(line, "id")) ? payload(nodes.get(field(line, "id"))) : missing("node");
        if (line.startsWith("GRAPH_NODE_SET")) {
          const id = field(line, "id");
          nodes.set(id, { id, props: field(line, "props") ? decode(line, "props") : {}, references: field(line, "references") ? decode(line, "references") : [] });
          return ok();
        }
        if (line.startsWith("GRAPH_EDGE_GET")) {
          const edge = edges.get(key({ from: field(line, "from"), to: field(line, "to"), type: field(line, "type") }));
          return edge ? payload(edge) : missing("edge");
        }
        if (line.startsWith("GRAPH_EDGE_SET_BATCH")) {
          const items = decode(line, "items");
          for (const e of items) edges.set(key(e), { ...e, id: key(e) });
          return { ok: true, fields: { applied: String(items.length), failed: "0" } };
        }
        if (line.startsWith("GRAPH_QUERY")) {
          const id = line.match(/id='([^']+)'/)?.[1];
          const type = line.match(/\[:([^\]]+)\]/)?.[1];
          const direction = line.includes("<-[") ? "in" : "out";
          return payload([...edges.values()].filter((e) => (direction === "out" ? e.from : e.to) === id && (!type || e.type === type)));
        }
        return ok();
      });
    },
  };
}
function handler(turns) {
  const prompts = [];
  return { prompts, clearHistory() {}, async chatStream(prompt) {
    prompts.push(JSON.parse(prompt));
    const turn = turns.shift();
    assert.notEqual(turn, undefined, "Unexpected extra model call");
    return typeof turn === "string" ? turn : JSON.stringify(turn);
  } };
}
const extract = (facts) => ({ facts, needs_more_context: false, missing_snippets: [], stop_reason: "completed" });
const lookup = (entity, direction = "out") => ({ lookups: [{ entity, direction, relation: "" }], answer_entity: "", evidence_ids: [], needs_more_context: true, missing_snippets: [], stop_reason: "completed" });
const query = (entity, direction = "out") => {
  const { answer_entity, evidence_ids, ...value } = lookup(entity, direction);
  return value;
};
const answer = (entity, ids) => ({ lookups: [], answer_entity: entity, evidence_ids: ids, needs_more_context: false, missing_snippets: [], stop_reason: "completed" });
const text = "Alice works at North Corp. North Corp is located in Rome.";
const facts = [
  { subject: "Alice", relation: "works_at", object: "North Corp", quote: "Alice works at North Corp." },
  { subject: "North Corp", relation: "located_in", object: "Rome", quote: "North Corp is located in Rome." },
];
async function taught() {
  const client = memoryClient();
  await learnGraphText(text, { handler: handler([extract(facts)]), cheetahClient: client, schemaRegistry });
  return client;
}

test("graph identities merge case/whitespace but retain punctuation and Unicode", () => {
  assert.equal(graphEntityId("  NORTH   Corp "), graphEntityId("North Corp"));
  assert.notEqual(graphEntityId("A-B"), graphEntityId("A B"));
  assert.notEqual(graphEntityId("Rome"), graphEntityId("Róme"));
});

test("extracts multiple subjects, probes before writing and keeps duplicate provenance", async () => {
  const client = memoryClient();
  const h = handler([extract(facts), extract(facts)]);
  const first = await learnGraphText(text, { handler: h, cheetahClient: client, schemaRegistry });
  assert.equal(first.written, 2);
  assert.equal(client.nodes.size, 3);
  const previous = [...client.edges.values()][0].props.src;
  const second = await learnGraphText(text, { handler: h, cheetahClient: client, schemaRegistry });
  assert.equal(second.known, 2);
  assert.equal(second.written, 0);
  assert.equal([...client.edges.values()][0].props.src, previous);
  assert(h.prompts.every((p) => p.schema_id === "cheetah-graph-extract" && p.response_schema.additionalProperties === false));
});

test("rejects invented endpoints, unrelated quotes, negation and narrative responses", async () => {
  assert.equal(filterGraphClaims([{ ...facts[0], object: "Mars" }], text).rejected[0].reason, "endpoint-not-in-quote");
  assert.equal(filterGraphClaims([{ ...facts[0], subject: "Ali" }], text).accepted.length, 0);
  const negated = "Alice never works at North Corp.";
  assert.equal(filterGraphClaims([{ ...facts[0], quote: negated }], negated).accepted.length, 0);
  const client = memoryClient();
  const result = await learnGraphText(text, { handler: handler(['Here is JSON: {"facts":[]}']), cheetahClient: client, schemaRegistry });
  assert.equal(result.stopReason, "invalid-response");
  assert.equal(client.edges.size, 0);
  assert.equal(result.episode.text, text);
});

test("follows model-selected intermediate entities and returns a cited two-edge chain", async () => {
  const client = await taught();
  const h = handler([query("Alice"), lookup("North Corp"), answer("Rome", ["e1", "e2"])]);
  const result = await reasonGraph("Where is Alice's workplace located?", { handler: h, cheetahClient: client, schemaRegistry });
  assert.equal(result.grounded, true);
  assert.equal(result.answer, "Rome");
  assert.equal(result.rounds, 3);
  assert.deepEqual(result.evidenceIds, ["e1", "e2"]);
  assert(h.prompts[1].evidence[0].quote.includes("Alice"));
  assert.equal(client.calls.filter((c) => typeof c === "string" && c.startsWith("GRAPH_QUERY")).length, 2);
});

test("incomplete citations get one complete observed-path template without another graph read", async () => {
  const client = await taught();
  const h = handler([query("Alice"), lookup("North Corp"), { ...answer("Rome", ["e2"]), lookups: [{ entity: "North Corp", relation: "", direction: "in" }] }, answer("Rome", ["e1", "e2"])]);
  const result = await reasonGraph("Where is Alice's workplace located?", { handler: h, cheetahClient: client, schemaRegistry });
  assert.equal(result.grounded, true);
  assert.deepEqual(h.prompts[3].citation_repair.evidence_ids, ["e1", "e2"]);
  assert.deepEqual(h.prompts[3].response_templates[0].response.evidence_ids, ["e1", "e2"]);
  assert.deepEqual(result.evidenceIds, ["e1", "e2"]);
  assert.equal(result.trace.filter(s => s.command?.startsWith("GRAPH_QUERY")).length, 2);
});

test("supports reverse lookup without reversing stored facts", async () => {
  const result = await reasonGraph("Which company is located in Rome?", {
    handler: handler([query("Rome", "in"), answer("North Corp", ["e1"])]), cheetahClient: await taught(), schemaRegistry,
  });
  assert.equal(result.answer, "North Corp");
  assert.equal(result.grounded, true);
});

test("a location alone cannot answer a country question; repair fetches the missing role", async () => {
  const client = await taught();
  const country = { subject: "Rome", relation: "located_in", object: "Italy", quote: "Rome is located in the country of Italy." };
  await learnGraphText(country.quote, { handler: handler([extract([country])]), cheetahClient: client, schemaRegistry });
  const h = handler([query("North Corp"), answer("Rome", ["e1"]), query("Rome"), answer("Italy", ["e1", "e2"])]);
  const result = await reasonGraph("In which country is North Corp located?", { handler: h, cheetahClient: client, schemaRegistry });
  assert.equal(result.answer, "Italy");
  assert.equal(result.rounds, 4);
  assert.equal(h.prompts[2].schema_id, "cheetah-graph-query");
  assert.equal(h.prompts[2].observations.at(-1).required_action, "lookup-observed-endpoint");
  assert.equal(h.prompts[2].next_lookup.entity, "Rome");
  assert.equal(h.prompts[2].response_templates[0].response.lookups[0].entity, "Rome");
});

test("refuses unobserved lookups, invented citations and disconnected answers", async () => {
  for (const turns of [
    [query("Mars")],
    [query("Alice"), answer("Rome", ["e9"])],
    [query("Alice"), lookup("North Corp"), answer("Rome", ["e2"])],
    [query("Alice"), lookup("Alice")],
  ]) {
    const result = await reasonGraph("Where does Alice work?", { handler: handler(turns), cheetahClient: await taught(), schemaRegistry });
    assert.equal(result.grounded, false);
    assert.equal(result.answer, "I don't know.");
    assert(result.openQuestion);
  }
});

test("bounds rounds and persists a timeout rather than calling the model", async () => {
  const h = handler([]);
  const result = await reasonGraph("Where is Alice?", { handler: h, cheetahClient: memoryClient(), schemaRegistry, deadline: Date.now() - 1 });
  assert.equal(result.stopReason, "session-timeout");
  assert.equal(h.prompts.length, 0);
  await assert.rejects(() => reasonGraph("x", { maxRounds: Infinity }), /maxRounds/);
});

test("rejects oversized UTF-8 references and over-budget prompts before inference", async () => {
  await assert.rejects(() => learnGraphText("é".repeat(2001), { handler: handler([]), cheetahClient: memoryClient(), schemaRegistry }), /UTF-8 bytes/);
  const h = handler([]);
  h.graphPromptBudgetTokens = 1;
  const result = await reasonGraph("Where is Alice?", { handler: h, cheetahClient: memoryClient(), schemaRegistry });
  assert.equal(result.stopReason, "context-overflow");
  assert.equal(h.prompts.length, 0);
});

test("WebNLG runner isolates gold labels, checkpoints and resumes input", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webnlg-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const row = { input: ["Alice | EMPLOYER_ORACLE_ONLY | North_Corp"], target: [facts[0].quote], "webnlg-id": "train/Test/1/Id1" };
  await fs.writeFile(path.join(dir, "train.json"), JSON.stringify({ language: "en", values: [row, { ...row, "webnlg-id": "train/Test/1/Id2" }] }));
  const h = handler([extract([facts[0]]), extract([facts[0]])]);
  const options = { datasetPath: dir, checkpointFile: path.join(dir, "checkpoint.json"), handler: h, cheetahClient: memoryClient(), schemaRegistry, modelKey: "test", limit: 1 };
  const first = await runWebNlgLearning(options);
  assert.equal(first.nextIndex, 1);
  const second = await runWebNlgLearning(options);
  assert.equal(second.nextIndex, 2);
  assert(h.prompts.every((prompt) => !JSON.stringify(prompt).includes("EMPLOYER_ORACLE_ONLY")));
  assert.deepEqual(first.records[0].metrics, { expectedPairs: 1, predictedPairs: 1, matchingPairs: 1 });
  await assert.rejects(() => runWebNlgLearning({ ...options, modelKey: "different" }), /identity mismatch/);
  assert.equal(scoreWebNlgClaims(row.input, []).matchingPairs, 0);
});

test("partial writes fail rather than reporting successful learning", async () => {
  const client = memoryClient();
  const original = client.execute;
  client.execute = async (commands) => commands[0].startsWith("GRAPH_EDGE_SET_BATCH")
    ? [{ ok: true, fields: { applied: "1", failed: "1" } }] : original(commands);
  await assert.rejects(() => learnGraphText(text, { handler: handler([extract(facts)]), cheetahClient: client, schemaRegistry }), /partial graph write/);
});

const assessment = (concepts) => ({ concepts, needs_more_context: true, missing_snippets: [], stop_reason: "completed" });
const concept = (entity, aspect, question, prior_answer = "", self_confidence = 0) => ({ id: "c1", entity, aspect, question, prior_answer, self_confidence, basis: "Diagnostic only" });

test("decomposition uses bounded cardinality schemas and repairs malformed subquestions", async () => {
  const h = handler([assessment([concept("Alice", "workplace", "We are given a task to decompose the question")])]);
  const result = await assessGraphKnowledge("Where does Alice work?", { handler: h, schemaRegistry });
  assert.equal(h.prompts[0].schema_id, "cheetah-knowledge-assessment-single");
  assert.equal(h.prompts[0].requested_concept_count, 1);
  assert(result.concepts[0].question.includes("Alice"));
  assert.equal(result.concepts[0].questionRepair, "entity-missing-or-meta-instruction");
  const pair = handler([assessment([concept("Alice", "workplace", "Where does Alice work?"), concept("Alice", "city", "Where is Alice located?")])]);
  await assessGraphKnowledge("Where does Alice work and where is Alice located?", { handler: pair, schemaRegistry });
  assert.equal(pair.prompts[0].schema_id, "cheetah-knowledge-assessment-pair");
});

test("high closed-book confidence never turns a missing graph fact into knowledge", async () => {
  const client = memoryClient();
  const closedBook = handler([assessment([concept("Iraq", "currency", "What is the currency of Iraq?", "Iraqi dinar", 1)])]);
  const h = handler([query("Iraq"), { ...answer("Iraqi dinar", ["e1"]), self_confidence: 1, reasoning_summary: "I recognize the answer" }]);
  const result = await answerGraphConcepts("What is the currency of Iraq?", { assessmentHandler: closedBook, handler: h, cheetahClient: client, schemaRegistry });
  assert.equal(result.assessment.concepts[0].self_confidence, 1);
  assert.equal(result.results[0].recalled.grounded, false);
  assert.equal(result.needsLearning, true);
  assert.equal(client.edges.size, 0);
  assert(!JSON.stringify(h.prompts).includes('"prior_answer"'));
});

test("rejects out-of-range confidence and names absent from the original question", async () => {
  for (const value of [concept("Mars", "location", "Where is Mars?", "Space", 1), concept("Alice", "location", "Where is Alice?", "Rome", 100)]) {
    const result = await assessGraphKnowledge("Where is Alice?", { handler: handler([assessment([value])]), schemaRegistry });
    assert.equal(result.concepts.length, 0);
    assert.equal(result.stopReason, "invalid-response");
  }
});

test("an empty extraction gets one source-checked repair, never a gold import", async () => {
  const h = handler([extract([]), extract([facts[0]])]);
  const client = memoryClient();
  const learned = await learnGraphText(text, { handler: h, cheetahClient: client, schemaRegistry, entityHints: ["Alice", "Invented person"] });
  assert.equal(learned.written, 1);
  assert.equal(h.prompts[1].schema_id, "cheetah-graph-extract-repair");
  assert.deepEqual(h.prompts[0].entity_hints, ["Alice"]);
  assert.equal(h.prompts[1].source_text, text);
});

test("natural predicate hints and inverse adjacency discover the actual stored edge", async () => {
  const client = await taught();
  const first = query("Alice"); first.lookups[0].relation = "works at";
  const direct = await reasonGraph("Where does Alice work?", { handler: handler([first, answer("North Corp", ["e1"])]), cheetahClient: client, schemaRegistry });
  assert.equal(direct.answer, "North Corp");
  const wrong = query("Rome"); wrong.lookups[0].relation = "company_location";
  const reverse = await reasonGraph("Which company is located in Rome?", { handler: handler([wrong, answer("North Corp", ["e1"])]), cheetahClient: client, schemaRegistry });
  assert.equal(reverse.answer, "North Corp");
  assert.deepEqual(reverse.trace.filter(t => t.command?.startsWith("GRAPH_QUERY")).length, 3);
  assert.equal(reverse.evidence[0].start, "Rome");
});

test("focused query references resolve exact question names without model retyping", async () => {
  const client = await taught();
  const h = handler([query("focus"), answer("North Corp", ["e1"])]);
  const result = await reasonGraph("Where does Alice work?", { handler: h, cheetahClient: client, schemaRegistry, focusEntity: "Alice" });
  assert.equal(result.answer, "North Corp");
  assert.equal(h.prompts[0].schema_id, "cheetah-focused-query");
  assert.deepEqual(h.prompts[0].entity_candidates, [{ id: "focus", name: "Alice" }]);
});

test("partial extraction repairs rejected names without losing accepted claims", async () => {
  const bad = { ...facts[1], subject: "North Corpp" };
  const h = handler([extract([facts[0], bad]), extract([facts[1]])]);
  const result = await learnGraphText(text, { handler: h, cheetahClient: memoryClient(), schemaRegistry });
  assert.equal(result.written, 2);
  assert.equal(result.rejected[0].reason, "endpoint-not-in-quote");
  assert.equal(h.prompts.length, 2);
});

test("a schema-valid extraction that omits a source sentence gets one source-only completeness repair", async () => {
  const h = handler([extract([facts[0]]), extract([facts[1]])]);
  const result = await learnGraphText(text, { handler: h, cheetahClient: memoryClient(), schemaRegistry });
  assert.equal(result.written, 2);
  assert.equal(h.prompts.length, 2);
  assert.deepEqual(h.prompts[1].uncovered_source_sentences, [facts[1].quote]);
  assert.equal(h.prompts[0].response_templates[0].response.facts.length, 2);
});

test("question-backed entity hints reject role phrases as graph identities", async () => {
  const source = "The population of Antioch California is 102372.";
  const bad = { subject: "The population of Antioch California", relation: "population", object: "102372", quote: source };
  const good = { ...bad, subject: "Antioch California" };
  const result = await learnGraphText(source, { handler: handler([extract([bad]), extract([good])]), cheetahClient: memoryClient(), schemaRegistry, entityHints: ["Antioch California"] });
  assert.equal(result.claims[0].subject, "Antioch California");
  assert.equal(result.rejected[0].reason, "decorated-subject-anchor");
});

test("lexical recall completes a clause-shaped anchor only to a stored question name", async () => {
  const client = await taught();
  const original = client.execute;
  client.execute = async commands => commands[0].startsWith("GRAPH_RECALL")
    ? [payload({ associations: [{ id: graphEntityId("Alice") }, { id: graphEntityId("North Corp") }] })] : original(commands);
  const h = handler([query("focus"), answer("North Corp", ["e1"])]);
  const result = await reasonGraph("Where does Alice work?", { handler: h, cheetahClient: client, schemaRegistry, focusEntity: "Where does Alice work" });
  assert.equal(result.answer, "North Corp");
  assert.deepEqual(h.prompts[0].entity_candidates, [{ id: "focus", name: "Alice" }]);
});

test("normalizes redundant/reordered citations using only the edges the model cited", async () => {
  const client = await taught();
  const result = await reasonGraph("Where is Alice's workplace located?", { handler: handler([query("Alice"), lookup("North Corp"), answer("Rome", ["e2", "e1"])]), cheetahClient: client, schemaRegistry });
  assert.equal(result.answer, "Rome");
  assert.deepEqual(result.evidenceIds, ["e1", "e2"]);
  assert.equal(result.citationRepair, "connected-subpath-of-cited-evidence");
  const invalid = await reasonGraph("Where does Alice work?", { handler: handler([query("Alice"), answer("North Corp", ["e1", "invented"])]), cheetahClient: client, schemaRegistry, maxRounds: 2 });
  assert.equal(invalid.grounded, false);
});

const lexicon = {
  fingerprint: "fixture-wordnet-v1", provenance: { provider: "wordnet", languages: ["eng", "ita"] },
  async load() {},
  async expand(term) {
    const values = { works: ["employment", "occupation"], located: ["situated"] }[term] ?? [];
    return { terms: values.map(term => ({ term, language: "eng", kind: "synonym", synset: "00000001-n" })) };
  },
};
async function correlationFixture() {
  const client = memoryClient();
  const base = client.execute;
  client.execute = async commands => commands[0].startsWith("GRAPH_RECALL")
    ? (client.calls.push(...commands), [payload({ associations: [...client.nodes.keys()].filter(id => id.startsWith("claim:")).map(id => ({ id, score: 0.9, sources: [{ seed: "employment", activation: 0.9 }] })) })]) : base(commands);
  const result = await learnGraphText(text, { handler: handler([extract(facts)]), lexicon, correlate: true, cheetahClient: client, schemaRegistry });
  return { client, result };
}

test("pre-checks vocabulary, stores bounded non-factual cues and probes before adding unknown links", async () => {
  const { client, result } = await correlationFixture();
  assert.equal(result.written, 2);
  assert.equal(result.correlations.written, 5);
  assert(result.correlations.trace[0].command.startsWith("GRAPH_RECALL"));
  assert.equal(result.correlations.provenance.provider, "wordnet");
  assert.equal(result.correlations.trace.filter(step => step.schemaId).length, 0, "lexical lookup must never prompt the LM");
  assert.equal([...client.edges.values()].filter(e => e.props?.grounding === "source-overlap").length, 2);
  assert([...client.edges.values()].filter(e => e.type === "wordnet_cue_for").every(e => e.props.factual === false && e.confidence >= 0.8));
  const again = await learnGraphText(text, { handler: handler([extract(facts)]), lexicon, correlate: true, cheetahClient: client, schemaRegistry });
  assert.equal(again.correlations.written, 0);
  assert.equal(again.correlations.known, 5);
});

test("correlation selects role-specific context but a fresh factual edge is mandatory", async () => {
  const { client } = await correlationFixture();
  const recalled = await recallGraphCorrelations("Who employs Alice?", { cheetahClient: client, lexicon, focusEntity: "Alice", aspect: "occupation", searchTerms: ["employment"] });
  assert.equal(recalled.facts.length, 1);
  assert.equal(recalled.facts[0].edge.props.object, "North Corp");
  assert.equal(recalled.facts[0].conceptId, graphClaimId(facts[0]));
  const h = handler([answer("North Corp", ["e1"])]);
  const result = await reasonGraph("Who employs Alice?", { handler: h, cheetahClient: client, schemaRegistry, focusEntity: "Alice", aspect: "occupation", searchTerms: ["employment"], correlate: true, lexicon });
  assert.equal(result.answer, "North Corp");
  assert.equal(h.prompts[0].schema_id, "cheetah-graph-reason");
  assert.equal(result.correlations.facts.length, 1);
  for (const [key, edge] of client.edges) if (edge.props?.grounding === "source-overlap") client.edges.delete(key);
  const stale = await recallGraphCorrelations("Who employs Alice?", { cheetahClient: client, lexicon, focusEntity: "Alice", aspect: "occupation" });
  assert.equal(stale.facts.length, 0, "cues must not resurrect deleted facts");
});

test("legacy model vocabulary and another lexicon fingerprint cannot supply WordNet context", async () => {
  const { client } = await correlationFixture();
  for (const node of client.nodes.values()) if (node.id.startsWith("claim:")) {
    node.props.correlationVersion = 1;
    node.props.lexicalProvider = "model";
  }
  const options = { cheetahClient: client, lexicon, focusEntity: "Alice", aspect: "occupation" };
  assert.equal((await recallGraphCorrelations("Who employs Alice?", options)).facts.length, 0);
  for (const node of client.nodes.values()) if (node.id.startsWith("claim:")) {
    node.props.correlationVersion = 2;
    node.props.lexicalProvider = "wordnet";
    node.props.lexiconFingerprint = "different-language-or-corpus";
  }
  assert.equal((await recallGraphCorrelations("Who employs Alice?", options)).facts.length, 0);
});

test("missing WordNet leaves factual learning intact and reports deterministic setup guidance", async () => {
  const client = memoryClient();
  const unavailable = { async load() { throw new Error("ENOENT missing WordNet"); } };
  const result = await learnGraphText(text, { handler: handler([extract(facts)]), lexicon: unavailable, correlate: true, cheetahClient: client, schemaRegistry });
  assert.equal(result.written, 2);
  assert.equal(result.correlations.written, 0);
  assert.equal(result.correlations.fallback, true);
  assert.equal(result.correlations.setupHint, "node scripts/install-wordnet.js");
  assert.equal([...client.nodes.keys()].filter(id => id.startsWith("claim:")).length, 0);
});

test("a correlated search cue cannot turn a family fact into a genus answer", async () => {
  const client = memoryClient(), base = client.execute;
  client.execute = async commands => commands[0].startsWith("GRAPH_RECALL")
    ? [payload({ associations: [...client.nodes.keys()].filter(id => id.startsWith("claim:")).map(id => ({ id, score: 0.9, sources: [{ seed: "family", activation: 0.9 }] })) })] : base(commands);
  const fact = { subject: "Almond", relation: "part_of", object: "Rosaceae family", quote: "Almond is part of the Rosaceae family." };
  const related = { ...lexicon, async expand() { return { terms: [{ term: "genus classification", kind: "synonym", language: "eng", synset: "00000001-n" }] }; } };
  await learnGraphText(fact.quote, { handler: handler([extract([fact])]), correlate: true, lexicon: related, cheetahClient: client, schemaRegistry });
  const result = await reasonGraph("What genus does Almond belong to?", { handler: handler([answer("Rosaceae family", ["e1"])]), cheetahClient: client, schemaRegistry,
    focusEntity: "Almond", aspect: "genus", searchTerms: ["family"], correlate: true, lexicon: related, maxRounds: 1 });
  assert.equal(result.correlations.facts.length, 1);
  assert.equal(result.grounded, false, "a search association is not proof of a taxonomic rank");
});

test("canonical entity completion restores a valid original atomic question", async () => {
  const client = await taught(), base = client.execute;
  client.execute = async commands => commands[0].startsWith("GRAPH_RECALL") ? [payload({ associations: [{ id: graphEntityId("Alice") }] })] : base(commands);
  const h = handler([query("focus"), answer("North Corp", ["e1"])]);
  const result = await reasonGraph("For Name the employer of Alice, retrieve the workplace", { handler: h, cheetahClient: client, schemaRegistry,
    rootQuestion: "Where does Alice work?", focusEntity: "Name the employer of Alice", originalConceptQuestion: "Where does Alice work?" });
  assert.equal(result.answer, "North Corp");
  assert.equal(h.prompts[0].question, "Where does Alice work?");
});

test("correlation learning is checkpoint-scoped and forwards to an immediate question", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webnlg-correlation-mode-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "train.json"), JSON.stringify({ language: "en", values: [{ input: ["Alice | worksAt | North_Corp"], target: [facts[0].quote], "webnlg-id": "train/Test/1/Id1" }] }));
  const options = { datasetPath: dir, checkpointFile: path.join(dir, "checkpoint.json"), cheetahClient: memoryClient(), schemaRegistry, modelKey: "fixture", limit: 1 };
  const state = await runWebNlgLearning({ ...options, correlate: true, lexicon,
    handler: handler([extract([facts[0]]), query("Alice"), answer("North Corp", ["e1"])]), question: "Where does Alice work?" });
  assert.equal(state.stopReason, null);
  assert.equal(state.identity.correlationVersion, 2);
  assert.equal(state.answers[0].answer, "North Corp");
  assert(state.answers[0].correlations, "the immediate question must retain correlation mode");
  await assert.rejects(() => runWebNlgLearning({ ...options, correlate: false, handler: handler([]) }), /identity mismatch/);
});

test("source entity repair removes only a leading article before an exact hinted name", () => {
  const quote = "The English language is spoken in England.";
  const fact = { subject: "The English language", relation: "spoken_in", object: "England", quote };
  const result = filterGraphClaims([fact], quote, { entityHints: ["English language"] });
  assert.equal(result.accepted[0].subject, "English language");
  assert.equal(result.entityNormalizations[0].basis, "leading-article-before-exact-source-hint");
  const decorated = filterGraphClaims([{ ...fact, subject: "The population of English language" }], quote, { entityHints: ["English language"] });
  assert.equal(decorated.accepted.length, 0);
});

test("answer JSON choices come from connected observations and keep intermediate lookup available", async () => {
  const client = await taught();
  const h = handler([query("Alice"), lookup("North Corp"), answer("Rome", ["e1", "e2"])]);
  const result = await reasonGraph("Where is Alice's workplace located?", { handler: h, cheetahClient: client, schemaRegistry });
  assert.equal(result.answer, "Rome");
  assert.equal(h.prompts[0].observed_answer_candidates, undefined, "no answer example before a graph read");
  assert.deepEqual(h.prompts[1].observed_answer_candidates, [{ answer_entity: "North Corp", evidence_ids: ["e1"] }]);
  assert(h.prompts[2].response_schema.properties.answer_entity.enum.includes("Rome"));
  assert(h.prompts[1].response_templates.some(t => t.response.lookups.length), "intermediate facts must not force an answer to a chain question");
});

test("assessment discards an invented qualifier only when its exact base name is in the question", async () => {
  const response = { concepts: [{ id: "c1", entity: "Airman (comic-character)", aspect: "creator", question: "Who created Airman?", prior_answer: "", self_confidence: 0, basis: "unknown" }], needs_more_context: true, missing_snippets: [], stop_reason: "completed" };
  const fixed = await assessGraphKnowledge("Who created Airman?", { handler: handler([response]), schemaRegistry });
  assert.equal(fixed.concepts[0].entity, "Airman");
  assert.equal(fixed.concepts[0].original_entity, "Airman (comic-character)");
  const rejected = await assessGraphKnowledge("Who created Superman?", { handler: handler([response]), schemaRegistry });
  assert.equal(rejected.concepts.length, 0);
});
