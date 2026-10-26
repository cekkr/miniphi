#!/usr/bin/env node
// Derive documentation from recorded outcomes without editing predictions.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const args = Object.fromEntries(process.argv.slice(2).reduce((out, token, i, all) => {
  if (token.startsWith("--")) out.push([token.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]);
  return out;
}, []));
if (!args.state) throw new Error("--state <report.json> is required");
const report = JSON.parse(await fs.readFile(args.state, "utf8"));
assert.equal(report.lexicon?.provider, "wordnet", "Publish the independent WordNet provider, not a model-vocabulary pilot");
assert.equal(report.stopReason, null, "A completed run is required");
assert.equal(report.definitions.length, 20, "Publish all twenty frozen cases");
for (const c of report.definitions) for (const arm of ["baseline", "correlated"]) assert(report.records.some(r => r.phase === "question_b" && r.caseId === c.id && r.arm === arm));
report.scoring = "Predeclared source-answer alias coverage across accepted grounded answers; not entailment or a guarantee that each answer was assigned to the correct atomic question. Both arms use identical factual edges, current runtime and Cheetah engine. Failures remain in the denominator.";
report.pilots = [];
for (const file of String(args.pilots ?? "").split(",").filter(Boolean)) report.pilots.push(JSON.parse(await fs.readFile(file, "utf8")));
const output = path.resolve(args.output ?? "docs/benchmarks/webnlg-correlations-wordnet-2026-10-26.json.gz");
await fs.mkdir(path.dirname(output), { recursive: true });
const raw = `${JSON.stringify(report, null, 2)}\n`;
await fs.writeFile(output, output.endsWith(".gz") ? gzipSync(raw) : raw);
const guideFile = path.resolve(args.guide ?? "docs/cheetah-webnlg-learning.md"), guide = await fs.readFile(guideFile, "utf8");
const rel = path.relative(path.dirname(guideFile), output).split(path.sep).join("/");
const a = report.summary.baseline, b = report.summary.correlated;
const learning = report.records.filter(r => r.phase === "learn");
const nodes = learning.reduce((n, r) => n + (r.result?.correlations?.newCueNodes ?? 0), 0);
const reused = learning.reduce((n, r) => n + (r.result?.correlations?.reusedCueNodes ?? 0), 0);
const empty = learning.filter(r => !r.result?.claims?.length).map(r => r.caseId);
const multilingualRecall = report.records.filter(r => r.phase === "multilingual_recall");
const multilingualAnswers = report.records.filter(r => r.phase === "multilingual_answer");
const jsonCalls = report.records.flatMap(r => r.events).filter(e => e.kind === "lmstudio" && e.request.body?.messages);
const stageSeconds = Object.fromEntries(["baseline", "correlated"].map(arm => [arm,
  Object.fromEntries(["question_b", "withheld"].map(phase => [phase, Number((report.records.filter(r => r.arm === arm && r.phase === phase)
    .reduce((total, r) => total + Date.parse(r.finishedAt) - Date.parse(r.startedAt), 0) / 1000).toFixed(3))])),
]));
assert(jsonCalls.every(e => e.request.body.response_format?.type === "json_schema"), "Every LM request must use schema mode");
assert(jsonCalls.every(e => e.request.body.messages.filter(m => m.role === "user").every(m => {
  try { const p = JSON.parse(m.content); return p.response_schema && p.response_templates; } catch { return false; }
})), "Every user prompt must be a structured JSON contract");
const portable = { provider: report.lexicon, startedAt: report.startedAt, finishedAt: report.finishedAt,
  reusedLearning: report.reusedLearning ?? null,
  summary: report.summary, learning: { ...report.learning, emptySourceCases: empty, newCueNodes: nodes, reusedCueNodes: reused },
  modelCalls: jsonCalls.length, vocabularyModelCalls: 0, rawReportSha256: createHash("sha256").update(raw).digest("hex"),
  recordedStageSeconds: stageSeconds,
  cases: report.definitions.map(c => ({ id: c.id, question: c.question_b, source: c.sources.map(s => s.text),
    claims: learning.find(r => r.caseId === c.id)?.result?.claims,
    arms: Object.fromEntries(["baseline", "correlated"].map(arm => { const r = report.records.find(r => r.caseId === c.id && r.arm === arm && r.phase === "question_b");
      return [arm, { score: r.score, results: r.result?.results.map(x => ({ concept: x.concept, answer: x.recalled.answer, grounded: x.recalled.grounded,
        evidenceIds: x.recalled.evidenceIds, evidence: x.recalled.evidence, modelConfidence: x.recalled.modelConfidence, stopReason: x.recalled.stopReason })) }]; })),
  })), multilingual: [...multilingualRecall, ...multilingualAnswers].map(r => ({ phase: r.phase, language: r.arm, question: r.question,
    result: r.phase === "multilingual_recall" ? {
      seeds: r.result?.seeds, facts: r.result?.facts?.map(f => ({ ...f.edge.props, relation: f.edge.type, matched_terms: f.matched_terms })),
    } : { answer: r.result?.answer, grounded: r.result?.grounded, evidenceIds: r.result?.evidenceIds,
      evidence: r.result?.evidence, stopReason: r.result?.stopReason },
  })),
};
await fs.writeFile(output.replace(/\.json(?:\.gz)?$/u, ".summary.json"), `${JSON.stringify(portable, null, 2)}\n`);
const cell = value => String(value ?? "").replace(/\|/gu, "\\|").replace(/\n/gu, " ");
const ship = portable.cases.find(c => c.id === "11-shipbuilding");
const shipExample = ship ? ["A concrete change in different-wording retrieval:", "", "```json", JSON.stringify({
  source_sentences: ship.source, later_question: ship.question,
  outcomes: Object.fromEntries(Object.entries(ship.arms).map(([arm, value]) => [arm, value.results.map(x => ({
    aspect: x.concept.aspect, prior_answer: x.concept.prior_answer, prior_self_confidence: x.concept.self_confidence,
    answer: x.answer, grounded: x.grounded,
    cited_facts: x.evidence?.filter(e => x.evidenceIds?.includes(e.id)).map(({ subject, relation, object }) => ({ subject, relation, object })),
  }))])),
}, null, 2), "```", ""] : [];
const continuation = report.reusedLearning ? [
  `This is a retrieval continuation: it copied the completed database from the earlier WordNet run (${report.reusedLearning.startedAt} → ${report.reusedLearning.finishedAt}), retained its learning records and restarted Cheetah. No source was retaught. The active runtime hashes are in this report; original teaching hashes are under reusedLearning.`, "",
  "The [earlier WordNet audit](benchmarks/webnlg-correlations-wordnet-initial-2026-10-26.json.gz) recorded **27/30** ordinary versus **25/30** correlated question-B facets (98 versus 74 calls), and **6/7** versus **5/7** additional vocabulary facets. The final continuation tests concrete observed-answer JSON choices plus removal of lexical mechanics from the model context, on those same saved facts. Both retrieval arms use the updated runtime. This is not a new learning score or a repeated-trial accuracy estimate.", "",
] : [];
const savedData = path.relative(process.cwd(), path.join(path.dirname(path.resolve(args.state)), "data")).split(path.sep).join("/");
const rows = ["<!-- graph-correlation-results:start -->", "### Measured WordNet results", "",
  `Run: ${report.startedAt} → ${report.finishedAt}; exact model \`${report.model}\`, loaded context ${report.loadedContextTokens} tokens.`, "",
  ...continuation,
  "This run taught all twenty sources once, adding WordNet cues without an LM vocabulary call, then restarted Cheetah. Both retrieval arms used identical factual edges and fresh model histories; order alternated by case. Question B and evaluator aliases are unchanged. Four additional vocabulary questions were fixed before inference and excluded from learning. The older 17/30 → 26/30 history and model-vocabulary pilot are separate experiments.", "",
  "| Measurement | Ordinary graph discovery | Correlated context |", "| --- | --- | --- |",
  `| Original rephrased question B | ${a.question_b.matched}/${a.question_b.total} facets; ${a.question_b.complete}/20 complete | ${b.question_b.matched}/${b.question_b.total} facets; ${b.question_b.complete}/20 complete |`,
  `| Four additional vocabulary questions | ${a.withheld.matched}/${a.withheld.total} facets | ${b.withheld.matched}/${b.withheld.total} facets |`,
  `| Model calls for question B | ${a.question_b.modelCalls} | ${b.question_b.modelCalls} |`,
  `| Recorded question-B stage duration | ${stageSeconds.baseline.question_b.toFixed(1)} s | ${stageSeconds.correlated.question_b.toFixed(1)} s |`,
  `| Concepts with recalled factual context, question B | ${a.question_b.correlationHits} | ${b.question_b.correlationHits} |`,
  `| Untaught-subject control declined | ${a.controlsDeclined}/1 | ${b.controlsDeclined}/1 |`,
  `| Unsupported genus control declined | ${a.unsupportedRolesDeclined}/1 | ${b.unsupportedRolesDeclined}/1 |`, "",
  `Learning added ${report.learning.newCueLinks} cue-to-claim links, created ${nodes} cue nodes and reused ${reused} existing cue nodes. Vocabulary generation used **zero model calls**. Learning/correlation stages reporting failure: ${report.learning.failures.length}; sources without any saved claims: ${empty.length}${empty.length ? ` (${empty.join(", ")})` : ""}. Only subsequent exact source-edge reads can support answers.`, "",
  "All twenty rephrased cases:", "", "| Concept | Ordinary | WordNet context |", "| --- | --- | --- |",
  ...portable.cases.map(c => `| ${cell(c.id)} | ${c.arms.baseline.score.matched}/${c.arms.baseline.score.total} | ${c.arms.correlated.score.matched}/${c.arms.correlated.score.total} |`), "",
  ...shipExample,
  "Separate multilingual probes use the previously learned English Almond facts. These are a small lexical/answer demonstration, not a multilingual WebNLG benchmark:", "",
  "| Language / query | Fresh source-edge reads | Model calls |", "| --- | --- | --- |",
  ...multilingualRecall.map(r => `| ${cell(r.arm)}: ${cell(r.question)} | ${cell(r.result?.facts?.map(f => `${f.edge.props.object} [${f.edge.type}]`).join("; ") || "none")} | ${r.events.filter(e => e.kind === "lmstudio" && e.request.body?.messages).length} |`), "",
  ...multilingualAnswers.map(r => `- ${r.arm}: “${r.question}” → **${r.result?.answer ?? r.error}**, grounded=${r.result?.grounded ?? false}.`), "",
  "Coverage checks predeclared answer aliases across accepted answers. It does not establish general accuracy, semantic entailment or correct assignment to every subquestion. Negative controls cover the stated cases, not all possible misleading synonyms.", "",
  `The [full WordNet audit](${rel}) retains every model request/response, Cheetah operation, lexical lookup, pre-check and runtime fingerprint. A [readable JSON summary](${rel.replace(/\.json(?:\.gz)?$/u, ".summary.json")}) keeps the twenty sources, actual decompositions, confidence, answers and quoted evidence. Cheetah revision: \`${report.cheetahRevision}\`. The compressed audit is ordinary UTF-8 JSON after gzip decompression.`, "",
  "Run the same protocol with the model loaded and the current Cheetah binary built:", "", "```sh",
  "node scripts/install-wordnet.js # once, unless already installed",
  "node scripts/benchmark-webnlg-correlations.js --output .miniphi/cheetah/correlations/new-run",
  "node scripts/render-webnlg-correlations.js --state .miniphi/cheetah/correlations/new-run/report.json",
  ...(report.reusedLearning ? ["# Optional: retest a copy of compatible completed data without reteaching", "node scripts/benchmark-webnlg-correlations.js --reuse-state .miniphi/cheetah/correlations/new-run/report.json --output .miniphi/cheetah/correlations/retrieval-followup"] : []),
  "```", "",
  "To reopen this machine's measured WordNet graph, start its saved database in one terminal and ask from another:", "", "```sh",
  `CHEETAH_HEADLESS=1 CHEETAH_LISTEN_ADDR=127.0.0.1:4455 CHEETAH_DATA_DIR="$PWD/${savedData}" thirds/cheetah/cheetah-server`,
  'node src/index.js cheetah-learn graph-ask "Identify the builder of A-Rosa Luna and the engine maker powering A-Rosa Luna." --cheetah-database webnlg_correlations --decompose --correlate --max-rounds 6 --json',
  "```", "", "The saved database is local and is not shipped in Git. The compressed audit and readable summary are portable.", "",
  "<!-- graph-correlation-results:end -->", ""].join("\n");
const marker = /<!-- graph-correlation-results:start -->[\s\S]*?<!-- graph-correlation-results:end -->\n?/;
assert(marker.test(guide) || guide.includes("## What remains unreliable"));
await fs.writeFile(guideFile, marker.test(guide) ? guide.replace(marker, rows) : guide.replace("## What remains unreliable", `${rows}\n## What remains unreliable`));
// Keep the everyday overview synchronized when publishing the default guide.
if (!args.guide || args.readme) {
  const readmeFile = path.resolve(args.readme ?? "README.md");
  const anchor = "shows the pipeline, multilingual examples and measured comparison.\n";
  let readme = await fs.readFile(readmeFile, "utf8");
  assert(readme.includes(anchor), "Missing WordNet README anchor");
  const auditLink = path.relative(path.dirname(readmeFile), output.replace(/\.json(?:\.gz)?$/u, ".summary.json")).split(path.sep).join("/");
  const block = ["", "<!-- wordnet-results:start -->", "Recorded on the same saved graph with twenty rephrased questions:", "",
    "| Retrieval | Source-answer coverage | Model calls |", "| --- | --- | --- |",
    `| Ordinary discovery | ${a.question_b.matched}/${a.question_b.total} facets | ${a.question_b.modelCalls} |`,
    `| WordNet context | ${b.question_b.matched}/${b.question_b.total} facets | ${b.question_b.modelCalls} |`, "",
    `Untaught-subject and unsupported-genus controls declined: ordinary ${a.controlsDeclined + a.unsupportedRolesDeclined}/2; WordNet ${b.controlsDeclined + b.unsupportedRolesDeclined}/2.`,
    "Vocabulary lookup used **zero LM calls**. The guide records separate multilingual",
    "probes and earlier regressions. This cohort measures source-answer coverage, not",
    `general accuracy. [Recorded outcomes](${auditLink}).`, "<!-- wordnet-results:end -->", ""].join("\n");
  readme = readme.replace(/\n<!-- wordnet-results:start -->[\s\S]*?<!-- wordnet-results:end -->\n/u, "");
  await fs.writeFile(readmeFile, readme.replace(anchor, anchor + block));
}
console.log(JSON.stringify({ output, summary: report.summary, learning: report.learning }, null, 2));
