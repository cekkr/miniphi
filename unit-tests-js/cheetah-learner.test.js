import test from "node:test";
import assert from "node:assert/strict";
import { teachFromText, recallAnswer } from "../src/libs/cheetah-learner.js";

const success = (fields = {}) => ({
  ok: true,
  status: "SUCCESS",
  fields,
  raw: `SUCCESS${Object.entries(fields).map(([k, v]) => `,${k}=${v}`).join("")}`,
});
const failure = (message) => ({ ok: false, status: "ERROR", fields: {}, raw: `ERROR,${message}` });
const payloadField = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

// A minimal LMStudioHandler stand-in: clearHistory()/chatStream() are the
// only two methods cheetah-learner.js actually calls.
function fakeHandler(responseTextOrError) {
  return {
    calls: 0,
    clearHistory() {},
    async chatStream() {
      this.calls += 1;
      if (responseTextOrError instanceof Error) {
        throw responseTextOrError;
      }
      return responseTextOrError;
    },
  };
}

// A permissive fake CheetahTcpClient that answers by command prefix so these
// tests can focus on orchestration logic; the exact protocol strings are
// already pinned by cheetah-knowledge-client.test.js.
function genericCheetahClient({ nodeExists = false, facts = [], props = {} } = {}) {
  const calls = [];
  return {
    calls,
    async execute(commands) {
      const list = Array.isArray(commands) ? commands : [commands];
      const responses = [];
      for (const command of list) {
        calls.push(command);
        if (command.startsWith("INSERT:")) {
          responses.push(success({ key: String(calls.length) }));
        } else if (command.startsWith("PAIR_SET")) {
          responses.push(success({ pair_set: true }));
        } else if (command.startsWith("GRAPH_NODE_GET")) {
          responses.push(nodeExists ? success({ payload: payloadField({ props }) }) : failure("node_not_found"));
        } else if (command.startsWith("GRAPH_NEIGHBOR_TYPES")) {
          responses.push(success({ payload: payloadField(facts.length ? [{ type: "x", count: 1 }] : []) }));
        } else if (command.startsWith("GRAPH_RECALL")) {
          responses.push(success({ payload: payloadField({ associations: facts, seeds: [] }) }));
        } else {
          responses.push(success({}));
        }
      }
      return responses;
    },
  };
}

test("teachFromText writes declared new facts and reports what was recognized as already known", async () => {
  const handler = fakeHandler(
    JSON.stringify({
      schema_version: "v1",
      thinking: "This is new: the state it's in.",
      subject_name: "Springfield",
      subject_type: "place",
      no_new_information: false,
      new_facts: [{ relation: "located_in", object_name: "Illinois", object_type: "place" }],
      known_facts: ["is a city"],
      stop_reason: "completed",
    }),
  );
  const cheetahClient = genericCheetahClient({ nodeExists: false });
  const record = await teachFromText("Springfield is a city in Illinois.", {
    handler,
    cheetahClient,
    schemaRegistry: null,
    sequence: 0,
  });
  assert.equal(record.subjectName, "Springfield");
  assert.equal(record.noNewInformation, false);
  assert.equal(record.newFactsWritten, 1);
  assert.deepEqual(record.knownFactsSkipped, ["is a city"]);
  assert.equal(record.error, null);
  assert.ok(cheetahClient.calls.some((c) => c.startsWith("GRAPH_EDGE_SET_BATCH")));
});

test("teachFromText writes nothing when the model declares no new information", async () => {
  const handler = fakeHandler(
    JSON.stringify({
      thinking: "already know all of this",
      subject_name: "Springfield",
      subject_type: "place",
      no_new_information: true,
      new_facts: [],
      known_facts: ["everything"],
      stop_reason: "completed",
    }),
  );
  const cheetahClient = genericCheetahClient({});
  const record = await teachFromText("Springfield is a city.", {
    handler,
    cheetahClient,
    schemaRegistry: null,
    sequence: 1,
  });
  assert.equal(record.newFactsWritten, 0);
  assert.equal(cheetahClient.calls.some((c) => c.startsWith("GRAPH_EDGE_SET_BATCH")), false);
});

test("teachFromText falls back to writing nothing on invalid model JSON (safe default)", async () => {
  const handler = fakeHandler("not json at all, just prose");
  const cheetahClient = genericCheetahClient({});
  const record = await teachFromText("Some snippet.", {
    handler,
    cheetahClient,
    schemaRegistry: null,
    sequence: 2,
  });
  assert.equal(record.error, "invalid-json");
  assert.equal(record.noNewInformation, true);
  assert.equal(record.newFactsWritten, 0);
});

test("recallAnswer is grounded only when the model grounds AND the adapter's own probe resolved an anchor", async () => {
  const handler = fakeHandler(
    JSON.stringify({
      thinking: "the retrieved fact answers this directly",
      anchor_resolved: true,
      grounded: true,
      answer: "Springfield is in Illinois.",
      confidence: "certain",
      evidence: ["located_in Illinois"],
      open_question: { has_question: false, question_text: "", topic_hint: "" },
      stop_reason: "completed",
    }),
  );
  const cheetahClient = genericCheetahClient({ nodeExists: true, facts: [{ id: "place:illinois" }] });
  const record = await recallAnswer("What do you know about Springfield?", {
    handler,
    cheetahClient,
    schemaRegistry: null,
  });
  assert.equal(record.grounded, true);
  assert.equal(record.openQuestion, null);
});

test("recallAnswer overrides a false grounded claim when the adapter's own probe found no anchor (anti-hallucination rule)", async () => {
  const handler = fakeHandler(
    JSON.stringify({
      thinking: "I believe I know this",
      anchor_resolved: true,
      grounded: true, // model over-claims groundedness
      answer: "Something made up.",
      confidence: "certain",
      evidence: [],
      open_question: { has_question: false, question_text: "", topic_hint: "" },
      stop_reason: "completed",
    }),
  );
  const cheetahClient = genericCheetahClient({ nodeExists: false, facts: [] });
  const record = await recallAnswer("What do you know about Nowhereville?", {
    handler,
    cheetahClient,
    schemaRegistry: null,
  });
  assert.equal(record.grounded, false);
  assert.equal(record.modelClaimedGroundedButAnchorMissing, true);
  assert.ok(record.openQuestion, "an open question must still be recorded despite the model's over-claim");
});

test("recallAnswer records the model's own open-question text/topic hint when it supplies one", async () => {
  const handler = fakeHandler(
    JSON.stringify({
      thinking: "no facts were given for this",
      anchor_resolved: false,
      grounded: false,
      answer: "I don't know.",
      confidence: "unknown",
      evidence: [],
      open_question: { has_question: true, question_text: "Who leads Elbonia?", topic_hint: "Elbonia" },
      stop_reason: "completed",
    }),
  );
  const cheetahClient = genericCheetahClient({ nodeExists: false, facts: [] });
  const record = await recallAnswer("Who leads Elbonia?", { handler, cheetahClient, schemaRegistry: null });
  assert.equal(record.grounded, false);
  assert.equal(record.openQuestion.questionText, "Who leads Elbonia?");
  assert.equal(record.openQuestion.topicHint, "Elbonia");
});

test("recallAnswer falls back to a safe decline + recorded open question when the model call throws", async () => {
  const handler = fakeHandler(new Error("LM Studio unreachable"));
  const cheetahClient = genericCheetahClient({ nodeExists: false, facts: [] });
  const record = await recallAnswer("What is the capital of Ruritania?", {
    handler,
    cheetahClient,
    schemaRegistry: null,
  });
  assert.equal(record.grounded, false);
  assert.equal(record.error, "LM Studio unreachable");
  assert.ok(record.openQuestion);
  assert.equal(record.openQuestion.questionText, "What is the capital of Ruritania?");
});
