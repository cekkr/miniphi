import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { html } from "../src/ui/html.js";
import ModelPicker from "../src/ui/components/model-picker.js";
import { buildUiModelSelection } from "../src/ui/model-selection.js";

const delay = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

const MODELS = [
  {
    id: "general-7b",
    displayName: "General 7B",
    type: "llm",
    arch: "llama",
    quantization: "Q4_K_M",
    state: "loaded",
    loadedContextLength: 16384,
    maxContextLength: 131072,
    loadedInstanceId: "general-7b",
    loadedInstances: [{ id: "general-7b", contextLength: 16384, config: {} }],
    capabilities: [],
  },
  {
    id: "qwen-coder-7b",
    displayName: "Qwen Coder 7B",
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

test("UI Auto selection is ranked from the entered task and preserves source metadata", () => {
  const selection = buildUiModelSelection({
    models: MODELS,
    task: "Refactor the parser and add tests",
    requestedModel: "auto",
    source: "native-v1",
  });
  assert.equal(selection.intent, "coding");
  assert.equal(selection.selectedValue, "auto");
  assert.equal(selection.choices[0].auto, true);
  assert.equal(selection.choices[0].resolvedModel, "qwen-coder-7b");
  assert.equal(selection.choices[0].source, "native-v1");
});

test("UI keeps an explicit configured model selected", () => {
  const selection = buildUiModelSelection({
    models: MODELS,
    task: "Write release notes",
    requestedModel: "general-7b",
  });
  assert.equal(selection.selectedValue, "general-7b");
});

test("ModelPicker renders Auto details and submits a concrete choice", async () => {
  const selection = buildUiModelSelection({
    models: MODELS,
    task: "Refactor the parser and add tests",
    requestedModel: "auto",
    source: "native-v1",
  });
  let submitted = null;
  const app = render(
    html`<${ModelPicker}
      choices=${selection.choices}
      selectedValue=${selection.selectedValue}
      intent=${selection.intent}
      onSubmit=${(choice) => {
        submitted = choice;
      }}
    />`,
  );
  try {
    await delay();
    const frame = app.lastFrame() ?? "";
    assert.match(frame, /Auto → qwen-coder-7b/);
    assert.match(frame, /Task intent: coding/);
    assert.match(frame, /tool_use/);
    app.stdin.write("\r");
    await delay();
    assert.equal(submitted.resolvedModel, "qwen-coder-7b");
    assert.equal(submitted.requested, "auto");
  } finally {
    app.unmount();
  }
});
