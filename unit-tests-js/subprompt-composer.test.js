import test from "node:test";
import assert from "node:assert/strict";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import SubpromptComposer, {
  normalizeSubtaskPlan,
  renderPlanBlock,
} from "../src/libs/subprompt-composer.js";

const validPlan = {
  schema_version: "subtask-plan@v1",
  mission_restated: "Build a photo social app on top of the supplied template.",
  strategy: "Inspect the template first, then implement bottom-up, verifying each layer.",
  subtasks: [
    {
      id: "implement-feed",
      title: "Render the feed from the template",
      goal: "GET /feed answers 200 with the template markup filled with real posts.",
      inputs: ["html-template/home.html"],
      actions: ["page_inspect", "write_file"],
      acceptance: ["curl /feed returns 200 and the body contains the uploaded caption"],
      depends_on: ["inspect-template"],
      estimated_turns: 2,
      risk: "mid",
    },
    {
      id: "inspect-template",
      title: "Inspect the design template",
      goal: "The template's classes, assets and forms are known.",
      inputs: ["html-template/"],
      actions: ["page_inspect"],
      acceptance: ["a page_inspect report for html-template/home.html is in context"],
      depends_on: [],
      estimated_turns: 1,
      risk: "low",
    },
  ],
  open_questions: [],
  needs_more_context: false,
  missing_snippets: [],
};

const clientReturning = (payloads) => {
  const calls = [];
  let index = 0;
  return {
    calls,
    async createChatCompletion(request) {
      calls.push(request);
      const payload = payloads[Math.min(index, payloads.length - 1)];
      index += 1;
      return { choices: [{ message: { content: payload }, finish_reason: "stop" }] };
    },
  };
};

test("a valid plan is accepted and reordered to respect its own dependencies", async () => {
  const client = clientReturning([JSON.stringify(validPlan)]);
  const composer = new SubpromptComposer({
    client,
    schemaRegistry: new PromptSchemaRegistry(),
    model: "prism-ml/bonsai-27b",
    contextLength: 32768,
  });
  const { plan, fallback } = await composer.compose({
    mission: "Build the app",
    facts: "server/ is empty",
  });

  assert.equal(fallback, false);
  assert.deepEqual(
    plan.subtasks.map((subtask) => subtask.id),
    ["inspect-template", "implement-feed"],
    "the dependency, not the model's ordering, decides what runs first",
  );
  assert.equal(client.calls[0].response_format.type, "json_schema");
  assert.equal(client.calls[0].response_format.json_schema.name, "subtask-plan");
  // Planning must not be sampled like extraction: at 0 a rejected plan is
  // simply re-emitted verbatim.
  assert.ok(client.calls[0].temperature > 0.2);
  assert.match(client.calls[0].messages[1].content, /server\/ is empty/);
});

test("an invalid response is retried once and then falls back to a deterministic plan", async () => {
  const client = clientReturning(["not json at all", "{\"still\":\"wrong\"}"]);
  const composer = new SubpromptComposer({
    client,
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
    contextLength: 8192,
  });
  const { plan, fallback, attempts } = await composer.compose({ mission: "Build the app" });

  assert.equal(attempts.length, 2);
  assert.equal(fallback, true);
  assert.match(plan.stop_reason, /invalid-response/);
  assert.deepEqual(
    plan.subtasks.map((subtask) => subtask.id),
    ["survey-workspace", "implement-task", "verify-with-tests"],
  );
  // The retry must tell the model what was wrong, or it repeats the same shape.
  assert.match(client.calls[1].messages[1].content, /PREVIOUS PLAN WAS REJECTED/);
});

test("a dependency cycle degrades to the declared order instead of dropping subtasks", () => {
  const plan = normalizeSubtaskPlan({
    subtasks: [
      { id: "a", acceptance: ["x"], depends_on: ["b"] },
      { id: "b", acceptance: ["y"], depends_on: ["a"] },
      { id: "c", acceptance: ["z"], depends_on: ["ghost"] },
    ],
  });
  assert.deepEqual(
    plan.subtasks.map((subtask) => subtask.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(plan.subtasks[0].depends_on, [], "a reference to a missing id is dropped");
});

test("the plan block marks the current subtask and shows only its acceptance criteria", () => {
  const plan = normalizeSubtaskPlan(validPlan);
  const block = renderPlanBlock(plan, {
    completed: new Set(["inspect-template"]),
    current: "implement-feed",
  });
  assert.match(block, /\[done\] inspect-template/);
  assert.match(block, /\[NOW\] implement-feed/);
  assert.match(block, /done when: curl \/feed returns 200/);
  assert.match(block, /load first: html-template\/home\.html/);
});

test("without a composer-capable client the deterministic plan still names a verification step", async () => {
  const composer = new SubpromptComposer({ client: null, schemaRegistry: null, model: null });
  const { plan, fallback } = await composer.compose({ mission: "anything" });
  assert.equal(fallback, true);
  assert.ok(plan.subtasks.some((subtask) => subtask.id === "verify-with-tests"));
  // Slug-shaped, so a summary using the ordinary word "verify" cannot close it
  // by coincidence (see agent-session-navigation).
  assert.ok(plan.subtasks.every((subtask) => /[-_0-9]/.test(subtask.id)));
});
