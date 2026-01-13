import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import PromptRecorder from "../libs/prompt-recorder.js";
import PromptStepJournal from "../libs/prompt-step-journal.js";

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
    promptDecomposer,
    globalMemory,
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
  const navigator = buildNavigator(stateManager);
  workspaceContext = await describeWorkspace(cwd, {
    navigator,
    objective: task,
    memory: stateManager,
    mode: command,
    schemaId: "log-analysis",
    promptId: promptGroupId,
    promptJournalId,
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
  if (!planResult && promptDecomposer) {
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

  context.task = task;
  context.stateManager = stateManager;
  context.promptRecorder = promptRecorder;
  context.promptJournal = promptJournal;
  context.workspaceContext = workspaceContext;
}
