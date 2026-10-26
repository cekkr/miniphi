#!/usr/bin/env node
// Render recorded observations only. Expected answers never feed inference.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, token, i, all) => {
  if (token.startsWith("--")) out.push([token.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]);
  return out;
}, []));
const stateFile = path.resolve(args.state ?? ".miniphi/cheetah/webnlg-study/cohort-20/study.json");
const output = path.resolve(args.output ?? "docs/webnlg_learning.md");
const jsonOutput = path.resolve(args["json-output"] ?? "docs/benchmarks/webnlg-learning-study-2026-10-26.json");
const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
const cases = Object.values(state.cases);
if (!args["allow-partial"]) assert.equal(cases.length, 20, "Final report requires all twenty cases");
for (const c of cases) for (const phase of ["before", "learn", "retest_a", "retest_b"]) assert(c[phase]?.finishedAt, `Missing ${c.definition.id}/${phase}`);
const normalize = (v) => String(v ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/(?<=\d),(?=\d)/g, "").replace(/(\d)\.0\b/g, "$1").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const match = (answer, aliases) => aliases.some(alias => ` ${normalize(answer)} `.includes(` ${normalize(alias)} `));
const score = (c, phase, prior = false) => {
  const result = c[phase]?.result;
  const answers = prior ? result?.assessment?.concepts?.map(r => r.prior_answer) ?? [] : result?.results?.filter(r => r.recalled.grounded).map(r => r.recalled.answer) ?? [];
  const facets = c.definition.expected_facets.map(f => ({ aspect: f.aspect, matched: answers.some(answer => match(answer, f.answers)) }));
  return { matched: facets.filter(f => f.matched).length, total: facets.length, complete: facets.every(f => f.matched), facets };
};
const repaired = cases.every(c => c.retest_repaired?.finishedAt && c.source_repair?.finishedAt);
const phases = ["before", "learn", "retest_a", "retest_b", ...(repaired ? ["source_repair", "retest_repaired"] : [])];
const summary = cases.map(c => ({ id: c.definition.id, theme: c.definition.theme, prior: score(c, "before", true), before: score(c, "before"), a: score(c, "retest_a"), b: score(c, "retest_b"), ...(repaired ? { repaired: score(c, "retest_repaired") } : {}), written: c.learn.result?.written ?? 0, rejected: c.learn.result?.rejected?.length ?? 0 }));
const total = (phase) => summary.reduce((sum, c) => sum + c[phase].matched, 0);
const facetCount = summary.reduce((sum, c) => sum + c.a.total, 0);
const allEvents = [...cases.flatMap(c => phases.flatMap(p => c[p].events)), ...[state.initialBonus, state.initialControl, state.bonus, state.control].flatMap(r => r?.events ?? [])];
const modelEvents = allEvents.filter(e => e.kind === "lmstudio" && e.request.body?.messages);
const hasResponseTemplates = modelEvents.some(e => e.request.body.messages.some(m => {
  try { return Boolean(JSON.parse(m.content).response_templates); } catch { return false; }
}));
const schemas = new Map();
for (const e of modelEvents) {
  const body = e.request.body;
  for (const m of body.messages) if (m.role === "user") {
    try { const p = JSON.parse(m.content); if (p.schema_id && p.response_schema) schemas.set(p.schema_id, p.response_schema); } catch { /* Preserve malformed/retry prompt text in the transcript. */ }
  }
}
const delays = cases.map(c => (Date.parse(c.retest_a.startedAt) - Date.parse(c.learn.finishedAt)) / 1000);
const metrics = { caseCount: cases.length, categoryCount: new Set(cases.map(c => c.definition.category)).size, expectedFacetCount: facetCount,
  closedBookSourceMatches: total("prior"), beforeMemorySourceMatches: total("before"), retestASourceMatches: total("a"), retestBSourceMatches: total("b"),
  casesCompleteA: summary.filter(c => c.a.complete).length, casesCompleteB: summary.filter(c => c.b.complete).length,
  newClaims: summary.reduce((s, c) => s + c.written, 0), rejectedProposals: summary.reduce((s, c) => s + c.rejected, 0),
  modelCalls: modelEvents.length, graphBatches: allEvents.filter(e => e.kind === "cheetah").length,
  minDelaySeconds: Math.min(...delays), maxDelaySeconds: Math.max(...delays) };
if (repaired) {
  metrics.repairedSourceMatches = total("repaired");
  metrics.casesCompleteRepaired = summary.filter(c => c.repaired.complete).length;
  metrics.repairNewClaims = cases.reduce((sum, c) => sum + (c.source_repair.result?.written ?? 0), 0);
}
const portable = { ...state, metrics, scoring: "Source-answer alias containment after Unicode/case/punctuation/number formatting normalization; answers count only when the adapter marked them grounded. Not entailment, RDF F1, current-world verification or general accuracy.", summary };
await fs.mkdir(path.dirname(jsonOutput), { recursive: true });
await fs.writeFile(jsonOutput, `${JSON.stringify(portable, null, 2)}\n`);
const lines = [];
const add = (...text) => lines.push(...text);
const json = (value) => ["```json", JSON.stringify(value, null, 2), "```", ""].join("\n");
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const rel = (file) => path.relative(path.dirname(output), file).split(path.sep).join("/");
function requestView(event) {
  const body = structuredClone(event.request.body);
  const schema = body.response_format?.json_schema;
  if (schema?.schema) schema.schema = { schema_reference: schema.schema.$id ?? schema.name, see: "Appendix: exact response schemas" };
  body.messages = body.messages.map(m => {
    if (typeof m.content !== "string" || m.role !== "user") return m;
    try {
      const content = JSON.parse(m.content);
      if (content.response_schema) content.response_schema = { schema_reference: content.response_schema.$id ?? content.schema_id, see: "Appendix: exact response schemas" };
      return { ...m, content };
    } catch { return m; }
  });
  return { url: event.request.url, method: event.request.method, body };
}
function decodedArguments(command) {
  const fields = {};
  for (const name of ["props", "items", "references"]) {
    const value = command.match(new RegExp(`(?:^| )${name}=([^ ]+)`))?.[1];
    if (!value || value === "-") continue;
    try { fields[name] = JSON.parse(Buffer.from(value, "base64").toString("utf8")); } catch { /* Raw command is always retained. */ }
  }
  return fields;
}
function exchanges(record) {
  add("<details>", `<summary>Every request and response (${record.events.length} exchanges)</summary>`, "");
  for (const [i, event] of record.events.entries()) {
    add(`#### Exchange ${i + 1}: ${event.kind} — ${event.startedAt}`, "");
    if (event.kind === "lmstudio") add("Request (decoded presentation; exact wire body is in the JSON report):", "", json(requestView(event)));
    else if (event.kind === "cheetah") add("Canonical requests sent through Cheetah's binder:", "", json({ ...event.request, decoded_arguments: event.request.commands.map(decodedArguments) }));
    else add("Binder value-writer request:", "", json(event.request));
    add("Recorded response:", "", json(event.response ?? { error: event.error ?? "No response recorded" }));
    if (event.kind === "lmstudio") {
      const m = event.response?.body?.choices?.[0]?.message;
      try { add("Model JSON, parsed for readability:", "", json(JSON.parse(m?.content || m?.reasoning_content || ""))); } catch { /* Failed JSON remains visible above. */ }
    }
  }
  add("</details>", "");
}
function answerStage(c, phase, label) {
  const record = c[phase], result = record.result;
  add(`### ${label}`, "", `Time: ${record.startedAt} → ${record.finishedAt}.`, "", `Question: **${result?.question ?? c.definition[phase === "retest_b" || phase === "retest_repaired" ? "question_b" : "question_a"]}**`, "");
  if (record.error) add(`Runtime error: ${record.error}`, "");
  add("Structured assessment and retrieval outcome:", "", json({
    concepts: result?.results?.map(r => ({ entity: r.concept.entity, aspect: r.concept.aspect,
      atomic_question: r.concept.question, questionRepair: r.concept.questionRepair ?? null,
      prior_answer: r.concept.prior_answer, prior_self_confidence: r.concept.self_confidence, uncertainty_basis: r.concept.basis,
      memory_gap: r.memoryGap, answer: r.recalled.answer, grounded: r.recalled.grounded,
      retrieved_self_confidence: r.recalled.modelConfidence, reasoning_summary: r.recalled.reasoningSummary,
      evidence_ids: r.recalled.evidenceIds, open_question: r.recalled.openQuestion ?? null, stop_reason: r.recalled.stopReason })),
    needs_learning: result?.needsLearning, source_score: score(c, phase), stop_reason: result?.stopReason ?? record.error ?? null,
  }));
  exchanges(record);
}
add("# WebNLG learning and delayed retrieval with a small language model", "",
  "For selected concepts, a compact worked example and current prompt contracts, read the [practical guide](cheetah-webnlg-learning.md). This file retains the complete recorded exchanges.", "",
  "The later optional [associative-vocabulary workflow](cheetah-webnlg-learning.md#associative-vocabulary-learning) uses independent WordNet/OMW vocabulary to learn retrieval cues and correlate entity/aspect words through Cheetah. Its separate results do not replace the historical measurements in this transcript.", "",
  ...(!hasResponseTemplates ? ["These recorded prompts already included exact JSON schemas, but predate the concrete response templates added to the runtime afterward. The practical guide describes that later change; the historical requests and measurements below are preserved.", ""] : []),
  `Recorded study: **2026-10-26**. Model: **${state.model}**, LM Studio at \`${state.baseUrl}\`, loaded context **${state.loadedContextTokens} tokens**.`, "",
  `This document contains **${cases.length} real subject/aspect examples across ${metrics.categoryCount} WebNLG dataset categories**. There are ${facetCount} predeclared answer facets. The category labels are the dataset's original labels: botanical taxonomy, currency, language distribution and rocket engineering are separate concepts even where WebNLG groups them under Food, Airport, WrittenWork or MeanOfTransportation.`, "",
  "Learning here means writing source-backed claims to Cheetah. Model weights are unchanged. Every model call declares an exact JSON schema and uses `response_format=json_schema`. The small model's confidence, the graph's contents and source-answer scoring are kept separate.", "",
  "## What this experiment establishes", "",
  "1. Ask all questions before any source is taught. Obtain JSON decomposition, prior answers and self-confidence, then probe the empty knowledge namespace.",
  "2. Teach all twenty sources. Split statements into atomic claims, check source support, probe exact edges and store new claims with verbatim episode provenance.",
  "3. Close and restart Cheetah. Use fresh model histories containing only the question, bounded graph evidence and corrective feedback.",
  "4. Ask the original questions, then run the whole cohort again with different wording. Expected answers and RDF gold triples never enter model prompts.", "",
  `Initial study started at ${state.initialStudy?.startedAt ?? state.startedAt} and finished at ${state.initialStudy?.finishedAt ?? state.finishedAt}. ${repaired ? `The explicitly recorded repair continuation ran from ${state.startedAt} to ${state.finishedAt}. ` : ""}Delay from initial teaching to the first retest ranged from ${metrics.minDelaySeconds.toFixed(1)} to ${metrics.maxDelaySeconds.toFixed(1)} seconds; these are measured delays, not a multi-day retention claim.`, "",
  "## Results", "", "| Measurement | Result |", "| --- | --- |",
  `| Prior answers matching the selected sources | ${metrics.closedBookSourceMatches}/${facetCount} facets |`,
  `| Grounded answers before teaching | ${metrics.beforeMemorySourceMatches}/${facetCount} facets |`,
  `| New claims written | ${metrics.newClaims} |`,
  `| Proposals rejected by source checks | ${metrics.rejectedProposals} |`,
  `| Original-question retest after restart | ${metrics.retestASourceMatches}/${facetCount} facets; ${metrics.casesCompleteA}/${cases.length} complete examples |`,
  `| Rephrased-question retest | ${metrics.retestBSourceMatches}/${facetCount} facets; ${metrics.casesCompleteB}/${cases.length} complete examples |`,
  ...(repaired ? [`| Same rephrased cohort after runtime/source repair | ${metrics.repairedSourceMatches}/${facetCount} facets; ${metrics.casesCompleteRepaired}/${cases.length} complete examples |`, `| Additional claims written by repair pass | ${metrics.repairNewClaims} |`] : []),
  `| Actual model calls, including retries | ${metrics.modelCalls} |`, "",
  "Scoring checks predeclared source-answer aliases after case/Unicode/punctuation/number formatting normalization. A retrieval answer counts only if MiniPhi accepted its citations. This is source-answer coverage on a small selected training set. It is not RDF triple F1, entailment, calibrated probability, current-world verification or a broad accuracy benchmark. Some valid real-world alternatives can differ from this dataset's selected sentence.", "",
  `| # | Concept | Prior source matches | Initial claims | Retest A | Rephrased B |${repaired ? " Repaired B |" : ""}`, `| --- | --- | --- | --- | --- | --- |${repaired ? " --- |" : ""}`);
for (const [i, s] of summary.entries()) add(`| ${i + 1} | [${cell(s.theme)}](#example-${i + 1}) | ${s.prior.matched}/${s.prior.total} | ${s.written} | ${s.a.matched}/${s.a.total} | ${s.b.matched}/${s.b.total} |${repaired ? ` ${s.repaired.matched}/${s.repaired.total} |` : ""}`);
if (repaired) {
  add("", "### Remaining failures and control outcomes", "",
    `The repaired cohort still missed ${facetCount - metrics.repairedSourceMatches} facets. The full evidence and failed attempts remain in their example transcripts:`, "",
    "| Concept | Missed source facet | Returned answers (accepted path / stop reason) |", "| --- | --- | --- |");
  for (const s of summary.filter(s => !s.repaired.complete)) {
    const answers = state.cases[s.id].retest_repaired.result?.results?.map(r => `${r.concept.aspect}: ${r.recalled.answer} (${r.recalled.grounded}; ${r.recalled.stopReason ?? "completed"})`).join("; ");
    add(`| ${cell(s.theme)} | ${cell(s.repaired.facets.filter(f => !f.matched).map(f => f.aspect).join(", "))} | ${cell(answers)} |`);
  }
  const missed = (id, aspect) => summary.some(s => s.id === id && s.repaired.facets.some(f => f.aspect === aspect && !f.matched));
  add("");
  if (missed("05-architecture", "location") || missed("12-memorials", "location")) add("The city/country location failures exposed a conservative terminal-role check: `located_in` evidence naming London or England does not explicitly type that endpoint as a city or country.", "");
  if (missed("11-shipbuilding", "builder")) add("In the ship-builder failure, MiniPhi accepted an engine endpoint cited through `powered_by`. Here `grounded: true` means an observed endpoint/path, not that the relation answers the question. Source-answer scoring correctly marks it wrong. This is an unresolved semantic-role validation defect.", "");
  if (missed("17-botany", "order")) add("For botanical order, Rosales evidence was retrieved; the model still declined after a corrupted subquestion was repaired. Retrieval of evidence alone does not ensure a usable answer.", "");
  add(`The additional Ajoblanco ingredient → plant-family query returned **${state.bonus?.result?.answer ?? "no result"}** (grounded=${state.bonus?.result?.grounded ?? false}; stop=${state.bonus?.result?.stopReason ?? "completed"}). ${state.bonus?.result?.grounded ? "Inspect its cited path below." : "This run does not establish successful cross-concept reasoning."} The untaught institute control returned ${state.control?.result?.results?.filter(r => r.recalled.grounded).length ?? 0} grounded answers.`, "");
}
add("", "## How MiniPhi identifies a gap", "",
  "`prior_answer` and `self_confidence` are model self-reports, not introspection guarantees. An empty prior answer is an admission of uncertainty; a confident answer can still be unsupported or disagree with the selected source. The 1/30 prior score describes answers elicited by this diagnostic prompt, not proof that model weights lack the other facts. A zero-result Cheetah probe establishes a memory gap, even when the model recognizes the topic. MiniPhi marks `needsLearning` from missing accepted graph evidence, never from a confidence threshold alone. As the ship-builder failure shows, an accepted path can still answer the wrong semantic role, leaving a false negative in gap detection.", "",
  "Question decomposition returns named entities, requested aspects and atomic questions. Simple or explicitly conjoined questions use bounded one/two-concept schemas to avoid invented extra facets. Malformed subquestions are explicitly repaired using the original question and recorded entity/aspect. Fresh histories keep a prior guess from becoming retrieval evidence.", "",
  "Focused graph requests select stable references such as `focus` and `e1_object`; MiniPhi resolves them to exact observed names. Predicate hints are normalized, then bounded untyped and reverse-adjacency discovery can recover from a wrong predicate spelling or direction. Only observed entities are eligible. The model can request an intermediate endpoint and receives at most bounded evidence, not the original teaching transcript.", "",
  "Atomic claims must pass source-overlap checks before writes; confidence cannot bypass them. Empty or partly rejected extraction gets at most one repair prompt; already accepted claims are preserved. Source-validated entity hints reject role phrases masquerading as subject names. Retrieval can complete a malformed entity from Cheetah's lexical recall, but only to a stored name occurring in the parent question. Redundant or reordered citations can be normalized to a connected path using only the actual cited edges; unknown ids still fail. Explicit country/city/capital/language/leader/currency questions also require role wording in terminal evidence. These gates are conservative lexical checks, not a complete semantic-entailment system.", "",
  "Novelty is an exact subject/relation/object edge probe. Different predicate spellings or qualified endpoint names can still create semantically overlapping edges, so the repair pass's additional writes are not necessarily additional real-world facts. Unanswered atomic questions are saved as open questions; the transcript shows that write alongside the failed lookup. Teaching consumes the supplied source sentences, never the model's prior guess.", "",
  "## How to read the complete transcript", "",
  `The [machine-readable study](${rel(jsonOutput)}) retains exact API request bodies, full HTTP responses, canonical Cheetah commands, decoded graph payloads, value-writer calls, timestamps and outcomes. This Markdown shows every exchange under expandable stage sections. User-message JSON strings are decoded into objects for readability; repeated inline schemas are replaced by references to the exact schemas in the appendix. API authorization headers are not recorded. Cheetah's byte transport is shown as the canonical commands produced by its upstream binder.`, "",
  `Manifest: [the frozen twenty cases](benchmarks/webnlg-study-cases.json). Runtime source fingerprint: \`${state.runtimeSha256}\`. Repository base: \`${state.revision}\`. Original local audit: \`${path.relative(process.cwd(), stateFile)}\`.`, "");
for (const [i, c] of cases.entries()) {
  add(`<a id="example-${i + 1}"></a>`, "", `## ${i + 1}. ${c.definition.theme}`, "",
    `Subject: **${c.definition.entity}**. Dataset category: \`${c.definition.category}\`.`, "",
    "### Source and predeclared evaluation targets", "");
  for (const source of c.definition.sources) add(`- Train index ${source.index}, \`${source.id}\`: ${source.text}`);
  add("", "Gold RDF and answer aliases below are evaluator-only; they are not model context:", "", json({ gold_triples: c.definition.sources.flatMap(s => s.gold_triples), expected_facets: c.definition.expected_facets }));
  answerStage(c, "before", "Before learning: decomposition, confidence and graph probe");
  add("### Learning: source decomposition, novelty checks and writes", "", `Time: ${c.learn.startedAt} → ${c.learn.finishedAt}.`, "",
    json({ source: c.definition.sources.map(s => s.text).join(" "), episode: c.learn.result?.episode, claims: c.learn.result?.claims,
      rejected: c.learn.result?.rejected, written: c.learn.result?.written, known: c.learn.result?.known,
      stop_reason: c.learn.result?.stopReason ?? c.learn.error ?? null }));
  exchanges(c.learn);
  answerStage(c, "retest_a", "Later, after Cheetah restart: original question");
  answerStage(c, "retest_b", "Later again: rephrased request with fresh context");
  if (repaired) {
    add("### Recorded source/identity repair pass", "", `Time: ${c.source_repair.startedAt} → ${c.source_repair.finishedAt}. Same source text and evaluator targets as above.`, "",
      json({ episode: c.source_repair.result?.episode, claims: c.source_repair.result?.claims, rejected: c.source_repair.result?.rejected,
        written: c.source_repair.result?.written, known: c.source_repair.result?.known, stop_reason: c.source_repair.result?.stopReason ?? c.source_repair.error ?? null }));
    exchanges(c.source_repair);
    answerStage(c, "retest_repaired", "Rephrased request after repair and another Cheetah restart");
  }
}
for (const [key, title] of [["initialBonus", "Initial cross-concept query before repairs"], ["initialControl", "Initial untaught control"], ["bonus", "Cross-concept query: soup ingredient → botanical family"], ["control", "Untaught control after the graph is populated"]]) if (state[key]) {
  const { trace, ...result } = state[key].result;
  add(`## ${title}`, "", json(result)); exchanges(state[key]);
}
add("## Runtime improvements exposed by the pilots", "",
  "The initial pilot produced extra concepts, corrupted an airport name and sent a predicate with spaces. Those were runtime defects: fixes live in MiniPhi's runtime, not in benchmark predictions. Bounded cardinality, explicit subquestion repairs, focused entity references, predicate normalization and bounded adjacency discovery were validated before freezing this cohort. Pilot logs remain under `.miniphi/cheetah/webnlg-study/pilot-01`, `pilot-02` and `pilot-03`. The repaired third pilot retrieved runway length, instrument and origin under both question wordings.", "",
  ...(repaired ? ["The complete first cohort then exposed partial-extraction loss, decorated subject anchors, clause-shaped entity names and overly broad citation lists. A separate, explicit continuation re-ingested the same sources with bounded partial repair and identity checks, used Cheetah lexical name completion, normalized valid cited subpaths, restarted Cheetah and retested the same rephrased questions. The original failures above were retained. Source cases and answer aliases were not changed to improve the score.", "", `Initial runtime fingerprint: \`${state.initialStudy.runtimeSha256}\`. Repaired runtime fingerprint: \`${state.runtimeSha256}\`.`, ""] : []),
  "Cheetah required no engine changes for this study. MiniPhi uses the upstream Node binder for every graph command; the server remains responsible for storage, adjacency and persistence. The adapter owns linguistic decomposition, confidence diagnostics and grounding policy.", "",
  "## Reproduce", "", "Run from MiniPhi's root with dependencies installed and the Cheetah submodule initialized/built:", "", "```sh",
  "node src/index.js models --load qwen3-4b-thinking-2507-mlx --context-length 8192",
  "node src/index.js lmstudio-health --timeout 10",
  "node scripts/run-webnlg-learning-study.js --limit 20 --output .miniphi/cheetah/webnlg-study/new-run",
  "node scripts/render-webnlg-learning-study.js --state .miniphi/cheetah/webnlg-study/new-run/study.json",
  "```", "",
  ...(repaired ? ["To reproduce the explicit continuation on a completed study (the original JSON is preserved):", "", "```sh", "node scripts/run-webnlg-learning-study.js --limit 20 --continue-study .miniphi/cheetah/webnlg-study/new-run/study.json --output .miniphi/cheetah/webnlg-study/new-repair-run", "node scripts/render-webnlg-learning-study.js --state .miniphi/cheetah/webnlg-study/new-repair-run/study.json", "```", ""] : []),
  "The runner starts its own isolated Cheetah server, probes every case before learning, restarts it before retrieval and saves progress after every stage/example. Reusing an output directory resumes only when manifest, model, case list and runtime fingerprint match. Without `--continue-study`, a new output directory creates fresh graph data; a continuation reopens the original study's graph. Model calls run sequentially; the default whole-run cap is 60 minutes (`--duration-minutes`, greater than zero and at most 180). Failures remain in the denominator.", "",
  "To reopen this recorded study's local graph, run the server in one terminal (the saved data is local and is not included in Git):", "", "```sh",
  'CHEETAH_HEADLESS=1 CHEETAH_LISTEN_ADDR=127.0.0.1:4455 \\',
  `  CHEETAH_DATA_DIR="$PWD/${path.relative(process.cwd(), state.dataDirectory ?? path.join(path.dirname(state.initialStudy?.path ?? stateFile), "data"))}" \\`,
  "  thirds/cheetah/cheetah-server", "```", "",
  "Then ask a compound question from a second terminal:", "", "```sh",
  "node src/index.js cheetah-learn graph-ask \"What instrument does Aaron Deer play and where does Aaron Deer come from?\" --decompose --max-rounds 6 --cheetah-database webnlg_study --json",
  "```", "",
  "Start Cheetah with the study's saved `data/` directory to reopen its facts; the test server is stopped on exit. `--decompose` exposes closed-book diagnostics and independently grounded answers per concept. These diagnostic prior answers are never written to the graph or presented as accepted knowledge.", "",
  "## Appendix: exact response schemas", "");
for (const [id, schema] of schemas) add(`### ${id}`, "", json(schema));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${lines.join("\n").trimEnd()}\n`);
console.log(JSON.stringify({ output, jsonOutput, metrics }, null, 2));
