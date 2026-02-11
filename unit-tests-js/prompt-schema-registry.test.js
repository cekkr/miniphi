import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

async function withTempSchemaDir(callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-schema-registry-"));
  try {
    const schemaPath = path.join(tempDir, "test-schema.schema.json");
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["answer", "needs_more_context", "missing_snippets"],
      properties: {
        answer: { type: "string" },
        needs_more_context: { type: "boolean" },
        missing_snippets: { type: "array", items: { type: "string" } },
      },
    };
    await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");
    await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("PromptSchemaRegistry.validateOutcome returns status=ok for valid JSON", async () => {
  await withTempSchemaDir(async (schemaDir) => {
    const registry = new PromptSchemaRegistry({ schemaDir });
    const outcome = registry.validateOutcome(
      "test-schema",
      JSON.stringify({
        answer: "ok",
        needs_more_context: false,
        missing_snippets: [],
      }),
    );

    assert.equal(outcome?.status, "ok");
    assert.equal(outcome?.validation?.valid, true);
    assert.deepEqual(outcome?.parsed, {
      answer: "ok",
      needs_more_context: false,
      missing_snippets: [],
    });
  });
});

test("PromptSchemaRegistry.validateOutcome detects preamble responses", async () => {
  await withTempSchemaDir(async (schemaDir) => {
    const registry = new PromptSchemaRegistry({ schemaDir });
    const outcome = registry.validateOutcome(
      "test-schema",
      `Sure, here is the JSON:\n${JSON.stringify({
        answer: "ok",
        needs_more_context: false,
        missing_snippets: [],
      })}`,
    );

    assert.equal(outcome?.status, "preamble_detected");
    assert.equal(outcome?.error, "non-JSON preamble detected");
    assert.equal(outcome?.preambleDetected, true);
    assert.equal(outcome?.validation?.valid, false);
  });
});

test("PromptSchemaRegistry.validate returns compatibility fields plus status metadata", async () => {
  await withTempSchemaDir(async (schemaDir) => {
    const registry = new PromptSchemaRegistry({ schemaDir });
    const result = registry.validate(
      "test-schema",
      JSON.stringify({
        answer: "missing required fields",
      }),
    );

    assert.equal(result?.valid, false);
    assert.equal(result?.status, "schema_invalid");
    assert.equal(typeof result?.error, "string");
    assert.equal(result?.preambleDetected, false);
    assert.ok(Array.isArray(result?.errors));
  });
});
