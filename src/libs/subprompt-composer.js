import { buildJsonSchemaResponseFormat } from "./json-schema-utils.js";
import { resolveSampling } from "./sampling-profiles.js";
import { planOutputTokens } from "./model-limits.js";
import { NULL_PROMPT_TRACE } from "./prompt-trace.js";

export const SUBTASK_PLAN_SCHEMA_ID = "subtask-plan";
const SCHEMA_VERSION = "subtask-plan@v1";
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * Turns a mission into an ordered set of verifiable subtasks, using the session
 * model itself.
 *
 * The old decomposition path (`prompt-decomposer.js`) expands a plan *tree* for
 * the headless run/analyze flows. The interactive agent had nothing: it was
 * handed a 30-line task statement and left to re-derive an order every turn from
 * whatever survived the context budget. Observed on photos-social, that produced
 * exactly the failure the operator reported — a run that never inspected the
 * template it was told to use, wrote an API server from memory, and satisfied
 * the only checks anyone had written down.
 *
 * Three things make this different from "ask the model for a plan":
 *
 *  1. **Facts, not just the task.** The prompt carries a deterministic survey of
 *     the workspace (what exists, what the reference material is, what the
 *     validator already demands). A local model plans well from facts and
 *     hallucinates structure when given prose alone.
 *  2. **Acceptance criteria are mandatory and must be textual.** A subtask
 *     without a machine-checkable check is rejected by the schema, so the plan
 *     cannot contain "make the feed look good".
 *  3. **Every exchange is traced.** The generated subprompts, the raw response
 *     and the repair attempts land in `.miniphi/prompt-trace/`, which is what
 *     makes a bad plan debuggable instead of invisible.
 */
export class SubpromptComposer {
  constructor(options = undefined) {
    this.client = options?.client ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.model =
      typeof options?.model === "string" && options.model.trim() ? options.model.trim() : null;
    this.reasoning = options?.reasoning ?? null;
    this.contextLength = Number.isFinite(options?.contextLength) ? options.contextLength : null;
    this.maxTokens = Number.isFinite(options?.maxTokens) ? Math.floor(options.maxTokens) : null;
    this.tokensPerSecond =
      Number.isFinite(options?.tokensPerSecond) && options.tokensPerSecond > 0
        ? options.tokensPerSecond
        : null;
    this.timeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(1000, Math.floor(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    this.trace = options?.trace ?? NULL_PROMPT_TRACE;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.maxSubtasks = Number.isFinite(options?.maxSubtasks)
      ? Math.max(1, Math.min(10, Math.floor(options.maxSubtasks)))
      : 8;
  }

  _log(message) {
    if (this.logger) {
      this.logger(`[subprompts] ${message}`);
    }
  }

  _system(schemaBlock) {
    return [
      "You are MiniPhi's planner. You do not write code in this call.",
      "You are given a mission and a survey of facts that were gathered from the workspace by tooling, not by guessing. Plan from those facts.",
      "",
      "Produce an ordered list of subtasks. Rules that decide whether the plan is usable:",
      `- At most ${this.maxSubtasks} subtasks. Fewer is better than more.`,
      "- Each subtask is one or two turns of work. If a subtask would take longer, split it.",
      "- The first subtasks are the ones that remove uncertainty: inspect what exists, read the references, establish the contract. Do not start with implementation.",
      "- Every subtask needs acceptance criteria that a program can check from text alone: a command that exits 0, an HTTP status, a string that must appear in a file or in a served page. Never a criterion that requires looking at something.",
      "- Name real paths from the facts in `inputs`. Do not invent files.",
      "- Order by dependency and record it in depends_on.",
      "",
      "Reply with ONLY the JSON object. No prose, no markdown fences.",
      "",
      "Exact JSON schema:",
      schemaBlock,
    ].join("\n");
  }

  _user({ mission, facts, constraints, feedback }) {
    const sections = [`MISSION\n${mission}`];
    if (facts) {
      sections.push(`WORKSPACE FACTS (gathered by tooling)\n${facts}`);
    }
    if (constraints) {
      sections.push(`HARD CONSTRAINTS\n${constraints}`);
    }
    if (feedback) {
      sections.push(
        `YOUR PREVIOUS PLAN WAS REJECTED\n${feedback}\nProduce a corrected plan; do not repeat the rejected shape.`,
      );
    }
    sections.push("Return the subtask plan as JSON now.");
    return sections.join("\n\n");
  }

  /** Deterministic plan used when the model cannot produce a valid one. */
  _fallback(mission, reason) {
    return {
      schema_version: SCHEMA_VERSION,
      mission_restated: String(mission).slice(0, 300),
      strategy:
        "Deterministic fallback: survey the workspace, then implement in the order the task states, verifying after each step.",
      subtasks: [
        {
          id: "survey-workspace",
          title: "Survey the workspace and references",
          goal: "Know exactly which files exist and what the reference material contains before writing anything.",
          why: "A plan built on unread references is a guess.",
          inputs: [],
          actions: ["list_dir", "read_file", "page_inspect"],
          acceptance: ["The workspace layout and each reference file's structure have been read into context."],
          depends_on: [],
          estimated_turns: 2,
          risk: "low",
        },
        {
          id: "implement-task",
          title: "Implement the task in small steps",
          goal: "Every requirement stated in the mission is implemented in the workspace.",
          why: "This is the mission.",
          inputs: [],
          actions: ["write_file", "edit_file", "run_cmd"],
          acceptance: ["The project's own validation command reports no issues."],
          depends_on: ["survey-workspace"],
          estimated_turns: 6,
          risk: "mid",
        },
        {
          id: "verify-with-tests",
          title: "Prove it works with an automated check",
          goal: "An executable check drives the delivered surface and reports a textual verdict.",
          why: "A change nothing verifies is not delivered.",
          inputs: [],
          actions: ["write_file", "run_cmd"],
          acceptance: ["A single command runs the check and exits 0."],
          depends_on: ["implement-task"],
          estimated_turns: 2,
          risk: "mid",
        },
      ],
      open_questions: [],
      needs_more_context: false,
      missing_snippets: [],
      stop_reason: reason,
    };
  }

  /**
   * @param {{mission:string, facts?:string, constraints?:string, sessionDeadline?:number|null}} input
   * @returns {Promise<{plan:object, fallback:boolean, attempts:Array}>}
   */
  async compose({ mission, facts = "", constraints = "", sessionDeadline = null } = {}) {
    const schema = this.schemaRegistry?.getSchema(SUBTASK_PLAN_SCHEMA_ID) ?? null;
    if (!this.client || !this.model || !schema) {
      return { plan: this._fallback(mission, "composer-unavailable"), fallback: true, attempts: [] };
    }
    const schemaBlock = this.schemaRegistry.buildInstructionBlock(SUBTASK_PLAN_SCHEMA_ID, {
      compact: true,
    });
    const responseFormat = buildJsonSchemaResponseFormat(schema.definition, SUBTASK_PLAN_SCHEMA_ID);
    const attempts = [];
    let feedback = "";
    // Grows when a reasoning model spends the whole budget thinking; see the
    // retry logic below. Starts at the caller's pacing cap.
    let tokenCap = this.maxTokens;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const remainingMs = Number.isFinite(sessionDeadline)
        ? Math.floor(sessionDeadline - Date.now())
        : null;
      if (remainingMs !== null && remainingMs <= 0) {
        return { plan: this._fallback(mission, "session-timeout"), fallback: true, attempts };
      }
      const system = this._system(schemaBlock);
      const user = this._user({ mission, facts, constraints, feedback });
      // Planning is the one call that must not be sampled like extraction: at
      // temperature 0 a local model re-emits the same unusable plan after a
      // rejection, which is exactly the loop this retry exists to break.
      const sampling = resolveSampling(attempt === 1 ? "planning" : "repair");
      const budget = planOutputTokens({
        contextLength: this.contextLength,
        promptTokens: Math.ceil((system.length + user.length) / 4),
        hardCap: tokenCap,
        tokensPerSecond: this.tokensPerSecond,
      });
      const messages = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      const startedAt = Date.now();
      let completion = null;
      let text = "";
      let error = null;
      try {
        completion = await this.client.createChatCompletion({
          model: this.model,
          messages,
          temperature: sampling.temperature,
          top_p: sampling.top_p,
          max_tokens: budget.maxTokens,
          response_format: responseFormat,
          timeoutMs:
            remainingMs === null
              ? this.timeoutMs
              : Math.max(1000, Math.min(this.timeoutMs, remainingMs)),
        });
        text = completion?.choices?.[0]?.message?.content ?? "";
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const validation = error ? null : this.schemaRegistry.validate(SUBTASK_PLAN_SCHEMA_ID, text);
      await this.trace.record({
        kind: "subprompt-plan",
        label: "subtask decomposition",
        attempt,
        elapsedMs: Date.now() - startedAt,
        request: {
          model: this.model,
          messages,
          response_format: responseFormat,
          temperature: sampling.temperature,
          top_p: sampling.top_p,
          max_tokens: budget.maxTokens,
          samplingProfile: sampling.samplingProfile,
          context_length: this.contextLength,
          reasoning: this.reasoning ?? null,
        },
        response: {
          text,
          reasoning:
            completion?.choices?.[0]?.message?.reasoning ??
            completion?.choices?.[0]?.message?.reasoning_content ??
            null,
          finish_reason: completion?.choices?.[0]?.finish_reason ?? null,
          usage: completion?.usage ?? null,
        },
        validation: validation
          ? {
              valid: Boolean(validation.valid),
              status: validation.status ?? null,
              error: validation.error ?? null,
            }
          : null,
        error,
      });
      attempts.push({
        attempt,
        error,
        valid: Boolean(validation?.valid),
        status: validation?.status ?? (error ? "request-failed" : null),
        finishReason: completion?.choices?.[0]?.finish_reason ?? null,
        usage: completion?.usage ?? null,
      });
      if (validation?.valid && validation.parsed) {
        const plan = normalizeSubtaskPlan(validation.parsed, this.maxSubtasks);
        this._log(`plan accepted: ${plan.subtasks.length} subtask(s)`);
        return { plan, fallback: false, attempts };
      }
      // A reasoning model that spent the whole cap thinking returned no content
      // at all. That is a budget failure, not a schema failure, and re-asking at
      // the same cap can only reproduce it — the same trap that scored
      // prism-ml/bonsai-27b 0/100 in the Easy benchmark. Grow, do not repeat.
      const reasoningTokens = Number(
        completion?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      );
      if (!text && completion?.choices?.[0]?.finish_reason === "length" && reasoningTokens > 0) {
        tokenCap = tokenCap ? tokenCap * 4 : reasoningTokens * 4;
        feedback = `your previous attempt spent all ${reasoningTokens} tokens reasoning and produced no JSON; think less and answer`;
      } else {
        feedback =
          error ??
          validation?.error ??
          "the response was not a valid subtask plan for the schema";
      }
      this._log(`attempt ${attempt} rejected: ${feedback}`);
    }
    return {
      plan: this._fallback(mission, `invalid-response: ${feedback}`),
      fallback: true,
      attempts,
    };
  }
}

/**
 * Repairs the parts of a schema-valid plan that the schema cannot express:
 * dependency cycles, references to ids that do not exist, and an order that
 * contradicts `depends_on`.
 */
export function normalizeSubtaskPlan(plan, maxSubtasks = 10) {
  const subtasks = (Array.isArray(plan?.subtasks) ? plan.subtasks : []).slice(0, maxSubtasks);
  const ids = new Set(subtasks.map((subtask) => subtask.id));
  const cleaned = subtasks.map((subtask) => ({
    ...subtask,
    depends_on: (Array.isArray(subtask.depends_on) ? subtask.depends_on : []).filter(
      (id) => ids.has(id) && id !== subtask.id,
    ),
    acceptance: Array.isArray(subtask.acceptance) ? subtask.acceptance.filter(Boolean) : [],
    inputs: Array.isArray(subtask.inputs) ? subtask.inputs.filter(Boolean) : [],
    actions: Array.isArray(subtask.actions) ? subtask.actions.filter(Boolean) : [],
  }));

  // Topological order, keeping the model's order as the tie-break. A cycle
  // degrades to the declared order rather than dropping subtasks: a plan that
  // silently loses a step is worse than one in a slightly wrong order.
  const byId = new Map(cleaned.map((subtask) => [subtask.id, subtask]));
  const ordered = [];
  const placed = new Set();
  let progress = true;
  while (progress && ordered.length < cleaned.length) {
    progress = false;
    for (const subtask of cleaned) {
      if (placed.has(subtask.id)) {
        continue;
      }
      if (subtask.depends_on.every((id) => placed.has(id))) {
        ordered.push(subtask);
        placed.add(subtask.id);
        progress = true;
      }
    }
  }
  for (const subtask of cleaned) {
    if (!placed.has(subtask.id)) {
      ordered.push(subtask);
      placed.add(subtask.id);
    }
  }
  return { ...plan, subtasks: ordered, _byId: undefined, subtaskIndex: [...byId.keys()] };
}

/**
 * Renders a plan as the compact contract block the agent reads every turn.
 *
 * Defensive about optional fields on purpose: `normalizeSubtaskPlan` fills them
 * in for plans this module produces, but the session accepts *any* injected
 * composer, and a plan missing `inputs` should degrade to a shorter block —
 * never throw inside the turn loop and take the whole run with it.
 */
export function renderPlanBlock(plan, { completed = new Set(), current = null } = {}) {
  if (!plan?.subtasks?.length) {
    return null;
  }
  const lines = [`Plan (${plan.subtasks.length} subtasks). Work them in order; do not skip ahead.`];
  for (const subtask of plan.subtasks) {
    const state = completed.has(subtask.id) ? "done" : subtask.id === current ? "NOW" : "todo";
    lines.push(`- [${state}] ${subtask.id}: ${subtask.goal ?? "(no goal stated)"}`);
    if (subtask.id === current) {
      for (const criterion of (Array.isArray(subtask.acceptance) ? subtask.acceptance : []).slice(0, 3)) {
        lines.push(`    done when: ${criterion}`);
      }
      const inputs = Array.isArray(subtask.inputs) ? subtask.inputs : [];
      if (inputs.length) {
        lines.push(`    load first: ${inputs.slice(0, 5).join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

export default SubpromptComposer;
