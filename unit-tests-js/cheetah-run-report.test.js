import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import CheetahRunReport from "../src/libs/cheetah-run-report.js";

async function makeTempWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "cheetah-run-report-"));
}

test("CheetahRunReport persists a run and lists it back newest-first", async () => {
  const workspaceRoot = await makeTempWorkspace();
  try {
    const report = new CheetahRunReport(workspaceRoot);
    await report.saveRun({
      id: "run-1",
      mode: "teach",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      params: { limit: 5 },
      results: [{ subjectName: "X" }],
      metrics: null,
    });
    await report.saveRun({
      id: "run-2",
      mode: "eval",
      startedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:00:01.000Z",
      params: { teachLimit: 5 },
      results: {},
      metrics: { hallucinationCount: 0 },
    });

    const runs = await report.listRuns(10);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].id, "run-2", "most recently saved run is listed first");
    assert.equal(runs[1].id, "run-1");
    assert.deepEqual(runs[0].metrics, { hallucinationCount: 0 });

    const runFile = path.join(workspaceRoot, "cheetah", "runs", "run-1.json");
    const persisted = JSON.parse(await fs.readFile(runFile, "utf8"));
    assert.equal(persisted.mode, "teach");
    assert.deepEqual(persisted.params, { limit: 5 });
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CheetahRunReport re-saving the same id updates it in place rather than duplicating", async () => {
  const workspaceRoot = await makeTempWorkspace();
  try {
    const report = new CheetahRunReport(workspaceRoot);
    await report.saveRun({ id: "dup", mode: "ask", finishedAt: "t1", metrics: { a: 1 } });
    await report.saveRun({ id: "dup", mode: "ask", finishedAt: "t2", metrics: { a: 2 } });
    const runs = await report.listRuns(10);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].metrics, { a: 2 });
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("CheetahRunReport.listRuns returns an empty array before any run is saved", async () => {
  const workspaceRoot = await makeTempWorkspace();
  try {
    const report = new CheetahRunReport(workspaceRoot);
    assert.deepEqual(await report.listRuns(), []);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
