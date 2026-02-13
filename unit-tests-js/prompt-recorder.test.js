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
        toolDefinitions: [{ name: "request-tool" }],
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
    assert.ok(Array.isArray(payload.request.tool_definitions));
    assert.equal(payload.request.toolDefinitions, undefined);
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

test("PromptRecorder normalizes legacy stop reason aliases", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-recorder-stop-"));
  try {
    const recorder = new PromptRecorder(workspace);
    const record = await recorder.record({
      scope: "sub",
      label: "recorder-stop-test",
      request: {
        messages: [{ role: "user", content: "Stop reason test" }],
      },
      response: {
        text: "{\"ok\":false}",
        stop_reason: "partial-fallback",
        stop_reason_code: "fallback",
        stop_reason_detail: "legacy fallback marker",
      },
      error: {
        message: "legacy fallback marker",
        stop_reason: "partial-fallback",
        stop_reason_code: "fallback",
      },
    });
    const payload = JSON.parse(await fs.readFile(record.path, "utf8"));
    assert.equal(payload.response.stop_reason, "analysis-error");
    assert.equal(payload.response.stop_reason_code, "analysis-error");
    assert.equal(payload.response.stop_reason_detail, "legacy fallback marker");
    assert.equal(payload.error.stop_reason, "analysis-error");
    assert.equal(payload.error.stop_reason_code, "analysis-error");
    assert.equal(payload.error.stop_reason_detail, "legacy fallback marker");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("PromptRecorder retains tool metadata keys even when no tools are supplied", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-recorder-tool-keys-"));
  try {
    const recorder = new PromptRecorder(workspace);
    const record = await recorder.record({
      request: {
        messages: [{ role: "user", content: "No tools." }],
      },
      response: {
        text: "{\"ok\":true}",
      },
    });
    const payload = JSON.parse(await fs.readFile(record.path, "utf8"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.request, "tool_definitions"),
      true,
    );
    assert.equal(payload.request.tool_definitions, null);
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.response, "tool_calls"),
      true,
    );
    assert.equal(payload.response.tool_calls, null);
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload.response, "tool_definitions"),
      true,
    );
    assert.equal(payload.response.tool_definitions, null);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
