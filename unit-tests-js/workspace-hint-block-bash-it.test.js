import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildWorkspaceHintBlock } from "../src/libs/workspace-context-utils.js";

test("Workspace hint block includes bash-it script paths", () => {
  const root = path.resolve("samples", "bash", "bash-it");
  const files = [
    "bash_it.sh",
    "plugins/available/alias-completion.plugin.bash",
  ];
  files.forEach((file) => {
    assert.ok(
      fs.existsSync(path.join(root, file)),
      `Sample file missing: ${file}`,
    );
  });
  const hint = buildWorkspaceHintBlock(files, root, null, { limit: 6 });
  assert.match(hint, /File manifest/);
  assert.ok(hint.includes("bash_it.sh"));
  assert.ok(hint.includes("plugins/available/alias-completion.plugin.bash"));
});
