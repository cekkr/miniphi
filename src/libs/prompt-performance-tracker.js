import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

const DEFAULT_DB_FILENAME = "miniphi-prompts.db";
const MAX_STORED_TEXT = 4000;
const DEFAULT_SNAPSHOT_LIMIT = 12;
const PROMPT_SCORE_FALLBACK_SCHEMA = [
  "{",
  '  "score": 0,',
  '  "prompt_category": "classification label",',
  '  "summary": "one-sentence rationale",',
  '  "follow_up_needed": false,',
  '  "follow_up_reason": "null or explanation",',
  '  "tags": ["array", "of", "strings"],',
  '  "recommended_prompt_pattern": "reuse hint",',
  '  "series_strategy": ["next prompt idea 1", "next prompt idea 2"]',
  "}",
].join("\n");

/**
 * Tracks prompt quality metrics inside a SQLite database so MiniPhi can surface
 * high-performing prompt structures per workspace/objective combination.
 */
export default class PromptPerformanceTracker {
  /**
   * @param {{
   *   dbPath?: string,
   *   debug?: boolean,
   *   snapshotLimit?: number
   * }} [options]
   */
  constructor(options = undefined) {
    this.dbPath = options?.dbPath ?? path.join(process.cwd(), DEFAULT_DB_FILENAME);
    this.debug = Boolean(options?.debug);
    this.snapshotLimit = options?.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT;
    this.db = null;
    this.enabled = false;
    this.semanticEvaluator = null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.scoreSchemaId = options?.scoreSchemaId ?? "prompt-score";
    this.scoringSuspended = false;
    this.scoringSuspendedReason = null;
    this.scoringSuspendedNotified = false;
  }

  async prepare() {
    if (this.enabled) {
      return;
    }
    await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
    try {
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize SQLite database (${this.dbPath}). Install the "sqlite" and "sqlite3" packages to enable prompt scoring. ${message}`,
      );
    }
    await this.db.exec("PRAGMA journal_mode = WAL;");
    await this.db.exec("PRAGMA foreign_keys = ON;");
    await this._migrate();
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  async dispose() {
    if (this.db) {
      try {
        await this.db.close();
      } catch {
        // ignore dispose errors
      }
      this.db = null;
    }
    this.enabled = false;
  }

  /**
   * Allows the tracker to call into a semantic evaluator (typically Phi-4) when grading prompts.
   * @param {(prompt: string, trace: object) => Promise<string>} evaluator
   */
  setSemanticEvaluator(evaluator) {
    this.semanticEvaluator = typeof evaluator === "function" ? evaluator : null;
  }

  /**
   * Persists a single prompt exchange and synthesizes scoring metadata.
   * @param {{
   *   traceContext: {
   *     scope: string,
   *     label?: string | null,
   *     metadata?: Record<string, unknown> | null,
   *     mainPromptId?: string | null,
   *     subPromptId: string
   *   },
   *   request: Record<string, unknown>,
   *   response?: Record<string, unknown> | null,
   *   error?: string | null
   * }} payload
   */
  async track(payload) {
    if (!this.enabled || !this.db || !payload?.traceContext || !payload.request) {
      return;
    }

    const traceContext = payload.traceContext;
    const sessionContext = this._resolveSessionContext(traceContext);
    const {
      sessionId,
      objective,
      workspacePath,
      workspaceType,
      workspaceSummary,
      workspaceFingerprint: contextWorkspaceFingerprint,
    } = sessionContext;
    const promptText = this._sanitizeText(this._extractPromptText(payload.request));
    if (!promptText) {
      return;
    }

    const responseText = this._sanitizeText(payload.response?.text ?? "");
    const reasoningPreview = this._buildReasoningPreview(payload.response?.reasoning ?? []);
    const durationMs =
      payload.response?.finishedAt && payload.response?.startedAt
        ? payload.response.finishedAt - payload.response.startedAt
        : null;
    const metadataPayload = {
      workspace: {
        path: workspacePath,
        type: workspaceType,
        summary: workspaceSummary,
        manifestSample: traceContext.metadata?.workspaceManifest ?? null,
        readmeSnippet: traceContext.metadata?.workspaceReadmeSnippet ?? null,
      },
      trace: {
        scope: traceContext.scope,
        label: traceContext.label ?? null,
        mainPromptId: traceContext.mainPromptId ?? null,
        subPromptId: traceContext.subPromptId ?? null,
        schemaId: traceContext.schemaId ?? null,
      },
      execution: {
        command: traceContext.metadata?.command ?? null,
        cwd: traceContext.metadata?.cwd ?? workspacePath ?? null,
        taskPlanId: traceContext.metadata?.taskPlanId ?? null,
        taskPlanOutline: traceContext.metadata?.taskPlanOutline ?? null,
        capabilities: traceContext.metadata?.capabilities ?? null,
        capabilitySummary: traceContext.metadata?.capabilitySummary ?? null,
        connections: traceContext.metadata?.workspaceConnections ?? null,
        connectionGraph: traceContext.metadata?.workspaceConnectionGraph ?? null,
      },
      stats: {
        durationMs,
        tokensApprox: payload.response?.tokensApprox ?? null,
        reasoningCount: payload.response?.reasoning?.length ?? 0,
        error: payload.error ?? null,
      },
      reasoningPreview,
      customMetadata: traceContext.metadata ?? null,
    };
    const metadataJson = JSON.stringify(metadataPayload);

    if (this.debug) {
      const idLabel = traceContext.subPromptId ? `promptId=${traceContext.subPromptId}` : "";
      console.log(
        `[MiniPhi][Debug][LM] objective="${objective ?? "unknown"}" scope=${traceContext.scope} ${idLabel}`.trim(),
      );
      console.log(`[MiniPhi][Debug][LM] prompt:\n${promptText}\n---`);
    }

    let evaluation = null;
    if (this.scoringSuspended) {
      if (this.debug && !this.scoringSuspendedNotified) {
        console.warn(
          `[MiniPhi][Debug][LM] Prompt scoring suspended${this.scoringSuspendedReason ? `: ${this.scoringSuspendedReason}` : ""}`,
        );
        this.scoringSuspendedNotified = true;
      }
    } else if (this.semanticEvaluator) {
      const evalPrompt = this._buildEvaluationPrompt({
        objective,
        workspacePath,
        workspaceType,
        workspaceSummary,
        promptText,
        responseText,
        reasoningPreview,
        errorText: payload.error ?? null,
        capabilitySummary: traceContext.metadata?.capabilitySummary ?? null,
        executionCommand: traceContext.metadata?.command ?? null,
        executionCwd: traceContext.metadata?.cwd ?? null,
      });
      try {
        const raw = await this.semanticEvaluator(evalPrompt, traceContext);
        evaluation = this._parseEvaluation(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const proseFailure =
          /schema validation/i.test(message) ||
          /not valid json/i.test(message) ||
          /response was not valid json/i.test(message) ||
          /failed json parse/i.test(message);
        if (proseFailure) {
          this.scoringSuspended = true;
          this.scoringSuspendedReason = message;
          if (this.debug) {
            console.warn(`[MiniPhi][Debug][LM] Prompt scoring suspended: ${message}`);
          }
        } else {
          process.emitWarning(`Prompt evaluator failed: ${message}`, "PromptPerformanceTracker");
        }
      }
    }

    const score = this._normalizeScore(
      evaluation?.score ?? this._estimateScore(responseText, payload.error, payload.response),
    );
    const followUpNeeded = this._resolveFollowUp(evaluation, payload.error, responseText);
    const followUpReason = this._resolveFollowUpReason(evaluation, payload.error, responseText);

    const workspaceFingerprint =
      contextWorkspaceFingerprint ?? this._fingerprint(workspacePath);
    const now = new Date().toISOString();
    await this._persistSession({
      sessionId,
      objective,
      workspacePath,
      workspaceType,
      workspaceFingerprint,
      createdAt: now,
    });

    await this._insertPromptScore({
      scope: traceContext.scope,
      sessionId,
      promptId: traceContext.subPromptId,
      promptLabel: traceContext.label ?? null,
      objective,
      promptText,
      responseText,
      score,
      followUpNeeded,
      followUpReason,
      evaluationJson: evaluation ? JSON.stringify(evaluation) : null,
      metadataJson,
      workspacePath,
      workspaceType,
      workspaceFingerprint,
      createdAt: now,
    });

    await this._snapshotBestPrompt({
      objective,
      workspaceFingerprint,
      workspaceType,
      workspacePath,
    });
  }

  /**
   * Records auxiliary prompt events (timeouts, retries) for richer telemetry.
   * @param {{
   *   traceContext: object,
   *   request?: Record<string, unknown> | null,
   *   eventType: string,
   *   severity?: string,
   *   message: string,
   *   metadata?: Record<string, unknown> | null
   * }} payload
   */
  async recordEvent(payload) {
    if (
      !this.enabled ||
      !this.db ||
      !payload ||
      !payload.traceContext ||
      !payload.eventType ||
      !payload.message
    ) {
      return;
    }
    const traceContext = payload.traceContext;
    const sessionContext = this._resolveSessionContext(traceContext);
    const { sessionId, objective, workspacePath, workspaceType, workspaceFingerprint } =
      sessionContext;
    if (!sessionId) {
      return;
    }
    const metadataJson = payload.metadata ? JSON.stringify(payload.metadata) : null;
    const createdAt = new Date().toISOString();
    await this._persistSession({
      sessionId,
      objective,
      workspacePath,
      workspaceType,
      workspaceFingerprint,
      createdAt,
    });
    await this._insertPromptEvent({
      sessionId,
      promptId: traceContext.subPromptId ?? payload.request?.id ?? null,
      eventType: payload.eventType,
      severity: payload.severity ?? "info",
      message: payload.message,
      metadataJson,
      workspacePath,
      workspaceType,
      workspaceFingerprint,
      createdAt,
    });
  }

  async _migrate() {
    if (!this.db) {
      return;
    }
    const migrations = [
      `CREATE TABLE IF NOT EXISTS prompt_sessions (
        session_id TEXT PRIMARY KEY,
        objective TEXT,
        workspace_path TEXT,
        workspace_type TEXT,
        workspace_fingerprint TEXT,
        created_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS prompt_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        prompt_label TEXT,
        objective TEXT,
        prompt_text TEXT,
        response_text TEXT,
        score REAL,
        follow_up_needed INTEGER NOT NULL DEFAULT 0,
        follow_up_reason TEXT,
        evaluation_json TEXT,
        metadata_json TEXT,
        workspace_path TEXT,
        workspace_type TEXT,
        workspace_fingerprint TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES prompt_sessions(session_id) ON DELETE CASCADE
      );`,
      `CREATE TABLE IF NOT EXISTS best_prompt_snapshots (
        workspace_fingerprint TEXT NOT NULL,
        objective TEXT NOT NULL,
        workspace_type TEXT,
        workspace_path TEXT,
        snapshot_json TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (workspace_fingerprint, objective)
      );`,
      `CREATE TABLE IF NOT EXISTS prompt_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        prompt_id TEXT,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        workspace_path TEXT,
        workspace_type TEXT,
        workspace_fingerprint TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES prompt_sessions(session_id) ON DELETE SET NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_scores_workspace ON prompt_scores(workspace_fingerprint, objective);`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_scores_session ON prompt_scores(session_id, created_at);`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_scores_score ON prompt_scores(score DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_events_session ON prompt_events(session_id, created_at);`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_events_type ON prompt_events(event_type, created_at);`,
    ];
    for (const sql of migrations) {
      await this.db.exec(sql);
    }
  }

  async _persistSession({
    sessionId,
    objective,
    workspacePath,
    workspaceType,
    workspaceFingerprint,
    createdAt,
  }) {
    if (!this.db || !sessionId) {
      return;
    }
    await this.db.run(
      `INSERT INTO prompt_sessions (session_id, objective, workspace_path, workspace_type, workspace_fingerprint, created_at)
       VALUES (@sessionId, @objective, @workspacePath, @workspaceType, @workspaceFingerprint, @createdAt)
       ON CONFLICT(session_id) DO UPDATE SET
         objective = COALESCE(excluded.objective, prompt_sessions.objective),
         workspace_path = COALESCE(excluded.workspace_path, prompt_sessions.workspace_path),
         workspace_type = COALESCE(excluded.workspace_type, prompt_sessions.workspace_type),
         workspace_fingerprint = COALESCE(excluded.workspace_fingerprint, prompt_sessions.workspace_fingerprint);`,
      {
        "@sessionId": sessionId,
        "@objective": objective,
        "@workspacePath": workspacePath,
        "@workspaceType": workspaceType,
        "@workspaceFingerprint": workspaceFingerprint,
        "@createdAt": createdAt,
      },
    );
  }

  async _insertPromptScore(entry) {
    if (!this.db) {
      return;
    }
    await this.db.run(
      `INSERT INTO prompt_scores (
        session_id,
        scope,
        prompt_id,
        prompt_label,
        objective,
        prompt_text,
        response_text,
        score,
        follow_up_needed,
        follow_up_reason,
        evaluation_json,
        metadata_json,
        workspace_path,
        workspace_type,
        workspace_fingerprint,
        created_at
      ) VALUES (
        @sessionId,
        @scope,
        @promptId,
        @promptLabel,
        @objective,
        @promptText,
        @responseText,
        @score,
        @followUpNeeded,
        @followUpReason,
        @evaluationJson,
        @metadataJson,
        @workspacePath,
        @workspaceType,
        @workspaceFingerprint,
        @createdAt
      );`,
      {
        "@sessionId": entry.sessionId ?? null,
        "@scope": entry.scope ?? "sub",
        "@promptId": entry.promptId,
        "@promptLabel": entry.promptLabel ?? null,
        "@objective": entry.objective ?? null,
        "@promptText": this._sanitizeText(entry.promptText),
        "@responseText": this._sanitizeText(entry.responseText),
        "@score": entry.score ?? null,
        "@followUpNeeded": entry.followUpNeeded ? 1 : 0,
        "@followUpReason": entry.followUpReason ?? null,
        "@evaluationJson": entry.evaluationJson ?? null,
        "@metadataJson": entry.metadataJson ?? null,
        "@workspacePath": entry.workspacePath ?? null,
        "@workspaceType": entry.workspaceType ?? null,
        "@workspaceFingerprint": entry.workspaceFingerprint ?? null,
        "@createdAt": entry.createdAt,
      },
    );
  }

  async _insertPromptEvent(entry) {
    if (!this.db) {
      return;
    }
    await this.db.run(
      `INSERT INTO prompt_events (
        session_id,
        prompt_id,
        event_type,
        severity,
        message,
        metadata_json,
        workspace_path,
        workspace_type,
        workspace_fingerprint,
        created_at
      ) VALUES (
        @sessionId,
        @promptId,
        @eventType,
        @severity,
        @message,
        @metadataJson,
        @workspacePath,
        @workspaceType,
        @workspaceFingerprint,
        @createdAt
      );`,
      {
        "@sessionId": entry.sessionId ?? null,
        "@promptId": entry.promptId ?? null,
        "@eventType": entry.eventType,
        "@severity": entry.severity ?? "info",
        "@message": entry.message,
        "@metadataJson": entry.metadataJson ?? null,
        "@workspacePath": entry.workspacePath ?? null,
        "@workspaceType": entry.workspaceType ?? null,
        "@workspaceFingerprint": entry.workspaceFingerprint ?? null,
        "@createdAt": entry.createdAt,
      },
    );
  }

  async _snapshotBestPrompt({ objective, workspaceFingerprint, workspaceType, workspacePath }) {
    if (!this.db || !objective || !workspaceFingerprint) {
      return;
    }
    const best = await this.db.get(
      `SELECT prompt_id, prompt_text, response_text, score, evaluation_json, created_at
       FROM prompt_scores
       WHERE workspace_fingerprint = ? AND objective = ?
       ORDER BY score DESC, created_at DESC
       LIMIT 1;`,
      [workspaceFingerprint, objective],
    );
    if (!best) {
      return;
    }
    const stats = await this.db.get(
      `SELECT
        COUNT(*) AS total,
        COALESCE(AVG(score), 0) AS avgScore,
        SUM(CASE WHEN follow_up_needed = 1 THEN 1 ELSE 0 END) AS followUps
       FROM prompt_scores
       WHERE workspace_fingerprint = ? AND objective = ?;`,
      [workspaceFingerprint, objective],
    );
    const recent = await this.db.all(
      `SELECT id, score, created_at
       FROM prompt_scores
       WHERE workspace_fingerprint = ? AND objective = ?
       ORDER BY created_at DESC
       LIMIT ?;`,
      [workspaceFingerprint, objective, this.snapshotLimit],
    );

    let evaluation = null;
    if (best.evaluation_json) {
      try {
        evaluation = JSON.parse(best.evaluation_json);
      } catch {
        evaluation = null;
      }
    }

    const snapshot = {
      objective,
      workspacePath,
      workspaceType,
      bestPrompt: {
        promptId: best.prompt_id,
        score: best.score,
        prompt: this._sanitizeText(best.prompt_text),
        summary: evaluation?.summary ?? null,
        category: evaluation?.prompt_category ?? null,
        recommendedPattern: evaluation?.recommended_prompt_pattern ?? null,
        seriesStrategy: evaluation?.series_strategy ?? null,
        tags: evaluation?.tags ?? null,
      },
      rollingAverage: stats?.avgScore ?? 0,
      followUpRate:
        stats?.total > 0 ? Number(stats.followUps ?? 0) / Number(stats.total ?? 1) : 0,
      recentScores: (recent ?? [])
        .map((row) => ({
          id: row.id,
          score: row.score,
          at: row.created_at,
        }))
        .reverse(),
    };

    await this.db.run(
      `INSERT INTO best_prompt_snapshots (
        workspace_fingerprint,
        objective,
        workspace_type,
        workspace_path,
        snapshot_json,
        computed_at
      ) VALUES (
        @workspaceFingerprint,
        @objective,
        @workspaceType,
        @workspacePath,
        @snapshotJson,
        @computedAt
      )
      ON CONFLICT(workspace_fingerprint, objective) DO UPDATE SET
        workspace_type = excluded.workspace_type,
        workspace_path = excluded.workspace_path,
        snapshot_json = excluded.snapshot_json,
        computed_at = excluded.computed_at;`,
      {
        "@workspaceFingerprint": workspaceFingerprint,
        "@objective": objective,
        "@workspaceType": workspaceType,
        "@workspacePath": workspacePath,
        "@snapshotJson": JSON.stringify(snapshot),
        "@computedAt": new Date().toISOString(),
      },
    );
  }

  _extractPromptText(request) {
    if (!request) {
      return "";
    }
    if (typeof request.promptText === "string" && request.promptText.trim()) {
      return request.promptText.trim();
    }
    if (Array.isArray(request.messages) && request.messages.length > 0) {
      const last = request.messages[request.messages.length - 1];
      if (last?.role === "user" && typeof last.content === "string") {
        return last.content.trim();
      }
    }
    return "";
  }

  _buildReasoningPreview(reasoning) {
    if (!Array.isArray(reasoning) || reasoning.length === 0) {
      return null;
    }
    const recent = reasoning.slice(-2);
    return recent.join("\n").trim();
  }

  _resolveWorkspacePath(metadata) {
    if (!metadata) {
      return null;
    }
    const cwd = metadata.cwd ?? metadata.workspacePath ?? metadata.workspaceRoot ?? null;
    if (typeof cwd === "string" && cwd.trim()) {
      return path.resolve(cwd);
    }
    const filePath = metadata.filePath ?? null;
    if (typeof filePath === "string" && filePath.trim()) {
      return path.dirname(path.resolve(filePath));
    }
    return null;
  }

  _buildEvaluationPrompt(details) {
    const workspaceSummary = details.workspaceSummary
      ? `Workspace summary:\n${details.workspaceSummary}\n`
      : "";
    const schemaBlock = this._buildSchemaInstructions(
      this.scoreSchemaId,
      PROMPT_SCORE_FALLBACK_SCHEMA,
    );
    const capabilitySummary = details.capabilitySummary
      ? `Available tools:\n${details.capabilitySummary}\n`
      : "";
    const commandLine = details.executionCommand
      ? `Command executed: ${details.executionCommand} (cwd: ${details.executionCwd ?? "n/a"})`
      : details.executionCwd
        ? `Working directory: ${details.executionCwd}`
        : "";
    return [
      "You score prompt effectiveness for MiniPhi. Use the assistant response to determine whether the stated objective is satisfied or if more prompts are needed.",
      "Return strict JSON matching this schema:",
      schemaBlock,
      `Objective: ${details.objective ?? "unknown"}`,
      `Workspace type: ${details.workspaceType ?? "unknown"}`,
      `Workspace path: ${details.workspacePath ?? "n/a"}`,
      workspaceSummary,
      capabilitySummary,
      commandLine,
      `Prompt:\n"""\n${details.promptText}\n"""`,
      `Assistant response:\n"""\n${details.responseText || "n/a"}\n"""`,
      `Reasoning summary: ${details.reasoningPreview ?? "n/a"}`,
      `Error: ${details.errorText ?? "none"}`,
      "JSON:",
    ]
      .filter(Boolean)
      .join("\n");
  }

  _buildSchemaInstructions(schemaId, fallbackSchema) {
    if (this.schemaRegistry && schemaId) {
      const block = this.schemaRegistry.buildInstructionBlock(schemaId);
      if (block) {
        return block;
      }
    }
    return ["```json", fallbackSchema, "```"].join("\n");
  }

  _parseEvaluation(raw) {
    if (!raw) {
      return null;
    }
    const cleaned = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, "");
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return this._normalizeEvaluationShape(parsed);
    } catch {
      return null;
    }
  }

  _normalizeEvaluationShape(payload) {
    const normalized = { ...payload };
    if (Array.isArray(normalized.tags)) {
      normalized.tags = normalized.tags
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter(Boolean);
    } else {
      normalized.tags = [];
    }
    if (Array.isArray(normalized.series_strategy)) {
      normalized.series_strategy = normalized.series_strategy
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
    } else if (typeof normalized.series_strategy === "string") {
      const trimmed = normalized.series_strategy.trim();
      normalized.series_strategy = trimmed ? [trimmed] : [];
    } else {
      normalized.series_strategy = [];
    }
    return normalized;
  }

  _estimateScore(responseText, error, responseSnapshot) {
    if (error) {
      return 25;
    }
    if (!responseText) {
      return 40;
    }
    const base = Math.min(85, 45 + Math.floor(responseText.length / 150));
    const reasoningBonus = Math.min(
      10,
      (responseSnapshot?.reasoning?.length ?? 0) * 2,
    );
    return base + reasoningBonus;
  }

  _normalizeScore(value) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value < 0) {
      return 0;
    }
    if (value > 100) {
      return 100;
    }
    return Math.round(value * 10) / 10;
  }

  _resolveFollowUp(evaluation, error, responseText) {
    if (typeof evaluation?.follow_up_needed === "boolean") {
      return evaluation.follow_up_needed;
    }
    if (error) {
      return true;
    }
    if (!responseText) {
      return true;
    }
    const text = responseText.toLowerCase();
    return (
      text.includes("follow-up") ||
      text.includes("needs to") ||
      text.includes("next step") ||
      text.includes("todo")
    );
  }

  _resolveFollowUpReason(evaluation, error, responseText) {
    if (evaluation?.follow_up_reason) {
      return evaluation.follow_up_reason;
    }
    if (error) {
      return error;
    }
    if (!responseText) {
      return "Assistant response was empty.";
    }
    return null;
  }

  _resolveSessionContext(traceContext) {
    if (!traceContext) {
      return {
        sessionId: null,
        objective: null,
        workspacePath: null,
        workspaceType: null,
        workspaceSummary: null,
        workspaceFingerprint: null,
      };
    }
    const metadata = traceContext.metadata ?? {};
    const workspacePath = this._resolveWorkspacePath(metadata);
    return {
      sessionId: traceContext.mainPromptId ?? traceContext.subPromptId ?? null,
      objective: traceContext.label ?? metadata.task ?? metadata.objective ?? null,
      workspacePath,
      workspaceType: metadata.workspaceType ?? null,
      workspaceSummary: metadata.workspaceSummary ?? null,
      workspaceFingerprint: this._fingerprint(workspacePath),
    };
  }

  _fingerprint(input) {
    if (!input) {
      return null;
    }
    return createHash("sha1").update(input).digest("hex");
  }

  _sanitizeText(value, limit = MAX_STORED_TEXT) {
    if (!value) {
      return "";
    }
    const trimmed = String(value).trim();
    if (trimmed.length <= limit) {
      return trimmed;
    }
    return `${trimmed.slice(0, limit)}...`;
  }
}
