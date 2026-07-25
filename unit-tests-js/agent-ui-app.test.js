import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { render } from "ink-testing-library";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";
import { html } from "../src/ui/html.js";
import App from "../src/ui/app.js";
import AgentSession from "../src/agent/agent-session.js";
import { createUiApprover } from "../src/agent/approvers.js";

const delay = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 3000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await delay(interval);
  }
  return false;
}

function scriptedClient(turns) {
  let i = 0;
  return {
    async createChatCompletion() {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { choices: [{ message: { content: JSON.stringify(turn) } }] };
    },
  };
}

const turn = (actions, summary = "working") => ({
  task: "demo",
  summary,
  summary_updates: [],
  actions,
  needs_more_context: false,
  missing_snippets: [],
});

test("App drives prompt -> running -> approve modal -> done and applies the edit", async () => {
  const workspace = await createTempWorkspace();
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "a.js"), "export const a = 1;\n", "utf8");

    const client = scriptedClient([
      turn([{ type: "read_file", path: "src/a.js", reason: "inspect" }]),
      turn([{ type: "write_file", path: "src/b.js", content: "export const b = 2;\n", reason: "add", danger: "low" }]),
      turn([{ type: "finish", reason: "done" }], "Added src/b.js"),
    ]);

    const session = new AgentSession({ client, cwd: workspace, baseDir: null });
    session.approver = createUiApprover(session);

    const app = render(html`<${App} session=${session} files=${[]} initialTask=${"Add a b module"} />`);
    try {
      await delay();

      // Prompt phase is focused with the initial task; Enter starts the run.
      app.stdin.write("\r");

      const sawModal = await waitFor(() => /Permission required/.test(app.lastFrame() ?? ""));
      assert.equal(sawModal, true, "permission modal should appear for the write");
      assert.match(app.lastFrame(), /write_file src\/b\.js/);

      // Let Ink register the modal's key handler before sending the keystroke.
      await delay(80);
      app.stdin.write("y"); // approve once

      const sawDone = await waitFor(() => /completed/.test(app.lastFrame() ?? ""));
      assert.equal(sawDone, true, "run should finish");
      assert.match(app.lastFrame(), /1 edit/);

      assert.equal(await fs.readFile(path.join(workspace, "src", "b.js"), "utf8"), "export const b = 2;\n");
    } finally {
      app.unmount();
    }
  } finally {
    await removeTempWorkspace(workspace);
  }
});
