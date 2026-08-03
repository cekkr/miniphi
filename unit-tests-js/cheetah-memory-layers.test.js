import test from "node:test";
import assert from "node:assert/strict";
import {
  segmentArticle,
  extractContextTags,
  extractMentionCandidates,
  questionCues,
  selectAnswerSpan,
  evidenceSupportRatio,
  contentOverlapRatio,
} from "../src/libs/cheetah-memory-layers.js";

const STADIUM = [
  "The HaMoshava Stadium, also known as Petah Tikva Stadium, is a football stadium in Petah Tikva, Israel.",
  "It was completed in 2011, and is used mainly for football matches and is home to both Hapoel Petah Tikva and Maccabi Petah Tikva.",
  "==Facilities== The western stand holds the main entrance and the press area.",
  "==External links== * Official site * Stadium database entry",
].join(" ");

test("segmentArticle splits an article into an ordered gist plus detail passages", () => {
  const passages = segmentArticle(STADIUM, { maxSegments: 6, maxChars: 200 });
  assert.ok(passages.length >= 2, "expected a gist and at least one detail passage");
  assert.equal(passages[0].layer, "gist");
  assert.equal(passages[0].section, "lead");
  assert.ok(passages[0].text.startsWith("The HaMoshava Stadium"));
  assert.ok(passages.some((passage) => passage.section === "Facilities"));
});

test("segmentArticle drops navigation sections so link lists never become memory", () => {
  const passages = segmentArticle(STADIUM);
  assert.equal(
    passages.some((passage) => /external links/i.test(passage.section)),
    false,
  );
  assert.equal(
    passages.some((passage) => passage.text.includes("Official site")),
    false,
  );
});

test("extractContextTags recovers the shared category from a definition and a title parenthetical", () => {
  const tags = extractContextTags("HaMoshava Stadium", STADIUM);
  assert.ok(tags.includes("football stadium"), `expected a category tag, got ${JSON.stringify(tags)}`);
  const highway = extractContextTags(
    "M-137 (Michigan highway)",
    "M-137 was a state trunkline highway in the US state of Michigan.",
  );
  assert.ok(highway.includes("Michigan highway"));
});

test("extractMentionCandidates keeps real names and drops sentence-initial ordinary words", () => {
  const mentions = extractMentionCandidates(STADIUM, { subject: "HaMoshava Stadium" });
  const names = mentions.map((mention) => mention.name);
  assert.ok(names.some((name) => name.includes("Petah Tikva")));
  assert.equal(
    names.some((name) => ["It", "The", "Israel."].includes(name)),
    false,
  );
  assert.ok(mentions.some((mention) => mention.type === "year" && mention.name === "2011"));
});

test("extractMentionCandidates never lets a name cross a sentence boundary or trail a connector", () => {
  // All three surfaces were real entity nodes in the 2026-08-03 benchmark run.
  const mentions = extractMentionCandidates(
    "It lived in Asia. It walked on two legs, along with Psittacosaurus in Mongolia. " +
      "The U.S. Army Corps of Engineers surveyed it. Bank of England funded the dig.",
    { subject: "Microceratus" },
  );
  const names = mentions.map((mention) => mention.name);
  assert.equal(names.includes("Asia. It"), false, "a name must not span a sentence boundary");
  assert.equal(names.includes("Mongolia the"), false, "a name must not end on a connector word");
  assert.equal(
    names.some((name) => /^(?:The|In|It)\b/.test(name)),
    false,
    "a leading grammatical word must not become part of the entity id",
  );
  assert.ok(names.includes("Bank of England"), "a genuine multi-word name keeps its connector");
});

test("questionCues separates the asked-for shape from the subject", () => {
  const cues = questionCues("When was HaMoshava Stadium completed?");
  assert.equal(cues.type, "when");
  assert.equal(cues.isBroad, false);
  assert.ok(cues.tokens.includes("completed"));
  assert.ok(cues.phrases.some((phrase) => phrase.includes("HaMoshava Stadium")));
  assert.equal(questionCues("What do you know about Alphyn?").isBroad, true);
});

test("selectAnswerSpan returns the sentence that answers a specific question", () => {
  const passages = segmentArticle(STADIUM).map((passage, index) => ({
    ...passage,
    id: `e${index + 1}`,
    subject: "HaMoshava Stadium",
  }));
  const cues = questionCues("When was HaMoshava Stadium completed?");
  const span = selectAnswerSpan(passages, cues, {
    focusTokens: ["completed"],
    requireTypeMatch: true,
    minScore: 0.6,
  });
  assert.ok(span, "expected an extractive span");
  assert.ok(span.text.includes("2011"));
});

test("selectAnswerSpan declines when only the subject matches and the asked-for detail is absent", () => {
  const passages = [{ id: "e1", subject: "Alpha", text: "Alpha is located in One." }];
  const cues = questionCues("When was Alpha founded?");
  const span = selectAnswerSpan(passages, cues, {
    focusTokens: ["founded"],
    requireTypeMatch: true,
    minScore: 0.6,
  });
  assert.equal(span, null);
});

test("evidenceSupportRatio measures the answer against its evidence, not the other way round", () => {
  assert.equal(
    evidenceSupportRatio("The stadium was completed in 2011.", [
      "It was completed in 2011, and is home to Hapoel Petah Tikva.",
    ]) >= 0.6,
    true,
  );
  assert.equal(
    evidenceSupportRatio("The stadium hosts the Olympic Games in Tokyo.", [
      "It was completed in 2011, and is home to Hapoel Petah Tikva.",
    ]) >= 0.6,
    false,
  );
});

test("contentOverlapRatio scores a candidate answer against a gold span", () => {
  assert.ok(contentOverlapRatio("Petah Tikva, Israel", "a football stadium in Petah Tikva, Israel") > 0.9);
  assert.ok(contentOverlapRatio("Paris, France", "a football stadium in Petah Tikva, Israel") < 0.2);
});
