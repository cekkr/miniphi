import test from "node:test";
import assert from "node:assert/strict";
import {
  HfDatasetClient,
  clipSnippet,
  guessSubjectFromText,
  fetchDisjointSamples,
} from "../src/libs/hf-dataset-client.js";

function fakeResponse({ ok = true, status = 200, statusText = "OK", body = {} } = {}) {
  return {
    ok,
    status,
    statusText,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("HfDatasetClient.getRows normalizes the datasets-server /rows shape", async () => {
  const calls = [];
  const client = new HfDatasetClient({
    dataset: "rahular/simple-wikipedia",
    async fetchImpl(url) {
      calls.push(url);
      return fakeResponse({
        body: {
          rows: [
            { row_idx: 0, row: { text: "Paris is the capital of France." }, truncated_cells: [] },
            { row_idx: 1, row: { text: "A long article..." }, truncated_cells: ["text"] },
          ],
          num_rows_total: 769764,
        },
      });
    },
  });

  const { rows, numRowsTotal } = await client.getRows({ offset: 5, length: 2 });
  assert.equal(numRowsTotal, 769764);
  assert.deepEqual(rows, [
    { rowIdx: 0, text: "Paris is the capital of France.", truncated: false },
    { rowIdx: 1, text: "A long article...", truncated: true },
  ]);
  assert.match(calls[0], /offset=5/);
  assert.match(calls[0], /length=2/);
  assert.match(calls[0], /dataset=rahular%2Fsimple-wikipedia/);
});

test("HfDatasetClient surfaces non-ok HTTP responses as errors", async () => {
  const client = new HfDatasetClient({
    async fetchImpl() {
      return fakeResponse({ ok: false, status: 404, statusText: "Not Found", body: { error: "no such dataset" } });
    },
  });
  await assert.rejects(() => client.getRows({ offset: 0, length: 1 }), /404/);
});

test("clipSnippet keeps only the first sentences and caps length", () => {
  const text =
    "Springfield is a city in Illinois. It has a large population. It is also home to a museum. Extra trailing detail that should never be reached.";
  const clipped = clipSnippet(text, { maxSentences: 2, maxChars: 1000 });
  assert.equal(clipped, "Springfield is a city in Illinois. It has a large population.");

  const longSentence = `Springfield is a city that ${"x".repeat(500)}.`;
  const cappedClip = clipSnippet(longSentence, { maxSentences: 1, maxChars: 40 });
  assert.ok(cappedClip.length <= 43); // 40 + "..."
  assert.ok(cappedClip.endsWith("..."));
});

test("clipSnippet handles empty/non-string input", () => {
  assert.equal(clipSnippet(""), "");
  assert.equal(clipSnippet(null), "");
  assert.equal(clipSnippet(undefined), "");
});

test("guessSubjectFromText extracts the defining-sentence subject", () => {
  assert.deepEqual(guessSubjectFromText("Albert Einstein was a theoretical physicist."), {
    subject: "Albert Einstein",
    matched: true,
  });
  assert.deepEqual(guessSubjectFromText("The Eiffel Tower is a landmark in Paris."), {
    subject: "Eiffel Tower",
    matched: true,
  });
  assert.equal(guessSubjectFromText("It rained yesterday in the valley."), null);
  assert.equal(guessSubjectFromText(""), null);
});

test("fetchDisjointSamples pulls teach/eval-known/eval-unknown from disjoint offset windows", async () => {
  const requests = [];
  const client = new HfDatasetClient({
    async fetchImpl(url) {
      requests.push(url);
      const isUnknownWindow = /offset=100000/.test(url);
      const rows = isUnknownWindow
        ? [{ row_idx: 100000, row: { text: "Lisbon is the capital of Portugal." }, truncated_cells: [] }]
        : [
            { row_idx: 0, row: { text: "Paris is the capital of France." }, truncated_cells: [] },
            { row_idx: 1, row: { text: "Berlin is the capital of Germany." }, truncated_cells: [] },
          ];
      return fakeResponse({ body: { rows, num_rows_total: 769764 } });
    },
  });

  const { teachRows, evalKnownRows, evalUnknownRows } = await fetchDisjointSamples(client, {
    teachOffset: 0,
    teachLimit: 2,
    evalOffset: 100000,
    evalKnownCount: 1,
    evalUnknownCount: 1,
  });

  assert.equal(teachRows.length, 2);
  assert.equal(evalKnownRows.length, 1);
  assert.equal(evalKnownRows[0].rowIdx, teachRows[0].rowIdx, "known-eval reuses a taught row, no extra fetch");
  assert.equal(evalUnknownRows.length, 1);
  assert.equal(evalUnknownRows[0].rowIdx, 100000);
  assert.notEqual(evalUnknownRows[0].rowIdx, teachRows[0].rowIdx);
  assert.equal(requests.length, 2, "exactly one fetch for teach + one for the unknown window");
  assert.ok(teachRows[0].subjectHint?.subject);
  assert.ok(evalUnknownRows[0].subjectHint?.subject);
});
