import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PromptRecorder from "../src/libs/prompt-recorder.js";

test("PromptRecorder normalizes response_format and tool metadata", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-recorder-"));
  try {
    const recorder = new PromptRecorder(workspace);
    const record = await recorder.record({
      scope: "sub",
      label: "recorder-test",
      request: {
        messages: [{ role: "user", content: "Hello" }],
        promptText: "Hello",
        responseFormat: { type: "json_schema", json_schema: { name: "demo", schema: {} } },
      },
      response: {
        text: "{\"ok\":true}",
        toolCalls: [{ id: "call-1", type: "function" }],
        toolDefinitions: [{ name: "tool-1" }],
      },
    });

    const payload = JSON.parse(await fs.readFile(record.path, "utf8"));
    assert.ok(payload.request);
    assert.ok(payload.request.response_format);
    assert.equal(payload.request.responseFormat, undefined);
    assert.equal(payload.request.promptText, undefined);
    assert.ok(payload.response);
    assert.ok(Array.isArray(payload.response.tool_calls));
    assert.ok(Array.isArray(payload.response.tool_definitions));
    assert.equal(payload.response.toolCalls, undefined);
    assert.equal(payload.response.toolDefinitions, undefined);
    assert.equal(payload.response.rawResponseText, "{\"ok\":true}");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
