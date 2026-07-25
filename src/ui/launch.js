import { render } from "ink";
import { html } from "./html.js";
import App from "./app.js";
import AgentSession from "../agent/agent-session.js";
import { createUiApprover } from "../agent/approvers.js";
import { scanWorkspaceFiles } from "./file-scan.js";

/**
 * Boots the interactive MiniPhi agent UI. Dynamically imported from the CLI so
 * headless/CI paths never load Ink/React.
 *
 * @param {object} options
 * @param {object} options.client   LM Studio REST client (createChatCompletion).
 * @param {string} [options.cwd]    Workspace root.
 * @param {string} [options.baseDir] The `.miniphi` dir for session persistence.
 * @param {string} [options.initialTask] Pre-seeded task (skips the picker).
 * @param {Function} [options.runCommand] Policy-gated command runner for run_cmd.
 * @param {number} [options.sessionDeadline] Absolute ms deadline.
 * @param {string} [options.model] Model id override.
 * @returns {Promise<object>} the finished session result.
 */
export async function launchAgentUi(options = undefined) {
  const {
    client,
    cwd = process.cwd(),
    baseDir = null,
    initialTask = "",
    runCommand = null,
    sessionDeadline = null,
    model = null,
    temperature = undefined,
  } = options ?? {};

  const files = await scanWorkspaceFiles(cwd);
  const session = new AgentSession({
    client,
    cwd,
    baseDir,
    runCommand,
    sessionDeadline,
    model,
    temperature,
  });
  // Wire the UI approver after construction so it can emit on the session.
  session.approver = createUiApprover(session);

  const startPhase = initialTask ? "prompt" : files.length ? "picker" : "prompt";
  const app = render(
    html`<${App}
      session=${session}
      files=${files}
      initialTask=${initialTask}
      startPhase=${startPhase}
    />`,
  );
  await app.waitUntilExit();
  return session;
}
