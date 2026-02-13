import { handleAnalyzeFileCommand } from "./analyze-file.js";
import { handleNitpickCommand } from "./nitpick.js";
import { handleRunCommand } from "./run.js";
import { handleWorkspaceCommand } from "./workspace.js";

function extractMutableState(context = undefined) {
  return {
    task: context?.task,
    stateManager: context?.stateManager ?? null,
    promptRecorder: context?.promptRecorder ?? null,
    promptJournal: context?.promptJournal ?? null,
    workspaceContext: context?.workspaceContext ?? null,
    result: context?.result,
  };
}

export function buildPrimaryCommandContext(context = undefined) {
  if (!context || typeof context !== "object") {
    return {};
  }
  return {
    ...context,
  };
}

export async function executePrimaryCommand(commandContext) {
  const command = commandContext?.command;
  if (command === "workspace") {
    await handleWorkspaceCommand(commandContext);
    return {
      ...extractMutableState(commandContext),
      skipPostAnalysis: true,
      handledBy: "workspace",
    };
  }
  if (command === "nitpick") {
    await handleNitpickCommand(commandContext);
    return {
      ...extractMutableState(commandContext),
      skipPostAnalysis: true,
      handledBy: "nitpick",
    };
  }
  if (command === "run") {
    await handleRunCommand(commandContext);
  } else if (command === "analyze-file") {
    await handleAnalyzeFileCommand(commandContext);
  }
  return {
    ...extractMutableState(commandContext),
    skipPostAnalysis: false,
    handledBy: command ?? "unknown",
  };
}
