import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import WorkspaceProfiler from "../src/libs/workspace-profiler.js";

test("WorkspaceProfiler classifies bash sources as code-heavy", () => {
  const root = path.resolve("samples", "bash", "bash-sources");
  const profiler = new WorkspaceProfiler({
    maxEntries: 200,
    maxDepth: 2,
    includeConnections: false,
  });
  const result = profiler.describe(root);
  assert.equal(result.classification.domain, "code");
  assert.ok(result.stats.codeFiles > 0);
  assert.ok(result.stats.codeFiles >= result.stats.docFiles);
  assert.ok(result.highlights.codeFiles.some((file) => /\.(c|h)$/i.test(file)));
});
