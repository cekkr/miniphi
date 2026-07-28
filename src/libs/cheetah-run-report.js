import fs from "fs/promises";
import path from "path";

const DEFAULT_INDEX_LIMIT = 200;

/**
 * Lightweight JSON run-log for `cheetah-learn` (teach/ask/chat/questions/
 * eval). Same bare-workspaceRoot convention as PromptRecorder/
 * TaskExecutionRegister, deliberately not routed through the larger
 * MiniPhiMemory: the actual knowledge lives in Cheetah, this is only an
 * operator-facing report of what a run did.
 */
export default class CheetahRunReport {
  constructor(workspaceRoot = path.join(process.cwd(), ".miniphi")) {
    this.baseDir = path.join(workspaceRoot, "cheetah");
    this.runsDir = path.join(this.baseDir, "runs");
    this.indexFile = path.join(this.baseDir, "index.json");
  }

  async prepare() {
    await fs.mkdir(this.runsDir, { recursive: true });
  }

  async _readIndex() {
    try {
      const raw = await fs.readFile(this.indexFile, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async _writeIndex(entries) {
    const tmpFile = `${this.indexFile}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(entries, null, 2), "utf8");
    await fs.rename(tmpFile, this.indexFile);
  }

  /**
   * @param {{id: string, mode: "teach"|"ask"|"chat"|"questions"|"eval",
   *   startedAt: string, finishedAt: string, params?: object, results?: any,
   *   metrics?: object}} run
   */
  async saveRun(run) {
    await this.prepare();
    const id = typeof run?.id === "string" && run.id.trim() ? run.id.trim() : `run-${Date.now()}`;
    const record = {
      id,
      mode: run?.mode ?? "unknown",
      startedAt: run?.startedAt ?? null,
      finishedAt: run?.finishedAt ?? new Date().toISOString(),
      params: run?.params ?? null,
      results: run?.results ?? null,
      metrics: run?.metrics ?? null,
    };
    const runFile = path.join(this.runsDir, `${id}.json`);
    const tmpFile = `${runFile}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tmpFile, runFile);

    const index = await this._readIndex();
    const summary = {
      id,
      mode: record.mode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      metrics: record.metrics,
      path: runFile,
    };
    const nextIndex = [summary, ...index.filter((entry) => entry?.id !== id)].slice(
      0,
      DEFAULT_INDEX_LIMIT,
    );
    await this._writeIndex(nextIndex);
    return record;
  }

  async listRuns(limit = 20) {
    const index = await this._readIndex();
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    return index.slice(0, cap);
  }
}
