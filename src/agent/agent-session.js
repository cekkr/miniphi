import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import PromptSchemaRegistry from "../libs/prompt-schema-registry.js";
import { buildJsonSchemaResponseFormat } from "../libs/json-schema-utils.js";
import { resolveMissingSnippets, buildSnippetContextBlock } from "../libs/plan-executor.js";
import ContextGraph, {
  CONTEXT_LANGUAGE_GUIDE,
  deriveContextBudget,
  estimateTokens,
} from "../libs/context-graph.js";
import ContextReferenceComposer from "../libs/context-reference-composer.js";
import {
  buildMutationProposal,
  classifyActionType,
  commitMutation,
  describeAction,
  executeReadonly,
  hashText,
  normalizeAgentAction,
} from "./agent-executor.js";

const AGENT_SCHEMA_ID = "agent-action";
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_ACTIONS_PER_TURN = 6;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MODEL_REQUEST_RETRIES = 1;
const DEFAULT_MAX_WEB_RESEARCH_ACTIONS = 3;
const DEFAULT_MAX_CONTEXT_REFORMS = 3;
const DEFAULT_MAX_CONTEXT_ONLY_TURNS = 3;
const DEFAULT_LOCAL_MEMORY_CANDIDATES = 12;
// Above this, a rejected whole-file proposal is treated as "too big to emit
// correctly" rather than as a typo to hunt for.
const LARGE_PROPOSAL_LINES = 120;
// A brand-new corrective instruction buys the model one idle turn to act on it.
// Capped so this cannot become a way around the no-progress guard.
const MAX_CORRECTION_GRACES = 3;
const MAX_ACTION_SCAN_MULTIPLIER = 3;
const MAX_PINNED_FILE_BYTES = 6000;
const MAX_RESEARCH_OUTPUT_CHARS = 6000;
const MAX_READONLY_OUTPUT_CHARS = 6000;
const MAX_MUTATION_CONTEXT_CHARS = 12000;

/**
 * Graph-recalled and `.miniphi`-recalled references become one selection pool.
 * They are deduplicated by id *and* by sentence, because the same fact can be
 * mirrored into Cheetah this run and harvested from disk from a previous one —
 * paying the reference budget twice for it would be the worst of both stores.
 */
const mergeReferenceCandidates = (...groups) => {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const candidate of Array.isArray(group) ? group : []) {
      const id = typeof candidate?.id === "string" ? candidate.id : "";
      const text = typeof candidate?.text === "string" ? candidate.text.trim() : "";
      if (!id || !text || seen.has(id) || seen.has(text)) {
        continue;
      }
      seen.add(id);
      seen.add(text);
      merged.push(candidate);
    }
  }
  return merged;
};

const SYSTEM_PROMPT = `You are MiniPhi, a local coding agent operating inside the operator's repository.
Work in turns. Each turn respond with ONLY a JSON object matching the provided schema (no prose, no markdown fences).
Use read_file/list_dir/search_text to gather context (these run automatically, no approval needed).
Use web_research for current library choices, unfamiliar APIs, or best-practice comparisons (it runs automatically and returns bounded JSON search results). When the task asks you to choose libraries, research before deciding unless no external library is needed; explain that choice in your summary.
Never repeat an action after MiniPhi reports it as duplicate or skipped-budget. Use the existing observation and move to implementation.
Propose changes with write_file (full file content) or edit_file (a unique anchor + replacement, or a full content replacement). write_file, edit_file and run_cmd require operator approval and may be rejected.
An edit_file anchor selects only that exact literal substring; MiniPhi replaces only those characters and leaves all surrounding text untouched. If replacement repeats an existing function/block, the anchor must include that complete function/block. To append safely, anchor the exact end block and include that block once followed by the addition.
write_file replaces the entire target: never use it with partial content for an existing file. Prefer a small anchored edit_file for existing files, preserve imports/exports and unrelated behavior, and do not introduce dependencies that are absent from the workspace.
After a validation failure caused by one of your edits, read the current changed file before repairing it unless its exact post-edit content is already loaded below. Never reconstruct a current file from an older snapshot.
When the task is complete, respond with a single finish action and a clear summary of what changed.
Only touch files inside the workspace; never invent paths. Keep edits minimal and correct.
When a "Cheetah-recalled complete sentence references" block is present, treat
its sentences as grounded memory. Use the reference ids for traceability and do
not combine isolated labels or keyword fragments into unsupported facts.

${CONTEXT_LANGUAGE_GUIDE}`;

// Only appended when the session was configured with a vision-capable model
// (see AgentSession.visionReview), so the model is never told about an action
// that would just report "unavailable".
const VISUAL_REVIEW_GUIDE = `A vision-capable model is available this session. Use visual_review to judge subjective visual quality that text/regex checks cannot see: does a shape look right, are colors/proportions convincing, does a page look populated and laid out or broken and empty. Target it either with path (a rendered HTML/image file in the workspace) or with url (a loopback address such as http://127.0.0.1:3000/, for a page that only renders once the app's own server is running - a file:// screenshot of a server-rendered template shows it unpopulated). Add focus to say what to look for. It runs automatically like web_research and returns structured JSON (quality_score, issues, suggestions, page_errors, console_errors) from a model that looked at an actual screenshot; use its issues/suggestions to drive your next write_file/edit_file instead of guessing, then review the same target again after the fix.`;

// Only appended when a reachable Cheetah knowledge base was configured (see
// AgentSession.knowledgeLookup), so the model is never told about an action
// that would just report "unavailable".
const KNOWLEDGE_LOOKUP_GUIDE = `A knowledge base (taught via the separate "cheetah-learn" command, e.g. from Wikipedia text) is available this session. Use knowledge_lookup (subject: an entity/topic name, e.g. "Springfield") before asserting a real-world fact you are not certain of; it runs automatically and returns structured JSON (resolved, facts, evidence) grounded in what was actually taught. resolved=false means nothing is recorded there - say so rather than guessing.`;

/**
 * Drives one interactive agent task: plan → act → (approve) → apply → repeat.
 * UI-agnostic: it emits events and awaits an injected `approver`, so the same
 * loop powers both the Ink UI and the headless CLI path.
 *
 * Events: `status`, `token`, `action-start`, `action-result`, `edit-proposed`,
 * `permission-request` (via a UI approver), `done`, `error`.
 */
export default class AgentSession extends EventEmitter {
  constructor(options = undefined) {
    super();
    this.client = options?.client ?? null;
    this.cwd = options?.cwd ?? process.cwd();
    this.baseDir = options?.baseDir ?? null; // the `.miniphi` dir, or null to skip persistence
    this.sessionId = options?.sessionId ?? `agent-${Date.now()}`;
    this.schemaRegistry = options?.schemaRegistry ?? new PromptSchemaRegistry();
    this.approver =
      typeof options?.approver === "function" ? options.approver : async () => ({ approved: false });
    this.runCommand = typeof options?.runCommand === "function" ? options.runCommand : null;
    this.webResearch = typeof options?.webResearch === "function" ? options.webResearch : null;
    this.visionReview = typeof options?.visionReview === "function" ? options.visionReview : null;
    this.knowledgeLookup =
      typeof options?.knowledgeLookup === "function" ? options.knowledgeLookup : null;
    this.validateWorkspace =
      typeof options?.validateWorkspace === "function" ? options.validateWorkspace : null;
    this.requireWebResearch = Boolean(options?.requireWebResearch);
    this.maxWebResearchActions =
      Number.isFinite(options?.maxWebResearchActions) && options.maxWebResearchActions > 0
        ? Math.floor(options.maxWebResearchActions)
        : DEFAULT_MAX_WEB_RESEARCH_ACTIONS;
    this.initialResearchQueries = Array.isArray(options?.initialResearchQueries)
      ? options.initialResearchQueries
          .filter((query) => typeof query === "string" && query.trim())
          .map((query) => query.trim())
          .slice(0, this.maxWebResearchActions)
      : [];
    this.maxTurns = Number.isFinite(options?.maxTurns) && options.maxTurns > 0 ? options.maxTurns : DEFAULT_MAX_TURNS;
    this.maxActionsPerTurn =
      Number.isFinite(options?.maxActionsPerTurn) && options.maxActionsPerTurn > 0
        ? options.maxActionsPerTurn
        : DEFAULT_MAX_ACTIONS_PER_TURN;
    this.temperature = Number.isFinite(options?.temperature) ? options.temperature : DEFAULT_TEMPERATURE;
    this.maxTurnTokens =
      Number.isFinite(options?.maxTurnTokens) && options.maxTurnTokens > 0
        ? Math.floor(options.maxTurnTokens)
        : -1;
    this.model = typeof options?.model === "string" && options.model.trim() ? options.model.trim() : null;
    this.modelSelection =
      options?.modelSelection && typeof options.modelSelection === "object"
        ? { ...options.modelSelection }
        : null;
    this.reasoning =
      options?.reasoning && typeof options.reasoning === "object"
        ? { ...options.reasoning }
        : null;
    this.reasoningRequests = [];
    if (this.reasoning && typeof this.client?.setDefaultReasoning === "function") {
      this.client.setDefaultReasoning(this.reasoning);
    }
    this.sessionDeadline = Number.isFinite(options?.sessionDeadline) ? options.sessionDeadline : null;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.contextEngine =
      options?.contextEngine ??
      (typeof options?.contextEngineFactory === "function"
        ? options.contextEngineFactory({
            sessionId: this.sessionId,
            cwd: this.cwd,
          })
        : null);
    // Durable, project-local memory served straight out of `.miniphi/`. It is a
    // *peer* of the Cheetah engine, not a layer under it: it answers when
    // Cheetah is disabled or unreachable, and what it returns is never mirrored
    // into the graph database (see local-context-memory.js).
    this.localMemory = options?.localMemory ?? null;
    if (this.localMemory && !this.localMemory.sessionId) {
      // The store is built before the session id exists (the UI creates it once
      // per process). Stamping it here is what lets `remember()` attribute a
      // record and `recall()` exclude this run's own writes.
      this.localMemory.sessionId = this.sessionId;
    }
    this.localMemoryCandidates =
      Number.isFinite(options?.localMemoryCandidates) && options.localMemoryCandidates > 0
        ? Math.floor(options.localMemoryCandidates)
        : DEFAULT_LOCAL_MEMORY_CANDIDATES;
    this.contextReferenceComposer =
      options?.contextReferenceComposer ??
      new ContextReferenceComposer({
        client: this.client,
        schemaRegistry: this.schemaRegistry,
        model: this.model,
        reasoning: this.reasoning,
        budgetTokens: options?.contextReferenceBudgetTokens,
        timeoutMs: options?.contextReferenceTimeoutMs,
      });

    // Multi-layered context. The prompt budget follows the model's *loaded*
    // context window (LM Studio JIT-loads small windows), minus the fixed cost
    // of the system prompt + schema block, so selection never overflows it.
    this.contextLength = Number.isFinite(options?.contextLength) && options.contextLength > 0
      ? Math.floor(options.contextLength)
      : null;
    this._hasExplicitContextBudget =
      Number.isFinite(options?.contextBudgetTokens) && options.contextBudgetTokens > 0;
    this.contextBudgetTokens = this._hasExplicitContextBudget
      ? Math.floor(options.contextBudgetTokens)
      : deriveContextBudget({
          contextLength: this.contextLength,
          reservedTokens: this._estimateFixedPromptTokens(),
        });
    this.context = options?.context instanceof ContextGraph
      ? options.context
      : new ContextGraph({ budgetTokens: this.contextBudgetTokens });
    this.maxContextReforms = Number.isFinite(options?.maxContextReforms) && options.maxContextReforms >= 0
      ? Math.floor(options.maxContextReforms)
      : DEFAULT_MAX_CONTEXT_REFORMS;
    // Turns that only reshape the context are legitimate work, but they must be
    // bounded or a model can reshape forever without ever touching a file.
    this.maxContextOnlyTurns = Number.isFinite(options?.maxContextOnlyTurns) && options.maxContextOnlyTurns >= 0
      ? Math.floor(options.maxContextOnlyTurns)
      : DEFAULT_MAX_CONTEXT_ONLY_TURNS;

    this.appliedEdits = [];
    this.cancelled = false;
    this._sessionDir = null;
    this._contextReforms = 0;
    this._contextOpsApplied = 0;
    this._contextOpsRejected = 0;
    this._contextOpsNoop = 0;
    this._contextOnlyTurns = 0;
    this._missionNodeId = null;
    this._budgetNodeId = null;
    // Signatures of already-run actions so a model that keeps re-proposing the
    // same read/edit is deduped instead of spinning until the turn budget.
    this._actionSignatures = new Set();
    this._progressThisTurn = false;
    this._webResearchCompleted = false;
    this._webResearchCount = 0;
    this._lastValidation = null;
    this._contextEngineLastSelection = null;
    this._contextEngineSelections = 0;
    this._contextEngineFallbacks = 0;
    this._contextReferenceSelections = [];
    this._contextReferenceCache = new Map();
    this._localMemoryQueries = 0;
    this._localMemoryCandidatesServed = 0;
    this._localMemoryRemembered = 0;
    this._localMemoryError = null;
    this._lastTurnSummary = null;
    this._lastTurnTruncated = false;
    this._invalidContentAttempts = new Map();
    this._anchorFailures = new Map();
    this._usedCorrectionGraces = new Set();
    this._correctionGracePending = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Selects the model before the first turn. The UI uses this after the
   * operator chooses Auto/manual from the live catalog. Once context exists,
   * changing models would invalidate prompt-budget assumptions and is rejected.
   */
  configureModel({ model, contextLength = null, selection = null } = {}) {
    if (this.context.nodes.size > 0) {
      throw new Error("The session model cannot change after the task has started.");
    }
    if (typeof model !== "string" || !model.trim()) {
      throw new Error("model is required to configure an agent session.");
    }
    this.model = model.trim();
    if (this.contextReferenceComposer) {
      this.contextReferenceComposer.model = this.model;
    }
    this.modelSelection =
      selection && typeof selection === "object"
        ? { ...selection, resolvedModel: this.model }
        : { requested: this.model, resolvedModel: this.model };
    this.contextLength =
      Number.isFinite(contextLength) && contextLength > 0
        ? Math.floor(contextLength)
        : null;
    if (!this._hasExplicitContextBudget) {
      this.contextBudgetTokens = deriveContextBudget({
        contextLength: this.contextLength,
        reservedTokens: this._estimateFixedPromptTokens(),
      });
      this.context.budgetTokens = this.contextBudgetTokens;
    }
    return {
      model: this.model,
      contextLength: this.contextLength,
      contextBudgetTokens: this.contextBudgetTokens,
      selection: this.modelSelection,
    };
  }

  configureReasoning(reasoning = null) {
    if (this.context.nodes.size > 0) {
      throw new Error("The reasoning profile cannot change after the task has started.");
    }
    this.reasoning =
      reasoning && typeof reasoning === "object" ? { ...reasoning } : null;
    if (this.contextReferenceComposer) {
      this.contextReferenceComposer.reasoning = this.reasoning;
    }
    if (typeof this.client?.setDefaultReasoning === "function") {
      this.client.setDefaultReasoning(this.reasoning);
    }
    return this.reasoning;
  }

  /** Resolve a pending UI permission request (delegates to the UI approver). */
  resolvePermission(id, decision) {
    if (typeof this.approver?.resolve === "function") {
      return this.approver.resolve(id, decision);
    }
    return false;
  }

  get rollbackDir() {
    return this._sessionDir ? path.join(this._sessionDir, "rollbacks") : null;
  }

  async _ensureSessionDir() {
    if (!this.baseDir || this._sessionDir) {
      return this._sessionDir;
    }
    this._sessionDir = path.join(this.baseDir, "agent-sessions", this.sessionId);
    await fs.mkdir(this._sessionDir, { recursive: true });
    return this._sessionDir;
  }

  async _persist(fileName, data) {
    const dir = await this._ensureSessionDir();
    if (!dir) {
      return;
    }
    try {
      await fs.writeFile(path.join(dir, fileName), JSON.stringify(data, null, 2), "utf8");
    } catch {
      // Persistence is best-effort; never let it break the loop.
    }
  }

  async _appendTranscript(entry) {
    const dir = await this._ensureSessionDir();
    if (!dir) {
      return;
    }
    try {
      await fs.appendFile(path.join(dir, "transcript.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // ignore
    }
  }

  _budgetExhausted() {
    return Number.isFinite(this.sessionDeadline) && this.sessionDeadline > 0 && Date.now() >= this.sessionDeadline;
  }

  _log(message) {
    if (this.logger) {
      this.logger(message);
    }
  }

  /** SYSTEM_PROMPT plus the visual_review/knowledge_lookup guides, only when configured. */
  _systemPrompt() {
    const guides = [
      typeof this.visionReview === "function" ? VISUAL_REVIEW_GUIDE : null,
      typeof this.knowledgeLookup === "function" ? KNOWLEDGE_LOOKUP_GUIDE : null,
    ].filter(Boolean);
    return guides.length ? `${SYSTEM_PROMPT}\n\n${guides.join("\n\n")}` : SYSTEM_PROMPT;
  }

  /** Tokens the system prompt + schema block always cost, excluded from the context budget. */
  _estimateFixedPromptTokens() {
    const schemaBlock = this.schemaRegistry?.buildInstructionBlock(AGENT_SCHEMA_ID) ?? "";
    return estimateTokens(this._systemPrompt()) + estimateTokens(schemaBlock) + 256;
  }

  /**
   * Records one observation as a context node instead of appending to a flat
   * transcript, so priority/importance/subtask level decide whether it is later
   * sent in full, as a digest, or as a requestable stub.
   */
  _remember({
    layer = "evidence",
    label,
    text,
    importance = undefined,
    pinned = false,
    kind = null,
    ttlTurns = null,
  } = {}) {
    if (typeof text !== "string" || !text.trim()) {
      return null;
    }
    return this.context.add({
      layer,
      label: label ?? layer,
      text,
      importance,
      pinned,
      kind,
      ttlTurns,
      turn: this.context.turn,
    });
  }

  /**
   * A successful write makes earlier reads and edit snapshots for that file
   * stale. Keeping both versions under context pressure makes a local model
   * repair the old source instead of the file that is actually on disk.
   */
  _retireSupersededFileContext(filePath) {
    const staleLabels = new Set([
      `read_file ${filePath}`,
      `requested ${filePath}`,
      `operator-selected ${filePath}`,
    ]);
    for (const node of this.context.nodes.values()) {
      const staleEdit =
        node.kind === "edit" &&
        (node.label === `written ${filePath}` || node.label === `unchanged ${filePath}`);
      if (
        node.state !== "dropped" &&
        (staleLabels.has(node.label) || staleEdit)
      ) {
        this.context.update(node.id, {
          state: "dropped",
          importance: 0,
          pinned: false,
        });
      }
    }
    // Read/search deduplication is version-sensitive. Once a file changes, a
    // new read of that path and a new workspace search can return new evidence.
    this._actionSignatures.delete(`read_file:${filePath}`);
    for (const signature of this._actionSignatures) {
      if (signature.startsWith("search_text:")) {
        this._actionSignatures.delete(signature);
      }
    }
  }

  /** Flat view of the live context, kept for logging/debugging convenience. */
  get observations() {
    return [...this.context.nodes.values()]
      .filter((node) => node.state !== "dropped")
      .map((node) => node.text);
  }

  async _persistContextGraph() {
    await this._persist("context-graph.json", this.context.toJSON());
  }

  async _seedPinnedFiles(selectedFiles) {
    const list = Array.isArray(selectedFiles) ? selectedFiles.filter(Boolean) : [];
    if (!list.length) {
      return;
    }
    const { resolved, unresolved } = await resolveMissingSnippets({
      snippets: list,
      cwd: this.cwd,
      maxCount: list.length,
      maxBytes: MAX_PINNED_FILE_BYTES,
    });
    for (const entry of resolved) {
      const block = buildSnippetContextBlock([entry]);
      if (block) {
        // One node per file so budget pressure can demote them individually.
        this._remember({
          layer: "evidence",
          label: `operator-selected ${entry.path}`,
          text: block,
          importance: 0.9,
          kind: "pinned-file",
        });
      }
    }
    if (unresolved.length) {
      this._remember({
        layer: "scratch",
        label: "unreadable selections",
        text: `Selected but unreadable: ${unresolved.join(", ")}`,
        importance: 0.5,
      });
    }
  }

  /**
   * Seeds the invariant layers: the mission (task + workspace) and the contract
   * (session policies). These are re-created per session and never dropped, so a
   * sub-conversation resumed after heavy compaction still knows what it is doing.
   */
  _seedInvariants(task) {
    const mission = this._remember({
      layer: "mission",
      label: "operator task",
      text: `Task: ${task}\nWorkspace root: ${this.cwd}`,
      importance: 1,
      pinned: true,
      kind: "mission",
    });
    this._missionNodeId = mission?.id ?? null;
    this._budgetNodeId = null; // `_buildMessages` seeds/refreshes the policy node
  }

  _buildPolicyText() {
    return [
      this._lastValidation && !this._lastValidation.valid
        ? `Workspace validation has ${this._lastValidation.issues.length} unresolved issue(s). Your next JSON turn MUST contain concrete read_file, search_text, write_file, or edit_file actions that address them. A summary describing intended changes is not progress and must never be returned with an empty actions array.`
        : null,
      this.requireWebResearch && !this._webResearchCompleted
        ? "Session requirement: perform at least one successful web_research action before proposing writes or commands."
        : null,
      this._webResearchCount >= this.maxWebResearchActions
        ? "Web research budget exhausted. Do not request more research; choose from the gathered results and implement the task now."
        : `Web research budget: ${this.maxWebResearchActions - this._webResearchCount} action(s) remaining.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * The seed the local `.miniphi` store is asked with.
   *
   * The mission alone would be a *constant*: every turn would ask the same
   * question and get the same records back, which is the opposite of memory
   * that follows the work. So the seed also carries what the run is up against
   * right now — the open validation issues and the last turn's own summary —
   * because that is the text a useful past record would resemble.
   *
   * Deliberately *not* the whole rendered context: a seed the size of the
   * prompt matches everything and therefore ranks nothing.
   */
  _localMemorySeed() {
    const parts = [];
    const mission = this._missionNodeId ? this.context.nodes.get(this._missionNodeId) : null;
    if (mission?.text) {
      parts.push(mission.text);
    }
    const focus = this.context.focusId ? this.context.nodes.get(this.context.focusId) : null;
    if (focus?.text && focus.id !== mission?.id) {
      parts.push(`${focus.label ?? ""} ${focus.text}`);
    }
    // The current obstacle is the highest-signal part of the seed: a past
    // session that hit the same wall is exactly the record worth surfacing.
    for (const issue of this._lastValidation?.issues ?? []) {
      parts.push(String(issue));
    }
    if (this._lastTurnSummary) {
      parts.push(this._lastTurnSummary);
    }
    return parts.join("\n").slice(0, 4000);
  }

  /**
   * Ranks durable `.miniphi` memory against this turn's seed. Failures are
   * never fatal: a broken local store degrades to "no extra candidates", the
   * same way an unreachable Cheetah does.
   */
  _recallLocalMemory() {
    if (!this.localMemory || typeof this.localMemory.recall !== "function") {
      return [];
    }
    const seed = this._localMemorySeed();
    if (!seed) {
      return [];
    }
    try {
      const result = this.localMemory.recall({
        text: seed,
        limit: this.localMemoryCandidates,
        // The live session's own nodes are already rendered into the prompt;
        // serving them again from disk would buy a duplicate with the budget.
        excludeSessionId: this.sessionId,
      });
      const candidates = Array.isArray(result?.referenceCandidates)
        ? result.referenceCandidates
        : [];
      this._localMemoryQueries += 1;
      this._localMemoryCandidatesServed += candidates.length;
      this.emit("local-memory", {
        turn: this.context.turn,
        candidates: candidates.length,
        matched: result?.matched ?? 0,
        scanned: result?.scanned ?? 0,
        elapsedMs: result?.elapsedMs ?? 0,
      });
      return candidates;
    } catch (error) {
      this._localMemoryError = error instanceof Error ? error.message : String(error);
      this._log(`[AgentSession] local memory recall failed: ${this._localMemoryError}`);
      return [];
    }
  }

  async _selectContextEngine() {
    const localCandidates = this._recallLocalMemory();
    if (!this.contextEngine || typeof this.contextEngine.select !== "function") {
      return {
        ok: true,
        engine: localCandidates.length ? "local" : "memory",
        preferredNodeIds: [],
        referenceCandidates: localCandidates,
      };
    }
    try {
      const selection = await this.contextEngine.select(this.context, {
        focusId: this.context.focusId,
      });
      this._contextEngineLastSelection = selection ?? null;
      this._contextEngineSelections += 1;
      if (selection?.fallback) {
        this._contextEngineFallbacks += 1;
      }
      this.emit("context-engine", {
        turn: this.context.turn,
        ...(selection ?? {}),
        stats:
          typeof this.contextEngine.stats === "function"
            ? this.contextEngine.stats()
            : null,
      });
      return {
        ...(selection ?? {}),
        preferredNodeIds: Array.isArray(selection?.preferredNodeIds)
          ? selection.preferredNodeIds
          : [],
        referenceCandidates: mergeReferenceCandidates(
          selection?.referenceCandidates,
          localCandidates,
        ),
      };
    } catch (error) {
      this._contextEngineFallbacks += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.emit("context-engine", {
        turn: this.context.turn,
        ok: false,
        engine: "cheetah",
        fallback: this.contextEngine?.required ? null : "memory",
        error: message,
      });
      this._log(`[AgentSession] context engine failed: ${message}`);
      if (this.contextEngine?.required) {
        throw error;
      }
      return {
        ok: false,
        engine: "cheetah",
        preferredNodeIds: [],
        // Cheetah being down is exactly when durable local memory matters most,
        // so the fallback keeps the candidates it already has.
        referenceCandidates: localCandidates,
        fallback: "memory",
        error: message,
      };
    }
  }

  async _composeContextReferences(task, candidates) {
    if (
      !this.contextReferenceComposer ||
      typeof this.contextReferenceComposer.compose !== "function" ||
      !Array.isArray(candidates) ||
      !candidates.length
    ) {
      return { block: "", selected: [] };
    }
    const cacheKey = JSON.stringify(
      candidates.map((candidate) => [
        candidate.id,
        candidate.text,
        candidate.score,
        candidate.source,
      ]),
    );
    if (this._contextReferenceCache.has(cacheKey)) {
      return this._contextReferenceCache.get(cacheKey);
    }
    const composed = await this.contextReferenceComposer.compose({
      task,
      candidates,
      turn: this.context.turn,
      sessionDeadline: this.sessionDeadline,
    });
    const block = this.contextReferenceComposer.render(composed.selected);
    const selection = {
      block,
      selected: composed.selected,
      fallback: composed.audit?.fallback ?? null,
    };
    this._contextReferenceCache.clear();
    this._contextReferenceCache.set(cacheKey, selection);
    this._contextReferenceSelections.push(composed.audit);
    await this._persist("context-references.json", {
      schemaVersion: "context-reference-memory@v1",
      sessionId: this.sessionId,
      selections: this._contextReferenceSelections,
    });
    this.emit("context-references", {
      turn: this.context.turn,
      candidates: candidates.length,
      selected: composed.selected.length,
      fallback: selection.fallback,
      referenceIds: composed.selected.map((reference) => reference.id),
    });
    return selection;
  }

  async _buildMessages(task) {
    const schemaBlock = this.schemaRegistry.buildInstructionBlock(AGENT_SCHEMA_ID) ?? "";
    // The policy node is mutable (research budget changes per turn). Re-seed it if
    // the retained-layer cap ever evicted it, so policies are never silently lost.
    if (!this._budgetNodeId || !this.context.update(this._budgetNodeId, { text: this._buildPolicyText() })) {
      this._budgetNodeId =
        this._remember({
          layer: "contract",
          label: "session policies",
          text: this._buildPolicyText(),
          importance: 1,
          kind: "policy",
        })?.id ?? null;
    }
    const engineSelection = await this._selectContextEngine();
    const referenceSelection = await this._composeContextReferences(
      task,
      engineSelection.referenceCandidates,
    );
    const referenceTokens = estimateTokens(referenceSelection.block);
    const graphBudgetTokens = Math.max(
      64,
      this.contextBudgetTokens - referenceTokens,
    );
    const contextBlock = this.context.nodes.size
      ? this.context.render({
          budgetTokens: graphBudgetTokens,
          preferredNodeIds: engineSelection.preferredNodeIds,
        })
      : "No context gathered yet. Start by gathering what you need.";
    const userBody = [
      contextBlock,
      referenceSelection.block || null,
      "Respond with the next turn as JSON.",
    ].filter(Boolean).join("\n\n");
    return [
      { role: "system", content: `${this._systemPrompt()}\n\nJSON schema:\n${schemaBlock}` },
      { role: "user", content: userBody },
    ];
  }

  async _requestTurn(messages, responseFormat) {
    const completion = await this.client.createChatCompletion({
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTurnTokens,
      response_format: responseFormat,
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoning?.model?.resolved &&
        typeof this.client?.setDefaultReasoning !== "function"
        ? { reasoning: this.reasoning.model.resolved }
        : {}),
    });
    if (completion?.miniphi_reasoning) {
      this.reasoningRequests.push({
        ...completion.miniphi_reasoning,
        at: new Date().toISOString(),
      });
    }
    const choice = completion?.choices?.[0] ?? null;
    // A turn that ran out of tokens is a *different* failure from a turn that
    // drifted off-schema, and conflating them is expensive: a `write_file`
    // whose content was cut mid-file is rejected downstream as "invalid
    // JavaScript syntax", so the model spends its next turn hunting a syntax
    // error it never made instead of writing a smaller file. Seen live against
    // prism-ml/bonsai-27b writing a whole Express app in one action.
    this._lastTurnTruncated = choice?.finish_reason === "length";
    return choice?.message?.content ?? "";
  }

  async _requestTurnWithRetry(messages, responseFormat) {
    let lastError = null;
    for (let attempt = 0; attempt <= DEFAULT_MODEL_REQUEST_RETRIES; attempt += 1) {
      if (this._budgetExhausted()) {
        throw new Error("session-timeout");
      }
      try {
        return await this._requestTurn(messages, responseFormat);
      } catch (error) {
        lastError = error;
        if (attempt < DEFAULT_MODEL_REQUEST_RETRIES) {
          this._log(
            `[AgentSession] model request failed; retrying once: ${
              error instanceof Error ? error.message : error
            }`,
          );
        }
      }
    }
    throw lastError ?? new Error("model request failed");
  }

  /**
   * Tells the model, in the retained layer it is guaranteed to read, that its
   * previous turn was cut off by the token budget rather than accepted whole.
   * Without this the only feedback it gets is the downstream rejection of a
   * half-written file, which reads as a syntax mistake it did not make.
   */
  _noteTruncatedTurn(turn) {
    if (!this._lastTurnTruncated) {
      return;
    }
    this._remember({
      layer: "contract",
      label: "response truncated",
      text: [
        `Your turn ${turn} response hit the per-turn output limit${
          this.maxTurnTokens > 0 ? ` (${this.maxTurnTokens} tokens)` : ""
        } and was cut off mid-way.`,
        "Anything you were writing is incomplete, so a write_file in that turn was rejected for being unparseable — that is a length problem, not a syntax mistake.",
        "Write less per turn: split the application into several smaller modules and create them one file per turn, rather than emitting one large file.",
      ].join(" "),
      importance: 1,
      ttlTurns: 2,
    });
    this._grantCorrectionGrace("truncated");
    this._log(`[AgentSession] turn ${turn} response was truncated by the output limit`);
    this._lastTurnTruncated = false;
  }

  /**
   * The recovery instruction that matches the failure, which is not what this
   * used to do.
   *
   * The literal-anchor contract — the paragraph explaining that an anchor is an
   * exact substring and how to replace a whole block — was attached to
   * `invalid-content`, a *syntax* failure where it is irrelevant, and
   * `anchor-not-found` / `anchor-ambiguous` were answered with nothing but
   * "anchor not found in <path>". A model that misses an anchor was therefore
   * never told how to recover, and repeated the same miss: seen live, three
   * consecutive turns sent an anchor for `server/package.json` that did not
   * exist.
   */
  _repairHint(status, action) {
    if (status === "anchor-not-found" || status === "anchor-ambiguous") {
      const path = typeof action?.path === "string" ? action.path : "";
      const attempts = (this._anchorFailures.get(path) ?? 0) + 1;
      this._anchorFailures.set(path, attempts);
      const escalation =
        attempts >= 2
          ? ` You have now missed an anchor in ${path} ${attempts} times, so your idea of that file's text is wrong. Stop guessing anchors: read_file ${path} first, then send one edit_file with the full replacement content and no anchor at all.`
          : "";
      if (attempts >= 2) {
        this._grantCorrectionGrace(`anchor:${path}`);
      }
      return ` An anchor is an exact literal substring of the file as it is on disk right now, not a line range and not a paraphrase. Copy it verbatim from the current file, include the complete block you are replacing, or omit the anchor and send a full-file content replacement.${escalation}`;
    }
    if (status === "invalid-content") {
      // An anchored *removal* is the classic way to produce unparseable output
      // from a correct intention: deleting the last entry of a list or object
      // leaves the separator that preceded it dangling. Seen live twice in a
      // row — removing `"node:sqlite": "^0.0.1"` from `dependencies` left the
      // comma after the entry before it, and the model re-sent the same shape.
      const anchored = typeof action?.anchor === "string" && action.anchor.length > 0;
      const anchorHint = anchored
        ? " Your anchor removed text and left the surrounding punctuation behind — deleting the last entry of an object or array strands the comma before it. Extend the anchor to cover that separator too, or drop the anchor and send the whole corrected file as `content`."
        : "";
      return ` The content must be the complete, parseable text of the file.${anchorHint}${this._oversizedProposalHint(action)}`;
    }
    if (status === "missing-file") {
      return " Create it with write_file first; edit_file only changes a file that already exists.";
    }
    if (status === "conflicting-action") {
      // Only the first edit to a path runs in a turn, because every later one
      // was written against the pre-edit text. Without saying so, a model that
      // split one fix across two edits sees the first succeed and never learns
      // the rest were dropped: seen live, `import multer` landed while the
      // `const upload = multer(...)` that made it useful was discarded, and the
      // server kept failing on `upload is not defined`.
      return " Only the first change to this file ran; the rest were written against its old text and were discarded, so the file is now half-changed. Put every change to one file into a SINGLE edit_file next turn — a full-content replacement is safest — and touch other files in separate actions.";
    }
    return "";
  }

  /**
   * Steers a repeatedly-rejected large file toward being split up.
   *
   * A syntax error in a 240-line file generated in one shot is not a typo the
   * model can reliably find and fix — it is a symptom of the file being longer
   * than the model can emit correctly, and re-proposing the same 240 lines just
   * moves the error somewhere else. Observed live: `prism-ml/bonsai-27b`
   * proposed one whole application entry point three turns running, failing at a
   * different line each time.
   *
   * Counted per path, so a one-off mistake in a short file gets the ordinary
   * repair hint and nothing more.
   */
  _oversizedProposalHint(action) {
    const path = typeof action?.path === "string" ? action.path : "";
    const lines = typeof action?.content === "string" ? action.content.split("\n").length : 0;
    if (!path) {
      return "";
    }
    const attempts = (this._invalidContentAttempts.get(path) ?? 0) + 1;
    this._invalidContentAttempts.set(path, attempts);
    if (attempts < 2 || lines < LARGE_PROPOSAL_LINES) {
      return "";
    }
    this._grantCorrectionGrace(`split:${path}`);
    return ` You have now proposed ${path} ${attempts} times and it is ${lines} lines long; a file this size is where these errors come from. Stop rewriting it whole. Split it into smaller modules (for example separate database, route and view files), write ONE small module this turn, and import it from the entry point.`;
  }

  /**
   * Records that a *new* corrective instruction was just issued, buying the
   * model one turn to act on it before the idle guard counts against it.
   * Keyed, so repeating the same instruction never buys a second grace, and
   * capped overall so this can never become an escape hatch from the guard.
   */
  _grantCorrectionGrace(key) {
    if (
      !key ||
      this._usedCorrectionGraces.has(key) ||
      this._usedCorrectionGraces.size >= MAX_CORRECTION_GRACES
    ) {
      return;
    }
    this._usedCorrectionGraces.add(key);
    this._correctionGracePending = true;
  }

  _consumeCorrectionGrace() {
    if (!this._correctionGracePending) {
      return false;
    }
    this._correctionGracePending = false;
    return true;
  }

  /**
   * The current validation issue naming this path, or null. Matching is on the
   * workspace-relative path as the validator would print it, so a validator
   * that says "server/package.json is not valid JSON" is recognised without the
   * validator having to report paths in a structured field.
   */
  _pathFailingValidation(relativePath) {
    if (this._lastValidation?.valid !== false || !relativePath) {
      return null;
    }
    const needle = String(relativePath).split(path.sep).join("/");
    for (const issue of this._lastValidation.issues ?? []) {
      const text = String(issue);
      if (text.includes(needle)) {
        return text.slice(0, 400);
      }
    }
    return null;
  }

  _fallbackTurn(task, reason) {
    return {
      task: String(task).slice(0, 80),
      summary: `Stopping: ${reason}`,
      summary_updates: [],
      actions: [{ type: "finish", reason }],
      needs_more_context: false,
      missing_snippets: [],
      _stopReason: reason,
    };
  }

  async _getTurn(task, responseFormat) {
    let messages = null;
    let text = "";
    try {
      messages = await this._buildMessages(task);
      text = await this._requestTurnWithRetry(messages, responseFormat);
    } catch (error) {
      return this._fallbackTurn(task, `model request failed: ${error instanceof Error ? error.message : error}`);
    }
    const validation = this.schemaRegistry.validate(AGENT_SCHEMA_ID, text);
    if (validation?.valid && validation.parsed) {
      return validation.parsed;
    }
    // One compact nudge before giving up, per the JSON-first contract.
    this._remember({
      layer: "contract",
      label: "schema violation",
      text: "Your last reply was not valid JSON for the schema. Reply again with ONLY the JSON object.",
      importance: 1,
      ttlTurns: 1,
    });
    try {
      const retryMessages = await this._buildMessages(task);
      const retryText = await this._requestTurnWithRetry(retryMessages, responseFormat);
      const retryValidation = this.schemaRegistry.validate(AGENT_SCHEMA_ID, retryText);
      if (retryValidation?.valid && retryValidation.parsed) {
        return retryValidation.parsed;
      }
    } catch {
      // fall through to fallback
    }
    return this._fallbackTurn(task, `invalid-response: ${validation?.error ?? "schema validation failed"}`);
  }

  async _handleMutation({ action, turn, mutationPathsThisTurn = null }) {
    const proposalResult = await buildMutationProposal({ action, cwd: this.cwd });
    if (proposalResult.ok) {
      // Dedupe identical (path + resulting content) proposals: if the file is
      // already in exactly this state, don't re-approve/re-apply it.
      const signature = `${action.type}:${proposalResult.proposal.path}:${hashText(
        proposalResult.proposal.afterContent,
      )}`;
      if (this._actionSignatures.has(signature)) {
        const result = {
          turn,
          action: { type: action.type, path: proposalResult.proposal.path },
          status: "duplicate",
        };
        this.emit("action-result", result);
        // "Already applied, move on" is the right answer only when the file is
        // actually good. If validation is currently *failing on this very path*,
        // that message tells the model to stop fixing a broken file — and
        // because the content is byte-identical, it is also the model's only
        // signal that its "fix" changed nothing. Seen live: a `package.json`
        // with a raw newline inside a JSON string was re-sent unchanged, and the
        // duplicate guard answered "do not re-write it; your next turn MUST be a
        // single finish action".
        const stillFailing = this._pathFailingValidation(proposalResult.proposal.path);
        this._remember({
          layer: "contract",
          label: `duplicate ${describeAction(action)}`,
          text: stillFailing
            ? `${describeAction(action)} -> unchanged: you sent ${proposalResult.proposal.path} with byte-identical content, so nothing changed and it is STILL failing validation: ${stillFailing} Re-read the file, find the exact defect, and send different content. Do not send the same content again.`
            : `${describeAction(action)} -> already applied: ${proposalResult.proposal.path} is already in exactly this state. Do not re-write or re-read it to verify. Your next turn MUST be a single finish action unless another file still needs work.`,
          importance: 1,
          ttlTurns: 1,
        });
        await this._appendTranscript({ kind: "action-result", ...result });
        return;
      }
      this._actionSignatures.add(signature);
    }
    if (!proposalResult.ok) {
      const repairHint = this._repairHint(proposalResult.status, action);
      // A failed edit is precisely when re-reading the file becomes useful
      // again: the model needs its exact current text to build a correct anchor
      // or a full replacement, and the repair hint above tells it to do that.
      // The read dedupe then answered "already gathered (skipped)" — the loop
      // instructing the model to read a file and refusing the read in the same
      // breath. Seen live: an anchored edit failed, the hint said "read_file
      // server/server.js first", the read came back `duplicate`, and the session
      // stalled to `no-progress` two turns later.
      this._actionSignatures.delete(`read_file:${action.path}`);
      const result = {
        turn,
        action: { type: action.type, path: action.path },
        status: proposalResult.status ?? "invalid",
        error: proposalResult.error,
      };
      this.emit("action-result", result);
      this._remember({
        layer: "contract",
        label: `${result.status} ${describeAction(action)}`,
        text: `${describeAction(action)} -> ${result.status}: ${result.error}${repairHint}`,
        importance: 0.9,
        ttlTurns: 1,
      });
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    const proposal = { ...proposalResult.proposal, reason: action.reason };
    this.emit("edit-proposed", { turn, proposal });
    const decision = await this.approver({
      kind: "edit",
      type: action.type,
      path: proposal.path,
      danger: action.danger,
      reason: action.reason,
      diff: proposal.diff,
      isNewFile: proposal.isNewFile,
    });
    if (!decision?.approved) {
      const result = { turn, action: { type: action.type, path: proposal.path }, status: "rejected" };
      this.emit("action-result", result);
      this._remember({
        layer: "plan",
        label: `rejected ${describeAction(action)}`,
        text: `${describeAction(action)} -> rejected by operator (${decision?.reason ?? "no reason"})`,
        importance: 0.9,
      });
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    const guard = await commitMutation({ proposal, cwd: this.cwd, rollbackDir: this.rollbackDir });
    const result = {
      turn,
      action: { type: action.type, path: proposal.path },
      status: guard.status,
      rollbackPath: guard.rollbackPath ?? null,
      error: guard.error ?? null,
    };
    this.appliedEdits.push(result);
    this.emit("action-result", result);
    if (guard.status === "written") {
      // The same-path guard exists to stop a second edit that was written
      // against text the first one already changed. Claiming the path before
      // attempting the write made a *failed* edit consume the slot, so the
      // model's corrective follow-up in the same turn was refused for a
      // conflict that did not exist — seen live, an `invalid-content` edit was
      // followed by a valid one that got `conflicting-action`.
      mutationPathsThisTurn?.add(proposal.path);
      this._progressThisTurn = true;
      this._retireSupersededFileContext(proposal.path);
    }
    const nudge =
      guard.status === "unchanged"
        ? " (file already in this state; emit a finish action if the task is complete)"
        : "";
    // Applied edits are durable progress facts, so they live in the plan layer
    // and outrank raw evidence when the budget tightens.
    const currentContent =
      proposal.afterContent.length > MAX_MUTATION_CONTEXT_CHARS
        ? `${proposal.afterContent.slice(0, MAX_MUTATION_CONTEXT_CHARS)}\n[output truncated at ${MAX_MUTATION_CONTEXT_CHARS} chars; read_file to load the current file again]`
        : proposal.afterContent;
    this._remember({
      layer: "plan",
      label: `${guard.status} ${proposal.path}`,
      text: [
        `${describeAction(action)} -> ${guard.status}${nudge}`,
        proposal.diff ? `Applied diff:\n${proposal.diff}` : null,
        guard.status === "written"
          ? `Current ${proposal.path} after the guarded write:\n${currentContent}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      importance: 0.9,
      kind: "edit",
    });
    await this._appendTranscript({ kind: "edit", ...result });
  }

  async _handleCommand({ action, turn }) {
    const decision = await this.approver({
      kind: "command",
      command: action.command,
      danger: action.danger,
      reason: action.reason,
    });
    if (!decision?.approved) {
      const result = { turn, action: { type: "run_cmd", command: action.command }, status: "rejected" };
      this.emit("action-result", result);
      this._remember({
        layer: "plan",
        label: `rejected run_cmd`,
        text: `run_cmd ${action.command} -> rejected by operator`,
        importance: 0.9,
      });
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    if (typeof this.runCommand !== "function") {
      const result = { turn, action: { type: "run_cmd", command: action.command }, status: "deferred-command" };
      this.emit("action-result", result);
      this._remember({
        layer: "contract",
        label: "run_cmd unavailable",
        text: `run_cmd ${action.command} -> not executed (no command runner wired)`,
        importance: 0.8,
        ttlTurns: 1,
      });
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    let output = "";
    let status = "executed";
    try {
      output = await this.runCommand(action.command);
    } catch (error) {
      status = "failed";
      output = error instanceof Error ? error.message : String(error);
    }
    if (status === "executed") {
      this._progressThisTurn = true;
    }
    const result = { turn, action: { type: "run_cmd", command: action.command }, status, output };
    this.emit("action-result", result);
    this._remember({
      layer: "evidence",
      label: `run_cmd ${action.command}`,
      text: `run_cmd ${action.command} -> ${status}\n${String(output).slice(0, 800)}`,
      importance: status === "failed" ? 0.9 : 0.7,
      kind: "command",
    });
    await this._appendTranscript({ kind: "command", ...result });
  }

  async _handleResearchRequired({ action, turn }) {
    const result = {
      turn,
      action: {
        type: action.type,
        path: action.path,
        command: action.command,
      },
      status: "research-required",
      error: "complete a web_research action before writes or commands",
    };
    this.emit("action-result", result);
    this._remember({
      layer: "contract",
      label: "research gate",
      text: `${describeAction(action)} -> research-required: perform web_research first, then reconsider the library choice before retrying this action.`,
      importance: 1,
      ttlTurns: 2,
    });
    // This is an intentional policy gate, not an idle duplicate. Keep the
    // bounded loop alive so the next turn can satisfy the requirement.
    this._progressThisTurn = true;
    await this._appendTranscript({ kind: "action-result", ...result });
  }

  async _validateCurrentWorkspace({ task, turn }) {
    let validation;
    try {
      validation = await this.validateWorkspace({
        cwd: this.cwd,
        task,
        turn,
        edits: [...this.appliedEdits],
      });
    } catch (error) {
      validation = {
        valid: false,
        summary: "Workspace validation failed to run.",
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
    const normalized = {
      valid: Boolean(validation?.valid),
      summary:
        typeof validation?.summary === "string"
          ? validation.summary
          : validation?.valid
            ? "Workspace validation passed."
            : "Workspace validation found issues.",
      issues: Array.isArray(validation?.issues)
        ? validation.issues.map((issue) => String(issue)).slice(0, 12)
        : [],
    };
    this._lastValidation = normalized;
    this.emit("validation", { turn, ...normalized });
    await this._appendTranscript({ kind: "validation", turn, ...normalized });

    // A validator reports the complete current issue set. Older validation
    // nodes describe previous file versions and must not remain pinned beside
    // the authoritative result or crowd it out under a tight context budget.
    for (const node of this.context.nodes.values()) {
      if (node.kind === "validation") {
        this.context.update(node.id, {
          state: "dropped",
          pinned: false,
          importance: 0,
        });
      }
    }
    if (!normalized.valid) {
      // Validation issues are the current definition of "done"; pin them so no
      // amount of budget pressure can hide them from the next turn.
      this._remember({
        layer: "plan",
        label: `validation issues (turn ${turn})`,
        text: `Workspace validation JSON:\n${JSON.stringify(normalized, null, 2)}\nFix these issues before finishing.`,
        importance: 1,
        pinned: true,
        kind: "validation",
      });
    }
    // Validation is the point at which the graph's meaning changes most —
    // stale issue nodes are dropped and the authoritative one is pinned — but
    // the snapshot was only written on context-ops and at session end. An
    // operator (or a crash-resume) reading `context-graph.json` mid-run saw a
    // validation state several turns old and drew the wrong conclusion from it.
    await this._persistContextGraph();
    return normalized;
  }

  /**
   * The live evidence node a previous identical read produced, or null when it
   * has been dropped. Null is what makes the read runnable again: the dedupe
   * exists to stop the model re-fetching text it already has, not to stop it
   * fetching text that is gone.
   */
  _liveEvidenceNode(label) {
    for (const node of this.context.nodes.values()) {
      if (node.label === label && node.state !== "dropped") {
        return node;
      }
    }
    return null;
  }

  async _handleReadonly({ action, turn }) {
    // Skip repeated identical reads/searches: they add no new context and would
    // otherwise let the model keep the loop alive without progress.
    const signature = `${action.type}:${action.path ?? action.term ?? ""}`;
    // "Already gathered" is only true while the gathered text is still *there*.
    // Budget pressure demotes an old read to a digest and then to a stub, and at
    // that point refusing the re-read leaves the model unable to obtain the file
    // by any means: the content is not in the prompt and the tool that fetches
    // it is disabled. Seen live — a 250-line `index.js` was read, aged out of a
    // 5000-token budget, and two consecutive turns asking for it again were
    // answered `duplicate` until the session stopped `no-progress` one edit away
    // from a working app.
    const gathered = this._liveEvidenceNode(describeAction(action));
    if (this._actionSignatures.has(signature) && gathered) {
      // The model asking to read a file it already read means one thing: it
      // cannot see the content. Answering "already gathered, use expand" asks it
      // to re-state the same intent in another vocabulary, and a model that does
      // not take that hint simply re-reads until the idle guard kills the run —
      // observed live, two turns of `duplicate` reads on the file holding the
      // one-line defect. Satisfying the intent is strictly better than
      // instructing it: expand the node here and say so.
      const expanded = this.context.applyOps([{ op: "expand", node: gathered.id }], { turn });
      const reloaded = expanded.applied.length > 0;
      const result = {
        turn,
        action: { type: action.type, path: action.path, term: action.term },
        status: reloaded ? "reloaded" : "duplicate",
      };
      this.emit("action-result", result);
      this._remember({
        layer: "contract",
        label: `duplicate ${describeAction(action)}`,
        text: reloaded
          ? `${describeAction(action)} -> not re-read; its content was already in your context as node [${gathered.id}] and MiniPhi has reloaded it in full for this turn. Use it now.`
          : `${describeAction(action)} -> already gathered and already loaded in full as node [${gathered.id}]. Use it; do not read it again.`,
        importance: 0.9,
        ttlTurns: 1,
      });
      if (reloaded) {
        // Reloading the text the model was blocked on is real progress: without
        // this the idle guard counts the turn that unblocked it against it.
        this._progressThisTurn = true;
        await this._persistContextGraph();
      }
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    this._actionSignatures.add(signature);
    this.emit("action-start", { turn, action, description: describeAction(action) });
    let output = "";
    let status = "executed";
    try {
      // Truncate exactly once, with the marker intact: the context graph is what
      // demotes long output now, and a second blind slice used to cut off the
      // "[output truncated]" notice — leaving the model to believe it had seen the
      // whole file (observed live 2026-07-25: it invented a placeholder value).
      output = await executeReadonly({ action, cwd: this.cwd, maxOutputChars: MAX_READONLY_OUTPUT_CHARS });
    } catch (error) {
      status = "failed";
      output = error instanceof Error ? error.message : String(error);
    }
    if (status === "executed") {
      this._progressThisTurn = true;
    }
    const result = { turn, action: { type: action.type, path: action.path, term: action.term }, status, output };
    this.emit("action-result", result);
    this._remember({
      layer: "evidence",
      label: describeAction(action),
      text: `${describeAction(action)} ->\n${output}`,
      importance: status === "failed" ? 0.85 : 0.7,
      kind: "readonly",
    });
    await this._appendTranscript({ kind: "readonly", ...result });
  }

  async _handleResearch({ action, turn }) {
    const signature = `${action.type}:${action.query}`;
    if (this._webResearchCount >= this.maxWebResearchActions) {
      const result = {
        turn,
        action: { type: action.type, query: action.query, maxResults: action.maxResults },
        status: "skipped-budget",
        error: `web research limit reached (${this.maxWebResearchActions})`,
      };
      this.emit("action-result", result);
      this._remember({
        layer: "contract",
        label: "research budget",
        text: `${describeAction(action)} -> skipped-budget: research limit reached. Your next turn MUST implement with write_file/edit_file or finish; do not request web_research again.`,
        importance: 1,
        ttlTurns: 2,
      });
      // A policy response should receive a follow-up turn without being treated
      // as an idle duplicate. The session turn cap still prevents a loop.
      this._progressThisTurn = true;
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    if (this._actionSignatures.has(signature)) {
      const result = {
        turn,
        action: { type: action.type, query: action.query },
        status: "duplicate",
      };
      this.emit("action-result", result);
      this._remember({
        layer: "contract",
        label: `duplicate ${describeAction(action)}`,
        text: `${describeAction(action)} -> already researched (skipped); use the existing results.`,
        importance: 0.8,
        ttlTurns: 1,
      });
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    this._actionSignatures.add(signature);
    this._webResearchCount += 1;
    this.emit("action-start", { turn, action, description: describeAction(action) });

    let output = "";
    let status = "executed";
    if (typeof this.webResearch !== "function") {
      status = "unavailable";
      output = JSON.stringify({
        query: action.query,
        results: [],
        error: "web research is not configured for this agent session",
      });
    } else {
      try {
        const report = await this.webResearch(action.query, { maxResults: action.maxResults });
        output =
          typeof report === "string"
            ? report
            : JSON.stringify(
                {
                  query: report?.query ?? action.query,
                  provider: report?.provider ?? null,
                  fetched_at: report?.fetchedAt ?? null,
                  results: Array.isArray(report?.results) ? report.results : [],
                },
                null,
                2,
              );
      } catch (error) {
        status = "failed";
        output = JSON.stringify({
          query: action.query,
          results: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (status === "executed") {
      this._progressThisTurn = true;
      this._webResearchCompleted = true;
    }
    const boundedOutput = String(output).slice(0, MAX_RESEARCH_OUTPUT_CHARS);
    const result = {
      turn,
      action: { type: action.type, query: action.query, maxResults: action.maxResults },
      status,
      output: boundedOutput,
    };
    this.emit("action-result", result);
    this._remember({
      layer: "evidence",
      label: `web_research "${action.query}"`,
      text: `${describeAction(action)} -> ${status}\n${boundedOutput}`,
      importance: 0.75,
      kind: "research",
    });
    await this._appendTranscript({ kind: "research", ...result });
  }

  async _handleVisualReview({ action, turn }) {
    // Reviewing the same target twice is only wasteful while nothing has
    // changed. "Look, fix, look again" is the whole point of this action, so
    // the edit count is part of the signature: after any applied write the same
    // page is reviewable again, and before one it is still deduped.
    const signature = `${action.type}:${action.path ?? action.url}:${action.focus ?? ""}:e${this.appliedEdits.length}`;
    if (this._actionSignatures.has(signature)) {
      const result = {
        turn,
        action: { type: action.type, path: action.path ?? null, url: action.url ?? null },
        status: "duplicate",
      };
      this.emit("action-result", result);
      this._remember({
        layer: "contract",
        label: `duplicate ${describeAction(action)}`,
        text: `${describeAction(action)} -> already reviewed (skipped); use the existing feedback.`,
        importance: 0.8,
        ttlTurns: 1,
      });
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    this._actionSignatures.add(signature);
    this.emit("action-start", { turn, action, description: describeAction(action) });

    let status = "executed";
    let output = "";
    if (typeof this.visionReview !== "function") {
      status = "unavailable";
      output = JSON.stringify({ error: "no vision-capable model is configured for this agent session" });
    } else {
      try {
        const result = await this.visionReview({
          path: action.path ?? null,
          absolutePath: action.path ? path.resolve(this.cwd, action.path) : null,
          url: action.url ?? null,
          focus: action.focus ?? null,
          sessionDeadline: this.sessionDeadline,
        });
        if (!result?.ok) {
          status = "failed";
          output = JSON.stringify({ error: result?.error ?? "visual review failed" });
        } else {
          output = JSON.stringify(result.response, null, 2);
        }
      } catch (error) {
        status = "failed";
        output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (status === "executed") {
      this._progressThisTurn = true;
    }
    const boundedOutput = String(output).slice(0, MAX_RESEARCH_OUTPUT_CHARS);
    const result = {
      turn,
      action: {
        type: action.type,
        path: action.path ?? null,
        url: action.url ?? null,
        focus: action.focus ?? null,
      },
      status,
      output: boundedOutput,
    };
    this.emit("action-result", result);
    this._remember({
      layer: "evidence",
      label: `visual_review ${action.path ?? action.url}`,
      text: `${describeAction(action)} -> ${status}\n${boundedOutput}`,
      importance: 0.8,
      kind: "visual",
    });
    await this._appendTranscript({ kind: "visual", ...result });
  }

  async _handleKnowledgeLookup({ action, turn }) {
    const signature = `${action.type}:${action.subject}`;
    if (this._actionSignatures.has(signature)) {
      const result = { turn, action: { type: action.type, subject: action.subject }, status: "duplicate" };
      this.emit("action-result", result);
      this._remember({
        layer: "contract",
        label: `duplicate ${describeAction(action)}`,
        text: `${describeAction(action)} -> already looked up (skipped); use the existing facts.`,
        importance: 0.8,
        ttlTurns: 1,
      });
      await this._appendTranscript({ kind: "action-result", ...result });
      return;
    }
    this._actionSignatures.add(signature);
    this.emit("action-start", { turn, action, description: describeAction(action) });

    let status = "executed";
    let output = "";
    if (typeof this.knowledgeLookup !== "function") {
      status = "unavailable";
      output = JSON.stringify({
        subject: action.subject,
        resolved: false,
        error: "no knowledge base is configured for this agent session",
      });
    } else {
      try {
        const result = await this.knowledgeLookup({
          subject: action.subject,
          sessionDeadline: this.sessionDeadline,
        });
        if (!result?.ok) {
          status = "failed";
          output = JSON.stringify({ error: result?.error ?? "knowledge lookup failed" });
        } else {
          output = JSON.stringify(result.response, null, 2);
        }
      } catch (error) {
        status = "failed";
        output = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (status === "executed") {
      this._progressThisTurn = true;
    }
    const boundedOutput = String(output).slice(0, MAX_RESEARCH_OUTPUT_CHARS);
    const result = {
      turn,
      action: { type: action.type, subject: action.subject },
      status,
      output: boundedOutput,
    };
    this.emit("action-result", result);
    this._remember({
      layer: "evidence",
      label: `knowledge_lookup "${action.subject}"`,
      text: `${describeAction(action)} -> ${status}\n${boundedOutput}`,
      importance: 0.75,
      kind: "knowledge",
    });
    await this._appendTranscript({ kind: "knowledge", ...result });
  }

  /**
   * Runs the full task loop and resolves with a result summary. Also emits a
   * `done` event with the same payload.
   */
  async submitTask(task, selectedFiles = []) {
    const responseFormat = this._buildResponseFormat();
    await this._ensureSessionDir();
    this._seedInvariants(task);
    await this._seedPinnedFiles(selectedFiles);
    await this._persist("session.json", {
      sessionId: this.sessionId,
      task,
      cwd: this.cwd,
      selectedFiles,
      model: this.model,
      modelSelection: this.modelSelection,
      reasoning: this.reasoning,
      startedAt: new Date().toISOString(),
    });
    for (const query of this.initialResearchQueries) {
      await this._handleResearch({
        turn: 0,
        action: {
          type: "web_research",
          query,
          maxResults: 5,
          reason: "preflight library research",
        },
      });
    }
    if (typeof this.validateWorkspace === "function") {
      await this._validateCurrentWorkspace({ task, turn: 0 });
    }

    let stopReason = "completed";
    let finalSummary = "";
    let turn = 0;
    let idleTurns = 0;
    let validationNoActionTurns = 0;

    for (turn = 1; turn <= this.maxTurns; turn += 1) {
      if (this.cancelled) {
        stopReason = "cancelled";
        break;
      }
      if (this._budgetExhausted()) {
        stopReason = "session-timeout";
        break;
      }

      // Age the graph one turn before rendering: fresh evidence outranks old
      // evidence at equal priority, without ever touching the invariant layers.
      this.context.decay({ turn });
      const turnData = await this._getTurn(task, responseFormat);
      this._noteTruncatedTurn(turn);
      finalSummary = turnData.summary ?? finalSummary;
      // Kept for the next turn's durable-memory seed: the model's own account of
      // what it is doing is the part of the run that actually moves.
      this._lastTurnSummary =
        typeof turnData.summary === "string" ? turnData.summary.slice(0, 600) : null;
      this.emit("status", {
        turn,
        summary: turnData.summary ?? "",
        summaryUpdates: Array.isArray(turnData.summary_updates) ? turnData.summary_updates : [],
      });
      await this._appendTranscript({ kind: "turn", turn, summary: turnData.summary, actions: turnData.actions });

      if (turnData._stopReason) {
        stopReason = turnData._stopReason;
        break;
      }

      // The model reshapes its own context first, so the ops it just requested
      // are in force for the actions of this same turn.
      const opsOutcome = await this._applyContextOps(turnData, turn);

      // Auto-resolve any repo-relative context the model still needs.
      if (turnData.needs_more_context && Array.isArray(turnData.missing_snippets) && turnData.missing_snippets.length) {
        const { resolved } = await resolveMissingSnippets({ snippets: turnData.missing_snippets, cwd: this.cwd });
        for (const entry of resolved) {
          const block = buildSnippetContextBlock([entry]);
          if (block) {
            this._remember({
              layer: "evidence",
              label: `requested ${entry.path}`,
              text: block,
              importance: 0.95,
              kind: "snippet",
            });
          }
        }
      }

      // Scan beyond the execution cap so invalid or same-path conflicting
      // proposals cannot crowd a later independent action out of the turn.
      // The scan itself stays bounded against oversized model arrays.
      const actions = Array.isArray(turnData.actions)
        ? turnData.actions.slice(
            0,
            this.maxActionsPerTurn * MAX_ACTION_SCAN_MULTIPLIER,
          )
        : [];
      // A declared context gap is handled before spending the turn: reform the
      // graph and re-prompt, so an imprecise context is repaired instead of
      // producing a guessed edit.
      if (turnData.context_sufficient === false && actions.length === 0) {
        const reformed = await this._reformContext(turnData, turn);
        if (reformed) {
          continue;
        }
      }
      let finished = false;
      this._progressThisTurn = false;
      const mutationPathsThisTurn = new Set();
      let executableActions = 0;
      for (const rawAction of actions) {
        if (this.cancelled || this._budgetExhausted()) {
          break;
        }
        const normalized = normalizeAgentAction(rawAction, this.cwd);
        if (!normalized.ok) {
          this.emit("action-result", { turn, action: rawAction, status: "invalid", error: normalized.error });
          this._remember({
            layer: "contract",
            label: `invalid action ${rawAction?.type ?? "?"}`,
            text: `invalid action (${rawAction?.type ?? "?"}) -> ${normalized.error}`,
            importance: 0.9,
            ttlTurns: 1,
          });
          continue;
        }
        const { action, category } = normalized;
        if (category === "finish") {
          finished = true;
          finalSummary = turnData.summary ?? finalSummary;
          break;
        }
        if (
          (action.type === "write_file" || action.type === "edit_file") &&
          mutationPathsThisTurn.has(action.path)
        ) {
          const result = {
            turn,
            action: { type: action.type, path: action.path },
            status: "conflicting-action",
            error: "multiple mutations target the same path in one turn",
          };
          this.emit("action-result", result);
          this._remember({
            layer: "contract",
            label: `conflict ${action.path}`,
            text: `${describeAction(action)} -> conflicting-action:${this._repairHint("conflicting-action", action)}`,
            importance: 0.9,
            ttlTurns: 1,
          });
          await this._appendTranscript({ kind: "action-result", ...result });
          continue;
        }
        if (executableActions >= this.maxActionsPerTurn) {
          break;
        }
        executableActions += 1;
        if (
          category === "mutating" &&
          this.requireWebResearch &&
          !this._webResearchCompleted
        ) {
          await this._handleResearchRequired({ action, turn });
          continue;
        }
        if (category === "readonly") {
          await this._handleReadonly({ action, turn });
        } else if (category === "research") {
          await this._handleResearch({ action, turn });
        } else if (category === "visual") {
          await this._handleVisualReview({ action, turn });
        } else if (category === "knowledge") {
          await this._handleKnowledgeLookup({ action, turn });
        } else if (action.type === "run_cmd") {
          await this._handleCommand({ action, turn });
        } else {
          await this._handleMutation({ action, turn, mutationPathsThisTurn });
        }
      }

      if (
        typeof this.validateWorkspace === "function" &&
        (finished || this._progressThisTurn) &&
        this.appliedEdits.some((entry) => entry.status === "written")
      ) {
        const validation = await this._validateCurrentWorkspace({ task, turn });
        if (validation.valid) {
          finished = true;
          finalSummary = validation.summary || finalSummary;
        } else {
          finished = false;
        }
      }

      if (finished) {
        stopReason = "completed";
        break;
      }
      // The turn did work but still reported an imprecise context: reform now so
      // the next prompt carries what the model said it was missing.
      if (turnData.context_sufficient === false && actions.length) {
        await this._reformContext(turnData, turn);
      }
      if (!actions.length) {
        // A turn that only reshaped the context did real work: the next prompt
        // carries different context, so give it one, up to the cap.
        if (opsOutcome?.applied?.length && this._contextOnlyTurns < this.maxContextOnlyTurns) {
          this._contextOnlyTurns += 1;
          this._remember({
            layer: "contract",
            label: "context-only turn",
            text: `Turn ${turn} only reshaped the context (${this._contextOnlyTurns}/${this.maxContextOnlyTurns} allowed). The context below is now reformed: emit concrete actions (read_file/search_text/write_file/edit_file) or finish next turn.`,
            importance: 1,
            ttlTurns: 1,
          });
          continue;
        }
        if (
          typeof this.validateWorkspace === "function" &&
          this._lastValidation &&
          !this._lastValidation.valid &&
          validationNoActionTurns < 1
        ) {
          validationNoActionTurns += 1;
          this._remember({
            layer: "contract",
            label: "no-action warning",
            text: "You emitted no actions while workspace validation still has issues. Your next turn MUST contain concrete write_file/edit_file fixes for the validation JSON.",
            importance: 1,
            ttlTurns: 1,
          });
          continue;
        }
        // Model produced no actionable steps; avoid spinning.
        stopReason = "no-actions";
        break;
      }
      validationNoActionTurns = 0;
      // If the model keeps re-proposing already-applied work (all no-ops), the
      // workspace is already in the desired state — finish cleanly rather than
      // burning the turn budget waiting for an explicit `finish`.
      if (this._progressThisTurn) {
        idleTurns = 0;
      } else if (this._consumeCorrectionGrace()) {
        // The loop handed the model a brand-new instruction this turn (split
        // this file up; your output was truncated). Counting the turn that
        // *delivered* it as idle lets the guard kill the run for not yet having
        // followed advice it has not had a turn to follow — which is what
        // happened live: the model answered the split instruction with the
        // right plan ("separate db, routes and views") and the session stopped
        // `no-progress` on that exact turn. The grace is one turn per distinct
        // instruction and capped, so a model that ignores the advice still
        // stops.
        this._log("[AgentSession] idle turn excused: new corrective instruction was just issued");
      } else {
        idleTurns += 1;
        if (idleTurns >= 2) {
          const hasWrittenEdit = this.appliedEdits.some((entry) => entry.status === "written");
          const validationAllowsCompletion =
            typeof this.validateWorkspace !== "function" || this._lastValidation?.valid === true;
          stopReason = hasWrittenEdit && validationAllowsCompletion ? "completed" : "no-progress";
          break;
        }
      }
    }

    if (turn > this.maxTurns) {
      stopReason = "max-turns";
    }

    if (this.contextEngine && typeof this.contextEngine.sync === "function") {
      try {
        await this.contextEngine.sync(this.context);
      } catch (error) {
        this._contextEngineFallbacks += 1;
        this._log(
          `[AgentSession] final context-engine sync failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    const contextEngineStats =
      this.contextEngine && typeof this.contextEngine.stats === "function"
        ? {
            ...this.contextEngine.stats(),
            selections: this._contextEngineSelections,
            sessionFallbacks: this._contextEngineFallbacks,
          }
        : {
            engine: "memory",
            selections: 0,
            sessionFallbacks: 0,
          };
    const result = {
      sessionId: this.sessionId,
      status: stopReason === "completed" ? "completed" : "stopped",
      stopReason,
      summary: finalSummary,
      turns: Math.min(turn, this.maxTurns),
      edits: this.appliedEdits,
      validation: this._lastValidation,
      model: {
        id: this.model,
        selection: this.modelSelection,
      },
      reasoning: {
        resolution: this.reasoning,
        requests: this.reasoningRequests,
      },
      context: {
        ...this.context.stats(),
        contextLength: this.contextLength,
        reforms: this._contextReforms,
        opsApplied: this._contextOpsApplied,
        opsRejected: this._contextOpsRejected,
        opsNoop: this._contextOpsNoop,
        contextOnlyTurns: this._contextOnlyTurns,
        references: {
          selections: this._contextReferenceSelections.length,
          selected:
            this._contextReferenceSelections.at(-1)?.selectedReferenceIds?.length ?? 0,
          fallbacks: this._contextReferenceSelections.filter((entry) => entry?.fallback)
            .length,
        },
        engine: contextEngineStats,
        localMemory: this._localMemoryStats(),
      },
    };
    await this._rememberSessionRecap(result);
    result.context.localMemory = this._localMemoryStats();
    await this._persistContextGraph();
    await this._persist("context-engine.json", contextEngineStats);
    await this._persist("result.json", { ...result, finishedAt: new Date().toISOString() });
    this.emit("done", result);
    return result;
  }

  _localMemoryStats() {
    if (!this.localMemory) {
      return { enabled: false };
    }
    const base =
      typeof this.localMemory.stats === "function" ? this.localMemory.stats() : {};
    return {
      enabled: true,
      ...base,
      queries: this._localMemoryQueries,
      candidatesServed: this._localMemoryCandidatesServed,
      remembered: this._localMemoryRemembered,
      lastError: this._localMemoryError,
    };
  }

  /**
   * Writes one durable record describing what this session actually concluded.
   * `result.json` already holds the same facts, but it is a per-session file no
   * later run reads; this record is what a *future* session recalls when it
   * asks "has this project done this before, and how did it end?".
   */
  async _rememberSessionRecap(result) {
    if (!this.localMemory || typeof this.localMemory.remember !== "function") {
      return;
    }
    const mission = this._missionNodeId ? this.context.nodes.get(this._missionNodeId) : null;
    // An applied-edit entry carries its path under `action`, not at the top
    // level; reading only `edit.path` silently produced an empty file list in
    // every recap ever written.
    const files = [
      ...new Set(
        (Array.isArray(result.edits) ? result.edits : [])
          .filter((edit) => edit?.status === "written")
          .map((edit) => edit?.action?.path ?? edit?.path ?? edit?.file)
          .filter((value) => typeof value === "string" && value.trim()),
      ),
    ].slice(0, 24);
    // Only a one-line anchor of the task, never the whole thing. The mission is
    // supplied fresh on every run, so restating it in the recap is a long,
    // highly topical duplicate that outranks what the session actually
    // concluded — measured on this corpus, the restated task beat the recap's
    // own outcome sentences for "how did the previous session end?".
    const missionAnchor = mission?.text
      ? mission.text.split("\n").find((line) => line.trim())?.trim().slice(0, 160)
      : null;
    const lines = [
      missionAnchor ? `The task was: ${missionAnchor}` : null,
      result.summary ? `The session concluded: ${result.summary}` : null,
      `The run stopped with reason ${result.stopReason} after ${result.turns} turn(s).`,
      files.length ? `It changed these files: ${files.join(", ")}.` : null,
      result.validation?.ok === false && result.validation?.summary
        ? `Workspace validation failed with: ${result.validation.summary}`
        : null,
      result.validation?.ok === true ? "Workspace validation passed." : null,
    ].filter(Boolean);
    try {
      const record = await this.localMemory.remember({
        kind: "recap",
        title: `session ${this.sessionId}`,
        text: lines.join("\n"),
        tags: ["recap", "session", result.stopReason].filter(Boolean),
        source: `session:${this.sessionId}`,
        // A recap outranks an ordinary note: it is the only record that says
        // how an attempt actually ended.
        importance: 0.85,
      });
      if (record) {
        this._localMemoryRemembered += 1;
      }
    } catch (error) {
      this._localMemoryError = error instanceof Error ? error.message : String(error);
      this._log(`[AgentSession] local memory recap failed: ${this._localMemoryError}`);
    }
  }

  /**
   * Applies the model's context graph operations and feeds rejections back as
   * context, which is how the model learns the language across turns.
   */
  async _applyContextOps(turnData, turn) {
    const ops = Array.isArray(turnData?.context_ops) ? turnData.context_ops : [];
    if (!ops.length) {
      return null;
    }
    const outcome = this.context.applyOps(ops, { turn });
    this._contextOpsApplied += outcome.applied.length;
    this._contextOpsRejected += outcome.rejected.length;
    this._contextOpsNoop += outcome.noops.length;
    this.emit("context-ops", { turn, ...outcome, stats: this.context.stats() });
    await this._appendTranscript({ kind: "context-ops", turn, ...outcome });
    const complaints = [
      ...outcome.rejected.map((entry) => `- ${entry.op}: ${entry.error}`),
      ...outcome.noops.map((entry) => `- ${entry.op} ${entry.node ?? ""}: ${entry.error}`),
    ];
    if (complaints.length) {
      // Without this feedback a local model re-sends the same reshaping every
      // turn and the loop stalls with nothing changing.
      this._remember({
        layer: "contract",
        label: "context ops not applied",
        text: `These context ops changed nothing:\n${complaints.join(
          "\n",
        )}\nUse only node ids shown in [brackets], and do not repeat an op MiniPhi reported as already applied.`,
        importance: 0.95,
        ttlTurns: 1,
      });
    }
    if (outcome.applied.length) {
      this._log(
        `[AgentSession] context ops applied: ${outcome.applied.map((entry) => entry.op).join(", ")}`,
      );
      await this._rememberAppliedNotes(outcome.applied);
      await this._persistContextGraph();
    }
    return outcome;
  }

  /**
   * A `note` op is the model saying "this is durable". Until now it was durable
   * only for the rest of the session — the graph JSON survived, but nothing
   * read it back on the next run. Every applied note is now also written to
   * `.miniphi/memory/`, which is what makes it recallable by a later session
   * (and on another machine, since that directory travels with the project).
   */
  async _rememberAppliedNotes(applied) {
    if (!this.localMemory || typeof this.localMemory.remember !== "function") {
      return;
    }
    for (const entry of applied) {
      if (entry?.op !== "note" || !entry.node) {
        continue;
      }
      const node = this.context.nodes.get(entry.node);
      if (!node?.text) {
        continue;
      }
      try {
        const record = await this.localMemory.remember({
          kind: node.layer === "plan" ? "decision" : "note",
          title: node.label || "model note",
          text: node.text,
          tags: ["model-note", node.layer].filter(Boolean),
          source: `session:${this.sessionId}`,
          importance: node.importance,
        });
        if (record) {
          this._localMemoryRemembered += 1;
        }
      } catch (error) {
        this._localMemoryError = error instanceof Error ? error.message : String(error);
        this._log(`[AgentSession] local memory write failed: ${this._localMemoryError}`);
      }
    }
  }

  /**
   * Reforms the graph around the gap the model reported. Bounded by
   * `maxContextReforms` so an unhelpful "still not enough" loop cannot spin.
   * Returns true when the caller should re-prompt with the reformed context.
   */
  async _reformContext(turnData, turn) {
    if (this._contextReforms >= this.maxContextReforms) {
      this._remember({
        layer: "contract",
        label: "reform budget",
        text: `Context reform budget exhausted (${this.maxContextReforms}). Work with the loaded context: gather what you need with read_file/list_dir/search_text, or finish and state what is missing.`,
        importance: 1,
      });
      return false;
    }
    this._contextReforms += 1;
    const gap = typeof turnData?.context_gap === "string" ? turnData.context_gap.trim() : "";
    const reform = this.context.reform({ gap, turn });
    this.emit("context-reform", {
      turn,
      gap,
      expanded: reform.expanded,
      reforms: this._contextReforms,
      stats: this.context.stats(),
    });
    await this._appendTranscript({ kind: "context-reform", turn, gap, expanded: reform.expanded });
    this._log(
      `[AgentSession] context reform ${this._contextReforms}/${this.maxContextReforms}${
        gap ? ` for gap "${gap.slice(0, 80)}"` : ""
      }: expanded ${reform.expanded.length} node(s)`,
    );
    await this._persistContextGraph();
    // A reform is real progress on the context, so it must not be scored as an
    // idle turn; the reform budget is what bounds the loop.
    this._progressThisTurn = true;
    return true;
  }

  _buildResponseFormat() {
    const schema = this.schemaRegistry.getSchema(AGENT_SCHEMA_ID);
    return schema ? buildJsonSchemaResponseFormat(schema.definition, AGENT_SCHEMA_ID) : null;
  }
}
