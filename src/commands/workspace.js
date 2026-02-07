import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import PromptRecorder from "../libs/prompt-recorder.js";
import PromptStepJournal from "../libs/prompt-step-journal.js";
import { classifyTaskIntent } from "../libs/model-selector.js";

const WORKSPACE_SUMMARY_PROMPT_BUDGET_CAP_TOKENS = 2200;
const WORKSPACE_SUMMARY_CONTEXT_BUDGET_RATIO = 0.18;
const WORKSPACE_SUMMARY_MAX_DATASET_LINES = 120;

function truncateText(text, maxChars) {
  if (typeof text !== "string") {
    return "";
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : null;
  if (!limit || trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}...`;
}

function buildCompactWorkspaceSummaryContext(workspaceContext, planResult = undefined) {
  if (!workspaceContext || typeof workspaceContext !== "object") {
    return workspaceContext ?? null;
  }
  const manifestPreview = Array.isArray(workspaceContext.manifestPreview)
    ? workspaceContext.manifestPreview.slice(0, 5).map((entry) => ({
        path: entry?.path ?? null,
        bytes: Number.isFinite(entry?.bytes) ? entry.bytes : null,
      }))
    : [];
  const fixedReferences = Array.isArray(workspaceContext.fixedReferences)
    ? workspaceContext.fixedReferences.slice(0, 3).map((entry) => ({
        path: entry?.path ?? null,
        relative: entry?.relative ?? null,
        bytes: Number.isFinite(entry?.bytes) ? entry.bytes : null,
        hash:
          typeof entry?.hash === "string" && entry.hash.length
            ? entry.hash.slice(0, 16)
            : null,
        error: entry?.error ?? null,
      }))
    : [];
  return {
    root: workspaceContext.root ?? null,
    summary: truncateText(workspaceContext.summary, 1600),
    classification: workspaceContext.classification ?? null,
    hintBlock: truncateText(workspaceContext.hintBlock, 900),
    planDirectives: truncateText(workspaceContext.planDirectives, 320),
    manifestPreview,
    readmeSnippet: truncateText(workspaceContext.readmeSnippet, 520),
    taskPlanSummary: truncateText(
      planResult?.summary ?? workspaceContext.taskPlanSummary,
      520,
    ),
    taskPlanOutline: truncateText(
      planResult?.outline ?? workspaceContext.taskPlanOutline,
      900,
    ),
    capabilitySummary: truncateText(workspaceContext.capabilitySummary, 520),
    navigationSummary: truncateText(workspaceContext.navigationSummary, 360),
    navigationBlock: truncateText(workspaceContext.navigationBlock, 640),
    helperScript: workspaceContext.helperScript
      ? {
          language: workspaceContext.helperScript.language ?? null,
          description: truncateText(workspaceContext.helperScript.description, 180),
          path: workspaceContext.helperScript.path ?? null,
        }
      : null,
    fixedReferences,
  };
}

function buildWorkspaceSummaryDataset(task, workspaceContext, planResult, options = undefined) {
  const maxLines =
    Number.isFinite(options?.maxLines) && options.maxLines > 0
      ? Math.floor(options.maxLines)
      : WORKSPACE_SUMMARY_MAX_DATASET_LINES;
  const lines = [];
  const pushLines = (text, maxChars = undefined) => {
    const normalized = truncateText(text, maxChars);
    if (!normalized) {
      return;
    }
    for (const line of normalized.split(/\r?\n/)) {
      if (lines.length >= maxLines) {
        return;
      }
      const cleaned = line.trimEnd();
      if (cleaned) {
        lines.push(cleaned);
      }
    }
  };
  if (task) {
    pushLines(`Task: ${task}`, 320);
  }
  if (workspaceContext?.summary) {
    lines.push("Workspace summary:");
    pushLines(workspaceContext.summary, 1600);
  }
  if (workspaceContext?.hintBlock) {
    lines.push("Workspace hints:");
    pushLines(workspaceContext.hintBlock, 900);
  }
  if (workspaceContext?.planDirectives) {
    pushLines(`Workspace directives: ${workspaceContext.planDirectives}`, 320);
  }
  if (Array.isArray(workspaceContext?.manifestPreview) && workspaceContext.manifestPreview.length) {
    lines.push("Manifest preview:");
    workspaceContext.manifestPreview.slice(0, 5).forEach((entry) => {
      if (!entry) {
        return;
      }
      const bytes =
        Number.isFinite(entry.bytes) && entry.bytes >= 0 ? `${entry.bytes} bytes` : "size unknown";
      pushLines(`- ${entry.path} (${bytes})`, 240);
    });
  }
  if (workspaceContext?.readmeSnippet) {
    lines.push("README excerpt:");
    pushLines(workspaceContext.readmeSnippet, 520);
  }
  if (planResult?.outline ?? workspaceContext?.taskPlanOutline) {
    lines.push("Plan outline:");
    pushLines(planResult?.outline ?? workspaceContext?.taskPlanOutline, 900);
  }
  if (workspaceContext?.navigationBlock ?? workspaceContext?.navigationSummary) {
    lines.push("Navigation summary:");
    pushLines(workspaceContext?.navigationBlock ?? workspaceContext?.navigationSummary, 640);
  }
  if (workspaceContext?.capabilitySummary) {
    lines.push("Capabilities:");
    pushLines(workspaceContext.capabilitySummary, 520);
  }
  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const normalized = line.trimEnd();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    deduped.push(normalized);
    seen.add(key);
    if (deduped.length >= maxLines) {
      break;
    }
  }
  if (deduped.length >= maxLines) {
    deduped[maxLines - 1] = `${deduped[maxLines - 1]} [dataset trimmed]`;
  }
  return deduped;
}

export async function handleWorkspaceCommand(context) {
  const {
    command,
    options,
    task: taskInput,
    implicitWorkspaceTask,
    promptId,
    promptGroupId,
    promptJournalId,
    planBranch,
    refreshPlan,
    verbose,
    restClient,
    phi4,
    analyzer,
    promptDecomposer,
    globalMemory,
    summaryLevels,
    streamOutput,
    sessionDeadline,
    archiveMetadata,
    DEFAULT_TASK_DESCRIPTION,
    parseDirectFileReferences,
    mergeFixedReferences,
    attachCommandLibraryToWorkspace,
    attachPromptCompositionsToWorkspace,
    applyPlanResultToWorkspace,
    logPlanContext,
    recordPlanStepInJournal,
    recordNavigationPlanInJournal,
    emitDecomposerNoticeIfNeeded,
    normalizePlanRecord,
    buildNavigator,
    recordLmStudioStatusSnapshot,
    describeWorkspace,
    recordAnalysisStepInJournal,
    attachContextRequestsToResult,
    handleLmStudioProtocolFailure,
    isLmStudioProtocolError,
    forceFastMode,
  } = context;

  let task = taskInput;
  let stateManager = context.stateManager;
  let promptRecorder = context.promptRecorder;
  let promptJournal = context.promptJournal;
  let workspaceContext = context.workspaceContext;

  if (task === DEFAULT_TASK_DESCRIPTION && !implicitWorkspaceTask && !options.task) {
    throw new Error(
      'Workspace mode expects a task description. Pass a free-form prompt (e.g., `miniphi "Draft README"`) or supply --task "<description>".',
    );
  }
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const fastMode = Boolean(forceFastMode);
  const skipNavigator = Boolean(options["no-navigator"]) || fastMode;
  const workspaceRefsResult = parseDirectFileReferences(task, cwd);
  const workspaceFixedReferences = workspaceRefsResult.references;
  task = workspaceRefsResult.cleanedTask;
  archiveMetadata.cwd = cwd;
  stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
  await recordLmStudioStatusSnapshot(restClient, stateManager, {
    label: "workspace",
    verbose,
    transport: "rest",
  });
  if (workspaceFixedReferences.length) {
    await stateManager.recordFixedReferences({
      references: workspaceFixedReferences,
      promptId: promptGroupId,
      task,
      cwd,
    });
  }
  promptRecorder = new PromptRecorder(stateManager.baseDir);
  await promptRecorder.prepare();
  phi4.setPromptRecorder(promptRecorder);
  const navigator = skipNavigator ? null : buildNavigator(stateManager, promptRecorder);
  workspaceContext = await describeWorkspace(cwd, {
    navigator,
    objective: task,
    memory: stateManager,
    mode: command,
    schemaId: "log-analysis",
    promptId: promptGroupId,
    promptJournalId,
    sessionDeadline,
  });
  workspaceContext = mergeFixedReferences(workspaceContext, workspaceFixedReferences);
  workspaceContext = await attachCommandLibraryToWorkspace(
    workspaceContext,
    stateManager,
    globalMemory,
    {
      limit: 8,
      verbose,
      mode: command,
      schemaId: "log-analysis",
    },
  );
  workspaceContext = await attachPromptCompositionsToWorkspace(
    workspaceContext,
    stateManager,
    globalMemory,
    {
      limit: 8,
      verbose,
    },
  );
  if (promptJournalId) {
    promptJournal = new PromptStepJournal(stateManager.baseDir);
    await promptJournal.openSession(promptJournalId, {
      mode: "workspace",
      task,
      command: null,
      cwd,
      promptId: promptGroupId,
      workspaceSummary: workspaceContext?.summary ?? null,
      workspaceType:
        workspaceContext?.classification?.domain ??
        workspaceContext?.classification?.label ??
        null,
      argv: process.argv.slice(2),
    });
  } else {
    promptJournal = null;
  }
  if (promptId) {
    const history = await stateManager.loadPromptSession(promptId);
    if (history) {
      phi4.setHistory(history);
    }
  }
  let planResult = null;
  let planSource = null;
  let resumePlan = null;
  if (promptId && !refreshPlan) {
    try {
      resumePlan = await stateManager.loadLatestPromptDecomposition({
        promptId: promptGroupId,
        mode: "workspace",
      });
      if (resumePlan) {
        planResult = normalizePlanRecord(resumePlan, planBranch);
        planSource = "resume";
        if (verbose && planResult?.planId) {
          console.log(
            `[MiniPhi] Reusing workspace plan ${planResult.planId} from prompt-id ${promptGroupId}.`,
          );
        }
      }
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load saved plan for ${promptGroupId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  if (!planResult && promptDecomposer && !fastMode) {
    try {
      planResult = await promptDecomposer.decompose({
        objective: task,
        command: null,
        workspace: workspaceContext,
        promptRecorder,
        storage: stateManager,
        mainPromptId: promptGroupId,
        promptJournalId,
        metadata: { mode: "workspace" },
        resumePlan,
        planBranch,
        sessionDeadline,
      });
      if (planResult) {
        planSource = resumePlan ? "refreshed" : "fresh";
      }
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Workspace decomposition failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    } finally {
      emitDecomposerNoticeIfNeeded();
    }
  }
  if (planResult) {
    workspaceContext = applyPlanResultToWorkspace(
      workspaceContext,
      planResult,
      planBranch,
      planSource,
    );
    logPlanContext(planResult, "[MiniPhi][Plan]");
  }
  if (promptJournal) {
    await recordPlanStepInJournal(promptJournal, promptJournalId, {
      planResult,
      objective: task,
      command: null,
      workspaceSummary: workspaceContext?.summary ?? null,
      mode: "workspace",
      planSource,
    });
    if (workspaceContext?.navigationHints) {
      await recordNavigationPlanInJournal(promptJournal, promptJournalId, {
        navigationHints: workspaceContext.navigationHints,
        workspaceSummary: workspaceContext.summary ?? null,
        objective: task,
      });
    }
  }
  console.log(`[MiniPhi][Workspace] cwd: ${cwd}`);
  console.log(`[MiniPhi][Workspace] task: ${task}`);
  if (workspaceContext?.summary) {
    console.log(`[MiniPhi][Workspace] summary: ${workspaceContext.summary}`);
  }
  if (workspaceContext?.navigationBlock) {
    console.log(`[MiniPhi][Workspace] navigation:\n${workspaceContext.navigationBlock}`);
  }
  if (workspaceContext?.promptTemplateBlock) {
    console.log(
      `[MiniPhi][Workspace] prompt templates:\n${workspaceContext.promptTemplateBlock}`,
    );
  }
  if (planResult?.outline) {
    console.log(`[MiniPhi][Workspace] plan (${planResult.planId}):\n${planResult.outline}`);
  } else if (!promptDecomposer) {
    console.log("[MiniPhi][Workspace] Prompt decomposer is not configured; skipping plan output.");
  }

  let summaryResult = null;
  if (analyzer) {
    const summaryWorkspaceContext = buildCompactWorkspaceSummaryContext(
      workspaceContext,
      planResult,
    );
    const datasetLines = buildWorkspaceSummaryDataset(
      task,
      summaryWorkspaceContext,
      planResult,
      {
        maxLines: WORKSPACE_SUMMARY_MAX_DATASET_LINES,
      },
    );
    if (datasetLines.length) {
      try {
        const taskIntent = classifyTaskIntent({
          task,
          mode: "workspace",
          workspaceContext: summaryWorkspaceContext,
        });
        summaryResult = await analyzer.analyzeDatasetLines(datasetLines, task, {
          summaryLevels,
          streamOutput,
          verbose,
          sessionDeadline,
          workspaceContext: summaryWorkspaceContext,
          promptBudgetCapTokens: WORKSPACE_SUMMARY_PROMPT_BUDGET_CAP_TOKENS,
          contextBudgetRatio: WORKSPACE_SUMMARY_CONTEXT_BUDGET_RATIO,
          promptContext: {
            scope: "workspace-summary",
            label: task,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "workspace",
              cwd,
              promptJournalId: promptJournalId ?? null,
              taskType: taskIntent.intent,
              workspaceType:
                summaryWorkspaceContext?.classification?.domain ??
                summaryWorkspaceContext?.classification?.label ??
                null,
              workspaceSummary: summaryWorkspaceContext?.summary ?? null,
              workspaceHint: summaryWorkspaceContext?.hintBlock ?? null,
              workspaceDirectives: summaryWorkspaceContext?.planDirectives ?? null,
              workspaceManifest: (summaryWorkspaceContext?.manifestPreview ?? [])
                .slice(0, 5)
                .map((entry) => entry.path),
              workspaceReadmeSnippet: summaryWorkspaceContext?.readmeSnippet ?? null,
              taskPlanId: planResult?.planId ?? null,
              taskPlanOutline: planResult?.outline ?? null,
              taskPlanBranch: summaryWorkspaceContext?.taskPlanBranch ?? null,
              taskPlanSource: summaryWorkspaceContext?.taskPlanSource ?? null,
              workspaceConnections: summaryWorkspaceContext?.connections?.hotspots ?? null,
              workspaceConnectionGraph: summaryWorkspaceContext?.connectionGraphic ?? null,
              capabilitySummary: summaryWorkspaceContext?.capabilitySummary ?? null,
              capabilities: summaryWorkspaceContext?.capabilityDetails ?? null,
              navigationSummary: summaryWorkspaceContext?.navigationSummary ?? null,
              navigationBlock: summaryWorkspaceContext?.navigationBlock ?? null,
              helperScript: summaryWorkspaceContext?.helperScript ?? null,
            },
          },
          datasetLabel: "workspace-summary",
          sourceLabel: "workspace-summary",
          fallbackCache: stateManager,
          fallbackCacheContext: {
            promptJournalId,
            mode: "workspace-summary",
          },
        });
      } catch (error) {
        if (isLmStudioProtocolError?.(error)) {
          await handleLmStudioProtocolFailure({
            error,
            mode: "workspace",
            promptJournal,
            promptJournalId,
            context: { workspaceSummary: workspaceContext?.summary ?? null },
          });
        }
        throw error;
      }
      attachContextRequestsToResult?.(summaryResult);
      if (promptJournal && summaryResult) {
        const promptExchange = summaryResult.promptExchange ?? null;
        const toolCalls = promptExchange?.response?.tool_calls ?? null;
        const toolDefinitions = promptExchange?.response?.tool_definitions ?? null;
        const links = promptExchange
          ? {
              promptExchangeId: promptExchange.id ?? null,
              promptExchangePath: promptExchange.path ?? null,
            }
          : null;
        await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
          label: "workspace-summary",
          prompt: summaryResult.prompt,
          response: summaryResult.analysis,
          schemaId: summaryResult.schemaId ?? null,
          toolCalls,
          toolDefinitions,
          operations: [
            {
              type: "workspace-summary",
              status: "completed",
              summary: `Summarized ${summaryResult.linesAnalyzed ?? 0} lines`,
            },
          ],
          metadata: {
            mode: "workspace",
            linesAnalyzed: summaryResult.linesAnalyzed ?? null,
            compressedTokens: summaryResult.compressedTokens ?? null,
            salvage: summaryResult?.analysisDiagnostics?.salvage ?? null,
            fallbackReason: summaryResult?.analysisDiagnostics?.fallbackReason ?? null,
            stopReason: summaryResult?.analysisDiagnostics?.stopReason ?? null,
            stopReasonCode: summaryResult?.analysisDiagnostics?.stopReasonCode ?? null,
            stopReasonDetail: summaryResult?.analysisDiagnostics?.stopReasonDetail ?? null,
          },
          workspaceSummary: workspaceContext?.summary ?? null,
          links,
          startedAt: summaryResult.startedAt ?? null,
          finishedAt: summaryResult.finishedAt ?? null,
        });
      }
    }
  }

  context.task = task;
  context.stateManager = stateManager;
  context.promptRecorder = promptRecorder;
  context.promptJournal = promptJournal;
  context.workspaceContext = workspaceContext;
  context.result = summaryResult;
}
