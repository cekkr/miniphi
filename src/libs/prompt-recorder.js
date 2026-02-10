import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  normalizePromptErrorPayload,
  normalizePromptRequestPayload,
  normalizePromptResponsePayload,
} from "./prompt-log-normalizer.js";

const DEFAULT_HISTORY_LIMIT = 200;

/**
 * Persists structured JSON prompt exchanges (request + response) under the MiniPhi workspace.
 * Each record captures LM Studio prompt metadata so individual sub-prompts can be replayed later.
 */
export default class PromptRecorder {
  /**
   * @param {string} workspaceRoot Absolute path to the MiniPhi workspace (usually .miniphi)
   */
  constructor(workspaceRoot = path.join(process.cwd(), ".miniphi")) {
    this.workspaceRoot = workspaceRoot;
    this.recordsDir = path.join(this.workspaceRoot, "prompt-exchanges");
    this.indexFile = path.join(this.recordsDir, "index.json");
    this.prepared = false;
  }

  async prepare() {
    if (this.prepared) {
      return;
    }
    await fs.promises.mkdir(this.recordsDir, { recursive: true });
    try {
      await fs.promises.access(this.indexFile, fs.constants.F_OK);
    } catch {
      await fs.promises.writeFile(
        this.indexFile,
        JSON.stringify({ entries: [], updatedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    }
    this.prepared = true;
  }

  /**
   * Writes a structured prompt exchange to disk.
   * @param {{
   *   id?: string,
   *   scope?: "main" | "sub",
   *   label?: string,
   *   mainPromptId?: string | null,
   *   subPromptId?: string | null,
   *   request: Record<string, unknown>,
   *   response?: Record<string, unknown> | null,
   *   error?: string | null,
   *   metadata?: Record<string, unknown> | null,
   * }} exchange
   * @returns {Promise<{ id: string, path: string }>}
   */
  async record(exchange) {
    if (!exchange || !exchange.request) {
      throw new Error("PromptRecorder.record requires a request payload.");
    }
    await this.prepare();
    const id = exchange.id ?? randomUUID();
    const recordPath = path.join(this.recordsDir, `${id}.json`);
    const request = this._normalizeRequest(exchange.request);
    const response = this._normalizeResponse(exchange.response ?? null);
    const payload = {
      id,
      recordedAt: new Date().toISOString(),
      scope: exchange.scope ?? "sub",
      label: exchange.label ?? null,
      mainPromptId: exchange.mainPromptId ?? null,
      subPromptId: exchange.subPromptId ?? null,
      metadata: exchange.metadata ?? null,
      request,
      response,
      error: this._normalizeError(exchange.error ?? null),
    };
    await fs.promises.writeFile(recordPath, JSON.stringify(payload, null, 2), "utf8");
    await this._updateIndex(payload, recordPath);
    return { id, path: recordPath };
  }

  async _updateIndex(payload, recordPath) {
    const index = await this._readIndex();
    const summary = {
      id: payload.id,
      scope: payload.scope,
      label: payload.label,
      mainPromptId: payload.mainPromptId,
      subPromptId: payload.subPromptId,
      recordedAt: payload.recordedAt,
      error: payload.error,
      file: path.relative(this.workspaceRoot, recordPath),
    };
    const filtered = index.entries.filter((entry) => entry.id !== payload.id);
    filtered.unshift(summary);
    index.entries = filtered.slice(0, DEFAULT_HISTORY_LIMIT);
    index.updatedAt = new Date().toISOString();
    await fs.promises.writeFile(this.indexFile, JSON.stringify(index, null, 2), "utf8");
  }

  async _readIndex() {
    try {
      const raw = await fs.promises.readFile(this.indexFile, "utf8");
      return JSON.parse(raw);
    } catch {
      return { entries: [], updatedAt: null };
    }
  }

  _normalizeRequest(request) {
    return normalizePromptRequestPayload(request);
  }

  _normalizeResponse(response) {
    return normalizePromptResponsePayload(response);
  }

  _normalizeError(error) {
    return normalizePromptErrorPayload(error);
  }
}
