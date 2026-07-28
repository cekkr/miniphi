import test from "node:test";
import assert from "node:assert/strict";
import { VisionReviewer, createVisionReviewAction } from "../src/libs/vision-reviewer.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

test("VisionReviewer sends the screenshot as image content and returns a schema-valid critique", async () => {
  const calls = [];
  const reviewer = new VisionReviewer({
    client: {
      async createChatCompletion(request) {
        calls.push(request);
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schema_version: "visual-review@v1",
                  matches_intent: true,
                  quality_score: 72,
                  description: "An orange circle bounces across a white canvas.",
                  issues: ["No seam lines on the ball."],
                  suggestions: ["Add dark curved seam strokes to read as a basketball."],
                  needs_more_context: false,
                  missing_snippets: [],
                  stop_reason: "",
                }),
              },
            },
          ],
        };
      },
    },
    schemaRegistry: new PromptSchemaRegistry(),
    model: "qwen/qwen3-vl-4b",
  });

  const { response, audit } = await reviewer.review({
    imageBase64: TINY_PNG_BASE64,
    focus: "does the ball look like a basketball",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "qwen/qwen3-vl-4b");
  assert.equal(calls[0].response_format.type, "json_schema");
  assert.equal(calls[0].response_format.json_schema.name, "visual-review");
  const userContent = calls[0].messages[1].content;
  assert.ok(Array.isArray(userContent), "vision requests send array content, not a plain string");
  assert.ok(userContent.some((part) => part.type === "image_url"));
  assert.match(userContent.find((part) => part.type === "image_url").image_url.url, /^data:image\/png;base64,/);
  assert.match(calls[0].messages[0].content, /does the ball look like a basketball/);

  assert.equal(response.quality_score, 72);
  assert.equal(response.matches_intent, true);
  assert.deepEqual(response.suggestions, ["Add dark curved seam strokes to read as a basketball."]);
  assert.equal(audit.attempts.length, 1);
  // The audit log must never carry the raw base64 payload.
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(TINY_PNG_BASE64));
});

test("VisionReviewer retries once on invalid JSON then falls back deterministically", async () => {
  let requests = 0;
  const reviewer = new VisionReviewer({
    client: {
      async createChatCompletion() {
        requests += 1;
        return { choices: [{ message: { content: "It looks like a nice ball." } }] };
      },
    },
    schemaRegistry: new PromptSchemaRegistry(),
    model: "fixture-vlm",
  });

  const { response, audit } = await reviewer.review({ imageBase64: TINY_PNG_BASE64 });

  assert.equal(requests, 2);
  assert.match(response.stop_reason, /^invalid-response:/);
  assert.equal(response.quality_score, 0);
  assert.equal(audit.fallback, response.stop_reason);
});

test("VisionReviewer short-circuits without a screenshot or without configuration", async () => {
  const reviewer = new VisionReviewer({
    client: { async createChatCompletion() { throw new Error("must not be called"); } },
    schemaRegistry: new PromptSchemaRegistry(),
    model: "fixture-vlm",
  });
  const noScreenshot = await reviewer.review({ imageBase64: null });
  assert.equal(noScreenshot.response.stop_reason, "no-screenshot");

  const unavailable = new VisionReviewer({ client: null, schemaRegistry: new PromptSchemaRegistry(), model: null });
  const result = await unavailable.review({ imageBase64: TINY_PNG_BASE64 });
  assert.equal(result.response.stop_reason, "vision-reviewer-unavailable");
});

test("createVisionReviewAction requires a client, schema registry, and model", () => {
  assert.equal(createVisionReviewAction({}), null);
  assert.equal(
    createVisionReviewAction({ restClient: {}, schemaRegistry: new PromptSchemaRegistry() }),
    null,
    "missing model id disables vision review",
  );
  assert.notEqual(
    createVisionReviewAction({
      restClient: { createChatCompletion: async () => ({}) },
      schemaRegistry: new PromptSchemaRegistry(),
      model: "qwen/qwen3-vl-4b",
    }),
    null,
  );
});
