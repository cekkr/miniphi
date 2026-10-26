import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { renderWebNlgExchangeMarkdown } from "../scripts/lib/webnlg-exchange-markdown.js";

const bytes = await fs.readFile(new URL("../docs/benchmarks/webnlg-correlations-wordnet-2026-10-26.json.gz", import.meta.url));
const report = JSON.parse(gunzipSync(bytes).toString("utf8"));
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const events = report.records.flatMap(r => r.events);
function recordedDictionaryLookups(node) {
  if (Array.isArray(node)) return node.flatMap(recordedDictionaryLookups);
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => key === "lexicalLookups" ? value : recordedDictionaryLookups(value));
}

test("current transcript preserves every recorded exchange, active JSON contract and raw response", () => {
  const before = sha(report);
  const { markdown, counts } = renderWebNlgExchangeMarkdown(report);
  assert.equal(sha(report), before, "documentation must not modify predictions or the underlying audit");
  assert.equal(counts.records, report.records.length);
  assert.equal(counts.exchanges, events.length);
  assert.equal(counts.lmstudio, events.filter(e => e.kind === "lmstudio").length);
  assert.equal(counts.cheetah, events.filter(e => e.kind === "cheetah").length);
  assert.equal(counts.valueWrites, events.filter(e => e.kind === "cheetah-value").length);
  const expectedLookups = recordedDictionaryLookups(report);
  assert.equal(counts.dictionaryLookups, expectedLookups.length);
  const ids = [...markdown.matchAll(/<a id="exchange-(e\d+)"><\/a>/gu)].map(m => m[1]);
  assert.equal(ids.length, events.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal([...markdown.matchAll(/<a id="case-[^"]+"><\/a>/gu)].length, 20);
  const objects = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(m => JSON.parse(m[1]));
  const requests = objects.filter(o => o?.body?.messages);
  assert.equal(requests.length, counts.lmstudio);
  for (const request of requests) {
    assert.equal(request.body.response_format.type, "json_schema");
    const user = request.body.messages.filter(m => m.role === "user").at(-1).content;
    assert(user.response_templates.length);
    assert.equal(request.body.response_format.json_schema.schema.sha256, sha(user.response_schema));
  }
  const commands = objects.filter(o => o?.commands).flatMap(o => o.commands);
  const expectedCommands = report.records.flatMap(r => r.events.filter(e => e.kind === "cheetah").flatMap(e => e.request.commands));
  assert.deepEqual(commands.sort(), expectedCommands.sort());
  const raw = objects.filter(o => Array.isArray(o) && o.length && o.every(item => typeof item?.raw === "string")).flatMap(o => o.map(item => item.raw));
  const expectedRaw = report.records.flatMap(r => r.events.filter(e => e.kind === "cheetah").flatMap(e => e.response.map(r => r.raw)));
  assert.deepEqual(raw.sort(), expectedRaw.sort());
  const responses = objects.filter(o => o?.body?.choices);
  const expectedResponses = events.filter(e => e.kind === "lmstudio" && e.response?.body?.choices).map(e => e.response);
  assert.deepEqual(responses.map(sha).sort(), expectedResponses.map(sha).sort());
  const lookups = objects.filter(o => o?.lookups?.length && o.lookups.every(l => typeof l.term === "string" && Array.isArray(l.senses))).flatMap(o => o.lookups);
  assert.deepEqual(lookups.map(sha).sort(), expectedLookups.map(sha).sort());
  assert(markdown.includes('"observed_answer_candidates"'));
  assert(markdown.includes('"wordnet_cue_for"'));
  assert(markdown.includes('"reasoning_content"'));
  assert(markdown.includes('"tool_definitions"'));
  assert(markdown.includes('"famiglia"'));
});

test("transcript publication refuses prompt/transport schema drift", () => {
  const changed = { ...report, records: [...report.records] };
  changed.records[0] = structuredClone(report.records[0]);
  const event = changed.records[0].events.find(e => e.kind === "lmstudio");
  event.request.body.response_format.json_schema.schema.type = "array";
  assert.throws(() => renderWebNlgExchangeMarkdown(changed), /Prompt\/transport schema drift/);
});
