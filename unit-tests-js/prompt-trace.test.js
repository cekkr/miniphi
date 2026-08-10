import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PromptTrace, createPromptTrace, NULL_PROMPT_TRACE } from "../src/libs/prompt-trace.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

const tempBase = async () =>
  fs.mkdtemp(path.join(os.tmpdir(), "miniphi-prompt-trace-"));

test("a recorded exchange keeps the complete prompt and response on disk", async () => {
  const baseDir = await tempBase();
  const trace = new PromptTrace({ baseDir, sessionId: "s1" });
  const systemPrompt = "You are MiniPhi. Follow the rules.";
  const userPrompt = "Do the thing.\nHere is the context.";

  const written = await trace.record({
    kind: "agent-turn",
    turn: 3,
    elapsedMs: 1234,
    request: {
      model: "prism-ml/bonsai-27b",
      temperature: 0.25,
      top_p: 0.9,
      max_tokens: 4096,
      samplingProfile: "agent",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    },
    response: {
      text: '{"task":"thing"}',
      finish_reason: "stop",
      usage: { prompt_tokens: 120, completion_tokens: 8 },
    },
    validation: { valid: true },
  });

  assert.ok(written?.file);
  const record = JSON.parse(await fs.readFile(written.file, "utf8"));
  assert.equal(record.turn, 3);
  assert.equal(record.request.model, "prism-ml/bonsai-27b");
  assert.equal(record.request.max_tokens, 4096);
  // The whole point of the trace: the exact bytes, not a summary of them.
  assert.equal(record.request.messages[0].content, systemPrompt);
  assert.equal(record.request.messages[1].content, userPrompt);
  assert.equal(record.response.text, '{"task":"thing"}');

  const index = await fs.readFile(path.join(trace.dir, "index.jsonl"), "utf8");
  const line = JSON.parse(index.trim());
  assert.equal(line.kind, "agent-turn");
  assert.equal(line.completionTokens, 8);
  assert.equal(line.valid, true);

  const transcript = await fs.readFile(path.join(trace.dir, "transcript.md"), "utf8");
  assert.match(transcript, /agent-turn/);
  assert.match(transcript, /Follow the rules/);
});

test("images are written beside the trace instead of inlined as base64", async () => {
  const baseDir = await tempBase();
  const trace = new PromptTrace({ baseDir, sessionId: "vision" });
  const written = await trace.record({
    kind: "page-regions",
    request: {
      model: "vlm",
      messages: [
        { role: "system", content: "look at the image" },
        {
          role: "user",
          content: [
            { type: "text", text: "Survey this page." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } },
          ],
        },
      ],
    },
    response: { text: "{}" },
  });

  const raw = await fs.readFile(written.file, "utf8");
  assert.doesNotMatch(raw, new RegExp(TINY_PNG_BASE64.slice(0, 40)));
  const record = JSON.parse(raw);
  const imagePart = record.request.messages[1].content.find((part) => part.type === "image_file");
  assert.ok(imagePart, "the image is recorded as a file reference");
  const bytes = await fs.readFile(path.join(trace.dir, imagePart.file));
  assert.equal(bytes.length, imagePart.bytes);
  assert.ok(bytes.length > 0);
});

test("stats and the summary count exchanges by kind", async () => {
  const baseDir = await tempBase();
  const trace = new PromptTrace({ baseDir, sessionId: "counts" });
  await trace.record({ kind: "agent-turn", request: { messages: [] }, response: { text: "a" } });
  await trace.record({ kind: "agent-turn", request: { messages: [] }, response: { text: "b" } });
  await trace.record({
    kind: "subprompt-plan",
    request: { messages: [] },
    response: { text: "" },
    validation: { valid: false, error: "nope" },
  });

  const stats = trace.stats();
  assert.equal(stats.exchanges, 3);
  assert.equal(stats.failures, 1);
  assert.deepEqual(stats.byKind, { "agent-turn": 2, "subprompt-plan": 1 });

  await trace.finalize({ stopReason: "completed" });
  const summary = JSON.parse(await fs.readFile(path.join(trace.dir, "summary.json"), "utf8"));
  assert.equal(summary.exchanges, 3);
  assert.equal(summary.stopReason, "completed");
});

test("without a base directory the trace degrades to a no-op instead of throwing", async () => {
  const trace = createPromptTrace({ baseDir: null, sessionId: "none" });
  assert.equal(trace, NULL_PROMPT_TRACE);
  assert.equal(await trace.record({ kind: "agent-turn" }), null);
  assert.equal(trace.stats().enabled, false);
});
