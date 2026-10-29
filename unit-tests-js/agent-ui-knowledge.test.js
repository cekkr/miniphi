import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import AgentSession from "../src/agent/agent-session.js";
import App from "../src/ui/app.js";
import { html } from "../src/ui/html.js";
import { createUiKnowledgeControl } from "../src/ui/knowledge-control.js";

const delay = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay();
  assert(predicate(), "Expected UI state was not rendered");
}
function sessionFixture() {
  const requests = [];
  const session = new AgentSession({ model: "selected-model", contextLength: 16384,
    client: { async createChatCompletion(request) {
      requests.push(request);
      return { choices: [{ message: { content: JSON.stringify({ task: "demo", summary: "Done", summary_updates: [],
        actions: [{ type: "finish", reason: "done" }], needs_more_context: false, missing_snippets: [] }) } }] };
    } } });
  return { session, requests };
}

test("UI knowledge selection wires and closes the runtime, updates contracts and respects the start gate", async () => {
  const { session } = sessionFixture();
  session.errorLearner = {};
  const calls = [];
  let closed = 0;
  const runtime = { configure(options) { this.model = options.model; }, async close() { closed++; } };
  const configure = createUiKnowledgeControl({ session, configData: { knowledge: { enabled: false } },
    runtimeFactory: async options => { calls.push(options); return runtime; } });
  const before = session.contextBudgetTokens;
  assert.deepEqual(await configure(true), { enabled: true, status: "Ready" });
  assert.equal(calls[0].env.MINIPHI_KNOWLEDGE, "1");
  assert.equal(calls[0].model, "selected-model");
  assert.equal(session.errorLearner.knowledgeRuntime, runtime);
  assert.match(session._systemPrompt(), /Optional graph knowledge is available/);
  assert(session.contextBudgetTokens < before);
  await configure(false);
  assert.equal(closed, 1);
  assert.equal(session.knowledgeRuntime, null);
  assert.equal(session.errorLearner.knowledgeRuntime, null);
  assert.equal(session.contextBudgetTokens, before);
  session._remember({ layer: "mission", label: "started", text: "Task started" });
  await assert.rejects(configure(true), /after the task has started/);
  assert.equal(calls.length, 1);
});

for (const reachable of [true, false]) test(`CLI UI toggles graph knowledge and handles ${reachable ? "a healthy" : "an unavailable"} Cheetah`, async () => {
  const { session, requests } = sessionFixture();
  let release;
  const probing = new Promise(resolve => { release = resolve; });
  const configure = createUiKnowledgeControl({ session, runtimeFactory: () => probing });
  const app = render(html`<${App} session=${session} initialTask="Check the source" configureKnowledge=${configure} />`);
  try {
    await delay();
    app.stdin.write("\r");
    await until(() => /Choose reasoning effort/.test(app.lastFrame()));
    assert.match(app.lastFrame(), /Graph knowledge: Off/);
    await delay();
    app.stdin.write("g");
    await until(() => /Checking Cheetah/.test(app.lastFrame()));
    app.stdin.write("\r");
    await delay();
    assert.equal(requests.length, 0, "Enter must wait for the capability probe");
    const runtime = { configure() {}, stats() { return { actions: 0, learned: 0 }; } };
    release(reachable ? runtime : null);
    await until(() => reachable ? /Graph knowledge: On/.test(app.lastFrame()) : /Cheetah unavailable/.test(app.lastFrame()));
    assert.equal(Boolean(session.knowledgeRuntime), reachable);
    app.stdin.write("\r");
    await until(() => /completed/.test(app.lastFrame()));
    assert.equal(requests.length, 1);
    assert.equal(/Optional graph knowledge is available/.test(requests[0].messages[0].content), reachable);
    assert.match(app.lastFrame(), new RegExp(`Graph knowledge: ${reachable ? "On" : "Off"}`));
  } finally { app.unmount(); }
});

test("leaving the UI during its probe closes the late runtime without attaching it", async () => {
  const { session } = sessionFixture();
  let release;
  let closed = 0;
  const configure = createUiKnowledgeControl({ session,
    runtimeFactory: () => new Promise(resolve => { release = resolve; }) });
  const pending = configure(true);
  await configure.close();
  release({ async close() { closed++; } });
  assert.equal((await pending).enabled, false);
  assert.equal(closed, 1);
  assert.equal(session.knowledgeRuntime, null);
});
