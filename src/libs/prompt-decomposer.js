import { randomUUID } from "crypto";
import {
  extractJsonBlock,
  buildPlanSegments,
  formatPlanSegmentsBlock,
  formatPlanRecommendationsBlock,
} from "./core-utils.js";
import { LMStudioRestClient } from "./lmstudio-api.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_STEP_PREVIEW = 10;

const SYSTEM_PROMPT = [
  "You are the MiniPhi prompt decomposer.",
  "Given a user objective, workspace metadata, and optional CLI commands, produce a structured JSON plan that breaks the work into recursive actions.",
  "ALWAYS return strictly valid JSON that matches the declared schema. Never include commentary outside the JSON.",
  "Each step must include a concise title, a short description, and booleans explaining whether it spawns a sub-prompt or depends on tooling.",
  "Use depth-first numbering so follow-up prompts can resume mid-branch (e.g., 1, 1.1, 1.2, 2, ...).",
  "Do not invent actions outside the workspace scope; prefer to reference concrete files, commands, or tools when available.",
].join(" ");

const PLAN_SCHEMA = [
  "{",
  '  "plan_id": "string identifier",',
  '  "summary": "two-sentence overview of the strategy",',
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
  required: ["plan_id", "summary", "steps"],
  properties: {
    plan_id: { type: "string" },
    summary: { type: "string" },
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

const JSON_ONLY_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "prompt-plan",
    schema: PLAN_JSON_SCHEMA,
  },
};

export default class PromptDecomposer {
  constructor(options = undefined) {
    this.restClient =
      options?.restClient ??
      new LMStudioRestClient(options?.restClientOptions ?? undefined);
    this.maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxActions = options?.maxActions ?? DEFAULT_MAX_ACTIONS;
    this.temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    const requestedTimeout = Number(options?.timeoutMs);
    this.timeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : DEFAULT_TIMEOUT_MS;
    this.disabled = false;
    this.disableNotice = null;
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
   *   metadata?: Record<string, unknown> | null,
   *   resumePlan?: object | null,
   *   planBranch?: string | null,
   * }} payload
   */
  async decompose(payload) {
    if (!payload?.objective || !this.restClient || this.disabled) {
      if (this.disabled) {
        this._log("[PromptDecomposer] Disabled after previous failures; skipping.");
      }
      return null;
    }
    const requestBody = this._buildRequestBody(payload);
    const messages = [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\nJSON schema:\n\`\`\`json\n${PLAN_SCHEMA}\n\`\`\``,
      },
      {
        role: "user",
        content: JSON.stringify(requestBody, null, 2),
      },
    ];

    let responseText = "";
    let normalizedPlan = null;
    let errorMessage = null;

    try {
      const completion = await this._withTimeout(
        this.restClient.createChatCompletion({
          messages,
          temperature: this.temperature,
          max_tokens: -1,
          response_format: JSON_ONLY_RESPONSE_FORMAT,
        }),
      );
      responseText = completion?.choices?.[0]?.message?.content ?? "";
      normalizedPlan = this._parsePlan(responseText, payload);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      if (this._isResponseFormatError(errorMessage)) {
        try {
          this._log(
            "[PromptDecomposer] response_format rejected; retrying with text and JSON block parsing.",
          );
          const completion = await this._withTimeout(
            this.restClient.createChatCompletion({
              messages,
              temperature: this.temperature,
              max_tokens: -1,
              response_format: { type: "text" },
            }),
          );
          responseText = completion?.choices?.[0]?.message?.content ?? "";
          normalizedPlan = this._parsePlan(responseText, payload);
          errorMessage = null;
        } catch (retryError) {
          errorMessage = retryError instanceof Error ? retryError.message : String(retryError);
        }
      }
      this._log(`[PromptDecomposer] REST failure: ${errorMessage}`);
      if (this._shouldDisable(errorMessage)) {
        this._disableDecomposer(errorMessage);
        this._log("[PromptDecomposer] Disabled after repeated failures.");
      }
    }

    if (payload.promptRecorder) {
      await payload.promptRecorder.record({
        scope: "sub",
        label: "prompt-decomposition",
        mainPromptId: payload.mainPromptId ?? null,
        metadata: {
          type: "prompt-decomposition",
          objective: payload.objective,
          command: payload.command ?? null,
          workspaceType: payload.workspace?.classification ?? null,
        },
        request: {
          endpoint: "/chat/completions",
          payload: requestBody,
        },
        response: normalizedPlan ?? { raw: responseText },
        error: errorMessage,
      });
    }

    if (!normalizedPlan) {
      return null;
    }

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

  _buildRequestBody(payload) {
    const commandAnalysis = this._analyzeCommand(payload.command);
    const resume = this._buildResumeContext(payload);
    const classification = payload.workspace?.classification ?? null;
    const cachedWorkspace = this._buildCachedWorkspaceHint(payload.workspace?.cachedHints);
    const stats = this._sanitizeWorkspaceStats(payload.workspace?.stats);
    const body = {
      objective: payload.objective,
      command: payload.command ?? null,
      workspace: {
        classification,
        domain: classification?.domain ?? null,
        summary: payload.workspace?.summary ?? null,
        actions: Array.isArray(classification?.actions) && classification.actions.length
          ? classification.actions
          : null,
        hint: payload.workspace?.hintBlock ?? null,
        directives: payload.workspace?.planDirectives ?? payload.workspace?.directives ?? null,
        cached_hint: payload.workspace?.cachedHints?.hintBlock ?? null,
        cached_context: cachedWorkspace,
        manifestSample: (payload.workspace?.manifestPreview ?? []).slice(0, 8),
        stats,
        capabilitySummary: payload.workspace?.capabilitySummary ?? null,
        navigationSummary: payload.workspace?.navigationSummary ?? null,
      },
      limits: {
        maxDepth: this.maxDepth,
        maxActions: this.maxActions,
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
    return body;
  }

  _withTimeout(promise) {
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      return promise;
    }
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Prompt decomposition exceeded ${Math.round(this.timeoutMs / 1000)}s timeout.`,
            ),
          );
        }, this.timeoutMs);
      }),
    ]);
  }

  _shouldDisable(message) {
    if (!message) {
      return false;
    }
    const normalized = message.toString().toLowerCase();
    return (
      normalized.includes("timed out") ||
      normalized.includes("timeout") ||
      normalized.includes("network")
    );
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
    if (!message) {
      return "REST failure";
    }
    const normalized = message.toLowerCase();
    if (normalized.includes("timeout") || normalized.includes("timed out")) {
      return "timeout";
    }
    if (normalized.includes("network")) {
      return "network error";
    }
    return "REST failure";
  }

  _parsePlan(responseText, payload) {
    const cleaned = this._cleanResponseText(responseText);
    const parsed = extractJsonBlock(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this._log(
        `[PromptDecomposer] Unable to parse JSON plan for "${payload.objective}": no valid JSON found.`,
      );
      return null;
    }
    const validation = this._validatePlanShape(parsed);
    if (!validation.valid) {
      this._log(
        `[PromptDecomposer] JSON plan failed validation for "${payload.objective}": ${validation.error}`,
      );
      return null;
    }
    const planId = parsed.plan_id || `plan-${randomUUID()}`;
    const summary = parsed.summary ?? null;

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
    };
    return normalized;
  }

  _validatePlanShape(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, error: "plan must be a JSON object" };
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

  _cleanResponseText(text) {
    if (!text || typeof text !== "string") {
      return "";
    }
    const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    return withoutThink.replace(/```[\w-]*\n?/gi, "").replace(/```/g, "").trim();
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

  _isResponseFormatError(message) {
    if (!message) {
      return false;
    }
    const normalized = message.toString().toLowerCase();
    return (
      normalized.includes("response_format") ||
      normalized.includes("json_schema") ||
      normalized.includes("json object")
    );
  }
}
