import { randomUUID } from "crypto";
import { LMStudioRestClient } from "./lmstudio-api.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_TEMPERATURE = 0.2;

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

function stripCodeFences(text = "") {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline !== -1) {
      const fence = trimmed.slice(0, firstNewline);
      if (/```json/i.test(fence)) {
        return trimmed.slice(firstNewline + 1).replace(/```$/, "").trim();
      }
    }
    return trimmed.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

export default class PromptDecomposer {
  constructor(options = undefined) {
    this.restClient =
      options?.restClient ??
      new LMStudioRestClient(options?.restClientOptions ?? undefined);
    this.maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxActions = options?.maxActions ?? DEFAULT_MAX_ACTIONS;
    this.temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
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
    if (!payload?.objective || !this.restClient) {
      return null;
    }
    const requestBody = this.#buildRequestBody(payload);
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
      const completion = await this.restClient.createChatCompletion({
        messages,
        temperature: this.temperature,
        max_tokens: -1,
      });
      responseText = completion?.choices?.[0]?.message?.content ?? "";
      normalizedPlan = this.#parsePlan(responseText, payload);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      this.#log(`[PromptDecomposer] REST failure: ${errorMessage}`);
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

  #buildRequestBody(payload) {
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

  #parsePlan(responseText, payload) {
    const extracted = stripCodeFences(responseText);
    if (!extracted) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(extracted);
    } catch (error) {
      this.#log(
        `[PromptDecomposer] Unable to parse JSON plan for "${payload.objective}": ${
          error instanceof Error ? error.message : error
        }`,
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
    };
    return normalized;
  }

  #log(message) {
    if (this.logger) {
      this.logger(message);
    }
  }
}
