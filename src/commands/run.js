import path from "path";
import { randomUUID } from "crypto";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import PromptRecorder from "../libs/prompt-recorder.js";
import PromptStepJournal from "../libs/prompt-step-journal.js";
import { normalizeDangerLevel } from "../libs/core-utils.js";
import TaskExecutionRegister from "../libs/task-execution-register.js";

export async function handleRunCommand(context) {
  const {
    command,
    options,
    positionals,
    task: taskInput,
    promptId,
    promptGroupId,
    promptJournalId,
    planBranch,
    refreshPlan,
    defaults,
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

  const cmd = options.cmd ?? positionals.join(" ");
  if (!cmd) {
    throw new Error('Missing --cmd "<command>" for run mode.');
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const fastMode =
    Boolean(forceFastMode) ||
    (Boolean(sessionDeadline) && !streamOutput && Boolean(options["no-summary"]));
  const skipNavigator = Boolean(options["no-navigator"]) || Boolean(forceFastMode);
  const fileRefResult = parseDirectFileReferences(task, cwd);
  const fixedReferences = fileRefResult.references;
  task = fileRefResult.cleanedTask;
  const userCommandDanger = normalizeDangerLevel(
    options["command-danger"] ?? defaults.commandDanger ?? "mid",
  );
  archiveMetadata.command = cmd;
  archiveMetadata.cwd = cwd;
  stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
  const executionId = archiveMetadata.executionId ?? randomUUID();
  archiveMetadata.executionId = executionId;
  const executionRegister = new TaskExecutionRegister(stateManager.baseDir);
  await executionRegister.openSession(executionId, {
    mode: "run",
    task,
    command: cmd,
    cwd,
    promptId: promptGroupId,
    promptJournalId: promptJournalId ?? null,
    model: archiveMetadata.model ?? null,
    contextLength: archiveMetadata.contextLength ?? null,
  });
  if (typeof phi4?.setExecutionRegister === "function") {
    phi4.setExecutionRegister(executionRegister, {
      executionId,
      mode: "run",
      command: cmd,
      cwd,
      promptId: promptGroupId,
      promptJournalId: promptJournalId ?? null,
    });
  }
  if (restClient && typeof restClient.setExecutionRegister === "function") {
    restClient.setExecutionRegister(executionRegister, {
      executionId,
      mode: "run",
      command: cmd,
      cwd,
      promptId: promptGroupId,
      promptJournalId: promptJournalId ?? null,
    });
  }
  await recordLmStudioStatusSnapshot(restClient, stateManager, {
    label: "run",
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
  promptRecorder = new PromptRecorder(stateManager.baseDir);
  await promptRecorder.prepare();
  phi4.setPromptRecorder(promptRecorder);
  const navigator = fastMode || skipNavigator ? null : buildNavigator(stateManager, promptRecorder);
  workspaceContext = await describeWorkspace(cwd, {
    navigator,
    objective: task,
    memory: stateManager,
    mode: command,
    promptId: promptGroupId,
    promptJournalId,
    sessionDeadline,
  });
  workspaceContext = mergeFixedReferences(workspaceContext, fixedReferences);
  workspaceContext = await attachCommandLibraryToWorkspace(
    workspaceContext,
    stateManager,
    globalMemory,
    {
      limit: 8,
      verbose,
      mode: command,
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
      mode: "run",
      task,
      command: cmd,
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
        mode: "run",
      });
      if (resumePlan) {
        planResult = normalizePlanRecord(resumePlan, planBranch);
        planSource = "resume";
        if (verbose && planResult?.planId) {
          console.log(
            `[MiniPhi] Reusing run plan ${planResult.planId} from prompt-id ${promptGroupId}.`,
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
        command: cmd,
        workspace: workspaceContext,
        promptRecorder,
        storage: stateManager,
        mainPromptId: promptGroupId,
        promptJournalId,
        metadata: { mode: "run" },
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
    logPlanContext(planResult, "[MiniPhi][Plan:run]");
  }
  if (promptJournal) {
    await recordPlanStepInJournal(promptJournal, promptJournalId, {
      planResult,
      objective: task,
      command: cmd,
      workspaceSummary: workspaceContext?.summary ?? null,
      mode: "run",
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
  await initializeResourceMonitor(`run:${cmd}`, stateManager?.resourceUsageFile ?? null);
  try {
    result = await analyzer.analyzeCommandOutput(cmd, task, {
      summaryLevels,
      verbose,
      streamOutput,
      cwd,
      timeout,
      sessionDeadline,
      workspaceContext,
      promptContext: {
        scope: "main",
        label: task,
        mainPromptId: promptGroupId,
        metadata: {
          mode: "run",
          command: cmd,
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
      commandDanger: userCommandDanger,
      commandSource: "user",
      authorizationContext: {
        reason: "Primary --cmd execution",
      },
      fallbackCache: stateManager,
      fallbackCacheContext: {
        promptJournalId,
        mode: "run",
        command: cmd,
        cwd,
      },
    });
  } catch (error) {
    if (isLmStudioProtocolError(error)) {
      await handleLmStudioProtocolFailure({
        error,
        mode: "run",
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
        label: `run:${cmd}`,
        prompt: result.prompt,
        response: result.analysis,
        schemaId: result.schemaId ?? null,
        toolCalls,
        toolDefinitions,
      operations: [
        {
          type: "command",
          command: cmd,
          cwd,
          danger: userCommandDanger,
          status: "executed",
          summary: `Captured ${result.linesAnalyzed ?? 0} lines`,
        },
      ],
      metadata: {
        mode: "run",
        linesAnalyzed: result.linesAnalyzed ?? null,
        compressedTokens: result.compressedTokens ?? null,
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
  const navigatorActions = skipNavigator
    ? []
    : (workspaceContext?.navigationHints?.actions ?? []).length > 0
      ? workspaceContext.navigationHints.actions
      : (workspaceContext?.navigationHints?.focusCommands ?? []).map((command) => ({
          command,
          danger: "mid",
        }));
  if (navigatorActions.length) {
    const followUps = await runNavigatorFollowUps({
      commands: navigatorActions,
      cwd,
      workspaceContext,
      summaryLevels,
      streamOutput,
      timeout,
      sessionDeadline,
      promptGroupId,
      baseMetadata: {
        parentCommand: cmd,
        parentMode: "run",
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
