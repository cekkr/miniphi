import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const DEFAULT_DB_FILENAME = "miniphi-prompts.db";
const MAX_STORED_TEXT = 4000;
const DEFAULT_SNAPSHOT_LIMIT = 12;

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
    this.statements = {};
    this.enabled = false;
    this.semanticEvaluator = null;
  }

  async prepare() {
    if (this.enabled) {
      return;
    }
    await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
    const Database = await this.#loadDriver();
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.#migrate();
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  dispose() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore dispose errors
      }
      this.db = null;
      this.statements = {};
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
    if (!this.enabled || !payload?.traceContext || !payload.request) {
      return;
    }

    const traceContext = payload.traceContext;
    const promptText = this.#sanitizeText(this.#extractPromptText(payload.request));
    if (!promptText) {
      return;
    }

    const responseText = this.#sanitizeText(payload.response?.text ?? "");
    const reasoningPreview = this.#buildReasoningPreview(payload.response?.reasoning ?? []);
    const workspacePath = this.#resolveWorkspacePath(traceContext.metadata);
    const workspaceType = traceContext.metadata?.workspaceType ?? null;
    const workspaceSummary = traceContext.metadata?.workspaceSummary ?? null;
    const sessionId = traceContext.mainPromptId ?? traceContext.subPromptId;
    const objective =
      traceContext.label ??
      traceContext.metadata?.task ??
      traceContext.metadata?.objective ??
      null;
    const metadataJson = JSON.stringify({
      ...traceContext.metadata,
      workspacePath,
      workspaceSummary,
      reasoningPreview,
      durationMs:
        payload.response?.finishedAt && payload.response?.startedAt
          ? payload.response.finishedAt - payload.response.startedAt
          : null,
      tokensApprox: payload.response?.tokensApprox ?? null,
      reasoningCount: payload.response?.reasoning?.length ?? 0,
      error: payload.error ?? null,
    });

    if (this.debug) {
      const idLabel = traceContext.subPromptId ? `promptId=${traceContext.subPromptId}` : "";
      console.log(
        `[MiniPhi][Debug][LM] objective="${objective ?? "unknown"}" scope=${traceContext.scope} ${idLabel}`.trim(),
      );
      console.log(`[MiniPhi][Debug][LM] prompt:\n${promptText}\n---`);
    }

    let evaluation = null;
    if (this.semanticEvaluator) {
      const evalPrompt = this.#buildEvaluationPrompt({
        objective,
        workspacePath,
        workspaceType,
        workspaceSummary,
        promptText,
        responseText,
        reasoningPreview,
        errorText: payload.error ?? null,
      });
      try {
        const raw = await this.semanticEvaluator(evalPrompt, traceContext);
        evaluation = this.#parseEvaluation(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.emitWarning(`Prompt evaluator failed: ${message}`, "PromptPerformanceTracker");
      }
    }

    const score = this.#normalizeScore(
      evaluation?.score ?? this.#estimateScore(responseText, payload.error, payload.response),
    );
    const followUpNeeded = this.#resolveFollowUp(evaluation, payload.error, responseText);
    const followUpReason = this.#resolveFollowUpReason(evaluation, payload.error, responseText);

    const workspaceFingerprint = this.#fingerprint(workspacePath);
    const now = new Date().toISOString();
    this.#persistSession({
      sessionId,
      objective,
      workspacePath,
      workspaceType,
      workspaceFingerprint,
      createdAt: now,
    });

    this.#insertPromptScore({
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

    this.#snapshotBestPrompt({
      objective,
      workspaceFingerprint,
      workspaceType,
      workspacePath,
    });
  }

  async #loadDriver() {
    try {
      const mod = await import("better-sqlite3");
      return mod.default ?? mod;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize SQLite driver (better-sqlite3). Install dependencies via "npm install" to enable prompt scoring. ${message}`,
      );
    }
  }

  #migrate() {
    const migrations = [
      `CREATE TABLE IF NOT EXISTS prompt_sessions (
        session_id TEXT PRIMARY KEY,
        objective TEXT,
        workspace_path TEXT,
        workspace_type TEXT,
        workspace_fingerprint TEXT,
        created_at TEXT NOT NULL
      )`,
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
      )`,
      `CREATE TABLE IF NOT EXISTS best_prompt_snapshots (
        workspace_fingerprint TEXT NOT NULL,
        objective TEXT NOT NULL,
        workspace_type TEXT,
        workspace_path TEXT,
        snapshot_json TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (workspace_fingerprint, objective)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_scores_workspace ON prompt_scores(workspace_fingerprint, objective)`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_scores_session ON prompt_scores(session_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_scores_score ON prompt_scores(score DESC)`,
    ];
    migrations.forEach((sql) => this.db.prepare(sql).run());

    this.statements.insertSession = this.db.prepare(
      `INSERT INTO prompt_sessions (session_id, objective, workspace_path, workspace_type, workspace_fingerprint, created_at)
       VALUES (@sessionId, @objective, @workspacePath, @workspaceType, @workspaceFingerprint, @createdAt)
       ON CONFLICT(session_id) DO UPDATE SET
         objective = COALESCE(excluded.objective, prompt_sessions.objective),
         workspace_path = COALESCE(excluded.workspace_path, prompt_sessions.workspace_path),
         workspace_type = COALESCE(excluded.workspace_type, prompt_sessions.workspace_type),
         workspace_fingerprint = COALESCE(excluded.workspace_fingerprint, prompt_sessions.workspace_fingerprint)`,
    );
    this.statements.insertScore = this.db.prepare(
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
      )`,
    );
    this.statements.selectBest = this.db.prepare(
      `SELECT prompt_id, prompt_text, response_text, score, evaluation_json, created_at
       FROM prompt_scores
       WHERE workspace_fingerprint = ? AND objective = ?
       ORDER BY score DESC, created_at DESC
       LIMIT 1`,
    );
    this.statements.selectStats = this.db.prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(AVG(score), 0) AS avgScore,
        SUM(CASE WHEN follow_up_needed = 1 THEN 1 ELSE 0 END) AS followUps
       FROM prompt_scores
       WHERE workspace_fingerprint = ? AND objective = ?`,
    );
    this.statements.selectRecentScores = this.db.prepare(
      `SELECT id, score, created_at
       FROM prompt_scores
       WHERE workspace_fingerprint = ? AND objective = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    );
    this.statements.upsertSnapshot = this.db.prepare(
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
        computed_at = excluded.computed_at`,
    );
  }

  #persistSession({ sessionId, objective, workspacePath, workspaceType, workspaceFingerprint, createdAt }) {
    if (!sessionId || !this.statements.insertSession) {
      return;
    }
    this.statements.insertSession.run({
      sessionId,
      objective,
      workspacePath,
      workspaceType,
      workspaceFingerprint,
      createdAt,
    });
  }

  #insertPromptScore(entry) {
    if (!this.statements.insertScore) {
      return;
    }
    this.statements.insertScore.run({
      sessionId: entry.sessionId ?? null,
      scope: entry.scope ?? "sub",
      promptId: entry.promptId,
      promptLabel: entry.promptLabel ?? null,
      objective: entry.objective ?? null,
      promptText: this.#sanitizeText(entry.promptText),
      responseText: this.#sanitizeText(entry.responseText),
      score: entry.score ?? null,
      followUpNeeded: entry.followUpNeeded ? 1 : 0,
      followUpReason: entry.followUpReason ?? null,
      evaluationJson: entry.evaluationJson ?? null,
      metadataJson: entry.metadataJson ?? null,
      workspacePath: entry.workspacePath ?? null,
      workspaceType: entry.workspaceType ?? null,
      workspaceFingerprint: entry.workspaceFingerprint ?? null,
      createdAt: entry.createdAt,
    });
  }

  #snapshotBestPrompt({ objective, workspaceFingerprint, workspaceType, workspacePath }) {
    if (!objective || !workspaceFingerprint || !this.statements.selectBest) {
      return;
    }
    const best = this.statements.selectBest.get(workspaceFingerprint, objective);
    if (!best) {
      return;
    }
    const stats = this.statements.selectStats.get(workspaceFingerprint, objective);
    const recent = this.statements.selectRecentScores.all(
      workspaceFingerprint,
      objective,
      this.snapshotLimit,
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
        prompt: this.#sanitizeText(best.prompt_text),
        summary: evaluation?.summary ?? null,
        category: evaluation?.prompt_category ?? null,
        recommendedPattern: evaluation?.recommended_prompt_pattern ?? null,
        seriesStrategy: evaluation?.series_strategy ?? null,
        tags: evaluation?.tags ?? null,
      },
      rollingAverage: stats?.avgScore ?? 0,
      followUpRate:
        stats?.total > 0 ? Number(stats.followUps ?? 0) / Number(stats.total ?? 1) : 0,
      recentScores: recent
        .map((row) => ({
          id: row.id,
          score: row.score,
          at: row.created_at,
        }))
        .reverse(),
    };

    this.statements.upsertSnapshot.run({
      workspaceFingerprint,
      objective,
      workspaceType,
      workspacePath,
      snapshotJson: JSON.stringify(snapshot),
      computedAt: new Date().toISOString(),
    });
  }

  #extractPromptText(request) {
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

  #buildReasoningPreview(reasoning) {
    if (!Array.isArray(reasoning) || reasoning.length === 0) {
      return null;
    }
    const recent = reasoning.slice(-2);
    return recent.join("\n").trim();
  }

  #resolveWorkspacePath(metadata) {
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

  #buildEvaluationPrompt(details) {
    const workspaceSummary = details.workspaceSummary
      ? `Workspace summary:\n${details.workspaceSummary}\n`
      : "";
    return [
      "You score prompt effectiveness for MiniPhi. Return strict JSON with the following keys:",
      'score (0-100), prompt_category (string), summary (string), follow_up_needed (boolean), follow_up_reason (string), tags (string array), recommended_prompt_pattern (string), series_strategy (string array).',
      "Use the assistant response to determine whether the stated objective is satisfied or if more prompts are needed.",
      `Objective: ${details.objective ?? "unknown"}`,
      `Workspace type: ${details.workspaceType ?? "unknown"}`,
      `Workspace path: ${details.workspacePath ?? "n/a"}`,
      workspaceSummary,
      `Prompt:\n"""\n${details.promptText}\n"""`,
      `Assistant response:\n"""\n${details.responseText || "n/a"}\n"""`,
      `Reasoning summary: ${details.reasoningPreview ?? "n/a"}`,
      `Error: ${details.errorText ?? "none"}`,
      "JSON:",
    ]
      .filter(Boolean)
      .join("\n");
  }

  #parseEvaluation(raw) {
    if (!raw) {
      return null;
    }
    const match = String(raw).match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]);
      return typeof parsed === "object" && parsed ? parsed : null;
    } catch {
      return null;
    }
  }

  #estimateScore(responseText, error, responseSnapshot) {
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

  #normalizeScore(value) {
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

  #resolveFollowUp(evaluation, error, responseText) {
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

  #resolveFollowUpReason(evaluation, error, responseText) {
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

  #fingerprint(input) {
    if (!input) {
      return null;
    }
    return createHash("sha1").update(input).digest("hex");
  }

  #sanitizeText(value, limit = MAX_STORED_TEXT) {
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
