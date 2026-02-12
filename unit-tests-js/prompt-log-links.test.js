import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PromptStepJournal from "../src/libs/prompt-step-journal.js";
import TaskExecutionRegister from "../src/libs/task-execution-register.js";
import PromptRecorder from "../src/libs/prompt-recorder.js";
import { normalizeLinksPayload } from "../src/libs/prompt-log-normalizer.js";

test("normalizeLinksPayload canonicalizes prompt-exchange links", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-links-base-"));
  try {
    const promptExchangePath = path.join(base, "prompt-exchanges", "abc.json");
    const normalized = normalizeLinksPayload(
      { promptExchangeId: "abc", promptExchangePath },
      { baseDir: base },
    );
    assert.equal(normalized.promptExchangeId, "abc");
    assert.equal(normalized.promptExchangePath, "prompt-exchanges/abc.json");

    const normalizedFromString = normalizeLinksPayload(promptExchangePath, { baseDir: base });
    assert.equal(normalizedFromString.promptExchangeId, null);
    assert.equal(normalizedFromString.promptExchangePath, "prompt-exchanges/abc.json");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("PromptStepJournal stores normalized prompt-exchange links", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-journal-"));
  const miniPhiRoot = path.join(root, ".miniphi");
  const promptExchangePath = path.join(miniPhiRoot, "prompt-exchanges", "step.json");
  try {
    const journal = new PromptStepJournal(miniPhiRoot);
    await journal.openSession("session-1");
    const step = await journal.appendStep("session-1", {
      label: "demo",
      prompt: "hello",
      response: "{\"ok\":true}",
      links: { promptExchangeId: "step-1", promptExchangePath },
    });
    const payload = JSON.parse(await fs.readFile(step.path, "utf8"));
    assert.equal(payload.links.promptExchangeId, "step-1");
    assert.equal(payload.links.promptExchangePath, "prompt-exchanges/step.json");

    const index = JSON.parse(
      await fs.readFile(path.join(miniPhiRoot, "prompt-exchanges", "stepwise", "index.json"), "utf8"),
    );
    assert.ok(index.entries[0].file.startsWith("prompt-exchanges/stepwise/"));
    assert.ok(!index.entries[0].file.includes("\\"), "journal index path should use posix separators");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TaskExecutionRegister and PromptRecorder persist links with posix paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-exec-"));
  const miniPhiRoot = path.join(root, ".miniphi");
  const promptExchangePath = path.join(miniPhiRoot, "prompt-exchanges", "abc.json");
  try {
    const register = new TaskExecutionRegister(miniPhiRoot);
    await register.openSession("exec-1");
    await register.record({
      request: { prompt: "ping" },
      links: { promptExchangeId: "abc", promptExchangePath },
    });
    const registerPath = path.join(miniPhiRoot, "executions", "exec-1", "task-execution.json");
    const registerPayload = JSON.parse(await fs.readFile(registerPath, "utf8"));
    assert.equal(
      registerPayload.entries[0].links.promptExchangePath,
      "prompt-exchanges/abc.json",
    );

    const recorder = new PromptRecorder(miniPhiRoot);
    const record = await recorder.record({
      request: { messages: [{ role: "user", content: "hi" }] },
    });
    const indexPath = path.join(miniPhiRoot, "prompt-exchanges", "index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    assert.ok(index.entries[0].file.endsWith(`${record.id}.json`));
    assert.ok(!index.entries[0].file.includes("\\"), "index file path should use posix separators");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
