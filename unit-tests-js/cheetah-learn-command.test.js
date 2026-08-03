import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import CheetahRunReport from "../src/libs/cheetah-run-report.js";
import {
  buildCheetahClient,
  printTeachResult,
  printRecallResult,
  runTeach,
  runAsk,
  runQuestions,
} from "../src/commands/cheetah-learn.js";

const success = (fields = {}) => ({
  ok: true,
  status: "SUCCESS",
  fields,
  raw: `SUCCESS${Object.entries(fields).map(([k, v]) => `,${k}=${v}`).join("")}`,
});
const payloadField = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

// Fake LMStudioRestClient: only `createChatCompletion` is exercised by
// LMStudioHandler's REST path, matching the fixture style already used in
// agent-session.test.js's scriptedClient.
function scriptedRestClient(turns) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async createChatCompletion({ messages }) {
      calls.push(messages);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      const content = typeof turn === "string" ? turn : JSON.stringify(turn);
      return { choices: [{ message: { content } }] };
    },
  };
}

// Permissive fake CheetahTcpClient answering by command prefix - the exact
// protocol strings are already pinned by cheetah-knowledge-client.test.js.
function genericCheetahClient({ nodeExists = false, facts = [], references = [] } = {}) {
  const calls = [];
  return {
    calls,
    async putValue(key, payload) {
      calls.push(`PUT_VALUE ${key} ${payload}`);
      return calls.length;
    },
    async execute(commands) {
      const list = Array.isArray(commands) ? commands : [commands];
      const responses = [];
      for (const command of list) {
        calls.push(command);
        if (command.startsWith("GRAPH_NODE_GET")) {
          responses.push(
            nodeExists
              ? success({ payload: payloadField({ props: {}, references }) })
              : { ok: false, raw: "ERROR,node_not_found" },
          );
        } else if (command.startsWith("GRAPH_NEIGHBOR_TYPES")) {
          responses.push(success({ payload: payloadField(facts.length ? [{ type: "x", count: 1 }] : []) }));
        } else if (command.startsWith("GRAPH_RECALL")) {
          responses.push(success({ payload: payloadField({ associations: facts, seeds: [] }) }));
        } else if (command.startsWith("GRAPH_NEIGHBORS")) {
          responses.push(success({ next_cursor: "*", payload: payloadField([]) }));
        } else {
          responses.push(success({}));
        }
      }
      return responses;
    },
  };
}

function captureConsoleLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

test("buildCheetahClient resolves host/port/database/timeout from options with sensible defaults", () => {
  const defaults = buildCheetahClient({});
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 4455);
  assert.equal(defaults.database, "miniphi_knowledge");

  const overridden = buildCheetahClient({
    "cheetah-host": "10.0.0.9",
    "cheetah-port": "5000",
    "cheetah-database": "custom_db",
    "cheetah-timeout-ms": "9000",
  });
  assert.equal(overridden.host, "10.0.0.9");
  assert.equal(overridden.port, 5000);
  assert.equal(overridden.database, "custom_db");
  assert.equal(overridden.timeoutMs, 9000);
});

test("printTeachResult/printRecallResult print human-readable summaries and honor --json suppression", () => {
  const capture = captureConsoleLog();
  try {
    printTeachResult(
      {
        subjectName: "Springfield",
        subjectType: "place",
        noNewInformation: false,
        newFactsWritten: 2,
        thinking: "saving new facts",
        knownFactsSkipped: ["is a city"],
        error: null,
      },
      { emitJson: false },
    );
    assert.ok(capture.lines.some((line) => line.includes("Springfield (place)")));
    assert.ok(capture.lines.some((line) => line.includes("saving new facts")));
    assert.ok(capture.lines.some((line) => line.includes("is a city")));

    capture.lines.length = 0;
    printTeachResult({ subjectName: "X", subjectType: "y" }, { emitJson: true });
    assert.equal(capture.lines.length, 0, "emitJson suppresses human-readable printing");

    capture.lines.length = 0;
    printRecallResult(
      {
        question: "What do you know about Springfield?",
        answer: "It is in Illinois.",
        grounded: true,
        confidence: "certain",
        modelClaimedGroundedButAnchorMissing: false,
        openQuestion: null,
      },
      { emitJson: false },
    );
    assert.ok(capture.lines.some((line) => line.includes("What do you know about Springfield?")));
    assert.ok(capture.lines.some((line) => line.includes("grounded=true")));
  } finally {
    capture.restore();
  }
});

test("runTeach --text teaches an ad-hoc snippet without touching the HF dataset client", async () => {
  const restClient = scriptedRestClient([
    {
      schema_version: "v1",
      subject_name: "Springfield",
      subject_type: "place",
      subject_context: "located in Illinois",
      context_tags: [],
      no_new_information: false,
      new_facts: [
        {
          relation: "located_in",
          object_name: "Illinois",
          object_type: "place",
          context: "the state the city sits in",
          evidence_quote: "Springfield is located in Illinois",
        },
      ],
      stop_reason: "completed",
    },
  ]);
  const cheetahClient = genericCheetahClient({});
  const capture = captureConsoleLog();
  try {
    const { results } = await runTeach({
      options: { text: "Springfield is located in Illinois." },
      restClient,
      cheetahClient,
      schemaRegistry: new PromptSchemaRegistry(),
      modelKey: "qwen2.5-coder-0.5b-instruct",
      verbose: false,
      emitJson: false,
      noSave: true,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].subjectName, "Springfield");
    assert.equal(results[0].newFactsWritten, 1);
    assert.ok(cheetahClient.calls.some((c) => c.startsWith("GRAPH_EDGE_SET_BATCH")));
  } finally {
    capture.restore();
  }
});

test("runAsk answers a single question and honors --no-save (skips the run report)", async () => {
  const restClient = scriptedRestClient([
    {
      schema_version: "v1",
      reasoning_steps: ["e1 states where Springfield is"],
      grounded: true,
      answer: "Springfield is in Illinois.",
      confidence: "certain",
      used_evidence_ids: ["e1"],
      evidence: ["located_in Illinois"],
      needs_more_context: false,
      follow_up_lookups: [],
      open_question: { has_question: false, question_text: "", topic_hint: "" },
      stop_reason: "completed",
    },
  ]);
  const reference = {
    id: "src-1",
    text: "Springfield is located in Illinois.",
    source: "test",
  };
  const cheetahClient = genericCheetahClient({
    nodeExists: true,
    facts: [{ id: "place:illinois", references: [reference] }],
  });
  const capture = captureConsoleLog();
  try {
    const { result } = await runAsk({
      options: {},
      positionals: ["ask", "What", "do", "you", "know", "about", "Springfield?"],
      restClient,
      cheetahClient,
      schemaRegistry: new PromptSchemaRegistry(),
      modelKey: "qwen2.5-coder-0.5b-instruct",
      emitJson: false,
      noSave: true,
    });
    assert.equal(result.grounded, true);
    assert.equal(result.question, "What do you know about Springfield?");
  } finally {
    capture.restore();
  }
});

test("runAsk throws a clear error when no question is supplied", async () => {
  const cheetahClient = genericCheetahClient({});
  await assert.rejects(
    () =>
      runAsk({
        options: {},
        positionals: ["ask"],
        restClient: scriptedRestClient(["{}"]),
        cheetahClient,
        schemaRegistry: new PromptSchemaRegistry(),
        modelKey: "qwen2.5-coder-0.5b-instruct",
        emitJson: true,
        noSave: true,
      }),
    /expects a question/,
  );
});

test("runQuestions lists open questions without any LM Studio call", async () => {
  const cheetahClient = {
    calls: [],
    async execute(commands) {
      this.calls.push(...(Array.isArray(commands) ? commands : [commands]));
      return [
        success({
          next_cursor: "*",
          payload: payloadField([{ to: "hypothesis:a", props: { question: "A?", status: "open" } }]),
        }),
      ];
    },
  };
  const capture = captureConsoleLog();
  try {
    const result = await runQuestions({ options: { status: "open" }, cheetahClient, emitJson: false });
    assert.equal(result.count, 1);
    assert.equal(result.items[0].question, "A?");
    assert.ok(capture.lines.some((line) => line.includes("A?")));
  } finally {
    capture.restore();
  }
});

test("runTeach persists a run report unless --no-save is set", async () => {
  const scriptedTurn = {
    schema_version: "v1",
    thinking: "already known",
    subject_name: "X",
    subject_type: "other",
    no_new_information: true,
    new_facts: [],
    known_facts: [],
    stop_reason: "completed",
  };
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cheetah-learn-command-"));
  try {
    const savedReport = new CheetahRunReport(path.join(workspaceRoot, "saved", ".miniphi"));
    await runTeach({
      options: { text: "Some snippet." },
      restClient: scriptedRestClient([scriptedTurn]),
      cheetahClient: genericCheetahClient({}),
      schemaRegistry: new PromptSchemaRegistry(),
      modelKey: "qwen2.5-coder-0.5b-instruct",
      verbose: false,
      emitJson: false,
      noSave: false,
      runReport: savedReport,
    });
    const savedRuns = await savedReport.listRuns();
    assert.equal(savedRuns.length, 1);
    assert.equal(savedRuns[0].mode, "teach");

    const skippedReport = new CheetahRunReport(path.join(workspaceRoot, "skipped", ".miniphi"));
    await runTeach({
      options: { text: "Some snippet." },
      restClient: scriptedRestClient([scriptedTurn]),
      cheetahClient: genericCheetahClient({}),
      schemaRegistry: new PromptSchemaRegistry(),
      modelKey: "qwen2.5-coder-0.5b-instruct",
      verbose: false,
      emitJson: false,
      noSave: true,
      runReport: skippedReport,
    });
    await assert.rejects(
      () => fs.access(path.join(workspaceRoot, "skipped", ".miniphi", "cheetah")),
      "no report directory should be created when --no-save is set",
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
