import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PromptStepJournal from "../src/libs/prompt-step-journal.js";

test("PromptStepJournal normalizes tool metadata and object responses", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-step-journal-"));
  try {
    const journal = new PromptStepJournal(workspace);
    await journal.openSession("step-journal-test", { mode: "workspace" });
    const stepRecord = await journal.appendStep("step-journal-test", {
      label: "analysis",
      prompt: "Explain this workspace.",
      response: {
        text: "{\"ok\":true}",
        toolCalls: [{ id: "call-1", type: "function" }],
        toolDefinitions: [{ name: "tool-1" }],
      },
      toolCalls: [{ id: "step-call", type: "function" }],
      toolDefinitions: [{ name: "step-tool" }],
      status: "recorded",
    });

    const payload = JSON.parse(await fs.readFile(stepRecord.path, "utf8"));
    assert.equal(payload.label, "analysis");
    assert.ok(Array.isArray(payload.tool_calls));
    assert.ok(Array.isArray(payload.tool_definitions));
    assert.equal(payload.tool_calls[0].id, "step-call");
    assert.equal(payload.tool_definitions[0].name, "step-tool");
    assert.equal(payload.toolCalls, undefined);
    assert.equal(payload.toolDefinitions, undefined);
    assert.equal(typeof payload.response, "string");

    const response = JSON.parse(payload.response);
    assert.equal(response.rawResponseText, "{\"ok\":true}");
    assert.equal(response.text, undefined);
    assert.ok(Array.isArray(response.tool_calls));
    assert.ok(Array.isArray(response.tool_definitions));
    assert.equal(response.toolCalls, undefined);
    assert.equal(response.toolDefinitions, undefined);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

