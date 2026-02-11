import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { handleNitpickCommand } from "../src/commands/nitpick.js";
import LMStudioHandler from "../src/libs/lmstudio-handler.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

const TASK = "Write 1000 words about the American Revolutionary War.";
const WRITER_MODEL = "student-writer";
const CRITIC_MODEL = "student-critic";

function countWords(text) {
  if (!text || typeof text !== "string") {
    return 0;
  }
  return (text.match(/\b[\w'-]+\b/g) ?? []).length;
}

function buildWordText(wordCount, prefix = "war") {
  return Array.from({ length: Math.max(0, wordCount) }, (_, index) => `${prefix}${index + 1}`).join(
    " ",
  );
}

function buildPlanPayload() {
  return {
    schema_version: "nitpick-plan@v1",
    task: TASK,
    outline: ["Causes", "Campaigns", "Aftermath"],
    drafting_plan: ["Draft", "Critique", "Revise"],
    tone: "Analytical",
    target_word_count: 1000,
    constraints: ["Keep chronology clear."],
    summary: "Plan drafted.",
    needs_more_context: false,
    missing_snippets: [],
    stop_reason: "completed",
    stop_reason_code: null,
    stop_reason_detail: null,
  };
}

function buildDraftPayload({ stage, contentWords, estimateWords }) {
  return {
    schema_version: "nitpick-draft@v1",
    task: TASK,
    role: "writer",
    stage,
    content: buildWordText(contentWords, stage),
    word_count_estimate: estimateWords,
    summary: `Draft stage ${stage}.`,
    citations: [],
    sources_used: [],
    warnings: [],
    needs_more_context: false,
    missing_snippets: [],
    stop_reason: "completed",
    stop_reason_code: null,
    stop_reason_detail: null,
  };
}

function buildCritiquePayload() {
  return {
    schema_version: "nitpick-critique@v1",
    task: TASK,
    role: "critic",
    critique: ["Expand evidence detail.", "Improve transitions."],
    revision_plan: ["Add detailed examples.", "Tighten sequence."],
    summary: "Needs expansion.",
    needs_more_context: false,
    missing_snippets: [],
    stop_reason: "completed",
    stop_reason_code: null,
    stop_reason_detail: null,
  };
}

test(
  "nitpick auto-expand rounds retry under-target finals and enforce actual-word validator",
  { timeout: 60_000 },
  async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-nitpick-auto-expand-"));
    await fs.mkdir(path.join(workspace, ".miniphi"), { recursive: true });
    const outputPath = path.join(workspace, "essay.txt");
    const schemaRegistry = new PromptSchemaRegistry();
    const lmCalls = [];

    const originalHandlerLoad = LMStudioHandler.prototype.load;
    const originalHandlerChatStream = LMStudioHandler.prototype.chatStream;
    LMStudioHandler.prototype.load = async function loadStub() {};
    LMStudioHandler.prototype.chatStream = async function chatStreamStub(
      prompt,
      _onToken,
      _onThink,
      _onError,
      traceOptions = undefined,
    ) {
      const label = traceOptions?.label ?? "";
      lmCalls.push(label);
      let payload;
      if (label === "nitpick-plan") {
        payload = buildPlanPayload();
      } else if (label === "nitpick-draft") {
        payload = buildDraftPayload({
          stage: "draft",
          contentWords: 700,
          estimateWords: 700,
        });
      } else if (label === "nitpick-critique-1") {
        payload = buildCritiquePayload();
      } else if (label === "nitpick-revision-1") {
        payload = buildDraftPayload({
          stage: "final",
          contentWords: 860,
          estimateWords: 1500,
        });
      } else if (label === "nitpick-auto-expand-1") {
        payload = buildDraftPayload({
          stage: "final",
          contentWords: 930,
          estimateWords: 1200,
        });
      } else if (label === "nitpick-auto-expand-2") {
        payload = buildDraftPayload({
          stage: "final",
          contentWords: 1030,
          estimateWords: 1200,
        });
      } else {
        throw new Error(`Unexpected step label: ${label}`);
      }

      this.lastPromptExchange = {
        id: `mock-${lmCalls.length}`,
        path: `mock://${label}`,
        request: {
          id: `request-${lmCalls.length}`,
          schemaId: traceOptions?.schemaId ?? null,
          promptChars: prompt.length,
        },
        response: {
          schemaId: traceOptions?.schemaId ?? null,
          schemaValidation: { valid: true, status: "ok", errors: [] },
          tool_calls: [],
          tool_definitions: [],
        },
        error: null,
      };
      return JSON.stringify(payload);
    };

    try {
      await handleNitpickCommand({
        command: "nitpick",
        options: {
          cwd: workspace,
          blind: false,
          rounds: 1,
          "target-words": 1000,
          "auto-expand-rounds": 2,
          "writer-model": WRITER_MODEL,
          "critic-model": CRITIC_MODEL,
          output: outputPath,
        },
        positionals: [],
        task: TASK,
        promptGroupId: `auto-expand-test-${randomUUID()}`,
        promptJournalId: null,
        promptJournalStatus: null,
        verbose: false,
        restClient: null,
        schemaRegistry,
        systemPrompt: "You are a careful writing assistant.",
        contextLength: null,
        gpu: null,
        lmStudioManager: null,
        performanceTracker: null,
        archiveMetadata: {},
        configData: {},
        DEFAULT_TASK_DESCRIPTION: "Describe the task.",
        parseDirectFileReferences: (taskText) => ({
          cleanedTask: taskText,
          references: [],
        }),
        mergeFixedReferences: (workspaceContext) => workspaceContext,
        recordLmStudioStatusSnapshot: async () => {},
        describeWorkspace: async () => ({
          summary: "Documentation workspace.",
          hintBlock: "Keep structure clear.",
          planDirectives: "Return strict JSON.",
          classification: { domain: "docs", label: "Documentation" },
        }),
        recordAnalysisStepInJournal: async () => {},
        sessionDeadline: null,
      });

      assert.deepEqual(lmCalls, [
        "nitpick-plan",
        "nitpick-draft",
        "nitpick-critique-1",
        "nitpick-revision-1",
        "nitpick-auto-expand-1",
        "nitpick-auto-expand-2",
      ]);

      const outputText = await fs.readFile(outputPath, "utf8");
      assert.ok(countWords(outputText) >= 1000, "Expected final output to reach minimum words.");

      const nitpickIndexPath = path.join(workspace, ".miniphi", "indices", "nitpick-index.json");
      const nitpickIndex = JSON.parse(await fs.readFile(nitpickIndexPath, "utf8"));
      assert.equal(nitpickIndex.entries.length, 1);
      const sessionPath = path.join(workspace, ".miniphi", nitpickIndex.entries[0].file);
      const session = JSON.parse(await fs.readFile(sessionPath, "utf8"));

      assert.equal(session.settings.autoExpandRounds, 2);
      assert.ok(session.finalWordCount >= 1000);
      assert.equal(session.stopReason, null);
      assert.equal(session.stopReasonCode, null);
      assert.ok(session.steps.some((step) => step.label === "auto-expand-1"));
      assert.ok(session.steps.some((step) => step.label === "auto-expand-2"));

      const rejectedRevision = session.steps.find((step) => step.label === "revision-1");
      assert.ok(rejectedRevision);
      assert.match(
        rejectedRevision.response.stop_reason_detail ?? "",
        /minimum words validator failed \(\d+\/1000\)/i,
      );

      const rejectedExpand = session.steps.find((step) => step.label === "auto-expand-1");
      assert.ok(rejectedExpand);
      assert.match(
        rejectedExpand.response.stop_reason_detail ?? "",
        /minimum words validator failed \(\d+\/1000\)/i,
      );
    } finally {
      LMStudioHandler.prototype.load = originalHandlerLoad;
      LMStudioHandler.prototype.chatStream = originalHandlerChatStream;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
);
