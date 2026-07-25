import test from "node:test";
import assert from "node:assert/strict";
import { decideUiLaunch } from "../src/ui/route.js";

const base = { command: null, bare: false, isImplicitTask: false, options: {}, isTTY: true };

test("bare invocation on a TTY opens the UI", () => {
  assert.deepEqual(decideUiLaunch({ ...base, bare: true }).ui, true);
});

test("free-form task on a TTY opens the UI seeded with the task", () => {
  const d = decideUiLaunch({ ...base, command: "workspace", isImplicitTask: true });
  assert.equal(d.ui, true);
  assert.equal(d.reason, "free-form-task");
});

test("explicit ui command opens the UI", () => {
  assert.equal(decideUiLaunch({ ...base, command: "ui" }).ui, true);
});

test("explicit subcommands stay headless", () => {
  assert.equal(decideUiLaunch({ ...base, command: "run" }).ui, false);
  assert.equal(decideUiLaunch({ ...base, command: "benchmark" }).ui, false);
  // free-form redirected to run/analyze-file via --cmd/--file is not workspace.
  assert.equal(decideUiLaunch({ ...base, command: "run", isImplicitTask: true }).ui, false);
});

test("non-TTY always runs headless (scripts/CI)", () => {
  assert.equal(decideUiLaunch({ ...base, bare: true, isTTY: false }).ui, false);
  assert.equal(decideUiLaunch({ ...base, command: "ui", isTTY: false }).ui, false);
  assert.equal(decideUiLaunch({ ...base, command: "workspace", isImplicitTask: true, isTTY: false }).ui, false);
});

test("--headless / --no-ui force headless even on a TTY", () => {
  assert.equal(decideUiLaunch({ ...base, bare: true, options: { headless: true } }).ui, false);
  assert.equal(decideUiLaunch({ ...base, command: "ui", options: { "no-ui": true } }).ui, false);
});
