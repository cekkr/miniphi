import { randomUUID } from "crypto";
import { extractJsonBlock } from "./core-utils.js";
import { LMStudioRestClient } from "./lmstudio-api.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 45000;

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
          // REST requires text or json_schema; use text and rely on JSON extraction downstream.
          response_format: { type: "text" },
        }),
      );
      responseText = completion?.choices?.[0]?.message?.content ?? "";
      normalizedPlan = this._parsePlan(responseText, payload);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      this._log(`[PromptDecomposer] REST failure: ${errorMessage}`);
      if (this._shouldDisable(errorMessage)) {
        this.disabled = true;
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
        metadata: {
          objective: payload.objective,
          command: payload.command ?? null,
          workspaceType: payload.workspace?.classification?.label ?? null,
          mainPromptId: payload.mainPromptId ?? null,
          extra: payload.metadata ?? null,
        },
      });
    }

    return normalizedPlan;
  }

  _buildRequestBody(payload) {
    return {
      objective: payload.objective,
      command: payload.command ?? null,
      workspace: {
        classification: payload.workspace?.classification ?? null,
        summary: payload.workspace?.summary ?? null,
        hint: payload.workspace?.hintBlock ?? null,
        manifestSample: (payload.workspace?.manifestPreview ?? []).slice(0, 8),
      },
      limits: {
        maxDepth: this.maxDepth,
        maxActions: this.maxActions,
      },
      expectations: {
        recursive: true,
        captureTools: true,
      },
    };
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

  _parsePlan(responseText, payload) {
    const parsed = extractJsonBlock(responseText);
    if (!parsed || typeof parsed !== "object") {
      this._log(
        `[PromptDecomposer] Unable to parse JSON plan for "${payload.objective}": no valid JSON found.`,
      );
      return null;
    }
    const planId = parsed.plan_id || `plan-${randomUUID()}`;
    const summary = parsed.summary ?? null;

    const normalized = {
      planId,
      summary,
      plan: {
        plan_id: planId,
        summary,
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        recommended_tools: Array.isArray(parsed.recommended_tools)
          ? parsed.recommended_tools
          : [],
        notes: parsed.notes ?? null,
      },
      outline: this._formatOutline(parsed.steps),
    };
    return normalized;
  }

  _formatOutline(steps, depth = 0, lines = [], prefix = "") {
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
      if (lines.length >= 80) {
        break;
      }
    }
    const rendered = lines.slice(0, 80).join("\n").trimEnd();
    return rendered.length ? rendered : null;
  }

  _log(message) {
    if (this.logger) {
      this.logger(message);
    }
  }
}
