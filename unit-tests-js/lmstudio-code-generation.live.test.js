import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";
import {
  buildJsonSchemaResponseFormat,
  validateJsonObjectAgainstSchema,
} from "../src/libs/json-schema-utils.js";
import { fetchModelCatalog, selectBestModelForTask } from "../src/libs/model-catalog.js";

// Live LM Studio code-generation/editing checks. Enable with:
//   MINIPHI_LMSTUDIO_INTEGRATION=1 node --test unit-tests-js/lmstudio-code-generation.live.test.js
// Requires LM Studio at http://127.0.0.1:1234 with at least one coding-capable
// model downloaded. These tests exercise MiniPhi's real abilities: strict
// JSON-schema code responses that are then executed and asserted on.
const LIVE = process.env.MINIPHI_LMSTUDIO_INTEGRATION === "1";
const LIVE_TIMEOUT_MS = 420000;

const CODE_FILE_SCHEMA_ID = "code-file";
const CODE_FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["file_name", "language", "content", "needs_more_context", "missing_snippets"],
  properties: {
    file_name: { type: "string" },
    language: { type: "string" },
    content: { type: "string" },
    explanation: { type: ["string", "null"] },
    needs_more_context: { type: "boolean" },
    missing_snippets: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM_PROMPT = [
  "You are MiniPhi, a local coding agent.",
  `Respond ONLY with JSON matching schema ${CODE_FILE_SCHEMA_ID}: keys file_name, language, content, explanation, needs_more_context, missing_snippets.`,
  "content must hold the complete file text (ESM JavaScript).",
  "Never wrap the JSON in markdown fences or add commentary outside the JSON.",
].join(" ");

let sharedClient = null;
let sharedModelId = null;

async function resolveLiveClient() {
  if (sharedClient) {
    return { restClient: sharedClient, modelId: sharedModelId };
  }
  const restClient = new LMStudioRestClient({ timeoutMs: LIVE_TIMEOUT_MS });
  const override = process.env.MINIPHI_LIVE_MODEL?.trim();
  if (override) {
    sharedClient = restClient;
    sharedModelId = override;
    return { restClient, modelId: override };
  }
  const catalog = await fetchModelCatalog({ restClient });
  const best = selectBestModelForTask(catalog.models, { intent: "coding" });
  assert.ok(best, "no chat-capable model available in LM Studio");
  sharedClient = restClient;
  sharedModelId = best.model.id;
  return { restClient, modelId: sharedModelId };
}

async function requestCodeFile({ restClient, modelId, userPrompt, retries = 1 }) {
  const responseFormat = buildJsonSchemaResponseFormat(CODE_FILE_SCHEMA, CODE_FILE_SCHEMA_ID);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const completion = await restClient.createChatCompletion({
      model: modelId,
      temperature: 0.1,
      max_tokens: -1,
      response_format: responseFormat,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            attempt === 0
              ? userPrompt
              : `${userPrompt}\n\nYour previous reply was rejected (${lastError}). Reply with STRICT JSON matching the schema, nothing else.`,
        },
      ],
    });
    const text = completion?.choices?.[0]?.message?.content ?? "";
    const outcome = validateJsonObjectAgainstSchema(CODE_FILE_SCHEMA, text);
    if (outcome.parsed && outcome.status === "ok") {
      return outcome.parsed;
    }
    lastError = outcome.error ?? outcome.status ?? "invalid JSON";
  }
  assert.fail(`model did not return schema-valid code JSON: ${lastError}`);
}

async function importGeneratedModule(workspace, fileName, content) {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.js$/, ".mjs");
  const target = path.join(workspace, safeName.endsWith(".mjs") ? safeName : `${safeName}.mjs`);
  await fs.writeFile(target, content, "utf8");
  return import(pathToFileURL(target).href);
}

test(
  "live: generates a simple slugify module that passes behavioral checks",
  { skip: !LIVE, timeout: LIVE_TIMEOUT_MS },
  async () => {
    const { restClient, modelId } = await resolveLiveClient();
    const workspace = await createTempWorkspace();
    try {
      const result = await requestCodeFile({
        restClient,
        modelId,
        userPrompt: [
          "Write an ESM JavaScript module that exports a named function `slugify(text)`.",
          "Behavior contract:",
          '- lowercase the input ("Hello" -> "hello")',
          "- replace every run of non-alphanumeric characters with a single hyphen",
          "- strip leading and trailing hyphens",
          '- return "" for null, undefined, or empty input',
          'Examples: slugify("Hello, World!") === "hello-world"; slugify("  --Multiple   Spaces--  ") === "multiple-spaces".',
        ].join("\n"),
      });

      assert.equal(result.needs_more_context, false);
      const mod = await importGeneratedModule(workspace, result.file_name || "slugify.mjs", result.content);
      assert.equal(typeof mod.slugify, "function", "module must export slugify");
      assert.equal(mod.slugify("Hello, World!"), "hello-world");
      assert.equal(mod.slugify("  --Multiple   Spaces--  "), "multiple-spaces");
      assert.equal(mod.slugify("Already-Slugged"), "already-slugged");
      assert.equal(mod.slugify(""), "");
      assert.equal(mod.slugify(null), "");
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);

const BUGGY_STATS_MODULE = `export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values) {
  if (!values.length) {
    return null;
  }
  return sum(values) / values.length;
}

export function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort();
  return sorted[Math.floor(sorted.length / 2)];
}
`;

test(
  "live: edits an existing module to fix targeted bugs without breaking working code",
  { skip: !LIVE, timeout: LIVE_TIMEOUT_MS },
  async () => {
    const { restClient, modelId } = await resolveLiveClient();
    const workspace = await createTempWorkspace();
    try {
      const result = await requestCodeFile({
        restClient,
        modelId,
        userPrompt: [
          "Fix the bugs in this ESM stats module and return the COMPLETE corrected file in `content`.",
          "Known defects:",
          "1. median() sorts lexicographically, so median([10, 2, 33]) is wrong; it must sort numerically.",
          "2. median() ignores the even-length case; median([1, 2, 3, 4]) must be 2.5 (average of the middle pair).",
          "Constraints: keep the existing exports (sum, mean, median) working and unchanged in signature; do not add dependencies.",
          "```js",
          BUGGY_STATS_MODULE,
          "```",
        ].join("\n"),
      });

      const mod = await importGeneratedModule(workspace, result.file_name || "stats.mjs", result.content);
      // Untouched functions must survive the edit.
      assert.equal(mod.sum([1, 2, 3]), 6);
      assert.equal(mod.mean([2, 4, 6]), 4);
      assert.equal(mod.mean([]), null);
      // The targeted bugs must be fixed.
      assert.equal(mod.median([10, 2, 33]), 10);
      assert.equal(mod.median([1, 2, 3, 4]), 2.5);
      assert.equal(mod.median([5]), 5);
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);

test(
  "live: generates a stateful class with multiple interacting methods",
  { skip: !LIVE, timeout: LIVE_TIMEOUT_MS },
  async () => {
    const { restClient, modelId } = await resolveLiveClient();
    const workspace = await createTempWorkspace();
    try {
      const result = await requestCodeFile({
        restClient,
        modelId,
        userPrompt: [
          "Write an ESM JavaScript module exporting a class `TaskQueue`.",
          "Behavior contract:",
          "- constructor takes no arguments and starts empty",
          "- add(title) stores a task { id, title, done: false } and returns its numeric id (ids start at 1 and increment)",
          "- complete(id) marks that task done and returns true; returns false for unknown ids",
          "- pending() returns an array of titles of tasks not yet done, in insertion order",
          "- stats() returns { total, done, pending } counts",
          "No external dependencies.",
        ].join("\n"),
      });

      const mod = await importGeneratedModule(workspace, result.file_name || "task-queue.mjs", result.content);
      assert.equal(typeof mod.TaskQueue, "function", "module must export TaskQueue");
      const queue = new mod.TaskQueue();
      const first = queue.add("write tests");
      const second = queue.add("fix decomposer");
      queue.add("ship release");
      assert.equal(first, 1);
      assert.equal(second, 2);
      assert.equal(queue.complete(second), true);
      assert.equal(queue.complete(99), false);
      assert.deepEqual(queue.pending(), ["write tests", "ship release"]);
      assert.deepEqual(queue.stats(), { total: 3, done: 1, pending: 2 });
    } finally {
      await removeTempWorkspace(workspace);
    }
  },
);
