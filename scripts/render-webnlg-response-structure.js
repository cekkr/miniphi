#!/usr/bin/env node
// Render measured outcomes only; never edit model predictions or aliases.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, token, i, all) => {
  if (token.startsWith("--")) out.push([token.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]);
  return out;
}, []));
if (!args.state) throw new Error("--state <report.json> is required");
const report = JSON.parse(await fs.readFile(args.state, "utf8"));
report.stabilityDefinition = "Equality of sorted normalized grounded-answer arrays across repeats, retaining duplicate answers; this is not semantic agreement or correctness.";
assert.equal(report.stopReason, null, "Cannot publish an incomplete comparison");
assert(report.summary && report.trials.length === report.repeats * 2);
if (args["followup-state"]) {
  report.followup = JSON.parse(await fs.readFile(args["followup-state"], "utf8"));
  assert.equal(report.followup.stopReason, null, "Cannot publish an incomplete follow-up");
  assert(report.followup.summary?.templates && report.followup.armNames?.length === 1);
}
async function readLiveProof(directory) {
  const results = {};
  for (const name of ["before", "control", "after"]) {
    try { results[name] = JSON.parse(await fs.readFile(path.join(directory, `${name}.json`), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const exchangeDir = path.join(directory, "prompt-exchanges");
  const exchanges = await Promise.all((await fs.readdir(exchangeDir)).filter(name => name.endsWith(".json") && name !== "index.json")
    .map(async name => JSON.parse(await fs.readFile(path.join(exchangeDir, name), "utf8"))));
  return { directory, results, exchanges };
}
if (args["live-dir"]) {
  const proof = await readLiveProof(args["live-dir"]);
  for (const name of ["before", "after"]) {
    assert.equal(proof.results[name]?.answer, "Denmark");
    assert.equal(proof.results[name]?.grounded, true);
    assert.equal(proof.results[name]?.evidenceIds.length, 2);
  }
  assert.equal(proof.results.control?.grounded, false);
  proof.runtimeHashes = Object.fromEntries(await Promise.all(Object.keys(report.runtimeHashes).map(async file => [file, createHash("sha256").update(await fs.readFile(file)).digest("hex")])));
  proof.previousAttempts = await Promise.all(String(args["failed-live-dirs"] ?? "").split(",").filter(Boolean).map(readLiveProof));
  report.liveAcceptance = proof;
}
const output = path.resolve(args.output ?? "docs/benchmarks/webnlg-response-structure-2026-10-26.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
const guideFile = path.resolve(args.guide ?? "docs/cheetah-webnlg-learning.md");
const guide = await fs.readFile(guideFile, "utf8");
const a = report.summary["schema-only"], b = report.summary.templates;
const rel = path.relative(path.dirname(guideFile), output).split(path.sep).join("/");
const followup = report.followup;
const f = followup?.summary.templates;
const repairCount = followup?.trials.flatMap(t => t.records).filter(r => r.phase === "learn" && r.result?.trace?.some(step => {
  try { return JSON.parse(step.prompt).uncovered_source_sentences?.length; } catch { return false; }
})).length;
const writes = followup?.trials.flatMap(t => t.records).filter(r => r.phase === "learn").reduce((n, r) => n + (r.result?.written ?? 0), 0);
const slotCounts = report.trials.filter(t => t.arm === "templates").flatMap(t => t.records).flatMap(r => r.exchanges).flatMap(e => {
  try {
    const p = JSON.parse(e.request.body.messages.filter(m => m.role === "user").at(-1).content);
    return p.schema_id?.startsWith("cheetah-graph-extract") ? [p.response_templates[0].response.facts.length] : [];
  } catch { return []; }
});
const oneItemPrototype = slotCounts.length > 0 && slotCounts.every(n => n === 1);
const block = ["<!-- response-structure-results:start -->", "## Measured response-template comparison", "",
  `A separate controlled run used ${report.definitions.length} frozen concepts (music, population, shipbuilding and botany), ${report.repeats} repeats per arm, both question wordings and fresh graphs restarted after teaching. Arm order alternated between repeats. The baseline kept the same runtime and exact JSON schemas but omitted only the new response templates/instructions. Gold answers stayed outside prompts.`, "",
  "| Measurement | Schema only | With response templates |", "| --- | --- | --- |",
  `| Source-answer facets recovered | ${a.matched}/${a.total} | ${b.matched}/${b.total} |`,
  `| Complete compound/simple questions | ${a.completeQuestions}/${a.questions} | ${b.completeQuestions}/${b.questions} |`,
  `| Schema-valid model responses | ${a.schemaValidResponses}/${a.modelCalls} | ${b.schemaValidResponses}/${b.modelCalls} |`,
  `| Atomic questions needing deterministic repair | ${a.questionRepairs} | ${b.questionRepairs} |`,
  `| Identical normalized answer lists across repeats | ${a.stableAnswerSets}/${a.repeatedQuestionGroups} | ${b.stableAnswerSets}/${b.repeatedQuestionGroups} |`,
  `| Untaught controls declined | ${a.controlsDeclined}/${report.repeats} | ${b.controlsDeclined}/${report.repeats} |`, "",
  "Exact answer-list stability is separate from correctness: consistently wrong answers or declines can be stable, qualified endpoint names can differ while referring to the same source facet, and duplicate answers are retained. This small repeated sample does not establish a general accuracy or reliability gain. Schema-valid JSON was already enforced in the baseline.", "",
  ...(oneItemPrototype ? ["This comparison records the **first one-item extraction-template prototype**. It lost source statements in shipbuilding and botany, so templates alone were worse on this sample. The runtime was then changed to show source-aware extraction slots and request one bounded repair for source sentences missing from accepted quotes. The original comparison is retained above.", ""] : []),
  ...(followup ? [`The subsequent single-arm check repeated ${followup.definitions.map(c => `\`${c.entity}\``).join(" and ")} ${followup.repeats} times, using both question wordings after restart. It wrote **${writes} source-backed edges**, invoked ${repairCount} missing-sentence repairs, and recovered **${f.matched}/${f.total} source-answer facets** (${f.completeQuestions}/${f.questions} complete questions). Model responses were schema-valid in ${f.schemaValidResponses}/${f.modelCalls} calls; ${f.controlsDeclined}/${followup.repeats} untaught controls had no accepted answer. This verifies the revised path on those examples; a single-arm follow-up cannot establish superiority over the baseline.`, ""] : []),
  ...(report.liveAcceptance ? [`A final two-hop acceptance run then passed learning, a two-edge \`Denmark\` answer, untaught-control refusal and the same answer after restart. It uses the final context-narrowed lookup schemas and complete-path citation templates. The audit retains ${report.liveAcceptance.previousAttempts.length} preceding failed acceptance attempts alongside the passing prompt/response records. The intermediate failures exposed stale lookup requests and final-hop-only citations; that regression is closed, while the broader semantic-role problem remains open.`, ""] : []),
  `The [complete comparison audit](${rel}) preserves runtime hashes, sources, both arms' prompts, raw responses and retrieval traces. These results are separate from the earlier twenty-concept cohort.`, "",
  "Run the comparison protocol against the current runtime with the exact model loaded, running model jobs sequentially (the historical hashes remain in the audit):", "", "```sh",
  "node scripts/benchmark-webnlg-response-structure.js --repeats 2 --output .miniphi/cheetah/response-structure/new-run",
  ...(followup ? ["node scripts/benchmark-webnlg-response-structure.js --case-ids 11-shipbuilding,17-botany --arms templates --repeats 2 --output .miniphi/cheetah/response-structure/new-followup",
    "node scripts/render-webnlg-response-structure.js --state .miniphi/cheetah/response-structure/new-run/report.json --followup-state .miniphi/cheetah/response-structure/new-followup/report.json"]
    : ["node scripts/render-webnlg-response-structure.js --state .miniphi/cheetah/response-structure/new-run/report.json"]),
  "```", "<!-- response-structure-results:end -->", ""].join("\n");
const marker = /<!-- response-structure-results:start -->[\s\S]*?<!-- response-structure-results:end -->\n?/;
assert(marker.test(guide) || guide.includes("## What remains unreliable"), "Guide results insertion point missing");
const updated = marker.test(guide) ? guide.replace(marker, block) : guide.replace("## What remains unreliable", `${block}\n## What remains unreliable`);
await fs.writeFile(guideFile, updated);
console.log(JSON.stringify({ output, guideFile, summary: report.summary }, null, 2));
