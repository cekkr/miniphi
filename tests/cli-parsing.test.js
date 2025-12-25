import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractImplicitWorkspaceTask,
  parseDirectFileReferences,
} from "../src/index.js";
import { mergeFixedReferences } from "../src/libs/core-utils.js";

test("extractImplicitWorkspaceTask captures implicit workspace requests", () => {
  const { task, rest } = extractImplicitWorkspaceTask([
    "Draft",
    "release",
    "notes",
    "--verbose",
  ]);
  assert.equal(task, "Draft release notes");
  assert.deepEqual(rest, ["--verbose"]);
});

test("extractImplicitWorkspaceTask ignores explicit commands", () => {
  const { task, rest } = extractImplicitWorkspaceTask(["run", "--cmd", "npm", "test"]);
  assert.equal(task, null);
  assert.deepEqual(rest, ["--cmd", "npm", "test"]);
});

test("parseDirectFileReferences resolves pinned file attachments", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "miniphi-cli-"));
  const filePath = path.join(tempDir, "sample.txt");
  fs.writeFileSync(filePath, "hello world", "utf8");
  const taskText = String.raw`Inspect @"${filePath}" for changes`;
  const { cleanedTask, references } = parseDirectFileReferences(taskText, tempDir);

  assert.equal(cleanedTask, `Inspect ${filePath} for changes`);
  assert.equal(references.length, 1);
  const ref = references[0];
  assert.equal(ref.label, filePath);
  assert.equal(ref.relative, path.basename(filePath));
  assert.equal(ref.bytes, 11);
  assert.ok(ref.hash && ref.hash.length > 0);

  // Ensure the workspace context threads the references through untouched.
  const workspaceContext = mergeFixedReferences({ summary: "fake" }, references);
  assert.deepEqual(workspaceContext.fixedReferences, references);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
