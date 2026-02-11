import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { handleNitpickCommand } from "../src/commands/nitpick.js";
import LMStudioHandler from "../src/libs/lmstudio-handler.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import WebResearcher from "../src/libs/web-researcher.js";
import WebBrowser from "../src/libs/web-browser.js";

const ESSAY_TASK =
  "Write 1000 words about the American Revolutionary War with citations and clear historical structure.";

const WRITER_MODEL = "student-a-model";
const CRITIC_MODEL = "student-b-model";

function countWords(text) {
  if (!text || typeof text !== "string") {
    return 0;
  }
  return (text.match(/\b[\w'-]+\b/g) ?? []).length;
}

function buildEssay(targetWords, leadSentence) {
  const sections = [
    `${leadSentence} Colonial grievances expanded from tax disputes to constitutional arguments about sovereignty, representation, and local consent.`,
    "After the Coercive Acts and the Boston Tea Party, many communities viewed imperial authority as punitive rather than protective.",
    "At Lexington and Concord, armed confrontation replaced petitioning, and militia networks proved that local mobilization could challenge professional troops.",
    "George Washington's command style emphasized endurance, training, and political discipline so the Continental Army could survive strategic setbacks.",
    "The New York campaign exposed American weaknesses, yet withdrawals preserved the army and kept the rebellion alive long enough for recovery.",
    "Victories at Trenton and Princeton rebuilt morale and demonstrated that operational surprise could offset shortages in manpower and materiel.",
    "Saratoga reshaped the war because French leaders now judged the insurgency viable, opening the way for alliance diplomacy and naval coordination.",
    "French military and financial support strengthened logistics, expanded artillery capacity, and complicated British global commitments from the Caribbean to India.",
    "Civilian life was defined by inflation, requisitions, and contested loyalties; households paid economic and emotional costs that echoed beyond the battlefield.",
    "Enslaved people, free Black communities, and Native nations made strategic choices in a conflict that threatened existing social and territorial orders.",
    "Southern campaigns highlighted brutality and counterinsurgency, as British officers sought loyalist momentum while Patriot partisans disrupted lines of control.",
    "Yorktown succeeded through Franco-American cooperation, siege craft, and naval blockade, proving coalition warfare could deliver a decisive operational result.",
    "The Treaty of Paris in 1783 recognized independence, defined borders, and initiated disputes over debts, loyalist property, and frontier enforcement.",
    "Postwar politics exposed the limits of wartime governance and fed constitutional debates about taxation powers, federal capacity, and republican accountability.",
    "Memory of the war became a contested civic narrative, balancing liberty rhetoric with unresolved exclusions in race, class, and gender.",
    "A durable interpretation links military adaptation, diplomatic leverage, and social transformation instead of reducing victory to a single battle.",
    "The Revolution therefore belongs to global history as well as national mythology, because empires, commerce, and ideology shaped each campaign decision.",
    "Scholars continue debating whether the conflict was primarily a civil war, an anticolonial revolution, or an imperial realignment with republican outcomes.",
    "Even so, the evidence supports a core conclusion: strategic persistence plus foreign alliance converted rebellion into recognized statehood.",
    "This essay closes by tying battlefield events to constitutional consequences, showing why military outcomes mattered for long-term institutional design.",
  ];

  const words = [];
  let index = 0;
  while (words.length < targetWords) {
    const sentence = sections[index % sections.length];
    const citation = index % 3 === 0 ? " [source:rev-war-1]" : index % 3 === 1 ? " [source:rev-war-2]" : " [source:rev-war-3]";
    words.push(...`${sentence}${citation}`.split(/\s+/));
    index += 1;
  }

  const paragraphs = [];
  for (let i = 0; i < words.length; i += 120) {
    paragraphs.push(words.slice(i, i + 120).join(" "));
  }
  return paragraphs.join("\n\n");
}

function buildPlanPayload() {
  return {
    schema_version: "nitpick-research-plan@v1",
    task: ESSAY_TASK,
    outline: [
      "Imperial crisis and causes of conflict",
      "Military chronology from Lexington to Yorktown",
      "Alliance diplomacy and global dimensions",
      "Socioeconomic impact and constitutional aftermath",
    ],
    queries: [
      "American Revolutionary War timeline Lexington Concord Yorktown",
      "French alliance 1778 significance Saratoga",
    ],
    facts_needed: [
      "Sequence of campaigns between 1775 and 1781",
      "How the French alliance changed strategy",
      "Key terms of the Treaty of Paris 1783",
    ],
    drafting_plan: [
      "Student A drafts causes and campaign chronology.",
      "Student B critiques argument quality, missing evidence, and clarity.",
      "Student A revises with stronger evidence and transitions for a 1000-word final draft.",
    ],
    tone: "Analytical and readable",
    target_word_count: 1000,
    constraints: [
      "Use concise paragraphs with explicit chronology.",
      "Use inline source markers like [source:ID].",
    ],
    summary: "Two-student collaborative plan with web research requirements.",
    needs_more_context: false,
    missing_snippets: [],
    stop_reason: "completed",
    stop_reason_code: null,
    stop_reason_detail: null,
  };
}

function buildDraftPayload(stage, targetWords, summary, extra = undefined) {
  return {
    schema_version: "nitpick-draft@v1",
    task: ESSAY_TASK,
    role: "writer",
    stage,
    content: buildEssay(targetWords, "The American Revolutionary War evolved from constitutional protest into a prolonged struggle for political legitimacy."),
    word_count_estimate: targetWords,
    summary,
    citations: [
      {
        source_id: "rev-war-1",
        claim: "The war widened after early clashes in Massachusetts.",
        excerpt: "Lexington and Concord accelerated military mobilization.",
      },
      {
        source_id: "rev-war-2",
        claim: "Saratoga helped secure French alliance support.",
        excerpt: "Diplomatic confidence followed the American victory.",
      },
      {
        source_id: "rev-war-3",
        claim: "Treaty negotiations formalized independence.",
        excerpt: "Paris terms recognized sovereignty and borders.",
      },
    ],
    sources_used: ["rev-war-1", "rev-war-2", "rev-war-3"],
    warnings: extra?.warnings ?? [],
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
    task: ESSAY_TASK,
    role: "critic",
    critique: [
      "Strengthen the transition from Saratoga to the 1778 French alliance by linking military outcomes to diplomacy.",
      "Expand the civilian economy section with clearer evidence about inflation and wartime supply stress.",
      "Clarify how Yorktown and the Treaty of Paris shaped postwar constitutional debates.",
    ],
    revision_plan: [
      "Add a diplomacy paragraph that explicitly ties Saratoga to French intervention.",
      "Add one paragraph on inflation, requisitions, and civilian burdens.",
      "Sharpen the conclusion around governance consequences after independence.",
    ],
    missing_facts: [
      "French alliance treaty year and military implications",
      "Specific Treaty of Paris consequences for sovereignty and debts",
    ],
    queries: ["Treaty of Paris 1783 terms and political consequences"],
    summary: "Student B critique identifies evidence and coherence gaps for revision.",
    needs_more_context: false,
    missing_snippets: [],
    stop_reason: "completed",
    stop_reason_code: null,
    stop_reason_detail: null,
  };
}

function buildMockResearchResult(query, index) {
  const slug = String(index).padStart(2, "0");
  return {
    id: `research-${slug}`,
    query,
    provider: "duckduckgo",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 5,
    maxResults: 5,
    results: [
      {
        title: `Reference ${slug}`,
        url: `https://example.org/revolutionary-war/${slug}`,
        snippet: `Research snippet ${slug}: verified chronology and diplomatic context.`,
      },
    ],
  };
}

test(
  "nitpick two-student essay flow writes 1000+ words and uses web research for revisions",
  { timeout: 60_000 },
  async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-nitpick-two-student-"));
    await fs.mkdir(path.join(workspace, ".miniphi"), { recursive: true });
    const outputPath = path.join(workspace, "revolutionary-war-essay.txt");
    const schemaRegistry = new PromptSchemaRegistry();
    const lmCalls = [];
    const researchCalls = [];
    const browserCalls = [];

    const originalHandlerLoad = LMStudioHandler.prototype.load;
    const originalHandlerChatStream = LMStudioHandler.prototype.chatStream;
    const originalResearchSearch = WebResearcher.prototype.search;
    const originalBrowserFetch = WebBrowser.prototype.fetch;

    LMStudioHandler.prototype.load = async function loadStub() {};
    LMStudioHandler.prototype.chatStream = async function chatStreamStub(
      prompt,
      _onToken,
      _onThink,
      _onError,
      traceOptions = undefined,
    ) {
      const label = traceOptions?.label ?? null;
      lmCalls.push({
        model: this.modelKey,
        label,
        schemaId: traceOptions?.schemaId ?? null,
        prompt,
      });

      let payload = null;
      if (label === "nitpick-plan") {
        assert.equal(this.modelKey, WRITER_MODEL);
        payload = buildPlanPayload();
      } else if (label === "nitpick-draft") {
        assert.equal(this.modelKey, WRITER_MODEL);
        payload = buildDraftPayload(
          "draft",
          720,
          "Student A first draft covers chronology but needs stronger diplomatic and social evidence.",
        );
      } else if (label === "nitpick-critique-1") {
        assert.equal(this.modelKey, CRITIC_MODEL);
        payload = buildCritiquePayload();
      } else if (label === "nitpick-revision-1") {
        assert.equal(this.modelKey, WRITER_MODEL);
        payload = buildDraftPayload(
          "final",
          1040,
          "Student A revised the essay using Student B critique and additional source-backed improvements.",
        );
      } else {
        throw new Error(`Unexpected nitpick step label: ${String(label)}`);
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

    WebResearcher.prototype.search = async function searchStub(query, options = {}) {
      researchCalls.push({ query, options });
      return buildMockResearchResult(query, researchCalls.length);
    };

    WebBrowser.prototype.fetch = async function fetchStub(url, options = {}) {
      browserCalls.push({ url, options });
      const id = `rev-war-${String(browserCalls.length)}`;
      return {
        id,
        url,
        finalUrl: url,
        title: `Snapshot for ${url}`,
        text: `Primary source extract for ${url}: treaty terms, alliance timing, and wartime economic stress.`,
        html: null,
        status: 200,
        error: null,
        screenshot: null,
        extractedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 12,
      };
    };

    try {
      await handleNitpickCommand({
        command: "nitpick",
        options: {
          cwd: workspace,
          blind: true,
          rounds: 1,
          "target-words": 1000,
          "research-rounds": 2,
          "max-results": 4,
          "max-sources": 6,
          "max-source-chars": 1600,
          "writer-model": WRITER_MODEL,
          "critic-model": CRITIC_MODEL,
          output: outputPath,
        },
        positionals: [],
        task: ESSAY_TASK,
        promptGroupId: `essay-two-students-${randomUUID()}`,
        promptJournalId: null,
        promptJournalStatus: null,
        verbose: false,
        restClient: null,
        schemaRegistry,
        systemPrompt: "You are a careful historical writing assistant.",
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
          summary: "Documentation-oriented workspace for writing tasks.",
          hintBlock: "Focus on structured narrative output.",
          planDirectives: "Return strict JSON.",
          classification: { domain: "docs", label: "Documentation" },
        }),
        recordAnalysisStepInJournal: async () => {},
        sessionDeadline: null,
      });

      assert.ok(researchCalls.length >= 3, "Expected web research calls for plan and critique.");
      assert.ok(browserCalls.length >= 3, "Expected web snapshot fetches for cited sources.");

      const labels = lmCalls.map((call) => call.label);
      assert.deepEqual(labels, [
        "nitpick-plan",
        "nitpick-draft",
        "nitpick-critique-1",
        "nitpick-revision-1",
      ]);

      const draftPrompt = lmCalls.find((call) => call.label === "nitpick-draft")?.prompt ?? "";
      assert.match(draftPrompt, /Sources:/);
      assert.match(draftPrompt, /Research snippet/);

      const revisionPrompt = lmCalls.find((call) => call.label === "nitpick-revision-1")?.prompt ?? "";
      assert.match(revisionPrompt, /Critique to address:/);
      assert.match(revisionPrompt, /Strengthen the transition from Saratoga to the 1778 French alliance/);

      const finalOutput = await fs.readFile(outputPath, "utf8");
      assert.ok(countWords(finalOutput) >= 1000, "Final essay should contain at least 1000 words.");

      const nitpickIndexPath = path.join(workspace, ".miniphi", "indices", "nitpick-index.json");
      const nitpickIndex = JSON.parse(await fs.readFile(nitpickIndexPath, "utf8"));
      assert.ok(Array.isArray(nitpickIndex.entries) && nitpickIndex.entries.length === 1);

      const sessionPath = path.join(workspace, ".miniphi", nitpickIndex.entries[0].file);
      const session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
      assert.equal(session.models.writer, WRITER_MODEL);
      assert.equal(session.models.critic, CRITIC_MODEL);
      assert.equal(session.settings.targetWords, 1000);
      assert.ok(Array.isArray(session.sources) && session.sources.length >= 3);
      assert.ok(session.steps.some((step) => step.label === "critique-1"));
      assert.ok(session.steps.some((step) => step.label === "revision-1"));
      assert.ok(countWords(session.finalText) >= 1000);
      assert.equal(session.stopReason, null);
      assert.equal(session.stopReasonCode, null);
    } finally {
      LMStudioHandler.prototype.load = originalHandlerLoad;
      LMStudioHandler.prototype.chatStream = originalHandlerChatStream;
      WebResearcher.prototype.search = originalResearchSearch;
      WebBrowser.prototype.fetch = originalBrowserFetch;
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
);
