import test from "node:test";
import assert from "node:assert/strict";
import ContextReferenceComposer from "../src/libs/context-reference-composer.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

const candidates = [
  {
    id: "c2:ref_auth",
    text: "The production deployment token is 5821.",
    sourceNodeId: "c2",
    source: "operator-note",
    score: 0.2,
    distance: 1,
  },
  {
    id: "c3:ref_decoy",
    text: "The staging deployment token is 1734.",
    sourceNodeId: "c3",
    source: "old-log",
    score: 0.9,
    distance: 2,
  },
];

test("the same session model selects grounded sentence ids with strict JSON schema", async () => {
  const calls = [];
  const composer = new ContextReferenceComposer({
    client: {
      async createChatCompletion(request) {
        calls.push(request);
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schema_version: "context-reference-selection@v1",
                  selected_references: ["c2:ref_auth"],
                  needs_more_context: false,
                  missing_snippets: [],
                  stop_reason: "",
                }),
                tool_calls: [],
              },
            },
          ],
        };
      },
    },
    schemaRegistry: new PromptSchemaRegistry(),
    model: "qwen/qwen3-4b-thinking-2507",
  });

  const result = await composer.compose({
    task: "Use the production token.",
    candidates,
    turn: 2,
  });
  assert.equal(calls[0].model, "qwen/qwen3-4b-thinking-2507");
  assert.equal(calls[0].response_format.type, "json_schema");
  assert.equal(calls[0].response_format.json_schema.name, "context-reference-selection");
  assert.deepEqual(result.selected.map((item) => item.id), ["c2:ref_auth"]);
  assert.match(composer.render(result.selected), /The production deployment token is 5821\./);
  assert.equal(result.audit.attempts[0].response.text.includes("selected_references"), true);
  assert.deepEqual(result.audit.attempts[0].response.tool_calls, []);
  assert.equal(result.audit.attempts[0].request.tool_definitions, null);
});

test("invalid narrative reference selection retries then emits deterministic JSON", async () => {
  let requests = 0;
  const composer = new ContextReferenceComposer({
    client: {
      async createChatCompletion() {
        requests += 1;
        return { choices: [{ message: { content: "Use the first sentence." } }] };
      },
    },
    schemaRegistry: new PromptSchemaRegistry(),
    model: "fixture",
    maxSelected: 1,
  });
  const result = await composer.compose({ task: "Use the production token.", candidates });

  assert.equal(requests, 2);
  assert.equal(result.selected[0].id, "c2:ref_auth");
  assert.match(result.response.stop_reason, /^invalid-response:/);
  assert.equal(result.audit.fallback, result.response.stop_reason);
});
