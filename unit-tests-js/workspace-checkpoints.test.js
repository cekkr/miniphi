import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WorkspaceCheckpoints, { scoreCheckpoint } from "../src/libs/workspace-checkpoints.js";

const makeWorkspace = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-checkpoints-"));
  await fs.mkdir(path.join(root, ".miniphi"), { recursive: true });
  return root;
};

const newCheckpoints = (root) =>
  new WorkspaceCheckpoints({ workspaceRoot: root, baseDir: path.join(root, ".miniphi") });

test("a workspace that boots outranks one that does not, and tests break the tie", () => {
  const broken = scoreCheckpoint({ validation: null });
  const oneIssue = scoreCheckpoint({ validation: { valid: false, issues: ["a"] } });
  const clean = scoreCheckpoint({ validation: { valid: true, issues: [] } });
  const cleanTested = scoreCheckpoint({
    validation: { valid: true, issues: [] },
    tests: { passed: true },
  });

  assert.ok(oneIssue.score > broken.score, "a validator that ran at all beats one that could not");
  assert.ok(clean.score > oneIssue.score);
  assert.ok(cleanTested.score > clean.score, "a passing suite is a stronger statement than a quiet validator");

  const threeIssues = scoreCheckpoint({ validation: { valid: false, issues: ["a", "b", "c"] } });
  assert.ok(oneIssue.score > threeIssues.score);
});

test("checkpoints capture real file states and restore them", async () => {
  const root = await makeWorkspace();
  const file = path.join(root, "app.js");
  await fs.writeFile(file, "export const working = true;\n", "utf8");

  const checkpoints = newCheckpoints(root);
  assert.equal(await checkpoints.prepare(), true, "git must be available for this suite");

  const good = await checkpoints.record({
    label: "working app",
    turn: 1,
    validation: { valid: true, issues: [] },
  });
  assert.ok(good?.id);

  // The destructive turn: a whole file replaced by a fragment.
  await fs.writeFile(file, "app.get('/x', () => {});\n", "utf8");
  const bad = await checkpoints.record({
    label: "replaced app.js with a fragment",
    turn: 2,
    validation: null,
  });
  assert.ok(bad.score < good.score);

  const regression = checkpoints.regression();
  assert.ok(regression, "a drop against a state we actually held is detectable");
  assert.equal(regression.bestBefore.id, good.id);

  const restored = await checkpoints.restore(good.id);
  assert.equal(restored.ok, true);
  assert.equal(await fs.readFile(file, "utf8"), "export const working = true;\n");
});

test("a revert is itself recorded, so reverting by mistake loses nothing", async () => {
  const root = await makeWorkspace();
  const file = path.join(root, "app.js");
  await fs.writeFile(file, "const v = 1;\n", "utf8");
  const checkpoints = newCheckpoints(root);
  await checkpoints.prepare();
  const first = await checkpoints.record({ label: "v1", validation: { valid: true, issues: [] } });

  await fs.writeFile(file, "const v = 2;\n", "utf8");
  await checkpoints.record({ label: "v2", validation: { valid: true, issues: [] } });

  await checkpoints.restore(first.id);
  assert.equal(await fs.readFile(file, "utf8"), "const v = 1;\n");

  // Reverting never destroys the state it reverted away from: v2 is still a
  // checkpoint and can be restored again.
  const v2 = checkpoints.list().find((entry) => entry.label === "v2");
  assert.ok(v2, "the state that was reverted away from is still reachable");
  const back = await checkpoints.restore(v2.id);
  assert.equal(back.ok, true);
  assert.equal(await fs.readFile(file, "utf8"), "const v = 2;\n");

  // And an uncommitted change made after a checkpoint is snapshotted before a
  // revert wipes it, rather than being lost.
  await fs.writeFile(file, "const v = 3;\n", "utf8");
  await checkpoints.restore(first.id);
  const rescued = checkpoints.list().find((entry) => entry.label.startsWith("before reverting"));
  assert.ok(rescued, "unsaved work is checkpointed before being overwritten");
});

test("files created after the target are removed by a restore", async () => {
  const root = await makeWorkspace();
  await fs.writeFile(path.join(root, "keep.js"), "keep\n", "utf8");
  const checkpoints = newCheckpoints(root);
  await checkpoints.prepare();
  const base = await checkpoints.record({ label: "base", validation: { valid: true, issues: [] } });

  await fs.writeFile(path.join(root, "stray.js"), "stray\n", "utf8");
  await checkpoints.record({ label: "added stray", validation: { valid: true, issues: [] } });

  await checkpoints.restore(base.id);
  const strayExists = await fs
    .access(path.join(root, "stray.js"))
    .then(() => true)
    .catch(() => false);
  assert.equal(strayExists, false, "a restore leaves the exact recorded state, not a hybrid");
});

test("the project's own git repository is never touched", async () => {
  const root = await makeWorkspace();
  await fs.writeFile(path.join(root, "app.js"), "const a = 1;\n", "utf8");
  const checkpoints = newCheckpoints(root);
  await checkpoints.prepare();
  await checkpoints.record({ label: "one", validation: null });

  const ownGit = await fs
    .access(path.join(root, ".git"))
    .then(() => true)
    .catch(() => false);
  assert.equal(ownGit, false, "the shadow repo lives under .miniphi, never in the workspace root");
  assert.ok(checkpoints.gitDir.includes(".miniphi"));
});

test("node_modules is never snapshotted", async () => {
  const root = await makeWorkspace();
  await fs.mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "vendored\n", "utf8");
  await fs.writeFile(path.join(root, "app.js"), "const a = 1;\n", "utf8");

  const checkpoints = newCheckpoints(root);
  await checkpoints.prepare();
  const entry = await checkpoints.record({ label: "one", validation: null });
  assert.ok(entry);

  const listed = await checkpoints._git(["ls-tree", "-r", "--name-only", "HEAD"]);
  assert.ok(listed.stdout.includes("app.js"));
  assert.ok(!listed.stdout.includes("node_modules"), "installed trees would dominate every diff");
});

test("an unchanged workspace does not accumulate empty checkpoints", async () => {
  const root = await makeWorkspace();
  await fs.writeFile(path.join(root, "app.js"), "const a = 1;\n", "utf8");
  const checkpoints = newCheckpoints(root);
  await checkpoints.prepare();
  await checkpoints.record({ label: "first", validation: null });
  const second = await checkpoints.record({ label: "no changes", validation: null });
  assert.equal(second, null);
  assert.equal(checkpoints.list().length, 1);
});

test("with git unavailable the history disables itself instead of failing the run", async () => {
  const root = await makeWorkspace();
  // A regular *file* where the base directory should be: `mkdir` cannot
  // succeed, which stands in for "git cannot be used here" without relying on
  // an exotic path.
  const blocker = path.join(root, "blocked");
  await fs.writeFile(blocker, "not a directory\n", "utf8");
  const checkpoints = new WorkspaceCheckpoints({
    workspaceRoot: root,
    baseDir: path.join(blocker, "history"),
  });
  const ready = await checkpoints.prepare();
  assert.equal(ready, false);
  assert.equal(checkpoints.enabled, false);
  assert.equal(await checkpoints.record({ label: "x" }), null);
  assert.equal(checkpoints.stats().enabled, false);
});

test("the workspace's own .gitignore does not hide the agent's output", async () => {
  const root = await makeWorkspace();
  // Exactly the photos-social shape: the generated app is gitignored because it
  // is generated, which is precisely why it needs protecting.
  await fs.writeFile(path.join(root, ".gitignore"), "server/\n.miniphi/\n", "utf8");
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.writeFile(path.join(root, "server", "index.js"), "const working = true;\n", "utf8");

  const checkpoints = newCheckpoints(root);
  await checkpoints.prepare();
  const good = await checkpoints.record({
    label: "working app",
    validation: { valid: true, issues: [] },
  });
  assert.ok(good);

  const tracked = await checkpoints._git(["ls-tree", "-r", "--name-only", "HEAD"]);
  assert.ok(
    tracked.stdout.includes("server/index.js"),
    "the generated app must be in the history, gitignored or not",
  );

  // And it can actually be restored.
  await fs.writeFile(path.join(root, "server", "index.js"), "broken\n", "utf8");
  await checkpoints.record({ label: "broke it", validation: null });
  await checkpoints.restore(good.id);
  assert.equal(
    await fs.readFile(path.join(root, "server", "index.js"), "utf8"),
    "const working = true;\n",
  );

  // `.miniphi` itself still stays out: it holds the history and would recurse.
  assert.ok(!tracked.stdout.includes(".miniphi/"));
});
