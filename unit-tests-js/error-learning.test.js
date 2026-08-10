import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import ErrorLearner from "../src/libs/error-learning.js";

const lesson = (overrides = {}) =>
  JSON.stringify({
    schema_version: "error-lesson@v1",
    title: "Native SQLite drivers cannot be installed on this host",
    cause:
      "Node 24 headers require a newer C++ standard than better-sqlite3's build sets, and no prebuilt binary covers Node 24.",
    rule: "Use the built-in node:sqlite module; never npm install better-sqlite3 or sqlite3 here.",
    applies_when: "choosing a SQLite driver on a Node 24 host",
    verification: "node -e \"import('node:sqlite')\" exits 0",
    durable: true,
    confidence: "high",
    needs_more_context: false,
    missing_snippets: [],
    ...overrides,
  });

const stubClient = (payload) => {
  const calls = [];
  return {
    calls,
    async createChatCompletion(request) {
      calls.push(request);
      return { choices: [{ message: { content: payload }, finish_reason: "stop" }] };
    },
  };
};

const memoryStub = () => {
  const stored = [];
  return {
    stored,
    async remember(record) {
      stored.push(record);
      return record;
    },
  };
};

test("a failure seen once is not worth a model call; the second time it is", () => {
  const learner = new ErrorLearner({ client: stubClient(lesson()), schemaRegistry: new PromptSchemaRegistry(), model: "m" });
  const first = learner.observe({ kind: "run_cmd", detail: "npm ERR! gyp failed with exit code 1" });
  assert.equal(first.count, 1);
  assert.equal(first.shouldLearn, false);

  // Numbers vary between occurrences of the same failure; the signature must
  // not, or nothing ever counts as a repeat.
  const second = learner.observe({ kind: "run_cmd", detail: "npm ERR! gyp failed with exit code 7" });
  assert.equal(second.count, 2);
  assert.equal(second.shouldLearn, true);
  assert.equal(second.signature, first.signature);
});

test("a durable lesson is written to local memory and to the notes file", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-lessons-"));
  const localMemory = memoryStub();
  const client = stubClient(lesson());
  const learner = new ErrorLearner({
    client,
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
    localMemory,
    baseDir,
  });
  learner.observe({ kind: "run_cmd", detail: "gyp failed" });
  const observation = learner.observe({ kind: "run_cmd", detail: "gyp failed" });
  assert.equal(observation.shouldLearn, true);

  const result = await learner.learn(learner.pending()[0], { mission: "build the app" });
  assert.equal(result.ok, true);
  assert.match(result.lesson.rule, /node:sqlite/);

  assert.equal(localMemory.stored.length, 1);
  assert.match(localMemory.stored[0].text, /node:sqlite/);
  assert.ok(localMemory.stored[0].tags.includes("lesson"));

  const notes = await fs.readFile(path.join(baseDir, "memory", "notes", "lessons.md"), "utf8");
  assert.match(notes, /Native SQLite drivers cannot be installed/);
  assert.match(notes, /\*\*Rule:\*\*/);

  // The mission is part of the prompt: the same error means different things in
  // different tasks.
  assert.match(client.calls[0].messages[1].content, /build the app/);
});

test("a lesson the model judges task-specific is not persisted", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-lessons-"));
  const localMemory = memoryStub();
  const learner = new ErrorLearner({
    client: stubClient(lesson({ durable: false })),
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
    localMemory,
    baseDir,
  });
  // A non-mechanical failure, since edit mechanics never reach the learner.
  learner.observe({ kind: "run_cmd", detail: "gyp failed" });
  learner.observe({ kind: "run_cmd", detail: "gyp failed" });
  const result = await learner.learn(learner.pending()[0]);

  assert.equal(result.ok, true);
  assert.equal(localMemory.stored.length, 0);
  const notesExist = await fs
    .access(path.join(baseDir, "memory", "notes", "lessons.md"))
    .then(() => true)
    .catch(() => false);
  assert.equal(notesExist, false);
});

test("a low-confidence cause triggers one search and re-derives the lesson", async () => {
  const searches = [];
  const responses = [lesson({ confidence: "low", research_query: "node 24 better-sqlite3 prebuilt" }), lesson()];
  let index = 0;
  const learner = new ErrorLearner({
    client: {
      async createChatCompletion() {
        const payload = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return { choices: [{ message: { content: payload } }] };
      },
    },
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
    webResearch: async (query) => {
      searches.push(query);
      return { results: [{ title: "node-gyp and Node 24", snippet: "no prebuilt binaries yet" }] };
    },
  });
  learner.observe({ kind: "run_cmd", detail: "gyp failed" });
  learner.observe({ kind: "run_cmd", detail: "gyp failed" });
  const result = await learner.learn(learner.pending()[0]);

  assert.deepEqual(searches, ["node 24 better-sqlite3 prebuilt"]);
  assert.equal(result.lesson.confidence, "high");
  assert.equal(learner.stats().researched, 1);
});

test("the same failure never produces two lessons, and the budget is bounded", async () => {
  const learner = new ErrorLearner({
    client: stubClient(lesson()),
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
    maxLessons: 1,
  });
  learner.observe({ kind: "a", detail: "one" });
  learner.observe({ kind: "a", detail: "one" });
  learner.observe({ kind: "b", detail: "two" });
  learner.observe({ kind: "b", detail: "two" });

  const [first, second] = learner.pending();
  assert.equal((await learner.learn(first)).ok, true);
  assert.equal((await learner.learn(first)).ok, false, "a learned failure is not re-learned");
  assert.equal((await learner.learn(second)).ok, false, "the lesson budget is enforced");
  assert.equal(learner.stats().lessons, 1);
});

test("MiniPhi's own edit mechanics never become world lessons", () => {
  const learner = new ErrorLearner({
    client: stubClient(lesson()),
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
  });
  // A missed anchor is answered by the repair hint, not by a rule about the
  // world. Asking a model to explain one produced advice about querySelector.
  learner.observe({ kind: "edit:anchor-not-found", detail: "anchor not found in server/server.js" });
  const second = learner.observe({
    kind: "edit:anchor-not-found",
    detail: "anchor not found in server/server.js",
  });
  assert.equal(second.count, 2);
  assert.equal(second.shouldLearn, false);
  assert.deepEqual(learner.pending(), []);

  // A command failure still qualifies.
  learner.observe({ kind: "run_cmd", detail: "gyp failed" });
  const cmd = learner.observe({ kind: "run_cmd", detail: "gyp failed" });
  assert.equal(cmd.shouldLearn, true);
});

test("a lesson with no connection to the failure is discarded", async () => {
  const unrelated = lesson({
    title: "Always check if DOM elements exist before accessing their properties",
    cause: "Scripts assume querySelector returns a node.",
    rule: "Verify a node is not null before touching it.",
  });
  const learner = new ErrorLearner({
    client: stubClient(unrelated),
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
    localMemory: memoryStub(),
  });
  learner.observe({ kind: "run_cmd", detail: "npm ERR! gyp rebuild exited with code 1" });
  learner.observe({ kind: "run_cmd", detail: "npm ERR! gyp rebuild exited with code 1" });

  const result = await learner.learn(learner.pending()[0]);
  assert.equal(result.ok, false);
  assert.match(result.error, /does not describe the observed failure/);
  assert.equal(learner.stats().rejected, 1);
  assert.equal(learner.stats().lessons, 0);
});

test("a lesson that does describe the failure is kept", async () => {
  const learner = new ErrorLearner({
    client: stubClient(lesson()),
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
    localMemory: memoryStub(),
  });
  learner.observe({ kind: "run_cmd", detail: "better-sqlite3 install failed: node-gyp rebuild" });
  learner.observe({ kind: "run_cmd", detail: "better-sqlite3 install failed: node-gyp rebuild" });
  const result = await learner.learn(learner.pending()[0]);
  assert.equal(result.ok, true);
  assert.equal(learner.stats().rejected, 0);
});
