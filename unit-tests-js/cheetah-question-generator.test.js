import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQuestionsForArticle,
  buildControlQuestion,
  selectBenchmarkQuestions,
  scoreAnswer,
} from "../src/libs/cheetah-question-generator.js";

const STADIUM = {
  title: "HaMoshava Stadium",
  subjectId: "topic:hamoshava_stadium",
  subjectType: "place",
  passages: [
    {
      text: "The HaMoshava Stadium is a football stadium in Petah Tikva, Israel. The stadium was completed in 2011.",
    },
  ],
};

test("buildQuestionsForArticle derives questions whose gold answers come from the source", () => {
  const questions = buildQuestionsForArticle(STADIUM);
  const byKind = Object.fromEntries(questions.map((question) => [question.kind, question]));
  assert.equal(byKind.year.goldAnswer, "2011");
  assert.equal(byKind.location.goldAnswer, "Petah Tikva, Israel");
  assert.ok(byKind.definition.goldAnswer.startsWith("football stadium"));
  assert.ok(questions.every((question) => question.expect === "answerable"));
});

test("buildQuestionsForArticle keeps an abbreviation inside the gold answer", () => {
  const questions = buildQuestionsForArticle({
    title: "Philpott Lake",
    subjectType: "place",
    passages: [{ text: "Philpott Lake is a reservoir in the U.S. state of Virginia, impounded by a dam." }],
  });
  const definition = questions.find((question) => question.kind === "definition");
  assert.equal(definition.goldAnswer, "reservoir in the U.S. state of Virginia");
});

test("buildQuestionsForArticle does not attribute a later sentence's agent to the subject", () => {
  const questions = buildQuestionsForArticle({
    title: "Marc Fein",
    subjectType: "person",
    passages: [
      {
        text: "Marc Fein is a sports journalist and studio host. He hosts a show. The show was created by Ernie Johnson.",
      },
    ],
  });
  assert.equal(
    questions.some((question) => question.kind === "agent"),
    false,
    "the creator of a different subject must not become the creator of this one",
  );
});

test("buildQuestionsForArticle drops a question whose gold answer is only the subject's own name", () => {
  const questions = buildQuestionsForArticle({
    title: "Alpha Alpha",
    subjectType: "other",
    passages: [{ text: "Alpha Alpha is the Alpha Alpha of Alpha." }],
  });
  assert.equal(
    questions.some((question) => question.kind === "definition"),
    false,
  );
});

test("selectBenchmarkQuestions spreads kinds and caps the easy broad question", () => {
  const articles = Array.from({ length: 20 }, (unused, index) =>
    buildQuestionsForArticle({
      ...STADIUM,
      title: `Stadium ${index}`,
      passages: [
        {
          text: `Stadium ${index} is a football stadium in Petah Tikva, Israel. The stadium was completed in 20${String(index).padStart(2, "0")}.`,
        },
      ],
    }),
  );
  const selected = selectBenchmarkQuestions(articles, { total: 20, maxBroadShare: 0.3 });
  assert.equal(selected.length, 20);
  const broad = selected.filter((question) => question.kind === "broad").length;
  assert.ok(broad <= 6, `broad questions should stay capped, got ${broad}`);
  assert.ok(new Set(selected.map((question) => question.kind)).size >= 3);
});

test("scoreAnswer requires the gold token for a year question and gold coverage otherwise", () => {
  const year = { kind: "year", goldAnswer: "2011", goldSentence: "The stadium was completed in 2011." };
  assert.equal(scoreAnswer("It was completed in 2011.", year).correct, true);
  assert.equal(scoreAnswer("It was completed in 1998.", year).correct, false);

  const location = {
    kind: "location",
    goldAnswer: "Petah Tikva, Israel",
    goldSentence: "The HaMoshava Stadium is a football stadium in Petah Tikva, Israel.",
  };
  assert.equal(scoreAnswer("It is in Petah Tikva, Israel.", location).correct, true);
  assert.equal(scoreAnswer("It is in Tokyo, Japan.", location).correct, false);
});

test("scoreAnswer reports an abstention rather than scoring it as a wrong answer", () => {
  const result = scoreAnswer("I don't know.", { kind: "location", goldAnswer: "Petah Tikva" });
  assert.equal(result.abstained, true);
  assert.equal(result.correct, false);
});

test("buildControlQuestion expects a decline for a never-taught subject", () => {
  const control = buildControlQuestion({ title: "Nowhereville Institute" });
  assert.equal(control.expect, "decline");
  assert.equal(control.goldAnswer, null);
  assert.match(control.question, /Nowhereville Institute/);
});
