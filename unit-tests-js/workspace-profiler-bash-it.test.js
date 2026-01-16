import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import WorkspaceProfiler from "../src/libs/workspace-profiler.js";

test("WorkspaceProfiler classifies bash-it as code-heavy with shell scripts", () => {
  const root = path.resolve("samples", "bash", "bash-it");
  const profiler = new WorkspaceProfiler({
    maxEntries: 200,
    maxDepth: 2,
    includeConnections: false,
  });
  const result = profiler.describe(root);
  assert.ok(["code", "mixed"].includes(result.classification.domain));
  assert.ok(result.stats.codeFiles > 0);
  assert.ok(result.stats.docFiles > 0);
  assert.ok(
    result.highlights.codeFiles.some(
      (file) => file.endsWith(".sh") || file.endsWith(".bash"),
    ),
  );
});
