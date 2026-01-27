import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DEFAULT_SCHEMA_VERSION = "task-execution-register@v1";

async function readJson(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempFile = `${filePath}.tmp`;
  await fs.promises.writeFile(tempFile, JSON.stringify(data, null, 2), "utf8");
  try {
    await fs.promises.rename(tempFile, filePath);
  } catch {
    await fs.promises.copyFile(tempFile, filePath);
    await fs.promises.unlink(tempFile);
  }
}

/**
 * Records LM Studio request/response pairs for a single task execution.
 * Stored under .miniphi/executions/<executionId>/task-execution.json.
 */
export default class TaskExecutionRegister {
  /**
   * @param {string} workspaceRoot Absolute path to the .miniphi directory.
   */
  constructor(workspaceRoot = path.join(process.cwd(), ".miniphi")) {
    this.workspaceRoot = workspaceRoot;
    this.executionsDir = path.join(this.workspaceRoot, "executions");
    this.executionId = null;
    this.registerFile = null;
    this.session = null;
    this.sequence = 0;
  }

  /**
   * Initializes (or rehydrates) the execution register.
   * @param {string} executionId
   * @param {Record<string, any>} [metadata]
   */
  async openSession(executionId, metadata = undefined) {
    if (!executionId) {
      return null;
    }
    this.executionId = executionId;
    const executionDir = path.join(this.executionsDir, executionId);
    this.registerFile = path.join(executionDir, "task-execution.json");
    await fs.promises.mkdir(executionDir, { recursive: true });

    const existing = await readJson(this.registerFile);
    if (existing && typeof existing === "object") {
      const mergedMetadata =
        metadata && typeof metadata === "object"
          ? { ...(existing.metadata ?? {}), ...metadata }
          : existing.metadata ?? null;
      const entries = Array.isArray(existing.entries) ? existing.entries : [];
      this.session = {
        ...existing,
        schemaVersion: existing.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
        metadata: mergedMetadata,
        updatedAt: new Date().toISOString(),
        entryCount: entries.length,
      };
      this.session.entries = entries;
      this.sequence = entries.length;
    } else {
      const timestamp = new Date().toISOString();
      this.session = {
        schemaVersion: DEFAULT_SCHEMA_VERSION,
        id: executionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: metadata ?? null,
        entryCount: 0,
        entries: [],
      };
      this.sequence = 0;
    }

    await writeJson(this.registerFile, this.session);
    return { id: executionId, path: this.registerFile };
  }

  /**
   * Records a single LM Studio request/response entry.
   * @param {{
   *   type?: string,
   *   transport?: string | null,
   *   request?: Record<string, any> | null,
   *   response?: Record<string, any> | null,
   *   error?: Record<string, any> | null,
   *   metadata?: Record<string, any> | null,
   *   links?: Record<string, any> | null,
   * }} entry
   */
  async record(entry) {
    if (!this.session || !this.registerFile || !entry) {
      return null;
    }
    const timestamp = new Date().toISOString();
    const next = {
      id: randomUUID(),
      sequence: this.sequence + 1,
      recordedAt: timestamp,
      type: entry.type ?? "lmstudio",
      transport: entry.transport ?? null,
      request: entry.request ?? null,
      response: entry.response ?? null,
      error: entry.error ?? null,
      metadata: entry.metadata ?? null,
      links: entry.links ?? null,
    };
    this.sequence = next.sequence;
    this.session.entries = Array.isArray(this.session.entries) ? this.session.entries : [];
    this.session.entries.push(next);
    this.session.entryCount = this.session.entries.length;
    this.session.updatedAt = timestamp;
    await writeJson(this.registerFile, this.session);
    return next;
  }

  getExecutionId() {
    return this.executionId;
  }
}
