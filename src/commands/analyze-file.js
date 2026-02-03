import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import PromptRecorder from "../libs/prompt-recorder.js";
import PromptStepJournal from "../libs/prompt-step-journal.js";
import TaskExecutionRegister from "../libs/task-execution-register.js";

export async function handleAnalyzeFileCommand(context) {
  const {
    command,
    options,
    positionals,
    task: taskInput,
    promptId,
    promptGroupId,
    promptJournalId,
    promptJournalStatus,
    planBranch,
    refreshPlan,
    verbose,
    restClient,
    phi4,
    analyzer,
    globalMemory,
    promptDecomposer,
    summaryLevels,
    streamOutput,
    timeout,
    sessionDeadline,
    chunkSize,
    resumeTruncationId,
    truncationChunkSelector,
    archiveMetadata,
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
    initializeResourceMonitor,
    runTruncationPlanHelpers,
    ensureTruncationProgressEntry,
    persistTruncationProgressSafe,
    computeTruncationProgress,
    findNextIncompleteChunk,
    buildTruncationChunkKey,
    selectTruncationChunk,
    buildLineRangeFromChunk,
    describeTruncationChunk,
    isTruncationChunkCompleted,
    runNavigatorFollowUps,
    recordAnalysisStepInJournal,
    handleLmStudioProtocolFailure,
    attachContextRequestsToResult,
    isLmStudioProtocolError,
    forceFastMode,
  } = context;

  let task = taskInput;
  let stateManager = context.stateManager;
  let promptRecorder = context.promptRecorder;
  let promptJournal = context.promptJournal;
  let workspaceContext = context.workspaceContext;
  let result = context.result;

  const fileFromFlag = options.file ?? options.path ?? positionals[0];
  if (!fileFromFlag) {
    throw new Error('Missing --file "<path>" for analyze-file mode.');
  }

  const filePath = path.resolve(fileFromFlag);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const analyzeCwd = path.dirname(filePath);
  const fastMode =
    Boolean(forceFastMode) ||
    (Boolean(sessionDeadline) && !streamOutput && Boolean(options["no-summary"]));
  const skipNavigator = Boolean(options["no-navigator"]) || Boolean(forceFastMode);
  const analyzeRefsResult = parseDirectFileReferences(task, analyzeCwd);
  const analyzeFixedReferences = analyzeRefsResult.references;
  task = analyzeRefsResult.cleanedTask;
  archiveMetadata.filePath = filePath;
  archiveMetadata.cwd = analyzeCwd;
  stateManager = new MiniPhiMemory(archiveMetadata.cwd);
  await stateManager.prepare();
  const executionId = archiveMetadata.executionId ?? randomUUID();
  archiveMetadata.executionId = executionId;
  const executionRegister = new TaskExecutionRegister(stateManager.baseDir);
  await executionRegister.openSession(executionId, {
    mode: "analyze-file",
    task,
    filePath,
    cwd: analyzeCwd,
    promptId: promptGroupId,
    promptJournalId: promptJournalId ?? null,
    model: archiveMetadata.model ?? null,
    contextLength: archiveMetadata.contextLength ?? null,
  });
  if (typeof phi4?.setExecutionRegister === "function") {
    phi4.setExecutionRegister(executionRegister, {
      executionId,
      mode: "analyze-file",
      filePath,
      cwd: analyzeCwd,
      promptId: promptGroupId,
      promptJournalId: promptJournalId ?? null,
    });
  }
  if (restClient && typeof restClient.setExecutionRegister === "function") {
    restClient.setExecutionRegister(executionRegister, {
      executionId,
      mode: "analyze-file",
      filePath,
      cwd: analyzeCwd,
      promptId: promptGroupId,
      promptJournalId: promptJournalId ?? null,
    });
  }
  await recordLmStudioStatusSnapshot(restClient, stateManager, {
    label: "analyze-file",
    verbose,
    transport: "rest",
  });
  let truncationResume = null;
  let selectedTruncationChunk = null;
  let truncationLineRange = null;
  let truncationPlanExecutionId = null;
  let truncationProgress = null;
  let truncationChunkKey = null;
  if (resumeTruncationId) {
    truncationResume = await stateManager.loadTruncationPlan(resumeTruncationId);
    if (!truncationResume) {
      console.warn(
        `[MiniPhi] No truncation plan found for execution ${resumeTruncationId}; continuing without resume.`,
      );
      truncationResume = null;
    } else if (
      !truncationResume.plan ||
      !Array.isArray(truncationResume.plan.chunkingPlan) ||
      truncationResume.plan.chunkingPlan.length === 0
    ) {
      console.warn(
        `[MiniPhi] Truncation plan ${resumeTruncationId} does not contain chunk targets; continuing without resume.`,
      );
      truncationResume = null;
    } else {
      truncationPlanExecutionId = truncationResume.executionId ?? resumeTruncationId;
      truncationProgress =
        (await stateManager.loadTruncationProgress(truncationPlanExecutionId)) ?? {
          executionId: truncationPlanExecutionId,
          chunks: {},
        };
      selectedTruncationChunk = selectTruncationChunk(truncationResume, truncationChunkSelector);
      if (selectedTruncationChunk) {
        truncationChunkKey = buildTruncationChunkKey(selectedTruncationChunk);
        if (
          !truncationChunkSelector &&
          truncationProgress &&
          truncationChunkKey &&
          isTruncationChunkCompleted(truncationProgress, truncationChunkKey)
        ) {
          const nextChunk = findNextIncompleteChunk(
            truncationResume,
            truncationProgress,
            truncationChunkKey,
          );
          if (nextChunk) {
            selectedTruncationChunk = nextChunk;
            truncationChunkKey = buildTruncationChunkKey(nextChunk);
            console.log(
              `[MiniPhi] Skipping previously completed truncation chunk; focusing ${describeTruncationChunk(nextChunk)}.`,
            );
          } else {
            console.log(
              "[MiniPhi] All truncation plan chunks are marked completed; rerunning the last chunk.",
            );
          }
        }
        truncationLineRange = buildLineRangeFromChunk(selectedTruncationChunk);
        const chunkLabel = describeTruncationChunk(selectedTruncationChunk);
        console.log(
          `[MiniPhi] Loaded truncation plan ${resumeTruncationId} (${truncationResume.plan.chunkingPlan.length} chunk target${truncationResume.plan.chunkingPlan.length === 1 ? "" : "s"}). Focusing ${chunkLabel}.`,
        );
      }
    }
  }
  if (analyzeFixedReferences.length) {
    await stateManager.recordFixedReferences({
      references: analyzeFixedReferences,
      promptId: promptGroupId,
      task,
      cwd: analyzeCwd,
    });
  }
  promptRecorder = new PromptRecorder(stateManager.baseDir);
  await promptRecorder.prepare();
  const navigator = fastMode || skipNavigator ? null : buildNavigator(stateManager, promptRecorder);
  workspaceContext = await describeWorkspace(analyzeCwd, {
    navigator,
    objective: task,
    memory: stateManager,
    mode: command,
    schemaId: "log-analysis",
    focusPath: filePath,
    promptId: promptGroupId,
    promptJournalId,
    sessionDeadline,
  });
  workspaceContext = mergeFixedReferences(workspaceContext, analyzeFixedReferences);
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
  if (truncationResume) {
    workspaceContext = {
      ...(workspaceContext ?? {}),
      truncationPlan: {
        ...truncationResume,
        executionId: truncationPlanExecutionId ?? resumeTruncationId,
        selectedChunk: selectedTruncationChunk,
      },
    };
  }
  if (promptJournalId) {
    promptJournal = new PromptStepJournal(stateManager.baseDir);
    await promptJournal.openSession(promptJournalId, {
      mode: "analyze-file",
      task,
      command: filePath,
      cwd: analyzeCwd,
      promptId: promptGroupId,
      workspaceSummary: workspaceContext?.summary ?? null,
      workspaceType:
        workspaceContext?.classification?.domain ??
        workspaceContext?.classification?.label ??
        null,
      argv: process.argv.slice(2),
    });
    const resumeStatus = promptJournalStatus ?? "paused";
    console.log(
      `[MiniPhi] Prompt journal session "${promptJournalId}" (${resumeStatus}). Re-run with --prompt-journal ${promptJournalId} to resume.`,
    );
  } else {
    promptJournal = null;
  }
  let planResult = null;
  let planSource = null;
  let resumePlan = null;
  phi4.setPromptRecorder(promptRecorder);
  if (verbose) {
    console.log(`[MiniPhi] Prompt recorder enabled (main id: ${promptGroupId})`);
  }
  if (promptId) {
    const history = await stateManager.loadPromptSession(promptId);
    if (history) {
      phi4.setHistory(history);
    }
  }
  if (promptId && !refreshPlan) {
    try {
      resumePlan = await stateManager.loadLatestPromptDecomposition({
        promptId: promptGroupId,
        mode: "analyze-file",
      });
      if (resumePlan) {
        planResult = normalizePlanRecord(resumePlan, planBranch);
        planSource = "resume";
        if (verbose && planResult?.planId) {
          console.log(
            `[MiniPhi] Reusing analyze-file plan ${planResult.planId} from prompt-id ${promptGroupId}.`,
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
        command: filePath,
        workspace: workspaceContext,
        promptRecorder,
        storage: stateManager,
        mainPromptId: promptGroupId,
        promptJournalId,
        metadata: { mode: "analyze-file" },
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
          `[MiniPhi] Prompt decomposition failed: ${error instanceof Error ? error.message : error}`,
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
    if (planResult.outline && verbose) {
      const outlineLines = planResult.outline.split(/\r?\n/);
      const preview = outlineLines.slice(0, 10).join("\n");
      const suffix = outlineLines.length > 10 ? "\n..." : "";
      console.log(`[MiniPhi] Prompt plan (${planResult.planId}):\n${preview}${suffix}`);
    }
    logPlanContext(planResult, "[MiniPhi][Plan:analyze]");
  }
  if (promptJournal) {
    await recordPlanStepInJournal(promptJournal, promptJournalId, {
      planResult,
      objective: task,
      command: filePath,
      workspaceSummary: workspaceContext?.summary ?? null,
      mode: "analyze-file",
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
  await initializeResourceMonitor(
    `analyze:${path.basename(filePath)}`,
    stateManager?.resourceUsageFile ?? null,
  );
  if (truncationResume && selectedTruncationChunk && truncationPlanExecutionId) {
    const helperRuns = await runTruncationPlanHelpers({
      planRecord: truncationResume,
      chunk: selectedTruncationChunk,
      chunkKey: truncationChunkKey,
      cwd: analyzeCwd,
      workspaceContext,
      summaryLevels,
      streamOutput,
      timeout,
      sessionDeadline,
      promptGroupId,
      promptJournal,
      promptJournalId,
      planExecutionId: truncationPlanExecutionId,
    });
    if (
      helperRuns.length &&
      truncationProgress &&
      truncationPlanExecutionId &&
      truncationChunkKey
    ) {
      const chunkEntry = ensureTruncationProgressEntry(
        truncationProgress,
        truncationChunkKey,
        selectedTruncationChunk,
      );
      const timestamp = new Date().toISOString();
      chunkEntry.lastHelperAt = timestamp;
      chunkEntry.helpers = chunkEntry.helpers ?? [];
      helperRuns.forEach((run) => {
        chunkEntry.helpers.unshift({
          command: run.command,
          status: run.status,
          note: run.note ?? run.fallbackReason ?? null,
          recordedAt: timestamp,
        });
      });
      const MAX_HISTORY = 8;
      chunkEntry.helpers = chunkEntry.helpers.slice(0, MAX_HISTORY);
      await persistTruncationProgressSafe(
        stateManager,
        truncationPlanExecutionId,
        truncationProgress,
      );
    }
  }
  try {
    result = await analyzer.analyzeLogFile(filePath, task, {
      summaryLevels,
      streamOutput,
      maxLinesPerChunk: chunkSize,
      sessionDeadline,
      workspaceContext,
      lineRange: truncationLineRange ?? null,
      promptContext: {
        scope: "main",
        label: task,
        mainPromptId: promptGroupId,
        metadata: {
          mode: "analyze-file",
          filePath,
          cwd: analyzeCwd,
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
          truncationResume: truncationResume
            ? {
                executionId: truncationPlanExecutionId ?? resumeTruncationId ?? null,
                chunkGoal: selectedTruncationChunk?.goal ?? selectedTruncationChunk?.label ?? null,
                chunkKey: truncationChunkKey ?? null,
                lineRange: truncationLineRange ?? null,
              }
            : null,
        },
      },
      fallbackCache: stateManager,
      fallbackCacheContext: {
        promptJournalId,
        mode: "analyze-file",
        filePath,
      },
    });
  } catch (error) {
    if (isLmStudioProtocolError(error)) {
      await handleLmStudioProtocolFailure({
        error,
        mode: "analyze-file",
        promptJournal,
        promptJournalId,
        context: { workspaceSummary: workspaceContext?.summary ?? null },
      });
    }
    throw error;
    }
    attachContextRequestsToResult(result);
    if (promptJournal && result) {
      const promptExchange = result.promptExchange ?? null;
      const toolCalls = promptExchange?.response?.tool_calls ?? null;
      const toolDefinitions = promptExchange?.response?.tool_definitions ?? null;
      const links = promptExchange
        ? {
            promptExchangeId: promptExchange.id ?? null,
            promptExchangePath: promptExchange.path ?? null,
          }
        : null;
      await recordAnalysisStepInJournal(promptJournal, promptJournalId, {
        label: `analyze-file:${path.basename(filePath)}`,
        prompt: result.prompt,
        response: result.analysis,
        schemaId: result.schemaId ?? null,
        toolCalls,
        toolDefinitions,
      operations: [
        {
          type: "file-analysis",
          file: filePath,
          status: "completed",
          summary: `Analyzed ${result.linesAnalyzed ?? 0} lines`,
        },
      ],
      metadata: {
        mode: "analyze-file",
        linesAnalyzed: result.linesAnalyzed ?? null,
        compressedTokens: result.compressedTokens ?? null,
        truncationResume: truncationResume
          ? {
              executionId: truncationPlanExecutionId ?? resumeTruncationId ?? null,
              chunkGoal: selectedTruncationChunk?.goal ?? selectedTruncationChunk?.label ?? null,
              chunkKey: truncationChunkKey ?? null,
              lineRange: truncationLineRange ?? null,
            }
          : null,
        salvage: result?.analysisDiagnostics?.salvage ?? null,
        fallbackReason: result?.analysisDiagnostics?.fallbackReason ?? null,
        stopReason: result?.analysisDiagnostics?.stopReason ?? null,
        stopReasonCode: result?.analysisDiagnostics?.stopReasonCode ?? null,
        stopReasonDetail: result?.analysisDiagnostics?.stopReasonDetail ?? null,
      },
        workspaceSummary: workspaceContext?.summary ?? null,
        links,
        startedAt: result.startedAt ?? null,
        finishedAt: result.finishedAt ?? null,
      });
    }
  if (
    truncationResume &&
    truncationProgress &&
    truncationPlanExecutionId &&
    truncationChunkKey &&
    selectedTruncationChunk
  ) {
    const chunkEntry = ensureTruncationProgressEntry(
      truncationProgress,
      truncationChunkKey,
      selectedTruncationChunk,
    );
    const completionTimestamp = new Date().toISOString();
    chunkEntry.completedAt = completionTimestamp;
    chunkEntry.lastRunAt = completionTimestamp;
    await persistTruncationProgressSafe(
      stateManager,
      truncationPlanExecutionId,
      truncationProgress,
    );
    const stats = computeTruncationProgress(truncationResume, truncationProgress);
    if (stats.total > 0) {
      const plural = stats.total === 1 ? "" : "s";
      console.log(
        `[MiniPhi] Truncation plan progress: ${stats.completed}/${stats.total} chunk${plural} complete for execution ${truncationPlanExecutionId}.`,
      );
    }
    const nextChunk = findNextIncompleteChunk(truncationResume, truncationProgress);
    if (nextChunk) {
      const nextLabel = describeTruncationChunk(nextChunk);
      const selectorHint = nextChunk.goal ?? nextChunk.label ?? nextChunk.id ?? null;
      const selectorSuffix = selectorHint ? ` --truncation-chunk "${selectorHint}"` : "";
      console.log(
        `[MiniPhi] Next chunk suggestion: ${nextLabel}. Resume with --resume-truncation ${truncationPlanExecutionId}${selectorSuffix}.`,
      );
    } else if (stats.total > 0) {
      console.log(
        `[MiniPhi] All truncation plan chunks completed for execution ${truncationPlanExecutionId}.`,
      );
    }
  }
  const analyzeNavigatorActions = skipNavigator
    ? []
    : (workspaceContext?.navigationHints?.actions ?? []).length > 0
      ? workspaceContext.navigationHints.actions
      : (workspaceContext?.navigationHints?.focusCommands ?? []).map((command) => ({
          command,
          danger: "mid",
        }));
  if (analyzeNavigatorActions.length) {
    const followUps = await runNavigatorFollowUps({
      commands: analyzeNavigatorActions,
      cwd: analyzeCwd,
      workspaceContext,
      summaryLevels,
      streamOutput,
      timeout,
      sessionDeadline,
      promptGroupId,
      baseMetadata: {
        parentCommand: filePath,
        parentMode: "analyze-file",
        workspaceSummary: workspaceContext?.summary ?? null,
      },
      promptJournal,
      promptJournalId,
    });
    if (followUps.length) {
      result.navigatorFollowUps = followUps;
    }
  }

  context.task = task;
  context.stateManager = stateManager;
  context.promptRecorder = promptRecorder;
  context.promptJournal = promptJournal;
  context.workspaceContext = workspaceContext;
  context.result = result;
}
