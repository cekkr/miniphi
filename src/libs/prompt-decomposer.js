import { randomUUID } from "crypto";
import {
  buildPlanSegments,
  formatPlanSegmentsBlock,
  formatPlanRecommendationsBlock,
} from "./core-utils.js";
import {
  buildJsonSchemaResponseFormat,
  validateJsonAgainstSchema,
} from "./json-schema-utils.js";
import { LMStudioRestClient } from "./lmstudio-api.js";
import { classifyLmStudioError, isContextOverflowError } from "./lmstudio-error-utils.js";
import {
  MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
  normalizeLmStudioRequestTimeoutMs,
} from "./runtime-defaults.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = MIN_LMSTUDIO_REQUEST_TIMEOUT_MS;
const MAX_STEP_PREVIEW = 10;
const COMPACT_SUMMARY_LIMIT = 800;
const COMPACT_HINT_LIMIT = 600;
const COMPACT_CAPABILITY_LIMIT = 400;
const SESSION_REQUEST_CAP_MS = 120000;

const PLAN_SCHEMA_ID = "prompt-plan";
const PLAN_SCHEMA_VERSION = "prompt-plan@v1";

const SYSTEM_PROMPT = [
  "You are the MiniPhi prompt decomposer.",
  `Given a user objective, workspace metadata, and optional CLI commands, produce a structured JSON plan that matches schema ${PLAN_SCHEMA_VERSION}.`,
  "ALWAYS return strictly valid JSON; never include commentary outside the JSON.",
  "Mandatory fields: schema_version, plan_id, summary, needs_more_context, missing_snippets, steps[].id/title/description/requires_subprompt/children, recommended_tools, notes.",
  "Use depth-first numbering so follow-up prompts can resume mid-branch (e.g., 1, 1.1, 1.2, 2, ...).",
  "Do not invent actions outside the workspace scope; prefer to reference concrete files, commands, or tools when available.",
].join(" ");

const PLAN_SCHEMA = [
  "{",
  `  "schema_version": "${PLAN_SCHEMA_VERSION}",`,
  '  "plan_id": "string identifier",',
  '  "summary": "two-sentence overview of the strategy",',
  '  "needs_more_context": false,',
  '  "missing_snippets": ["files or snippets needed"],',
  '  "steps": [',
  "    {",
  '      "id": "1 or 1.1 style depth-first index",',
  '      "title": "short name",',
  '      "description": "action details",',
  '      "requires_subprompt": true,',
  '      "recommendation": "optional tool/script to run or null",',
  '      "children": []',
  "    }",
  "  ],",
  '  "recommended_tools": ["cli command or script name"],',
  '  "notes": "extra context or null"',
  "}",
].join("\n");

const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "plan_id", "summary", "steps", "needs_more_context", "missing_snippets"],
  properties: {
    schema_version: { type: "string", enum: [PLAN_SCHEMA_VERSION] },
    plan_id: { type: "string" },
    summary: { type: "string" },
    needs_more_context: { type: "boolean" },
    missing_snippets: { type: "array", items: { type: "string" }, default: [] },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "description", "requires_subprompt", "children"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          requires_subprompt: { type: "boolean" },
          recommendation: { type: ["string", "null"] },
          children: { type: "array" },
        },
      },
    },
    recommended_tools: { type: "array", items: { type: "string" }, default: [] },
    notes: { type: ["string", "null"] },
  },
};

const DEFAULT_RESPONSE_FORMAT = buildJsonSchemaResponseFormat(
  PLAN_JSON_SCHEMA,
  PLAN_SCHEMA_ID,
);

export default class PromptDecomposer {
  constructor(options = undefined) {
    this.restClient =
      options?.restClient ??
      new LMStudioRestClient(options?.restClientOptions ?? undefined);
    this.maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxActions = options?.maxActions ?? DEFAULT_MAX_ACTIONS;
    this.temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.schemaId =
      typeof options?.schemaId === "string" && options.schemaId.trim().length
        ? options.schemaId.trim()
        : PLAN_SCHEMA_ID;
    const requestedTimeout = Number(options?.timeoutMs);
    this.timeoutMs = normalizeLmStudioRequestTimeoutMs(
      requestedTimeout,
      DEFAULT_TIMEOUT_MS,
    );
    this.disabled = false;
    this.disableNotice = null;
  }

  _resolveSchemaDefinition() {
    if (this.schemaRegistry?.getSchema) {
      const entry = this.schemaRegistry.getSchema(this.schemaId);
      if (entry?.definition) {
        return entry.definition;
      }
    }
    return PLAN_JSON_SCHEMA;
  }

  _buildSchemaBlock() {
    if (this.schemaRegistry?.buildInstructionBlock) {
      const block = this.schemaRegistry.buildInstructionBlock(this.schemaId, {
        compact: true,
        maxLength: 1600,
      });
      if (block) {
        return block;
      }
    }
    return ["```json", PLAN_SCHEMA, "```"].join("\n");
  }

  _resolveResponseFormat() {
    const definition = this._resolveSchemaDefinition();
    return buildJsonSchemaResponseFormat(definition, this.schemaId) ?? DEFAULT_RESPONSE_FORMAT;
  }

  /**
   * Generates and optionally persists a recursive action plan for the provided objective.
   * @param {{
   *   objective: string,
   *   command?: string | null,
   *   workspace?: Record<string, unknown> | null,
   *   promptRecorder?: import("./prompt-recorder.js").default | null,
   *   storage?: import("./miniphi-memory.js").default | null,
   *   mainPromptId?: string | null,
   *   promptJournalId?: string | null,
   *   metadata?: Record<string, unknown> | null,
   *   resumePlan?: object | null,
   *   planBranch?: string | null,
   *   sessionDeadline?: number | null,
   * }} payload
   */
  async decompose(payload) {
    if (!payload?.objective || !this.restClient || this.disabled) {
      if (this.disabled) {
        this._log("[PromptDecomposer] Disabled after previous failures; skipping.");
      }
      return null;
    }
    let requestBody = null;
    let requestMessages = null;
    let responseText = "";
    let responseToolCalls = null;
    let responseToolDefinitions = null;
    let promptRecord = null;
    let normalizedPlan = null;
    let schemaValidation = null;
    let errorMessage = null;
    let errorInfo = null;

    const attempts = [
      this._buildRequestBody(payload, { compact: false }),
      this._buildRequestBody(payload, { compact: true }),
      this._buildRequestBody(payload, { compact: true, minimal: true }),
    ];
    const schemaBlock = this._buildSchemaBlock();
    const responseFormat = this._resolveResponseFormat();

    const buildMessages = (body) => [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\nJSON schema:\n${schemaBlock}`,
      },
      {
        role: "user",
        content: JSON.stringify(body, null, 2),
      },
    ];

    const runCompletion = async (body, responseFormatOverride = undefined) => {
      const responseFormatForRun = responseFormatOverride ?? responseFormat;
      const messages = buildMessages(body);
      const requestTimeoutMs = this._resolveRequestTimeout(payload?.sessionDeadline);
      const completion = await this._withTimeout(
        this.restClient.createChatCompletion({
          messages,
          temperature: this.temperature,
          max_tokens: -1,
          response_format: responseFormatForRun,
        }),
        requestTimeoutMs,
      );
      const message = completion?.choices?.[0]?.message ?? null;
      const text = message?.content ?? "";
      schemaValidation = validateJsonAgainstSchema(this._resolveSchemaDefinition(), text);
      return {
        text,
        toolCalls: message?.tool_calls ?? null,
        toolDefinitions: completion?.tool_definitions ?? null,
        messages,
        responseFormat: responseFormatForRun,
      };
    };

    for (let i = 0; i < attempts.length && !normalizedPlan; i += 1) {
      requestBody = attempts[i];
      const modeLabel = i === 0 ? "full" : i === 1 ? "compact" : "minimal";
      try {
        if (i > 0) {
          this._log(`[PromptDecomposer] Attempting ${modeLabel} workspace payload due to previous failure.`);
        }
        const response = await runCompletion(requestBody);
        responseText = response.text;
        requestMessages = response.messages;
        responseToolCalls = response.toolCalls;
        responseToolDefinitions = response.toolDefinitions;
        normalizedPlan = this._parsePlan(responseText, payload);
        errorMessage = null;
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage && this._isContextOverflowError(errorMessage)) {
          continue;
        }
        if (errorMessage) {
          break;
        }
      }
    }
    if (!normalizedPlan && !errorMessage) {
      errorMessage = "no valid decomposition plan returned";
    }

    if (errorMessage) {
      errorInfo = classifyLmStudioError(errorMessage);
      this._log(`[PromptDecomposer] REST failure: ${errorMessage}`);
      if (this._shouldDisable(errorMessage)) {
        this._disableDecomposer(errorMessage);
        this._log("[PromptDecomposer] Disabled after repeated failures.");
      }
      normalizedPlan = this._fallbackPlan(errorMessage, payload, errorInfo);
    }

    if (payload.promptRecorder) {
      const schemaValidationSummary = schemaValidation
        ? {
            valid: Boolean(schemaValidation.valid),
            errors: Array.isArray(schemaValidation.errors)
              ? schemaValidation.errors.slice(0, 3)
              : null,
            preambleDetected: Boolean(schemaValidation.preambleDetected),
          }
        : null;
      const responsePayload =
        normalizedPlan && typeof normalizedPlan === "object" && !Array.isArray(normalizedPlan)
          ? { ...normalizedPlan }
          : { raw: responseText };
      responsePayload.rawResponseText = responseText ?? "";
      responsePayload.schemaValidation =
        schemaValidationSummary ?? responsePayload.schemaValidation ?? null;
      responsePayload.tool_calls = responseToolCalls ?? null;
      responsePayload.tool_definitions = responseToolDefinitions ?? null;
      promptRecord = await payload.promptRecorder.record({
        scope: "sub",
        label: "prompt-decomposition",
        mainPromptId: payload.mainPromptId ?? null,
        metadata: {
          type: "prompt-decomposition",
          objective: payload.objective,
          command: payload.command ?? null,
          workspaceType: payload.workspace?.classification ?? null,
          promptJournalId: payload.promptJournalId ?? null,
          stop_reason:
            normalizedPlan?.stopReason ??
            errorInfo?.reason ??
            errorMessage ??
            null,
          stop_reason_code: errorInfo?.code ?? null,
          stop_reason_detail: errorInfo?.message ?? null,
        },
        request: {
          endpoint: "/chat/completions",
          payload: requestBody,
          messages: requestMessages ?? null,
          response_format: responseFormat ?? DEFAULT_RESPONSE_FORMAT,
        },
        response: responsePayload,
        error: errorMessage,
      });
    }

    if (!normalizedPlan) {
      return null;
    }
    normalizedPlan.schemaId = this.schemaId;
    normalizedPlan.toolCalls = responseToolCalls ?? null;
    normalizedPlan.toolDefinitions = responseToolDefinitions ?? null;
    normalizedPlan.promptExchange = promptRecord ?? null;

    if (payload.storage) {
      await payload.storage.savePromptDecomposition({
        plan: normalizedPlan.plan,
        planId: normalizedPlan.planId,
        summary: normalizedPlan.summary,
        outline: normalizedPlan.outline ?? null,
        segments: normalizedPlan.segments ?? null,
        segmentBlock: normalizedPlan.segmentBlock ?? null,
        recommendedTools: normalizedPlan.recommendedTools ?? null,
        recommendationsBlock: normalizedPlan.recommendationsBlock ?? null,
        metadata: {
          objective: payload.objective,
          command: payload.command ?? null,
          workspaceType: payload.workspace?.classification?.label ?? null,
          mainPromptId: payload.mainPromptId ?? null,
          extra: payload.metadata ?? null,
          planBranch: payload.planBranch ?? null,
        },
      });
    }

    return normalizedPlan;
  }

  _buildRequestBody(payload, { compact = false, minimal = false } = {}) {
    const commandAnalysis = this._analyzeCommand(payload.command);
    const resume = this._buildResumeContext(payload);
    const classification = payload.workspace?.classification ?? null;
    const cachedWorkspace =
      minimal ? null : this._buildCachedWorkspaceHint(payload.workspace?.cachedHints, compact);
    const stats = minimal ? null : this._sanitizeWorkspaceStats(payload.workspace?.stats);
    const cachedHintBlock = minimal ? null : payload.workspace?.cachedHints?.hintBlock ?? null;
    const summary =
      minimal && payload.workspace?.summary
        ? this._compactText(payload.workspace.summary, 240)
        : compact
          ? this._compactText(payload.workspace?.summary, COMPACT_SUMMARY_LIMIT)
          : payload.workspace?.summary ?? null;
    const hintBlock =
      minimal && payload.workspace?.hintBlock
        ? this._compactText(payload.workspace.hintBlock, 240)
        : compact
          ? this._compactText(payload.workspace?.hintBlock, COMPACT_HINT_LIMIT)
          : payload.workspace?.hintBlock ?? null;
    const directives =
      minimal
        ? null
        : compact && payload.workspace?.planDirectives
          ? this._compactText(payload.workspace.planDirectives, COMPACT_HINT_LIMIT)
          : payload.workspace?.planDirectives ?? payload.workspace?.directives ?? null;
    const body = {
      objective: payload.objective,
      command: payload.command ?? null,
      workspace: {
        classification,
        domain: classification?.domain ?? null,
        summary,
        actions: Array.isArray(classification?.actions) && classification.actions.length
          ? classification.actions
          : null,
        hint: hintBlock,
        directives,
        cached_hint: cachedHintBlock,
        cached_context: cachedWorkspace,
        manifestSample:
          minimal || compact ? [] : (payload.workspace?.manifestPreview ?? []).slice(0, 8),
        stats,
        capabilitySummary: compact
          ? this._compactText(payload.workspace?.capabilitySummary, COMPACT_CAPABILITY_LIMIT)
          : payload.workspace?.capabilitySummary ?? null,
        navigationSummary: compact
          ? this._compactText(payload.workspace?.navigationSummary, COMPACT_CAPABILITY_LIMIT)
          : payload.workspace?.navigationSummary ?? null,
      },
      limits: {
        maxDepth: minimal ? Math.min(2, this.maxDepth ?? DEFAULT_MAX_DEPTH) : this.maxDepth,
        maxActions: minimal ? Math.min(6, this.maxActions ?? DEFAULT_MAX_ACTIONS) : this.maxActions,
      },
      expectations: {
        recursive: true,
        captureTools: true,
        jsonOnly: true,
        stripPreambles: true,
        resumeBranch: payload.planBranch ?? null,
      },
    };
    if (commandAnalysis) {
      body.command_analysis = commandAnalysis;
    }
    if (resume) {
      body.resume = resume;
    }
    if (body.workspace.cached_hint && body.workspace.hint === body.workspace.cached_hint) {
      body.workspace.cached_hint = null;
    }
    if (cachedWorkspace) {
      if (cachedWorkspace.summary && cachedWorkspace.summary === body.workspace.summary) {
        cachedWorkspace.summary = null;
      }
      if (cachedWorkspace.hint && cachedWorkspace.hint === body.workspace.hint) {
        cachedWorkspace.hint = null;
      }
      if (
        cachedWorkspace.directives &&
        cachedWorkspace.directives === body.workspace.directives
      ) {
        cachedWorkspace.directives = null;
      }
      const hasManifest =
        Array.isArray(cachedWorkspace.manifestSample) && cachedWorkspace.manifestSample.length > 0;
      const hasNavigation =
        cachedWorkspace.navigation?.summary || cachedWorkspace.navigation?.block;
      const hasClassification = Boolean(cachedWorkspace.classification);
      const hasHints =
        cachedWorkspace.summary ||
        cachedWorkspace.hint ||
        cachedWorkspace.directives ||
        cachedWorkspace.updated_at;
      body.workspace.cached_context =
        hasManifest || hasNavigation || hasClassification || hasHints ? cachedWorkspace : null;
    }
    return body;
  }

  _withTimeout(promise, timeoutOverride = undefined) {
    const timeoutMs =
      Number.isFinite(timeoutOverride) && timeoutOverride > 0
        ? timeoutOverride
        : this.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Prompt decomposition exceeded ${Math.round(timeoutMs / 1000)}s timeout.`,
          ),
        );
      }, timeoutMs);
      timer?.unref?.();
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  _shouldDisable(message) {
    if (this._isSessionTimeout(message)) {
      return false;
    }
    return classifyLmStudioError(message).shouldDisable;
  }

  _disableDecomposer(message) {
    this.disabled = true;
    this.disableNotice = {
      feature: "prompt-decomposer",
      reason: this._classifyDisableReason(message),
      message,
      timestamp: new Date().toISOString(),
      emitted: false,
    };
  }

  consumeDisableNotice() {
    if (!this.disableNotice || this.disableNotice.emitted) {
      return null;
    }
    this.disableNotice.emitted = true;
    return this.disableNotice;
  }

  _classifyDisableReason(message) {
    if (this._isSessionTimeout(message)) {
      return "session-timeout";
    }
    return classifyLmStudioError(message).reason;
  }

  _isSessionTimeout(message) {
    if (!message || typeof message !== "string") {
      return false;
    }
    const normalized = message.toLowerCase();
    return normalized.includes("session-timeout") || normalized.includes("session timeout");
  }

  _resolveRequestTimeout(sessionDeadline) {
    const baseTimeout =
      Number.isFinite(this.timeoutMs) && this.timeoutMs > 0 ? this.timeoutMs : null;
    if (!Number.isFinite(sessionDeadline)) {
      return baseTimeout;
    }
    const remaining = sessionDeadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error("session-timeout: session deadline exceeded.");
    }
    const sessionCap = Math.min(
      Math.max(1000, Math.floor(remaining * 0.4)),
      SESSION_REQUEST_CAP_MS,
      remaining,
    );
    if (baseTimeout) {
      return Math.min(baseTimeout, sessionCap);
    }
    return sessionCap;
  }

  _parsePlan(responseText, payload) {
    const schemaValidation = validateJsonAgainstSchema(this._resolveSchemaDefinition(), responseText);
    const parsed = schemaValidation?.parsed ?? null;
    const preambleDetected = Boolean(schemaValidation?.preambleDetected);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (preambleDetected) {
        this._log(
          `[PromptDecomposer] Unable to parse JSON plan for "${payload.objective}": non-JSON preamble detected.`,
        );
        return this._fallbackPlan(
          "non-JSON preamble detected",
          payload,
          undefined,
          { stopReason: "preamble_detected" },
        );
      }
      this._log(
        `[PromptDecomposer] Unable to parse JSON plan for "${payload.objective}": no valid JSON found.`,
      );
      return this._fallbackPlan("no valid JSON found", payload);
    }
    if (schemaValidation && !schemaValidation.valid) {
      const detail = schemaValidation.errors?.[0] ?? "schema validation failed";
      this._log(
        `[PromptDecomposer] JSON plan failed schema validation for "${payload.objective}": ${detail}`,
      );
      return this._fallbackPlan(detail, payload);
    }
    const validation = this._validatePlanShape(parsed);
    if (!validation.valid) {
      this._log(
        `[PromptDecomposer] JSON plan failed validation for "${payload.objective}": ${validation.error}`,
      );
      return this._fallbackPlan(validation.error, payload);
    }
    const planId = parsed.plan_id || `plan-${randomUUID()}`;
    const summary = parsed.summary ?? null;
    const schemaVersion = parsed.schema_version || PLAN_SCHEMA_VERSION;
    const needsMoreContext = Boolean(parsed.needs_more_context);
    const missingSnippets = Array.isArray(parsed.missing_snippets)
      ? parsed.missing_snippets
      : [];

    const segments = buildPlanSegments(parsed, { limit: 36 });
    const segmentBlock = formatPlanSegmentsBlock(segments, { limit: 14 });
    const recommendedTools = Array.isArray(parsed.recommended_tools)
      ? parsed.recommended_tools
          .map((tool) => (typeof tool === "string" ? tool.trim() : ""))
          .filter((tool) => tool.length > 0)
      : [];
    const recommendationsBlock = formatPlanRecommendationsBlock(recommendedTools);
    const normalized = {
      planId,
      summary,
      plan: {
        plan_id: planId,
        summary,
        schema_version: schemaVersion,
        needs_more_context: needsMoreContext,
        missing_snippets: missingSnippets,
        steps: validation.steps ?? [],
        recommended_tools: Array.isArray(parsed.recommended_tools)
          ? parsed.recommended_tools
          : [],
        notes: parsed.notes ?? null,
      },
      outline: this._formatOutline(validation.steps),
      branch: payload.planBranch ?? null,
      segments,
      segmentBlock,
      recommendedTools,
      recommendationsBlock,
      schemaVersion,
      needsMoreContext,
      missingSnippets,
      stopReason: null,
    };
    return normalized;
  }

  _validatePlanShape(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, error: "plan must be a JSON object" };
    }
    if (typeof parsed.schema_version !== "string" || parsed.schema_version.trim().length === 0) {
      return { valid: false, error: "schema_version must be a non-empty string" };
    }
    if (parsed.schema_version !== PLAN_SCHEMA_VERSION) {
      return { valid: false, error: `schema_version must be ${PLAN_SCHEMA_VERSION}` };
    }
    if (typeof parsed.needs_more_context !== "boolean") {
      return { valid: false, error: "needs_more_context must be a boolean" };
    }
    if (!Array.isArray(parsed.missing_snippets)) {
      return { valid: false, error: "missing_snippets must be an array" };
    }
    if (!Array.isArray(parsed.steps)) {
      return { valid: false, error: "plan.steps must be an array" };
    }
    const normalizedSteps = this._normalizeSteps(parsed.steps);
    if (!normalizedSteps.valid) {
      return { valid: false, error: normalizedSteps.error };
    }
    return {
      valid: true,
      steps: normalizedSteps.steps,
    };
  }

  _normalizeSteps(steps, depth = 0) {
    if (!Array.isArray(steps)) {
      return { valid: false, error: "steps must be an array" };
    }
    const normalized = [];
    for (const step of steps) {
      if (typeof step !== "object" || !step) {
        return { valid: false, error: "each step must be an object" };
      }
      const children = Array.isArray(step.children) ? step.children : [];
      const normalizedStep = {
        id: typeof step.id === "string" ? step.id : String(normalized.length + 1),
        title: typeof step.title === "string" ? step.title : "Untitled step",
        description: typeof step.description === "string" ? step.description : "",
        requires_subprompt: Boolean(step.requires_subprompt),
        recommendation:
          typeof step.recommendation === "string" || step.recommendation === null
            ? step.recommendation
            : null,
        children: [],
      };
      if (children.length > 0) {
        const childResult = this._normalizeSteps(children, depth + 1);
        if (!childResult.valid) {
          return childResult;
        }
        normalizedStep.children = childResult.steps;
      }
      normalized.push(normalizedStep);
      if (normalized.length >= this.maxActions * (depth + 1)) {
        break;
      }
    }
    return { valid: true, steps: normalized };
  }

  _buildResumeContext(payload) {
    const plan = payload?.resumePlan ?? null;
    const branch = payload?.planBranch ?? null;
    const promptId = payload?.mainPromptId ?? null;
    if (!plan && !branch && !promptId) {
      return null;
    }
    const planPayload = plan?.plan ?? plan;
    const planId = planPayload?.plan_id ?? planPayload?.planId ?? planPayload?.id ?? null;
    const planPreview = Array.isArray(planPayload?.steps)
      ? planPayload.steps.slice(0, MAX_STEP_PREVIEW).map((step) => ({
          id: step?.id ?? null,
          title: step?.title ?? null,
          requires_subprompt: Boolean(step?.requires_subprompt),
          has_children: Array.isArray(step?.children) && step.children.length > 0,
        }))
      : null;
    return {
      prompt_id: promptId,
      branch: branch || null,
      previous_plan_id: planId,
      outline: this._formatOutline(planPayload?.steps ?? null, 0, [], "", 24),
      preview_steps: planPreview,
    };
  }

  _buildCachedWorkspaceHint(cached) {
    if (!cached || typeof cached !== "object") {
      return null;
    }
    const manifestSample = Array.isArray(cached.manifestPreview)
      ? cached.manifestPreview.slice(0, 6)
      : [];
    const navigation =
      cached.navigationSummary || cached.navigationBlock
        ? {
            summary: cached.navigationSummary ?? null,
            block: cached.navigationBlock ?? null,
          }
        : null;
    return {
      summary: cached.summary ?? null,
      hint: cached.hintBlock ?? null,
      directives: cached.directives ?? null,
      classification: cached.classification ?? null,
      updated_at: cached.updatedAt ?? cached.savedAt ?? null,
      manifestSample,
      navigation,
    };
  }

  _sanitizeWorkspaceStats(stats) {
    if (!stats || typeof stats !== "object") {
      return null;
    }
    const numericFields = ["files", "directories", "codeFiles", "docFiles", "dataFiles", "otherFiles"];
    const cleaned = {};
    for (const field of numericFields) {
      const value = Number(stats[field]);
      if (Number.isFinite(value) && value >= 0) {
        cleaned[field] = Math.round(value);
      }
    }
    if (Array.isArray(stats.chapterLikeFiles) && stats.chapterLikeFiles.length) {
      cleaned.chapterSamples = stats.chapterLikeFiles.slice(0, 4);
    }
    return Object.keys(cleaned).length ? cleaned : null;
  }

  _analyzeCommand(command) {
    if (!command || typeof command !== "string") {
      return null;
    }
    const pieces = command
      .split(/&&|\|\||;|\n/)
      .map((piece) => piece.trim())
      .filter(Boolean);
    const isPipeline = command.includes("|");
    return {
      raw: command,
      multi_goal: pieces.length > 1,
      segments: pieces.slice(0, MAX_STEP_PREVIEW),
      is_pipeline: isPipeline,
    };
  }

  _formatOutline(steps, depth = 0, lines = [], prefix = "", maxLines = 80) {
    if (!Array.isArray(steps) || steps.length === 0) {
      const rendered = lines.join("\n").trimEnd();
      return rendered.length ? rendered : null;
    }
    for (const step of steps) {
      const id = step?.id ?? `${prefix || depth + 1}`;
      const title = step?.title ?? "Untitled step";
      const desc = typeof step?.description === "string" ? step.description.trim() : "";
      const flags = [];
      if (step?.requires_subprompt) {
        flags.push("sub-prompt");
      }
      if (step?.recommendation) {
        flags.push(step.recommendation);
      }
      const indent = "  ".repeat(depth);
      const flagText = flags.length ? ` (${flags.join(" | ")})` : "";
      lines.push(`${indent}${id}. ${title}${flagText}`);
      if (desc) {
        lines.push(`${indent}   - ${desc}`);
      }
      if (Array.isArray(step?.children) && step.children.length > 0) {
        this._formatOutline(step.children, depth + 1, lines, id);
      }
      if (lines.length >= maxLines) {
        break;
      }
    }
    const rendered = lines.slice(0, maxLines).join("\n").trimEnd();
    return rendered.length ? rendered : null;
  }

  _log(message) {
    if (this.logger) {
      this.logger(message);
    }
  }

  _compactText(text, limit = COMPACT_SUMMARY_LIMIT) {
    if (!text || typeof text !== "string") {
      return text ?? null;
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed.length <= limit) {
      return trimmed;
    }
    return `${trimmed.slice(0, Math.max(10, limit))}...`;
  }

  _isContextOverflowError(message) {
    return isContextOverflowError(message);
  }

  _fallbackPlan(message, payload, errorInfo = undefined, options = undefined) {
    const normalizedError = errorInfo ?? classifyLmStudioError(message);
    const stopReasonOverride =
      typeof options?.stopReason === "string" && options.stopReason.trim().length > 0
        ? options.stopReason.trim()
        : null;
    const stopReason =
      stopReasonOverride ??
      (this._isSessionTimeout(message) ? "session-timeout" : null) ??
      normalizedError?.reason ??
      message ??
      "unknown error";
    const planId = "prompt-plan-fallback";
    const summary = `Decomposer failed (${message ?? stopReason})`;
    const normalized = {
      planId,
      summary,
      plan: {
        plan_id: planId,
        summary,
        schema_version: "prompt-plan@fallback",
        needs_more_context: true,
        missing_snippets: ["valid prompt-plan JSON from LM Studio"],
        steps: [],
        recommended_tools: [],
        notes: message ?? null,
      },
      outline: null,
      branch: payload.planBranch ?? null,
      segments: [],
      segmentBlock: null,
      recommendedTools: [],
      recommendationsBlock: null,
      schemaVersion: "prompt-plan@fallback",
      needsMoreContext: true,
      missingSnippets: ["valid prompt-plan JSON from LM Studio"],
      stopReason,
    };
    return normalized;
  }
}
