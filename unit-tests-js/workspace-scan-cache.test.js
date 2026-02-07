import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createWorkspaceScanCache,
  resolveWorkspaceScan,
  resolveWorkspaceScanSync,
} from "../src/libs/workspace-scanner.js";
import { collectManifestSummary, listWorkspaceFiles } from "../src/libs/workspace-context-utils.js";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";

test("workspace scan cache reuses scan results across async/sync resolvers", async () => {
  const workspace = await createTempWorkspace("miniphi-scan-cache-");
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "index.js"), "console.log('hello');\n", "utf8");
    const scanCache = createWorkspaceScanCache();

    const first = await resolveWorkspaceScan(workspace, { scanCache });
    const second = await resolveWorkspaceScan(workspace, { scanCache });
    const third = resolveWorkspaceScanSync(workspace, { scanCache });

    assert.strictEqual(second, first);
    assert.strictEqual(third, first);
    assert.ok(Array.isArray(first.files));
    assert.ok(first.files.includes("src/index.js"));
  } finally {
    await removeTempWorkspace(workspace);
  }
});

test("workspace context utils share scan cache across list and manifest calls", async () => {
  const workspace = await createTempWorkspace("miniphi-scan-context-");
  try {
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "alpha.js"), "export const alpha = 1;\n", "utf8");
    const scanCache = createWorkspaceScanCache();

    const initialFiles = await listWorkspaceFiles(workspace, { scanCache });
    assert.ok(initialFiles.includes("src/alpha.js"));

    await fs.writeFile(path.join(workspace, "src", "beta.js"), "export const beta = 2;\n", "utf8");
    const manifest = await collectManifestSummary(workspace, { scanCache, limit: 20 });
    assert.ok(Array.isArray(manifest.files));
    assert.ok(manifest.files.includes("src/alpha.js"));
    assert.ok(!manifest.files.includes("src/beta.js"));
  } finally {
    await removeTempWorkspace(workspace);
  }
});
