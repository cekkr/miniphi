import fs from "fs";
import path from "path";
import {
  normalizeJournalResponseValue,
  normalizeToolMetadataPayload,
} from "./prompt-log-normalizer.js";

const DEFAULT_INDEX = { entries: [] };
const VALID_STATUS = new Set(["active", "paused", "completed", "closed"]);

function sanitizeId(raw) {
  if (!raw) {
    return "";
  }
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

function resolveStatus(value, fallback = "active") {
  if (!value) {
    return fallback;
  }
  let normalized = value.toString().trim().toLowerCase();
  if (normalized === "complete") {
    normalized = "completed";
  }
  if (!VALID_STATUS.has(normalized)) {
    return fallback;
  }
  return normalized;
}

export default class PromptStepJournal {
  /**
   * @param {string} miniPhiRoot Absolute path to the .miniphi directory
   */
  constructor(miniPhiRoot) {
    this.baseDir = miniPhiRoot;
    this.sessionsDir = path.join(this.baseDir, "prompt-exchanges", "stepwise");
    this.indexFile = path.join(this.sessionsDir, "index.json");
    this.prepared = false;
  }

  async prepare() {
    if (this.prepared) {
      return;
    }
    await fs.promises.mkdir(this.sessionsDir, { recursive: true });
    try {
      await fs.promises.access(this.indexFile, fs.constants.F_OK);
    } catch {
      await fs.promises.writeFile(this.indexFile, JSON.stringify(DEFAULT_INDEX, null, 2), "utf8");
    }
    this.prepared = true;
  }

  /**
   * Creates (or refreshes) a journal session.
   * @param {string} sessionId
   * @param {Record<string, any>} [metadata]
   */
  async openSession(sessionId, metadata = undefined) {
    if (!sessionId) return null;
    await this.prepare();
    const safeId = sanitizeId(sessionId);
    const sessionDir = path.join(this.sessionsDir, safeId);
    const sessionFile = path.join(sessionDir, "session.json");
    let session = await this._readJSON(sessionFile);
    if (!session) {
      session = {
        id: sessionId,
        status: "active",
        steps: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: metadata ?? null,
      };
    } else {
      session.updatedAt = new Date().toISOString();
      session.metadata = {
        ...(session.metadata ?? {}),
        ...(metadata ?? {}),
      };
    }
    await fs.promises.mkdir(sessionDir, { recursive: true });
    await this._writeJSON(sessionFile, session);
    await this._updateIndex(session, sessionFile);
    return { id: session.id, path: sessionFile, status: session.status, steps: session.steps ?? 0 };
  }

  /**
   * Appends a structured step to the journal.
   * @param {string} sessionId
   * @param {{
   *   label?: string,
   *   prompt?: string | null,
   *   response?: string | null,
   *   schemaId?: string | null,
   *   status?: string | null,
   *   operations?: Array<Record<string, any>>,
   *   metadata?: Record<string, any> | null,
   *   tool_calls?: Array<Record<string, any>> | null,
   *   tool_definitions?: Array<Record<string, any>> | null,
   *   toolCalls?: Array<Record<string, any>> | null,
   *   toolDefinitions?: Array<Record<string, any>> | null,
   *   workspaceSummary?: string | null,
   *   links?: Record<string, any> | null,
   *   startedAt?: number | string | null,
   *   finishedAt?: number | string | null,
   * }} payload
   */
  async appendStep(sessionId, payload) {
    if (!sessionId || !payload) return null;
    await this.prepare();
    const { sessionDir, sessionFile, session } = await this._loadSession(sessionId);
    if (!session) {
      return null;
    }
    const stepsDir = path.join(sessionDir, "steps");
    await fs.promises.mkdir(stepsDir, { recursive: true });
    const sequence = (session.steps ?? 0) + 1;
    const fileName = `step-${String(sequence).padStart(3, "0")}.json`;
    const stepFile = path.join(stepsDir, fileName);
    const startedAt = this._normalizeDate(payload.startedAt);
    const finishedAt = this._normalizeDate(payload.finishedAt);
    const toolMetadata = normalizeToolMetadataPayload(payload);
    const entry = {
      id: `${session.id}#${sequence}`,
      sequence,
      label: payload.label ?? `step-${sequence}`,
      prompt: payload.prompt ?? null,
      response: normalizeJournalResponseValue(payload.response),
      schemaId: payload.schemaId ?? null,
      status: payload.status ?? "recorded",
      operations: Array.isArray(payload.operations) ? payload.operations : [],
      metadata: payload.metadata ?? null,
      tool_calls: toolMetadata.tool_calls,
      tool_definitions: toolMetadata.tool_definitions,
      workspaceSummary: payload.workspaceSummary ?? null,
      links: payload.links ?? null,
      startedAt,
      finishedAt,
      durationMs:
        startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
      recordedAt: new Date().toISOString(),
    };
    await this._writeJSON(stepFile, entry);
    session.steps = sequence;
    session.updatedAt = new Date().toISOString();
    await this._writeJSON(sessionFile, session);
    await this._updateIndex(session, sessionFile);
    return { id: entry.id, path: stepFile };
  }

  /**
   * Updates the session status (active, paused, completed, closed).
   * @param {string} sessionId
   * @param {"active"|"paused"|"completed"|"closed"} status
   * @param {Record<string, any> | null} [note]
   */
  async setStatus(sessionId, status, note = null) {
    if (!sessionId) return;
    await this.prepare();
    const { sessionFile, session } = await this._loadSession(sessionId);
    if (!session) {
      return;
    }
    session.status = resolveStatus(status, session.status);
    session.updatedAt = new Date().toISOString();
    if (note) {
      session.note = note;
    }
    await this._writeJSON(sessionFile, session);
    await this._updateIndex(session, sessionFile);
  }

  async _loadSession(sessionId) {
    const safeId = sanitizeId(sessionId);
    const sessionDir = path.join(this.sessionsDir, safeId);
    const sessionFile = path.join(sessionDir, "session.json");
    const session = await this._readJSON(sessionFile);
    if (!session) {
      return { sessionDir, sessionFile, session: null };
    }
    return { sessionDir, sessionFile, session };
  }

  async _updateIndex(session, sessionFile) {
    const index = await this._readJSON(this.indexFile, DEFAULT_INDEX);
    const filtered = index.entries.filter((entry) => entry.id !== session.id);
    filtered.unshift({
      id: session.id,
      status: session.status,
      steps: session.steps ?? 0,
      updatedAt: session.updatedAt,
      file: path.relative(this.baseDir, sessionFile).replace(/\\/g, "/"),
    });
    index.entries = filtered.slice(0, 200);
    await this._writeJSON(this.indexFile, index);
  }

  async _readJSON(filePath, fallback = null) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async _writeJSON(filePath, data) {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  _normalizeDate(value) {
    if (!value) return null;
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "number") {
      return new Date(value);
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return null;
  }
}
