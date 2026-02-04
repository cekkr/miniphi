import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import LMStudioHandler from "../libs/lmstudio-handler.js";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import PromptRecorder from "../libs/prompt-recorder.js";
import PromptStepJournal from "../libs/prompt-step-journal.js";
import TaskExecutionRegister from "../libs/task-execution-register.js";
import WebResearcher from "../libs/web-researcher.js";
import WebBrowser from "../libs/web-browser.js";
import { parseStrictJsonObject } from "../libs/core-utils.js";
import { parseNumericSetting, resolveDurationMs } from "../libs/cli-utils.js";
import { classifyTaskIntent, selectNitpickModels } from "../libs/model-selector.js";

const DEFAULT_ROUNDS = 2;
const DEFAULT_TARGET_WORDS = 1200;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_SOURCES = 6;
const DEFAULT_SOURCE_CHARS = 1800;

function parseList(value) {
  if (!value && value !== 0) {
    return [];
  }
  return String(value)
    .split(/[,|]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBooleanFlag(value, fallback = undefined) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function buildSchemaBlock(schemaRegistry, schemaId) {
  return schemaRegistry?.buildInstructionBlock(schemaId, {
    compact: true,
    maxLength: 1800,
  });
}

function buildPlanPrompt({ task, targetWords, schemaBlock, blind }) {
  const lines = [
    "You are planning a long-form response for MiniPhi.",
    `Task: ${task}`,
  ];
  if (targetWords) {
    lines.push(`Target word count: ${targetWords}`);
  }
  if (blind) {
    lines.push("Blind mode: do NOT use prior knowledge. Produce search queries and facts needed.");
  }
  lines.push(
    "Return strict JSON only that matches this schema:",
    schemaBlock ?? "",
    "Include outline and drafting_plan arrays. If context is missing, set needs_more_context true and list missing_snippets.",
  );
  return lines.filter(Boolean).join("\n");
}

function buildDraftPrompt({
  task,
  outline,
  targetWords,
  constraints,
  sources,
  critique,
  stage,
  schemaBlock,
  blind,
}) {
  const lines = [
    "You are the writer. Draft the response for the task below.",
    `Task: ${task}`,
  ];
  if (outline?.length) {
    lines.push("Outline:");
    outline.forEach((item) => lines.push(`- ${item}`));
  }
  if (constraints?.length) {
    lines.push("Constraints:");
    constraints.forEach((item) => lines.push(`- ${item}`));
  }
  if (critique?.length) {
    lines.push("Critique to address:");
    critique.forEach((item) => lines.push(`- ${item}`));
  }
  if (targetWords) {
    lines.push(`Target word count: ${targetWords}`);
  }
  if (blind) {
    lines.push(
      "Blind mode: ONLY use the provided sources. Cite sources inline like [source:ID].",
    );
  }
  if (sources?.length) {
    lines.push("Sources:");
    sources.forEach((source) => {
      lines.push(`[source:${source.id}] ${source.title ?? "Untitled"}`);
      lines.push(`URL: ${source.url}`);
      if (source.snippet) {
        lines.push(`Snippet: ${source.snippet}`);
      }
      if (source.text) {
        lines.push(`Extract: ${source.text}`);
      }
    });
  }
  lines.push(
    "Return strict JSON only that matches this schema:",
    schemaBlock ?? "",
    `Set stage to "${stage}". Provide content, word_count_estimate, summary, and citations if available.`,
  );
  return lines.filter(Boolean).join("\n");
}

function buildCritiquePrompt({ task, draft, sources, schemaBlock, blind }) {
  const lines = [
    "You are the critic. Review the draft and list precise improvements.",
    `Task: ${task}`,
    "Draft:",
    draft ?? "",
  ];
  if (blind) {
    lines.push("Blind mode: verify claims against sources only; flag unsupported claims.");
  }
  if (sources?.length) {
    lines.push("Sources:");
    sources.forEach((source) => {
      lines.push(`[source:${source.id}] ${source.title ?? "Untitled"}`);
      lines.push(`URL: ${source.url}`);
      if (source.snippet) {
        lines.push(`Snippet: ${source.snippet}`);
      }
    });
  }
  lines.push(
    "Return strict JSON only that matches this schema:",
    schemaBlock ?? "",
    "Provide critique and a revision_plan list. Include queries if more research is required.",
  );
  return lines.filter(Boolean).join("\n");
}

function buildFallback(schemaId, { task, role, stage, reason }) {
  const base = {
    schema_version: "fallback-v1",
    task: task ?? "",
    summary: reason ?? "fallback",
    needs_more_context: true,
    missing_snippets: [],
    stop_reason: reason ?? "fallback",
    stop_reason_code: "fallback",
    stop_reason_detail: reason ?? null,
  };
  switch (schemaId) {
    case "nitpick-plan":
      return {
        ...base,
        outline: [],
        drafting_plan: [],
      };
    case "nitpick-research-plan":
      return {
        ...base,
        outline: [],
        queries: [],
        facts_needed: [],
        drafting_plan: [],
      };
    case "nitpick-critique":
      return {
        ...base,
        role: "critic",
        critique: [],
        revision_plan: [],
      };
    case "nitpick-draft":
    default:
      return {
        ...base,
        role: role ?? "writer",
        stage: stage ?? "draft",
        content: "",
        word_count_estimate: 0,
      };
  }
}

function clampSourceText(text, maxChars) {
  if (!text) {
    return "";
  }
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : null;
  if (!limit || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function isSessionExpired(sessionDeadline) {
  if (!Number.isFinite(sessionDeadline)) {
    return false;
  }
  return Date.now() >= sessionDeadline;
}

async function runNitpickStep({
  handler,
  prompt,
  schemaId,
  label,
  metadata,
  task,
  role,
  stage,
  sessionDeadline,
  mainPromptId,
}) {
  if (isSessionExpired(sessionDeadline)) {
    return {
      response: buildFallback(schemaId, { task, role, stage, reason: "session-timeout" }),
      promptExchange: null,
      error: "session-timeout",
    };
  }
  handler.clearHistory();
  try {
    const raw = await handler.chatStream(prompt, undefined, undefined, undefined, {
      scope: "sub",
      label,
      schemaId,
      metadata,
      mainPromptId,
    });
    const parsed = parseStrictJsonObject(raw);
    if (!parsed) {
      return {
        response: buildFallback(schemaId, { task, role, stage, reason: "invalid-json" }),
        promptExchange: handler.consumeLastPromptExchange?.() ?? handler.getLastPromptExchange?.(),
        error: "invalid-json",
      };
    }
    const response = {
      ...parsed,
      stop_reason: parsed.stop_reason ?? "completed",
    };
    return {
      response,
      promptExchange: handler.consumeLastPromptExchange?.() ?? handler.getLastPromptExchange?.(),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      response: buildFallback(schemaId, { task, role, stage, reason: message }),
      promptExchange: handler.consumeLastPromptExchange?.() ?? handler.getLastPromptExchange?.(),
      error: message,
    };
  }
}

export async function handleNitpickCommand(context) {
  const {
    command,
    options,
    positionals,
    task: taskInput,
    promptGroupId,
    promptJournalId,
    promptJournalStatus,
    verbose,
    restClient,
    schemaRegistry,
    systemPrompt,
    contextLength,
    gpu,
    lmStudioManager,
    performanceTracker,
    archiveMetadata,
    configData,
    DEFAULT_TASK_DESCRIPTION,
    parseDirectFileReferences,
    mergeFixedReferences,
    recordLmStudioStatusSnapshot,
    describeWorkspace,
    recordAnalysisStepInJournal,
    sessionDeadline,
  } = context;

  const positionalTask = positionals.join(" ").trim();
  let task = positionalTask || taskInput;
  if (task === DEFAULT_TASK_DESCRIPTION && positionalTask) {
    task = positionalTask;
  }
  if (!task || !task.trim() || task === DEFAULT_TASK_DESCRIPTION) {
    throw new Error('nitpick expects a task via --task "<description>" or positional text.');
  }
  if (!schemaRegistry) {
    throw new Error("nitpick requires a schema registry (docs/prompts).");
  }
  const nitpickDefaults = configData?.nitpick ?? {};
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const blindFlag =
    typeof options.blind !== "undefined"
      ? Boolean(options.blind)
      : Boolean(nitpickDefaults.blind);
  const blind = blindFlag || options.mode === "blind";
  const roundsRaw =
    parseNumericSetting(options.rounds, "--rounds") ??
    parseNumericSetting(nitpickDefaults.rounds, "config.nitpick.rounds") ??
    DEFAULT_ROUNDS;
  const rounds = Math.max(1, Math.floor(roundsRaw));
  const targetRaw =
    parseNumericSetting(options["target-words"], "--target-words") ??
    parseNumericSetting(options["word-count"], "--word-count") ??
    parseNumericSetting(nitpickDefaults.targetWords, "config.nitpick.targetWords") ??
    DEFAULT_TARGET_WORDS;
  const targetWords = Math.max(100, Math.floor(targetRaw));
  const maxResultsRaw =
    parseNumericSetting(options["max-results"], "--max-results") ??
    parseNumericSetting(nitpickDefaults.maxResults, "config.nitpick.maxResults") ??
    DEFAULT_MAX_RESULTS;
  const maxResults = Math.max(1, Math.floor(maxResultsRaw));
  const maxSourcesRaw =
    parseNumericSetting(options["max-sources"], "--max-sources") ??
    parseNumericSetting(nitpickDefaults.maxSources, "config.nitpick.maxSources") ??
    DEFAULT_MAX_SOURCES;
  const maxSources = Math.max(1, Math.floor(maxSourcesRaw));
  const maxSourceCharsRaw =
    parseNumericSetting(options["max-source-chars"], "--max-source-chars") ??
    parseNumericSetting(nitpickDefaults.maxSourceChars, "config.nitpick.maxSourceChars") ??
    DEFAULT_SOURCE_CHARS;
  const maxSourceChars = Math.max(400, Math.floor(maxSourceCharsRaw));
  const researchRoundsRaw =
    parseNumericSetting(options["research-rounds"], "--research-rounds") ??
    parseNumericSetting(nitpickDefaults.researchRounds, "config.nitpick.researchRounds") ??
    1;
  const researchRounds = Math.max(1, Math.floor(researchRoundsRaw));
  const headful =
    typeof options.headful === "boolean"
      ? options.headful
      : Boolean(nitpickDefaults.headful);
  const screenshotEnabled =
    typeof options.screenshot === "boolean"
      ? options.screenshot
      : Boolean(nitpickDefaults.screenshot);
  const blockResourcesDefault = parseBooleanFlag(nitpickDefaults.blockResources, true);

  const fileRefResult = parseDirectFileReferences(task, cwd);
  const fixedReferences = fileRefResult.references;
  task = fileRefResult.cleanedTask;

  const stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
  await recordLmStudioStatusSnapshot(restClient, stateManager, {
    label: "nitpick",
    verbose,
    transport: "rest",
  });
  if (fixedReferences.length) {
    await stateManager.recordFixedReferences({
      references: fixedReferences,
      promptId: promptGroupId,
      task,
      cwd,
    });
  }

  const promptRecorder = new PromptRecorder(stateManager.baseDir);
  await promptRecorder.prepare();

  let promptJournal = null;
  if (promptJournalId) {
    promptJournal = new PromptStepJournal(stateManager.baseDir);
    await promptJournal.openSession(promptJournalId, {
      mode: "nitpick",
      task,
      command: null,
      cwd,
      promptId: promptGroupId,
      workspaceSummary: null,
      workspaceType: null,
      argv: process.argv.slice(2),
    });
    const resumeStatus = promptJournalStatus ?? "paused";
    console.log(
      `[MiniPhi] Prompt journal session "${promptJournalId}" (${resumeStatus}). Re-run with --prompt-journal ${promptJournalId} to resume.`,
    );
  }

  let workspaceContext = await describeWorkspace(cwd, {
    navigator: null,
    objective: task,
    memory: stateManager,
    mode: command,
    promptId: promptGroupId,
    promptJournalId,
    sessionDeadline,
  });
  workspaceContext = mergeFixedReferences(workspaceContext, fixedReferences);
  const intentInfo = classifyTaskIntent({
    task,
    mode: "nitpick",
    workspaceContext,
  });

  const candidatePool =
    parseList(options["model-pool"]).length
      ? parseList(options["model-pool"])
      : parseList(nitpickDefaults.modelPool).length
        ? parseList(nitpickDefaults.modelPool)
        : Array.isArray(context?.routerConfig?.models) && context.routerConfig.models.length
          ? context.routerConfig.models
          : null;

  const modelSelection = selectNitpickModels({
    task,
    workspaceContext,
    candidates: candidatePool,
    writerModel:
      options["writer-model"] ??
      options["model-a"] ??
      options.model ??
      nitpickDefaults.writerModel ??
      null,
    criticModel:
      options["critic-model"] ??
      options["model-b"] ??
      nitpickDefaults.criticModel ??
      null,
  });

  const writerModel = modelSelection.writerModel;
  const criticModel = modelSelection.criticModel;
  const lmManager =
    (lmStudioManager ?? context?.phi4?.manager ?? null) ?? undefined;

  const writer = new LMStudioHandler(lmManager, {
    systemPrompt: systemPrompt ?? undefined,
    schemaRegistry,
    modelKey: writerModel,
  });
  const critic = new LMStudioHandler(lmManager, {
    systemPrompt: systemPrompt ?? undefined,
    schemaRegistry,
    modelKey: criticModel,
  });
  writer.setPromptRecorder(promptRecorder);
  critic.setPromptRecorder(promptRecorder);
  if (performanceTracker) {
    writer.setPerformanceTracker(performanceTracker);
    critic.setPerformanceTracker(performanceTracker);
  }
  if (restClient) {
    writer.setRestClient(restClient);
    critic.setRestClient(restClient);
  }

  const executionId = archiveMetadata.executionId ?? randomUUID();
  archiveMetadata.executionId = executionId;
  const executionRegister = new TaskExecutionRegister(stateManager.baseDir);
  await executionRegister.openSession(executionId, {
    mode: "nitpick",
    task,
    command: null,
    cwd,
    promptId: promptGroupId,
    promptJournalId: promptJournalId ?? null,
    model: writerModel,
    contextLength: contextLength ?? null,
  });
  writer.setExecutionRegister?.(executionRegister, {
    executionId,
    mode: "nitpick",
    task,
    promptId: promptGroupId,
    promptJournalId: promptJournalId ?? null,
  });
  critic.setExecutionRegister?.(executionRegister, {
    executionId,
    mode: "nitpick",
    task,
    promptId: promptGroupId,
    promptJournalId: promptJournalId ?? null,
  });
  if (restClient?.setExecutionRegister) {
    restClient.setExecutionRegister(executionRegister, {
      executionId,
      mode: "nitpick",
      task,
      promptId: promptGroupId,
      promptJournalId: promptJournalId ?? null,
    });
  }

  await writer.load({ contextLength, gpu });
  if (criticModel !== writerModel) {
    await critic.load({ contextLength, gpu });
  }

  const steps = [];
  let sources = [];
  let latestDraft = "";
  let stopReason = "completed";
  let stopReasonCode = null;
  let stopReasonDetail = null;

  const planSchemaId = blind ? "nitpick-research-plan" : "nitpick-plan";
  const planPrompt = buildPlanPrompt({
    task,
    targetWords,
    schemaBlock: buildSchemaBlock(schemaRegistry, planSchemaId),
    blind,
  });
  const planStep = await runNitpickStep({
    handler: writer,
    prompt: planPrompt,
    schemaId: planSchemaId,
    label: "nitpick-plan",
    metadata: {
      mode: "nitpick",
      taskType: intentInfo.intent,
      workspaceType: intentInfo.workspaceType,
      subContext: "plan",
    },
    task,
    role: "writer",
    stage: "draft",
    sessionDeadline,
    mainPromptId: promptGroupId,
  });
  steps.push({
    label: "plan",
    schemaId: planSchemaId,
    model: writerModel,
    response: planStep.response,
    promptExchange: planStep.promptExchange,
    error: planStep.error ?? null,
  });
  if (promptJournal && promptJournalId) {
    await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
      label: "nitpick-plan",
      prompt: planPrompt,
      response: JSON.stringify(planStep.response, null, 2),
      schemaId: planSchemaId,
      toolCalls: planStep.promptExchange?.response?.tool_calls ?? null,
      toolDefinitions: planStep.promptExchange?.response?.tool_definitions ?? null,
      operations: [
        { type: "nitpick-step", status: "completed", summary: "Plan the draft" },
      ],
      metadata: {
        mode: "nitpick",
        model: writerModel,
        stopReason: planStep.response?.stop_reason ?? null,
      },
      workspaceSummary: workspaceContext?.summary ?? null,
      links: planStep.promptExchange
        ? {
            promptExchangeId: planStep.promptExchange.id ?? null,
            promptExchangePath: planStep.promptExchange.path ?? null,
          }
        : null,
    });
  }

  if (blind && Array.isArray(planStep.response?.queries) && planStep.response.queries.length) {
    const researcher = new WebResearcher();
    const shouldSave = !options["no-save"];
    const provider =
      typeof options.provider === "string"
        ? options.provider
        : typeof nitpickDefaults.provider === "string"
          ? nitpickDefaults.provider
          : "duckduckgo";
    const browserTimeoutMs =
      resolveDurationMs({
        secondsValue: options["browser-timeout"],
        secondsLabel: "--browser-timeout",
        millisValue: options["browser-timeout-ms"],
        millisLabel: "--browser-timeout-ms",
      }) ??
      (Number.isFinite(nitpickDefaults.browserTimeoutMs)
        ? nitpickDefaults.browserTimeoutMs
        : undefined);
    const browser = new WebBrowser({
      headless: !headful,
      timeoutMs: browserTimeoutMs,
      maxTextChars: maxSourceChars,
      blockResources: parseBooleanFlag(options["block-resources"], blockResourcesDefault),
      screenshotDir: screenshotEnabled
        ? path.join(stateManager.baseDir, "web", "screenshots")
        : null,
    });
    try {
      const collected = [];
      for (const query of planStep.response.queries.slice(0, maxResults)) {
        const report = await researcher.search(query, {
          provider,
          maxResults,
          includeRaw: false,
        });
        if (shouldSave) {
          await stateManager.saveResearchReport(report);
        }
        const results = report.results ?? [];
        results.slice(0, maxResults).forEach((result) => {
          if (result?.url) {
            collected.push({
              url: result.url,
              title: result.title ?? null,
              snippet: result.snippet ?? null,
            });
          }
        });
      }
      const unique = new Map();
      collected.forEach((entry) => {
        if (!unique.has(entry.url)) {
          unique.set(entry.url, entry);
        }
      });
      const selected = Array.from(unique.values()).slice(0, maxSources);
      for (const entry of selected) {
        const snapshot = await browser.fetch(entry.url, {
          includeHtml: false,
          screenshot: screenshotEnabled,
        });
        if (snapshot.screenshot) {
          snapshot.screenshot =
            path.relative(stateManager.baseDir, snapshot.screenshot) || snapshot.screenshot;
        }
        if (shouldSave) {
          await stateManager.saveWebSnapshot(snapshot);
        }
        sources.push({
          id: snapshot.id,
          url: snapshot.url,
          title: entry.title ?? snapshot.title ?? null,
          snippet: entry.snippet ?? null,
          text: clampSourceText(snapshot.text, maxSourceChars),
        });
      }
    } finally {
      await browser.close();
    }
  }

  const outline = planStep.response?.outline ?? [];
  const constraints = planStep.response?.constraints ?? [];

  const draftPrompt = buildDraftPrompt({
    task,
    outline,
    targetWords,
    constraints,
    sources,
    stage: "draft",
    schemaBlock: buildSchemaBlock(schemaRegistry, "nitpick-draft"),
    blind,
  });
  const draftStep = await runNitpickStep({
    handler: writer,
    prompt: draftPrompt,
    schemaId: "nitpick-draft",
    label: "nitpick-draft",
    metadata: {
      mode: "nitpick",
      taskType: intentInfo.intent,
      workspaceType: intentInfo.workspaceType,
      subContext: "draft",
    },
    task,
    role: "writer",
    stage: "draft",
    sessionDeadline,
    mainPromptId: promptGroupId,
  });
  latestDraft = draftStep.response?.content ?? "";
  steps.push({
    label: "draft",
    schemaId: "nitpick-draft",
    model: writerModel,
    response: draftStep.response,
    promptExchange: draftStep.promptExchange,
    error: draftStep.error ?? null,
  });
  if (promptJournal && promptJournalId) {
    await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
      label: "nitpick-draft",
      prompt: draftPrompt,
      response: JSON.stringify(draftStep.response, null, 2),
      schemaId: "nitpick-draft",
      toolCalls: draftStep.promptExchange?.response?.tool_calls ?? null,
      toolDefinitions: draftStep.promptExchange?.response?.tool_definitions ?? null,
      operations: [
        { type: "nitpick-step", status: "completed", summary: "Draft response" },
      ],
      metadata: {
        mode: "nitpick",
        model: writerModel,
        stopReason: draftStep.response?.stop_reason ?? null,
      },
      workspaceSummary: workspaceContext?.summary ?? null,
      links: draftStep.promptExchange
        ? {
            promptExchangeId: draftStep.promptExchange.id ?? null,
            promptExchangePath: draftStep.promptExchange.path ?? null,
          }
        : null,
    });
  }

  let researchRound = 1;
  for (let round = 1; round <= rounds; round += 1) {
    const critiquePrompt = buildCritiquePrompt({
      task,
      draft: latestDraft,
      sources,
      schemaBlock: buildSchemaBlock(schemaRegistry, "nitpick-critique"),
      blind,
    });
    const critiqueStep = await runNitpickStep({
      handler: critic,
      prompt: critiquePrompt,
      schemaId: "nitpick-critique",
      label: `nitpick-critique-${round}`,
      metadata: {
        mode: "nitpick",
        taskType: intentInfo.intent,
        workspaceType: intentInfo.workspaceType,
        subContext: "critique",
      },
      task,
      role: "critic",
      stage: "revision",
      sessionDeadline,
      mainPromptId: promptGroupId,
    });
    steps.push({
      label: `critique-${round}`,
      schemaId: "nitpick-critique",
      model: criticModel,
      response: critiqueStep.response,
      promptExchange: critiqueStep.promptExchange,
      error: critiqueStep.error ?? null,
    });
    if (promptJournal && promptJournalId) {
      await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
        label: `nitpick-critique-${round}`,
        prompt: critiquePrompt,
        response: JSON.stringify(critiqueStep.response, null, 2),
        schemaId: "nitpick-critique",
        toolCalls: critiqueStep.promptExchange?.response?.tool_calls ?? null,
        toolDefinitions: critiqueStep.promptExchange?.response?.tool_definitions ?? null,
        operations: [
          { type: "nitpick-step", status: "completed", summary: "Critique draft" },
        ],
        metadata: {
          mode: "nitpick",
          model: criticModel,
          stopReason: critiqueStep.response?.stop_reason ?? null,
        },
        workspaceSummary: workspaceContext?.summary ?? null,
        links: critiqueStep.promptExchange
          ? {
              promptExchangeId: critiqueStep.promptExchange.id ?? null,
              promptExchangePath: critiqueStep.promptExchange.path ?? null,
            }
          : null,
      });
    }

    if (
      blind &&
      Array.isArray(critiqueStep.response?.queries) &&
      critiqueStep.response.queries.length &&
      researchRound < researchRounds
    ) {
      const researcher = new WebResearcher();
      const shouldSave = !options["no-save"];
      const provider =
        typeof options.provider === "string"
          ? options.provider
          : typeof nitpickDefaults.provider === "string"
            ? nitpickDefaults.provider
            : "duckduckgo";
      const browser = new WebBrowser({
        headless: !headful,
        timeoutMs:
          Number.isFinite(nitpickDefaults.browserTimeoutMs)
            ? nitpickDefaults.browserTimeoutMs
            : undefined,
        maxTextChars: maxSourceChars,
        blockResources: parseBooleanFlag(options["block-resources"], blockResourcesDefault),
      });
      try {
        researchRound += 1;
        const collected = [];
        for (const query of critiqueStep.response.queries.slice(0, maxResults)) {
          const report = await researcher.search(query, {
            provider,
            maxResults,
            includeRaw: false,
          });
          if (shouldSave) {
            await stateManager.saveResearchReport(report);
          }
          const results = report.results ?? [];
          results.slice(0, maxResults).forEach((result) => {
            if (result?.url) {
              collected.push({
                url: result.url,
                title: result.title ?? null,
                snippet: result.snippet ?? null,
              });
            }
          });
        }
        const unique = new Map();
        collected.forEach((entry) => {
          if (!unique.has(entry.url)) {
            unique.set(entry.url, entry);
          }
        });
        const selected = Array.from(unique.values()).slice(0, maxSources);
        for (const entry of selected) {
          const snapshot = await browser.fetch(entry.url, {
            includeHtml: false,
            screenshot: screenshotEnabled,
          });
          if (snapshot.screenshot) {
            snapshot.screenshot =
              path.relative(stateManager.baseDir, snapshot.screenshot) || snapshot.screenshot;
          }
          if (shouldSave) {
            await stateManager.saveWebSnapshot(snapshot);
          }
          sources.push({
            id: snapshot.id,
            url: snapshot.url,
            title: entry.title ?? snapshot.title ?? null,
            snippet: entry.snippet ?? null,
            text: clampSourceText(snapshot.text, maxSourceChars),
          });
        }
      } finally {
        await browser.close();
      }
    }

    const revisionPrompt = buildDraftPrompt({
      task,
      outline,
      targetWords,
      constraints,
      critique: critiqueStep.response?.critique ?? [],
      sources,
      stage: round === rounds ? "final" : "revision",
      schemaBlock: buildSchemaBlock(schemaRegistry, "nitpick-draft"),
      blind,
    });
    const revisionStep = await runNitpickStep({
      handler: writer,
      prompt: revisionPrompt,
      schemaId: "nitpick-draft",
      label: `nitpick-revision-${round}`,
      metadata: {
        mode: "nitpick",
        taskType: intentInfo.intent,
        workspaceType: intentInfo.workspaceType,
        subContext: "revision",
      },
      task,
      role: "writer",
      stage: round === rounds ? "final" : "revision",
      sessionDeadline,
      mainPromptId: promptGroupId,
    });
    latestDraft = revisionStep.response?.content ?? latestDraft;
    steps.push({
      label: `revision-${round}`,
      schemaId: "nitpick-draft",
      model: writerModel,
      response: revisionStep.response,
      promptExchange: revisionStep.promptExchange,
      error: revisionStep.error ?? null,
    });
    if (promptJournal && promptJournalId) {
      await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
        label: `nitpick-revision-${round}`,
        prompt: revisionPrompt,
        response: JSON.stringify(revisionStep.response, null, 2),
        schemaId: "nitpick-draft",
        toolCalls: revisionStep.promptExchange?.response?.tool_calls ?? null,
        toolDefinitions: revisionStep.promptExchange?.response?.tool_definitions ?? null,
        operations: [
          { type: "nitpick-step", status: "completed", summary: "Revise draft" },
        ],
        metadata: {
          mode: "nitpick",
          model: writerModel,
          stopReason: revisionStep.response?.stop_reason ?? null,
        },
        workspaceSummary: workspaceContext?.summary ?? null,
        links: revisionStep.promptExchange
          ? {
              promptExchangeId: revisionStep.promptExchange.id ?? null,
              promptExchangePath: revisionStep.promptExchange.path ?? null,
            }
          : null,
      });
    }
  }

  if (steps.some((step) => step.error)) {
    stopReason = "partial-fallback";
    stopReasonCode = "fallback";
    stopReasonDetail = "One or more nitpick steps returned fallback JSON.";
  }

  const session = {
    id: executionId,
    task,
    mode: blind ? "blind-nitpick" : "nitpick",
    createdAt: new Date().toISOString(),
    models: {
      writer: writerModel,
      critic: criticModel,
    },
    intent: intentInfo.intent,
    workspaceType: intentInfo.workspaceType ?? null,
    settings: {
      rounds,
      targetWords,
      blind,
      maxResults,
      maxSources,
      maxSourceChars,
      researchRounds,
    },
    sources,
    steps,
    finalText: latestDraft,
    stopReason,
    stopReasonCode,
    stopReasonDetail,
  };

  const saved = await stateManager.saveNitpickSession(session);
  if (saved?.path) {
    const rel = path.relative(process.cwd(), saved.path) || saved.path;
    console.log(`[MiniPhi][Nitpick] Session saved to ${rel}`);
  }

  if (options.output) {
    const outputPath = path.resolve(options.output);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, latestDraft, "utf8");
    const rel = path.relative(process.cwd(), outputPath) || outputPath;
    console.log(`[MiniPhi][Nitpick] Final draft written to ${rel}`);
  }
  if (options.print) {
    console.log(latestDraft);
  }
}
