import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const json = value => `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
const cell = value => String(value ?? "").replace(/\|/gu, "\\|").replace(/\n/gu, " ");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const localTime = value => value ? `${new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "medium", hour12: false,
}).format(new Date(value))} Europe/Rome` : "not recorded";
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

// This is a presentation decoder, never a Cheetah command encoder/client.
function commandArguments(command) {
  const decoded = {};
  for (const name of ["props", "items", "references"]) {
    const value = command.match(new RegExp(`(?:^| )${name}=([^ ]+)`))?.[1];
    if (!value || value === "-") continue;
    const parsed = parse(Buffer.from(value.replace(/^base64:/u, ""), "base64").toString("utf8"));
    if (parsed !== null) decoded[name] = parsed;
  }
  return decoded;
}

function responseView(response) {
  const shown = structuredClone(response);
  const encoded = shown.fields?.payload;
  if (typeof encoded === "string") {
    const decoded = parse(Buffer.from(encoded.replace(/^base64:/u, ""), "base64").toString("utf8"));
    if (decoded !== null) {
      if (shown.raw?.includes(encoded)) delete shown.fields.payload;
      shown.decoded_payload = decoded;
    }
  }
  return shown;
}

function requestView(event) {
  const request = structuredClone(event.request);
  const body = request.body;
  body.messages = body.messages.map(message => {
    if (message.role !== "user") return message;
    const content = parse(message.content);
    assert(content?.response_schema && content?.response_templates, "Missing predefined JSON contract");
    return { ...message, content };
  });
  const lastUser = body.messages.filter(m => m.role === "user").at(-1);
  assert.equal(body.response_format?.type, "json_schema", "LM requests must use json_schema");
  assert.deepEqual(body.response_format.json_schema.schema, lastUser.content.response_schema, "Prompt/transport schema drift");
  // Show the full, context-specific schema in the user prompt once, with a
  // lossless reference for the identical second copy in response_format.
  body.response_format.json_schema.schema = {
    presentation_reference: `messages[${body.messages.indexOf(lastUser)}].content.response_schema`,
    sha256: digest(lastUser.content.response_schema),
  };
  return request;
}

function validations(result) {
  return (result?.trace ?? []).filter(t => t.schemaId).map(t => ({ schema_id: t.schemaId, validation: t.validation }));
}

function selection(correlations) {
  if (!correlations) return undefined;
  return { seeds: correlations.seeds, provenance: correlations.provenance,
    candidates: correlations.candidates?.map(({ id, name, relation, score, relevance, matched_terms }) => ({ id, name, relation, score, relevance, matched_terms })),
    selected_facts: correlations.facts?.map(({ conceptId, matched_terms, edge }) => ({ concept_id: conceptId, matched_terms, edge_id: edge.id })),
  };
}

function outcome(record) {
  const result = record.result;
  if (!result) return { error: record.error ?? "No result recorded" };
  if (record.phase === "learn") return {
    source_id: result.sourceId, episode: result.episode, claims: result.claims,
    written: result.written, known: result.known, rejected: result.rejected,
    entity_normalizations: result.entityNormalizations, validation: validations(result),
    stop_reason: result.stopReason,
    vocabulary: result.correlations && Object.fromEntries(Object.entries(result.correlations)
      .filter(([key]) => !["trace", "lexicalLookups", "precheck"].includes(key))),
  };
  if (result.results) return {
    question: result.question, assessment_stop_reason: result.assessment?.stopReason,
    assessment_validation: validations(result.assessment), needs_learning: result.needsLearning,
    concepts: result.results.map(({ concept, recalled, memoryGap }) => ({
      diagnostic: concept, memory_gap: memoryGap, answer: recalled.answer, grounded: recalled.grounded,
      self_confidence: recalled.modelConfidence, reasoning_summary: recalled.reasoningSummary,
      evidence_ids: recalled.evidenceIds, evidence: recalled.evidence, rounds: recalled.rounds,
      correlation_selection: selection(recalled.correlations),
      citation_repair: recalled.citationRepair, validation: validations(recalled), stop_reason: recalled.stopReason,
    })), source_coverage: record.score, stop_reason: result.stopReason,
  };
  if (record.phase === "multilingual_recall") return {
    seeds: result.seeds, facts: result.facts, provenance: result.provenance,
  };
  return { question: result.question, answer: result.answer, grounded: result.grounded,
    evidence_ids: result.evidenceIds, evidence: result.evidence, correlation_selection: selection(result.correlations),
    validation: validations(result), stop_reason: result.stopReason };
}

/** Render recorded exchanges only. No inference, database access or prediction edits. */
export function renderWebNlgExchangeMarkdown(report, {
  auditLink = "benchmarks/webnlg-correlations-wordnet-2026-10-26.json.gz",
  legacyLink = "webnlg_learning_legacy.md",
  guideLink = "cheetah-webnlg-learning.md",
  stateArgument = "docs/benchmarks/webnlg-correlations-wordnet-2026-10-26.json.gz",
  outputArgument = "docs/webnlg_learning.md",
} = {}) {
  assert.equal(report.lexicon?.provider, "wordnet");
  assert.equal(report.stopReason, null, "A completed WordNet run is required");
  assert.equal(report.definitions.length, 20, "All twenty concepts must be preserved");
  const lines = [], add = (...values) => lines.push(...values);
  const eventIds = new Map();
  for (const record of report.records) for (const event of record.events) {
    assert(!eventIds.has(event), "Duplicate event object");
    eventIds.set(event, `E${String(eventIds.size + 1).padStart(5, "0")}`);
  }
  const counts = { records: report.records.length, exchanges: eventIds.size,
    lmstudio: 0, cheetah: 0, valueWrites: 0, dictionaryLookups: 0 };
  const emitted = new Set(), renderedRecords = new Set();
  const a = report.summary.baseline, b = report.summary.correlated;
  add("# WebNLG: recorded learning, predefined JSON answers and WordNet recall", "",
    `This is the latest complete twenty-concept transcript. Start with the [practical guide](${guideLink}) for a shorter explanation. The [earlier pre-template study](${legacyLink}) is preserved separately, including its before-learning probes, failed answers and repair continuation.`, "",
    `Model: **${report.model}**. LM Studio: \`${report.baseUrl}\`. Loaded context: **${report.loadedContextTokens} tokens**. Retrieval run: ${localTime(report.startedAt)} → ${localTime(report.finishedAt)}. Exact recorded UTC timestamps remain in every exchange.`, "",
    "**Learning writes facts to Cheetah; it does not change model weights.** WordNet/OMW supplies vocabulary independently of Qwen. All model user prompts below are JSON and retain their exact active schemas, predefined response templates and observed-answer choices. Only freshly read source-backed edges can support answers.", "",
    "## Evidence and chronology", "",
    `The [complete archived JSON](${auditLink}) contains the original serialized request/response objects. This Markdown renders **${report.records.length} stages and ${eventIds.size} recorded application-level exchanges** without requesting new generations. It includes teaching, both retrieval arms, all four additional-wording questions, both refusal controls and every multilingual probe.`, "",
    "The final run reused the completed WordNet database and its original learning records, copied the data, and restarted Cheetah before retrieval. Teaching therefore uses the earlier extraction contract; the later retrieval stages show the new concrete observed-answer templates. No newer fields have been inserted into historical prompts.", "",
    "Closed-book prior answers and self-confidence are collected before each graph retrieval, with fresh model histories. They are not a new empty-database baseline and never authorize writes. The earlier transcript contains the separate before-teaching baseline.", "",
    json({ learning_origin: report.reusedLearning, current_runtime_hashes: report.runtimeHashes,
      cheetah_revision: report.cheetahRevision, lifecycle: report.lifecycle, lexicon: report.lexicon,
      lexicon_fingerprint: report.lexiconFingerprint }),
    "## Results and navigation", "",
    "| Measurement | Ordinary discovery | WordNet context |", "| --- | --- | --- |",
    `| Rephrased question B | ${a.question_b.matched}/${a.question_b.total} facets | ${b.question_b.matched}/${b.question_b.total} facets |`,
    `| Fully covered examples | ${a.question_b.complete}/20 | ${b.question_b.complete}/20 |`,
    `| Question-B model calls | ${a.question_b.modelCalls} | ${b.question_b.modelCalls} |`,
    `| Additional vocabulary questions | ${a.withheld.matched}/${a.withheld.total} facets | ${b.withheld.matched}/${b.withheld.total} facets |`,
    `| Untaught-subject control declined | ${a.controlsDeclined}/1 | ${b.controlsDeclined}/1 |`,
    `| Unsupported-genus control declined | ${a.unsupportedRolesDeclined}/1 | ${b.unsupportedRolesDeclined}/1 |`, "",
    "Coverage is evaluator-only source-answer alias containment, not general accuracy, semantic entailment or correct assignment to every atomic question. The two location-type misses and the additional shipwright-wording failure remain visible. No failed stages have been removed.", "",
    "| Case | Concepts | Ordinary | WordNet |", "| --- | --- | --- | --- |",
    ...report.definitions.map(definition => {
      const records = report.records.filter(r => r.caseId === definition.id && r.phase === "question_b");
      const score = arm => { const s = records.find(r => r.arm === arm)?.score; assert(s); return `${s.matched}/${s.total}`; };
      return `| [${cell(definition.id)}](#case-${definition.id}) | ${cell(definition.theme)} | ${score("baseline")} | ${score("correlated")} |`;
    }), "",
    "[Refusal controls](#refusal-controls) · [Multilingual exchanges](#multilingual-exchanges) · [Rendering and coverage checks](#rendering-and-coverage-checks)", "",
    "## How to read the exchanges", "",
    "1. A source-learning stage shows the exact source, extracted claims, exact-edge novelty probes, writes and local WordNet results. Vocabulary links have factual:false and are separate from factual edges.",
    "2. A later stage shows the user's differently worded question, atomic concepts, diagnostic confidence, WordNet query expansion and source-edge reads. Both baseline and correlated outcomes are retained.",
    "3. Each collapsed exchange block contains every recorded application-level request and response in that stage, in recorded order. Exchange IDs are stable positions in the original report; grouping by concept does not imply that all stages happened consecutively.", "",
    "LM request content strings are decoded into JSON objects for reading. The full active schema appears in the user prompt; response_format references that identical schema with its SHA-256 instead of printing a second copy. The archive retains both original copies and the original serialized content strings. Response templates are shown exactly as recorded, including context-specific endpoint/evidence enums.", "",
    "Cheetah canonical command lines and raw binder responses are retained. Base64 props/items/references and response payloads are also decoded. Duplicate fields.payload is omitted only when the same encoded bytes remain in raw. Value-writer operations show the recorded binder API request/receipt. Connection negotiation, database-selection packets, HTTP headers and socket-frame bytes were not captured in this audit and are not reconstructed.", "",
    "The MLX backend often returned the whole constrained JSON in reasoning_content with content empty. Both raw fields, usage, tool_calls and finish_reason remain visible; a separate parsed view is provided only if the entire field parses as JSON. Missing request tools are shown as an empty tool_definitions audit array, not as invented model calls.", "",
    "WordNet lookups are local operations, not LM Studio exchanges. Their recorded results are shown separately; their exact interleaving is not reconstructed because individual dictionary lookups have no timestamps. Lexical search mechanics remain outside the later model's source-evidence prompt.", "");

  // Put one real new contract near the top, with a direct link to its full exchange.
  const ship = report.records.find(r => r.caseId === "11-shipbuilding" && r.phase === "question_b" && r.arm === "correlated");
  const example = ship?.events.find(event => event.kind === "lmstudio" && event.request.body.messages.some(message => {
    const p = message.role === "user" ? parse(message.content) : null;
    return p?.observed_answer_candidates?.some(c => c.answer_entity === "Neptun Werft");
  }));
  assert(example, "Missing real observed-answer example");
  const examplePrompt = parse(example.request.body.messages.filter(m => m.role === "user").at(-1).content);
  const exampleMessage = example.response?.body?.choices?.[0]?.message;
  add("## A real predefined answer structure", "",
    `This is a labelled excerpt of [${eventIds.get(example)}](#exchange-${eventIds.get(example).toLowerCase()}); the full HTTP request and raw response appear in the shipbuilding stage. Every value below comes from that recorded request/response, not an expected answer supplied by the evaluator.`, "",
    json({ schema_id: examplePrompt.schema_id, question: examplePrompt.question,
      requested_aspect: examplePrompt.requested_aspect, evidence: examplePrompt.evidence,
      observed_answer_candidates: examplePrompt.observed_answer_candidates,
      response_templates: examplePrompt.response_templates,
      active_answer_enum: examplePrompt.response_schema.properties.answer_entity.enum,
      active_evidence_enum: examplePrompt.response_schema.properties.evidence_ids.items.enum,
      response_format_type: example.request.body.response_format.type,
      parsed_model_response: parse(exampleMessage?.content || exampleMessage?.reasoning_content || "") }),
    "The endpoint and citations are concrete because Cheetah has already returned the quoted edge. Query and decline alternatives remain available; a source-backed intermediate node does not automatically answer a multi-hop question.", "");

  function dictionary(record) {
    const groups = record.phase === "learn" ? [{ label: "Learning vocabulary", data: record.result?.correlations }]
      : record.result?.results ? record.result.results.map(r => ({ label: `Query vocabulary: ${r.concept.aspect}`, data: r.recalled.correlations }))
        : [{ label: "Query vocabulary", data: record.result?.correlations ?? record.result }];
    for (const { label, data } of groups) {
      if (!data?.lexicalLookups?.length) continue;
      counts.dictionaryLookups += data.lexicalLookups.length;
      add("<details>", `<summary>${cell(label)} — ${data.lexicalLookups.length} recorded local WordNet lookups</summary>`, "",
        "No LM request generated these synonyms/translations/derivations. Empty results are retained.", "",
        json({ seeds: data.seeds, lookups: data.lexicalLookups }), "</details>", "");
    }
  }

  function exchanges(record) {
    add("<details>", `<summary>Every LM Studio/Cheetah request and response — ${record.events.length} exchanges</summary>`, "");
    for (const event of record.events) {
      const id = eventIds.get(event);
      assert(!emitted.has(id), `Duplicate exchange ${id}`); emitted.add(id);
      add(`<a id="exchange-${id.toLowerCase()}"></a>`, `#### Exchange ${id}: ${event.kind}`, "",
        `Recorded: ${localTime(event.at)}. UTC: \`${event.at ?? "not recorded"}\`.`, "");
      if (event.kind === "lmstudio") {
        counts.lmstudio++;
        add("LM Studio request — decoded JSON presentation:", "", json(requestView(event)),
          "Recorded LM Studio response — raw content/reasoning and metadata:", "", json(event.response ?? { error: event.error ?? "No response recorded" }));
        const message = event.response?.body?.choices?.[0]?.message;
        add("Tool instrumentation (absence normalized to empty arrays):", "",
          json({ tool_definitions: event.request.body.tools ?? [], tool_calls: message?.tool_calls ?? [] }));
        const parsed = parse(message?.content || message?.reasoning_content || "");
        if (parsed !== null) add("Entire model JSON field, parsed for readability:", "", json(parsed));
      } else if (event.kind === "cheetah") {
        counts.cheetah++;
        add("Canonical Cheetah request:", "", json(event.request));
        const decoded = event.request.commands.map(commandArguments);
        if (decoded.some(args => Object.keys(args).length)) add("Decoded arguments (same command order):", "", json(decoded));
        add("Recorded Cheetah responses — raw lines plus decoded payloads:", "",
          json(event.response?.map(responseView) ?? { error: event.error ?? "No response recorded" }));
      } else {
        assert.equal(event.kind, "cheetah-value", "Unhandled exchange type"); counts.valueWrites++;
        add("Recorded Cheetah value-writer API request:", "", json(event.request),
          "Recorded value-writer receipt:", "", json(event.response ?? { error: event.error ?? "No response recorded" }));
      }
    }
    add("</details>", "");
  }

  function stage(record) {
    assert(!renderedRecords.has(record), "Duplicate stage"); renderedRecords.add(record);
    add(`### ${record.phase} — ${record.arm}`, "",
      `Time: ${localTime(record.startedAt)} → ${localTime(record.finishedAt)}.`, "");
    if (record.question) add(`Question: **${record.question}**`, "");
    add("Recorded outcome (duplicate transport traces are rendered in the exchange block):", "", json(outcome(record)));
    dictionary(record); exchanges(record);
  }

  for (const definition of report.definitions) {
    add(`<a id="case-${definition.id}"></a>`, `## ${definition.id}: ${definition.theme}`, "",
      `WebNLG category: **${definition.category}**. Named entity: **${definition.entity}**.`, "",
      "Source targets supplied during learning (gold RDF was not supplied):", "");
    for (const source of definition.sources) add(`- \`${source.id}\` (training row ${source.index}): ${source.text}`);
    add("", "Original question wording, retained only as study context:", "", `> ${definition.question_a}`, "",
      "The later rephrased request actually tested in this run:", "", `> ${definition.question_b}`, "");
    for (const record of report.records.filter(r => r.caseId === definition.id)) stage(record);
  }
  add('<a id="refusal-controls"></a>', "## Refusal controls", "",
    "These subjects/aspects were not taught. Full rejected/declined paths and model diagnostics remain below.", "");
  for (const record of report.records.filter(r => ["control", "role_control"].includes(r.phase))) stage(record);
  add('<a id="multilingual-exchanges"></a>', "## Multilingual exchanges", "",
    "The six direct lexical recalls use no model. The three subsequent questions use Qwen with the same English source facts. This is a limited multilingual demonstration, not a multilingual WebNLG benchmark.", "");
  for (const record of report.records.filter(r => r.phase.startsWith("multilingual_"))) stage(record);
  assert.equal(renderedRecords.size, report.records.length, "A recorded stage was omitted");
  assert.equal(emitted.size, eventIds.size, "A recorded exchange was omitted");
  add('<a id="rendering-and-coverage-checks"></a>', "## Rendering and coverage checks", "",
    json({ ...counts, rendered_records: renderedRecords.size, rendered_exchanges: emitted.size,
      report_json_stringify_sha256: digest(report), response_schema_mode: "json_schema", vocabulary_model_calls: 0 }),
    "All stages and recorded application-level exchanges in the archived report were emitted once. Schemas in model prompts were checked against response_format before presentation deduplication. Rendering does not call LM Studio, open Cheetah, edit predictions or change evaluation aliases.", "",
    "To reproduce this Markdown directly from the tracked audit:", "", "```sh",
    `node scripts/render-webnlg-exchanges.js --state '${stateArgument.replace(/'/gu, "'\\''")}' --output '${outputArgument.replace(/'/gu, "'\\''")}'`, "```", "");
  return { markdown: `${lines.join("\n").trimEnd()}\n`, counts };
}

export { localTime as formatWebNlgTime };
