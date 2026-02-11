import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyJsonSchemaValidation,
  validateJsonAgainstSchema,
  validateJsonObjectAgainstSchema,
} from "../src/libs/json-schema-utils.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["helper_script"],
  properties: {
    helper_script: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["language", "code"],
          properties: {
            language: { type: "string", enum: ["node", "python"] },
            code: { type: "string" },
          },
        },
      ],
    },
  },
};

test("validateJsonAgainstSchema accepts helper_script null with oneOf", () => {
  const response = JSON.stringify({ helper_script: null });
  const result = validateJsonAgainstSchema(schema, response);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("validateJsonAgainstSchema rejects helper_script missing required fields", () => {
  const response = JSON.stringify({ helper_script: {} });
  const result = validateJsonAgainstSchema(schema, response);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes("missing required property") || error.includes("no oneOf schema matched"),
    ),
    JSON.stringify(result.errors),
  );
});

test("classifyJsonSchemaValidation reports schema_invalid with parsed object", () => {
  const response = JSON.stringify({ helper_script: {} });
  const validation = validateJsonAgainstSchema(schema, response);
  const outcome = classifyJsonSchemaValidation(validation);

  assert.equal(outcome.status, "schema_invalid");
  assert.equal(typeof outcome.error, "string");
  assert.deepEqual(outcome.parsed, { helper_script: {} });
});

test("validateJsonObjectAgainstSchema reports preamble_detected on prose-prefixed payload", () => {
  const response = `Sure, here is the JSON:\n${JSON.stringify({ helper_script: null })}`;
  const outcome = validateJsonObjectAgainstSchema(schema, response);

  assert.equal(outcome.status, "preamble_detected");
  assert.equal(outcome.error, "non-JSON preamble detected");
  assert.equal(outcome.preambleDetected, true);
});
