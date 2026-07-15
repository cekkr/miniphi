import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import PromptRecorder from "../libs/prompt-recorder.js";
import PromptStepJournal from "../libs/prompt-step-journal.js";
import { classifyTaskIntent } from "../libs/model-selector.js";
import {
  buildExecutedActionsBlock,
  buildPlanProgress,
  buildSnippetContextBlock,
  executeFocusedBranchActions,
  resolveMissingSnippets,
} from "../libs/plan-executor.js";

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
    taskPlanFocusBranch:
      planResult?.focusBranch ??
      workspaceContext.taskPlanFocusBranch ??
      workspaceContext.taskPlanBranch ??
      null,
    taskPlanFocusReason: planResult?.focusReason ?? workspaceContext.taskPlanFocusReason ?? null,
    taskPlanFocusSegmentBlock: truncateText(
      planResult?.focusSegmentBlock ?? workspaceContext.taskPlanFocusSegmentBlock,
      900,
    ),
    taskPlanNextSubpromptBranch:
      planResult?.nextSubpromptBranch ?? workspaceContext.taskPlanNextSubpromptBranch ?? null,
    capabilitySummary: truncateText(workspaceContext.capabilitySummary, 520),
    navigationSummary: truncateText(workspaceContext.navigationSummary, 360),
    navigationBlock: truncateText(workspaceContext.navigationBlock, 640),
    executedActionsBlock: truncateText(workspaceContext.executedActionsBlock, 1400),
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
  if (workspaceContext?.taskPlanFocusSegmentBlock) {
    const branchLabel = workspaceContext.taskPlanFocusBranch ?? "auto";
    lines.push(`Plan focus (${branchLabel}):`);
    pushLines(workspaceContext.taskPlanFocusSegmentBlock, 900);
  }
  if (workspaceContext?.taskPlanNextSubpromptBranch) {
    pushLines(
      `Next suggested sub-prompt branch: ${workspaceContext.taskPlanNextSubpromptBranch}`,
      180,
    );
  }
  if (workspaceContext?.executedActionsBlock) {
    pushLines(workspaceContext.executedActionsBlock, 1400);
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
  if (planResult && !fastMode) {
    const actionSegments =
      Array.isArray(planResult.focusSegments) && planResult.focusSegments.length
        ? planResult.focusSegments
        : Array.isArray(planResult.segments)
          ? planResult.segments.slice(0, 6)
          : [];
    if (actionSegments.length) {
      let previousProgress = null;
      try {
        previousProgress = await stateManager.loadPlanProgress(planResult.planId);
      } catch {
        previousProgress = null;
      }
      const execution = await executeFocusedBranchActions({
        segments: actionSegments,
        cwd,
        sessionDeadline,
        logger: verbose ? (message) => console.warn(message) : null,
      });
      const executedBlock = buildExecutedActionsBlock(execution.results);
      if (executedBlock) {
        workspaceContext = { ...workspaceContext, executedActionsBlock: executedBlock };
      }
      const progress = buildPlanProgress({
        planId: planResult.planId,
        focusBranch: planResult.focusBranch ?? null,
        results: execution.results,
        previous: previousProgress,
      });
      try {
        const saved = await stateManager.savePlanProgress(planResult.planId, progress);
        if (verbose && saved?.path) {
          const rel = path.relative(cwd, saved.path) || saved.path;
          console.log(`[MiniPhi][Plan] Progress saved to ${rel}`);
        }
      } catch (error) {
        if (verbose) {
          console.warn(
            `[MiniPhi][Plan] Unable to save plan progress: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      if (execution.executedCount > 0) {
        console.log(
          `[MiniPhi][Plan] Executed ${execution.executedCount} plan action(s) from branch ${planResult.focusBranch ?? "auto"}.`,
        );
      }
      if (progress.firstIncompleteBranch) {
        console.log(
          `[MiniPhi][Plan] First incomplete branch: ${progress.firstIncompleteBranch} (resume with --plan-branch ${progress.firstIncompleteBranch}).`,
        );
      }
      if (promptJournal) {
        await promptJournal.appendStep(promptJournalId, {
          label: "plan-actions",
          status: "recorded",
          operations: execution.results.map((entry) => ({
            type: entry.action?.type ?? "unmapped",
            status: entry.status,
            summary: `step ${entry.branch ?? "?"}: ${entry.title ?? ""}`.trim(),
            target:
              entry.action?.target ?? entry.action?.term ?? entry.action?.command ?? null,
            error: entry.error ?? null,
          })),
          metadata: {
            mode: "workspace",
            planId: planResult.planId ?? null,
            focusBranch: planResult.focusBranch ?? null,
            executedCount: execution.executedCount,
            firstIncompleteBranch: progress.firstIncompleteBranch ?? null,
          },
          workspaceSummary: workspaceContext?.summary ?? null,
        });
      }
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
      const taskIntent = classifyTaskIntent({
        task,
        mode: "workspace",
        workspaceContext: summaryWorkspaceContext,
      });
      const planSubContext = summaryWorkspaceContext?.taskPlanFocusBranch
        ? `plan-${summaryWorkspaceContext.taskPlanFocusBranch}`
        : summaryWorkspaceContext?.taskPlanBranch
          ? `plan-${summaryWorkspaceContext.taskPlanBranch}`
          : "workspace-summary";
      const summaryPromptMetadata = {
        mode: "workspace",
        subContext: planSubContext,
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
        taskPlanFocusBranch: summaryWorkspaceContext?.taskPlanFocusBranch ?? null,
        taskPlanFocusReason: summaryWorkspaceContext?.taskPlanFocusReason ?? null,
        taskPlanFocusSegmentBlock:
          summaryWorkspaceContext?.taskPlanFocusSegmentBlock ?? null,
        taskPlanNextSubpromptBranch:
          summaryWorkspaceContext?.taskPlanNextSubpromptBranch ?? null,
        taskPlanSource: summaryWorkspaceContext?.taskPlanSource ?? null,
        workspaceConnections: summaryWorkspaceContext?.connections?.hotspots ?? null,
        workspaceConnectionGraph: summaryWorkspaceContext?.connectionGraphic ?? null,
        capabilitySummary: summaryWorkspaceContext?.capabilitySummary ?? null,
        capabilities: summaryWorkspaceContext?.capabilityDetails ?? null,
        navigationSummary: summaryWorkspaceContext?.navigationSummary ?? null,
        navigationBlock: summaryWorkspaceContext?.navigationBlock ?? null,
        helperScript: summaryWorkspaceContext?.helperScript ?? null,
      };
      const runWorkspaceSummary = (lines, { scope = "workspace-summary", extraMetadata = null } = {}) =>
        analyzer.analyzeDatasetLines(lines, task, {
          summaryLevels,
          streamOutput,
          verbose,
          sessionDeadline,
          workspaceContext: summaryWorkspaceContext,
          promptBudgetCapTokens: WORKSPACE_SUMMARY_PROMPT_BUDGET_CAP_TOKENS,
          contextBudgetRatio: WORKSPACE_SUMMARY_CONTEXT_BUDGET_RATIO,
          promptContext: {
            scope,
            label: task,
            mainPromptId: promptGroupId,
            metadata: { ...summaryPromptMetadata, ...(extraMetadata ?? {}) },
          },
          datasetLabel: scope,
          sourceLabel: scope,
          fallbackCache: stateManager,
          fallbackCacheContext: {
            promptJournalId,
            mode: scope,
          },
        });
      try {
        summaryResult = await runWorkspaceSummary(datasetLines);
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

      // Missing-snippet round-trip: when the model asks for repo-relative
      // files, fetch them and re-prompt once instead of dying on stdout.
      const missingSnippets = Array.isArray(summaryResult?.analysis?.missing_snippets)
        ? summaryResult.analysis.missing_snippets
        : [];
      const sessionExhausted =
        Number.isFinite(sessionDeadline) && sessionDeadline > 0 && Date.now() >= sessionDeadline;
      if (
        Boolean(summaryResult?.analysis?.needs_more_context) &&
        missingSnippets.length &&
        !fastMode &&
        !sessionExhausted
      ) {
        const { resolved } = await resolveMissingSnippets({ snippets: missingSnippets, cwd });
        if (resolved.length) {
          const snippetBlock = buildSnippetContextBlock(resolved);
          const snippetPaths = resolved.map((entry) => entry.path);
          console.log(
            `[MiniPhi][Workspace] Auto-fetched ${resolved.length} requested snippet(s): ${snippetPaths.join(", ")}; re-prompting once.`,
          );
          const retryDataset = [...datasetLines, ...snippetBlock.split(/\r?\n/)];
          let retryResult = null;
          try {
            retryResult = await runWorkspaceSummary(retryDataset, {
              scope: "workspace-summary-snippets",
              extraMetadata: { snippetRoundTrip: true, snippetPaths },
            });
          } catch (error) {
            if (verbose) {
              console.warn(
                `[MiniPhi][Workspace] Snippet re-prompt failed: ${error instanceof Error ? error.message : error}`,
              );
            }
          }
          if (promptJournal) {
            await promptJournal.appendStep(promptJournalId, {
              label: "workspace-summary-snippets",
              status: retryResult?.analysis ? "completed" : "failed",
              response: retryResult?.analysis ?? null,
              schemaId: retryResult?.schemaId ?? null,
              operations: [
                {
                  type: "missing-snippets-roundtrip",
                  status: retryResult?.analysis ? "completed" : "failed",
                  summary: `Auto-fetched ${snippetPaths.join(", ")}`,
                },
              ],
              metadata: {
                mode: "workspace",
                snippetRoundTrip: true,
                snippetPaths,
                fallbackReason: retryResult?.analysisDiagnostics?.fallbackReason ?? null,
              },
              workspaceSummary: workspaceContext?.summary ?? null,
            });
          }
          if (retryResult?.analysis && !retryResult.analysisDiagnostics?.fallbackReason) {
            retryResult.snippetRoundTrip = { snippetPaths, requested: missingSnippets };
            summaryResult = retryResult;
          }
        }
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
