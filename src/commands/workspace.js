import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import PromptRecorder from "../libs/prompt-recorder.js";
import PromptStepJournal from "../libs/prompt-step-journal.js";

function buildWorkspaceSummaryDataset(task, workspaceContext, planResult) {
  const lines = [];
  if (task) {
    lines.push(`Task: ${task}`);
  }
  if (workspaceContext?.summary) {
    lines.push("Workspace summary:");
    lines.push(workspaceContext.summary);
  }
  if (workspaceContext?.hintBlock) {
    lines.push("Workspace hints:");
    lines.push(workspaceContext.hintBlock);
  }
  if (workspaceContext?.planDirectives) {
    lines.push(`Workspace directives: ${workspaceContext.planDirectives}`);
  }
  if (Array.isArray(workspaceContext?.manifestPreview) && workspaceContext.manifestPreview.length) {
    lines.push("Manifest preview:");
    workspaceContext.manifestPreview.slice(0, 8).forEach((entry) => {
      if (!entry) {
        return;
      }
      const bytes =
        Number.isFinite(entry.bytes) && entry.bytes >= 0 ? `${entry.bytes} bytes` : "size unknown";
      lines.push(`- ${entry.path} (${bytes})`);
    });
  }
  if (workspaceContext?.readmeSnippet) {
    lines.push("README excerpt:");
    lines.push(workspaceContext.readmeSnippet);
  }
  if (planResult?.outline) {
    lines.push("Plan outline:");
    lines.push(planResult.outline);
  }
  if (workspaceContext?.navigationBlock) {
    lines.push("Navigation summary:");
    lines.push(workspaceContext.navigationBlock);
  }
  if (workspaceContext?.capabilitySummary) {
    lines.push("Capabilities:");
    lines.push(workspaceContext.capabilitySummary);
  }
  return lines
    .flatMap((line) => line.split(/\r?\n/))
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
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
    const datasetLines = buildWorkspaceSummaryDataset(task, workspaceContext, planResult);
    if (datasetLines.length) {
      try {
        summaryResult = await analyzer.analyzeDatasetLines(datasetLines, task, {
          summaryLevels,
          streamOutput,
          verbose,
          sessionDeadline,
          workspaceContext,
          promptContext: {
            scope: "workspace-summary",
            label: task,
            mainPromptId: promptGroupId,
            metadata: {
              mode: "workspace",
              cwd,
              promptJournalId: promptJournalId ?? null,
              workspaceType:
                workspaceContext?.classification?.domain ??
                workspaceContext?.classification?.label ??
                null,
              workspaceSummary: workspaceContext?.summary ?? null,
              workspaceHint: workspaceContext?.hintBlock ?? null,
              workspaceDirectives: workspaceContext?.planDirectives ?? null,
              workspaceManifest: (workspaceContext?.manifestPreview ?? [])
                .slice(0, 5)
                .map((entry) => entry.path),
              workspaceReadmeSnippet: workspaceContext?.readmeSnippet ?? null,
              taskPlanId: planResult?.planId ?? null,
              taskPlanOutline: planResult?.outline ?? null,
              taskPlanBranch: workspaceContext?.taskPlanBranch ?? null,
              taskPlanSource: workspaceContext?.taskPlanSource ?? null,
              workspaceConnections: workspaceContext?.connections?.hotspots ?? null,
              workspaceConnectionGraph: workspaceContext?.connectionGraphic ?? null,
              capabilitySummary: workspaceContext?.capabilitySummary ?? null,
              capabilities: workspaceContext?.capabilityDetails ?? null,
              navigationSummary: workspaceContext?.navigationSummary ?? null,
              navigationBlock: workspaceContext?.navigationBlock ?? null,
              helperScript: workspaceContext?.helperScript ?? null,
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
