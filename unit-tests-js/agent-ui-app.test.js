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

test("App resolves UI Auto selection after task entry and sends the concrete model", async () => {
  const workspace = await createTempWorkspace();
  try {
    const requests = [];
    const client = {
      async createChatCompletion(payload) {
        requests.push(payload);
        return {
          choices: [
            {
              message: {
                content: JSON.stringify(
                  turn([{ type: "finish", reason: "done" }], "Done"),
                ),
              },
            },
          ],
        };
      },
    };
    const session = new AgentSession({ client, cwd: workspace, baseDir: null });
    const modelCatalog = [
      {
        id: "general-7b",
        type: "llm",
        arch: "llama",
        quantization: "Q4_K_M",
        state: "loaded",
        loadedContextLength: 8192,
        maxContextLength: 131072,
        loadedInstanceId: "general-7b",
        loadedInstances: [
          {
            id: "general-7b",
            contextLength: 8192,
            config: { context_length: 8192 },
          },
        ],
        capabilities: [],
      },
      {
        id: "qwen-coder-7b",
        type: "llm",
        arch: "qwen2",
        quantization: "Q4_K_M",
        state: "not-loaded",
        loadedContextLength: null,
        maxContextLength: 131072,
        loadedInstanceId: null,
        loadedInstances: [],
        capabilities: ["tool_use"],
      },
    ];
    const app = render(
      html`<${App}
        session=${session}
        files=${[]}
        initialTask=${"Refactor the parser"}
        modelCatalog=${modelCatalog}
        modelCatalogSource=${"native-v1"}
        requestedModel=${"auto"}
      />`,
    );
    try {
      await delay();
      app.stdin.write("\r");
      const sawPicker = await waitFor(() =>
        /Auto → qwen-coder-7b/.test(app.lastFrame() ?? ""),
      );
      assert.equal(sawPicker, true);

      app.stdin.write("\r");
      const sawDone = await waitFor(() => /completed/.test(app.lastFrame() ?? ""));
      assert.equal(sawDone, true);
      assert.equal(requests[0].model, "qwen-coder-7b");
      assert.equal(session.modelSelection.requested, "auto");
      assert.equal(session.modelSelection.source, "native-v1");
      assert.equal(session.modelSelection.resolvedModel, "qwen-coder-7b");
    } finally {
      app.unmount();
    }
  } finally {
    await removeTempWorkspace(workspace);
  }
});
