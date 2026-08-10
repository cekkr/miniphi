import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BOOTSTRAP_PROTOCOL_PATH,
  composeGuidelines,
  loadBootstrapProtocol,
  loadNavigationRules,
  loadWorkspaceHandbook,
} from "../src/libs/project-guidelines.js";

test("the navigation rules load as the marked block, without the file's own rationale", async () => {
  const rules = await loadNavigationRules();
  assert.ok(rules, "the pre-written rules must ship with the repository");
  assert.doesNotMatch(rules, /BEGIN RULES/);
  assert.doesNotMatch(
    rules,
    /This file is loaded by/,
    "the prose explaining why the file exists is not sent to the model",
  );
  // The rules the operator asked for specifically.
  assert.match(rules, /R2\. A design reference is to be \*used\*/);
  assert.match(rules, /unit test/i);
  assert.match(rules, /Puppeteer|Playwright|Selenium/);
  assert.match(rules, /textual verdict/i);
});

test("the bootstrap protocol is vendored and carries the validation addendum", async () => {
  const protocol = await loadBootstrapProtocol();
  assert.ok(protocol, "AGENTS.bootstrap.md must be available offline");
  assert.equal(protocol.path, BOOTSTRAP_PROTOCOL_PATH);
  assert.match(protocol.text, /AGENTS\.md Bootstrap Protocol/);
  assert.match(protocol.text, /MiniPhi Addendum: Validation-First Delivery/);
  assert.match(protocol.text, /readable by a model without vision/i);
});

test("an explicit path overrides the vendored copy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-bootstrap-"));
  const file = path.join(dir, "AGENTS.bootstrap.md");
  await fs.writeFile(file, "# Operator's own protocol", "utf8");
  const protocol = await loadBootstrapProtocol({ file });
  assert.equal(protocol.text, "# Operator's own protocol");
  assert.equal(protocol.path, file);
});

test("a workspace handbook is loaded and truncated rather than dropped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-handbook-"));
  await fs.writeFile(path.join(dir, "AGENTS.md"), `# Project\n${"x".repeat(9000)}`, "utf8");
  const handbook = await loadWorkspaceHandbook({ workspaceRoot: dir, maxChars: 200 });
  assert.equal(handbook.name, "AGENTS.md");
  assert.equal(handbook.truncated, true);
  assert.ok(handbook.text.startsWith("# Project"));
  assert.match(handbook.text, /handbook truncated at 200 of \d+ chars/);
});

test("the composed block puts the rules first and names its sources", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-guidelines-"));
  await fs.writeFile(path.join(dir, "AGENTS.md"), "# Sample project\nUse the template.", "utf8");
  const composed = await composeGuidelines({ workspaceRoot: dir });
  assert.match(composed.block, /^Operating rules for this run/);
  assert.match(composed.block, /Use the template\./);
  assert.deepEqual(composed.sources, ["docs/guidelines/agent-navigation.md", "AGENTS.md"]);
});

test("a workspace with no handbook still gets the rules", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-guidelines-"));
  const composed = await composeGuidelines({ workspaceRoot: dir });
  assert.ok(composed.block);
  assert.equal(composed.handbook, null);
  assert.deepEqual(composed.sources, ["docs/guidelines/agent-navigation.md"]);
});
