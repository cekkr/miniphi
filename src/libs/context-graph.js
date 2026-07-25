/**
 * Multi-layered context graph.
 *
 * LM Studio prompts are hard-capped by the *loaded* context length of the model
 * (JIT loads default to a small window on most hosts), so MiniPhi cannot keep
 * appending observations to one flat transcript. This module holds the context
 * as a graph of typed nodes that are selected per prompt against a token budget
 * using three independent axes:
 *
 *   - **priority**  — which layer the node belongs to (mission/contract are
 *     invariants and never dropped; scratch is the first thing to go).
 *   - **importance** — how much this specific node matters right now (0..1,
 *     decayed every turn, boosted by the model through context ops).
 *   - **subtask level** — how deep in the task tree the node was produced, so a
 *     "sub conversation" can be re-established from the mission + the ancestor
 *     spine + its own evidence without dragging in sibling branches.
 *
 * Nodes that do not fit the budget degrade instead of vanishing: first to their
 * digest, then to a one-line stub in a context index. Because every node keeps a
 * stable id, the model can ask for a stub back, pin what matters, or restructure
 * the graph through the *context graph language* (see {@link CONTEXT_OP_TYPES}).
 * That is the "reform the context" half of the design: when the current context
 * is not precise enough to finish a (sub)task, the model reshapes it rather than
 * failing or hallucinating.
 *
 * The module is pure (no I/O, no LM Studio calls) so it is deterministic and
 * unit-testable; persistence is the caller's job via {@link ContextGraph#toJSON}.
 */

/** Approximate tokens for a string (~4 chars/token, the usual GGUF ballpark). */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Context layers, ordered by priority (0 = highest). `retained` layers are the
 * invariants that make a sub-conversation resumable: they are never digested or
 * dropped, only hard-truncated as a last resort.
 */
export const CONTEXT_LAYERS = {
  mission: { priority: 0, title: "Mission", retained: true },
  contract: { priority: 1, title: "Contract", retained: true },
  plan: { priority: 2, title: "Plan", retained: false },
  subtask: { priority: 3, title: "Subtask", retained: false },
  evidence: { priority: 4, title: "Evidence", retained: false },
  scratch: { priority: 5, title: "Scratch", retained: false },
};

export const CONTEXT_LAYER_NAMES = Object.keys(CONTEXT_LAYERS);
const MAX_LAYER_PRIORITY = Math.max(...Object.values(CONTEXT_LAYERS).map((layer) => layer.priority));

/** Relations between context nodes; edges are advisory metadata for the model. */
export const CONTEXT_RELATIONS = new Set([
  "derived_from",
  "supports",
  "refines",
  "supersedes",
  "answers",
  "blocks",
  "child_of",
]);

/** The verbs of the context graph language. */
export const CONTEXT_OP_TYPES = [
  "pin",
  "unpin",
  "boost",
  "expand",
  "collapse",
  "drop",
  "note",
  "link",
  "open_subtask",
  "close_subtask",
  "focus",
];

/**
 * Operator-facing description of the context graph language, injected into
 * prompts so the model learns to reshape its own context.
 */
export const CONTEXT_LANGUAGE_GUIDE = `Context graph language (field "context_ops"):
Your context is a graph of layered nodes, each shown with a [id]. It is rendered
against a token budget, so low-priority nodes appear as digests or as one-line
stubs under "Context index". Reshape it instead of guessing:
  {"op":"expand","node":"c7"}            load a stub/digest in full (stays loaded
                                         until you collapse or drop it; if it does
                                         not fit you get the largest window that does)
  {"op":"expand","node":"c7","offset":4000}  page that window further into a long
                                         node, starting at the given character
  {"op":"pin","node":"c7"}               keep a node in every future prompt
  {"op":"boost","node":"c7","importance":0.9}  raise its selection priority
  {"op":"collapse","node":"c7","text":"3-line gist"}  replace it with your own digest
  {"op":"drop","node":"c7"}              discard a node you are done with
  {"op":"note","label":"decision","text":"chose Matter.js","layer":"plan"}  record a durable fact
  {"op":"link","from":"c7","to":"c2","relation":"supports"}
  {"op":"open_subtask","label":"add validation","text":"goal of this sub-task"}
  {"op":"close_subtask","text":"what the sub-task established"}
An open subtask scopes the evidence you gather; closing it collapses that
evidence into one summary so the parent conversation stays inside the budget.
Set "context_sufficient": false and describe the gap in "context_gap" when the
loaded context cannot answer the current step; MiniPhi then reforms the graph
and re-prompts you once.`;

const DEFAULT_BUDGET_TOKENS = 4000;
const DEFAULT_DECAY = 0.85;
const DEFAULT_MAX_NODES = 400;
const DEFAULT_DIGEST_CHARS = 320;
const DEFAULT_MAX_OPS = 12;
const MIN_BUDGET_TOKENS = 512;
// A single retained node may not eat more than this share of the budget.
const RETAINED_NODE_BUDGET_SHARE = 0.4;
// Smallest window worth sending for an explicitly expanded node that cannot fit.
const MIN_PARTIAL_TOKENS = 64;
// Retained layers bypass the budget, so their population is capped instead.
const MAX_RETAINED_NODES_PER_LAYER = 6;

/**
 * Derives the prompt token budget for context selection from the model's real
 * context window. `contextLength` should be the *loaded* context length reported
 * by LM Studio (`loaded_context_length`), not the model's theoretical maximum.
 */
export function deriveContextBudget({
  contextLength = null,
  reservedTokens = 0,
  reservedOutputTokens = 1024,
  safetyRatio = 0.85,
  minBudgetTokens = MIN_BUDGET_TOKENS,
  fallbackBudgetTokens = DEFAULT_BUDGET_TOKENS,
} = {}) {
  const window = Number(contextLength);
  if (!Number.isFinite(window) || window <= 0) {
    return Math.max(minBudgetTokens, Math.floor(fallbackBudgetTokens));
  }
  const ratio = Number.isFinite(safetyRatio) && safetyRatio > 0 && safetyRatio <= 1 ? safetyRatio : 0.85;
  const usable = Math.floor(window * ratio);
  const reserved = Math.max(0, Math.floor(reservedTokens)) + Math.max(0, Math.floor(reservedOutputTokens));
  return Math.max(minBudgetTokens, usable - reserved);
}

const clamp01 = (value, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, numeric));
};

/** Head-biased digest: keeps the opening of a block plus an omission marker. */
export function autoDigest(text, maxChars = DEFAULT_DIGEST_CHARS) {
  if (typeof text !== "string" || text.length <= maxChars) {
    return typeof text === "string" ? text : "";
  }
  const head = text.slice(0, maxChars);
  const cut = head.lastIndexOf("\n");
  const body = cut > maxChars * 0.5 ? head.slice(0, cut) : head;
  return `${body.trimEnd()}\n[digest: ${text.length - body.length} more chars available — expand to load]`;
}

export default class ContextGraph {
  constructor(options = undefined) {
    this.budgetTokens = Number.isFinite(options?.budgetTokens) && options.budgetTokens > 0
      ? Math.floor(options.budgetTokens)
      : DEFAULT_BUDGET_TOKENS;
    this.decayFactor = Number.isFinite(options?.decayFactor) ? options.decayFactor : DEFAULT_DECAY;
    this.maxNodes = Number.isFinite(options?.maxNodes) && options.maxNodes > 0
      ? Math.floor(options.maxNodes)
      : DEFAULT_MAX_NODES;
    this.digestChars = Number.isFinite(options?.digestChars) && options.digestChars > 0
      ? Math.floor(options.digestChars)
      : DEFAULT_DIGEST_CHARS;
    this.maxOpsPerTurn = Number.isFinite(options?.maxOpsPerTurn) && options.maxOpsPerTurn > 0
      ? Math.floor(options.maxOpsPerTurn)
      : DEFAULT_MAX_OPS;

    this.nodes = new Map();
    this.edges = [];
    this.revision = 0;
    this.turn = 0;
    this._nodeSeq = 0;
    this._subtaskSeq = 0;
    this._subtaskStack = [];
  }

  // ---------------------------------------------------------------- structure

  get focusId() {
    return this._subtaskStack.length ? this._subtaskStack[this._subtaskStack.length - 1] : null;
  }

  get level() {
    return this._subtaskStack.length;
  }

  /** Ids of the focus subtask and all its ancestors (root-first). */
  focusPath(focusId = undefined) {
    const start = focusId === undefined ? this.focusId : focusId;
    const path = [];
    let cursor = start;
    while (cursor && this.nodes.has(cursor) && !path.includes(cursor)) {
      path.unshift(cursor);
      cursor = this.nodes.get(cursor).parentSubtaskId ?? null;
    }
    return path;
  }

  get(id) {
    return this.nodes.get(id) ?? null;
  }

  /**
   * Adds a node. `layer` decides the default priority; `importance` (0..1) and
   * the owning subtask decide how it competes for budget inside that layer.
   */
  add(spec = {}) {
    const layer = CONTEXT_LAYERS[spec.layer] ? spec.layer : "evidence";
    const text = typeof spec.text === "string" ? spec.text : "";
    const id = typeof spec.id === "string" && spec.id.trim() && !this.nodes.has(spec.id.trim())
      ? spec.id.trim()
      : this._nextNodeId();
    const subtaskId = spec.subtaskId !== undefined ? spec.subtaskId : this.focusId;
    const node = {
      id,
      layer,
      label: typeof spec.label === "string" && spec.label.trim() ? spec.label.trim() : layer,
      text,
      digest: typeof spec.digest === "string" && spec.digest ? spec.digest : null,
      priority: Number.isFinite(spec.priority) ? Math.floor(spec.priority) : CONTEXT_LAYERS[layer].priority,
      importance: clamp01(spec.importance, layer === "evidence" ? 0.6 : 0.8),
      pinned: Boolean(spec.pinned),
      state: "active",
      level: Number.isFinite(spec.level) ? Math.floor(spec.level) : this.focusPath(subtaskId).length,
      subtaskId: subtaskId ?? null,
      parentSubtaskId: spec.parentSubtaskId ?? null,
      kind: typeof spec.kind === "string" ? spec.kind : null,
      source: typeof spec.source === "string" ? spec.source : "runtime",
      turn: Number.isFinite(spec.turn) ? Math.floor(spec.turn) : this.turn,
      // Corrective feedback ("you repeated that", "that was not JSON") must be
      // impossible to demote in the turn it applies to, but must not accumulate
      // forever either: a TTL expires it once it has had its turn.
      ttlTurns: Number.isFinite(spec.ttlTurns) && spec.ttlTurns > 0 ? Math.floor(spec.ttlTurns) : null,
      tokens: estimateTokens(text),
      expandRequested: false,
      expandOffset: 0,
    };
    this.nodes.set(node.id, node);
    this.revision += 1;
    this._enforceRetainedCap(node);
    this._enforceNodeCap();
    return node;
  }

  /** Replaces a node's text/metadata in place (used for mutable contract lines). */
  update(id, patch = {}) {
    const node = this.nodes.get(id);
    if (!node) {
      return null;
    }
    if (typeof patch.text === "string") {
      node.text = patch.text;
      node.tokens = estimateTokens(patch.text);
      node.state = "active";
    }
    if (typeof patch.label === "string" && patch.label.trim()) {
      node.label = patch.label.trim();
    }
    if (patch.importance !== undefined) {
      node.importance = clamp01(patch.importance, node.importance);
    }
    if (patch.pinned !== undefined) {
      node.pinned = Boolean(patch.pinned);
    }
    if (typeof patch.digest === "string") {
      node.digest = patch.digest;
    }
    if (typeof patch.state === "string") {
      node.state = patch.state;
    }
    if (Number.isFinite(patch.turn)) {
      node.turn = Math.floor(patch.turn);
    }
    this.revision += 1;
    return node;
  }

  link(fromId, toId, relation = "supports") {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId) || fromId === toId) {
      return null;
    }
    const rel = CONTEXT_RELATIONS.has(relation) ? relation : "supports";
    const existing = this.edges.find(
      (edge) => edge.from === fromId && edge.to === toId && edge.relation === rel,
    );
    if (existing) {
      return existing;
    }
    const edge = { from: fromId, to: toId, relation: rel };
    this.edges.push(edge);
    this.revision += 1;
    return edge;
  }

  /** Opens a sub-conversation: later nodes attach to it until it is closed. */
  openSubtask({ label, text = "", importance = 0.9, turn = undefined } = {}) {
    const parentSubtaskId = this.focusId;
    const id = this._nextSubtaskId();
    const node = this.add({
      id,
      layer: "subtask",
      label: typeof label === "string" && label.trim() ? label.trim() : `subtask ${id}`,
      text,
      importance,
      subtaskId: parentSubtaskId,
      parentSubtaskId,
      level: this._subtaskStack.length,
      kind: "subtask",
      turn,
    });
    // A subtask owns itself so its own goal travels with its evidence.
    node.subtaskId = id;
    this._subtaskStack.push(id);
    return node;
  }

  /**
   * Closes a sub-conversation and collapses everything it produced into one
   * summary node at the parent level, which is exactly what a later prompt needs
   * to continue the parent conversation.
   */
  closeSubtask({ id = undefined, text = "", turn = undefined } = {}) {
    const targetId = id && this.nodes.has(id) ? id : this.focusId;
    if (!targetId) {
      return null;
    }
    const subtask = this.nodes.get(targetId);
    // Only a subtask can be closed: closing an evidence node would digest it and
    // invent an outcome for work that was never scoped.
    if (subtask?.kind !== "subtask") {
      return null;
    }
    const children = [...this.nodes.values()].filter(
      (node) => node.subtaskId === targetId && node.id !== targetId && node.state !== "dropped",
    );
    for (const child of children) {
      if (child.pinned) {
        continue;
      }
      child.state = "digested";
      child.digest = child.digest ?? autoDigest(child.text, Math.floor(this.digestChars / 2));
      child.importance = clamp01(child.importance * 0.5, 0.2);
    }
    const parentSubtaskId = subtask?.parentSubtaskId ?? null;
    const summaryText = typeof text === "string" && text.trim()
      ? text.trim()
      : `Closed subtask "${subtask?.label ?? targetId}" after ${children.length} context node(s).`;
    subtask.state = "digested";
    subtask.digest = autoDigest(subtask.text, Math.floor(this.digestChars / 2));
    const summary = this.add({
      layer: "plan",
      label: `outcome: ${subtask?.label ?? targetId}`,
      text: summaryText,
      importance: 0.85,
      subtaskId: parentSubtaskId,
      level: Math.max(0, (subtask?.level ?? 1)),
      kind: "subtask-outcome",
      turn,
    });
    this.link(summary.id, targetId, "derived_from");
    const index = this._subtaskStack.indexOf(targetId);
    if (index >= 0) {
      this._subtaskStack = this._subtaskStack.slice(0, index);
    }
    return summary;
  }

  /**
   * Per-turn maintenance: expire TTL nodes that have had their turn and decay
   * importance so old evidence loses ground to new evidence.
   */
  decay({ factor = undefined, turn = undefined } = {}) {
    const ratio = Number.isFinite(factor) ? factor : this.decayFactor;
    if (Number.isFinite(turn)) {
      this.turn = Math.floor(turn);
    }
    for (const node of this.nodes.values()) {
      if (node.ttlTurns && !node.pinned && this.turn - node.turn > node.ttlTurns) {
        this.nodes.delete(node.id);
        continue;
      }
      if (node.pinned || CONTEXT_LAYERS[node.layer]?.retained) {
        continue;
      }
      node.importance = clamp01(node.importance * ratio, node.importance);
    }
    this.edges = this.edges.filter((edge) => this.nodes.has(edge.from) && this.nodes.has(edge.to));
    this.revision += 1;
  }

  // ---------------------------------------------------------------- selection

  /**
   * Scores a node for the current focus. Layer priority dominates, then
   * importance, then recency, then how close the node is to the focused subtask.
   */
  scoreNode(node, { focusId = undefined, focusPath = null } = {}) {
    if (node.state === "dropped") {
      return -Infinity;
    }
    const spine = focusPath ?? this.focusPath(focusId);
    let score = (MAX_LAYER_PRIORITY - node.priority) * 10;
    score += node.importance * 6;
    const age = Math.max(0, this.turn - node.turn);
    score += Math.max(0, 3 - age * 0.5);
    if (node.subtaskId === null) {
      score += 1; // root-level context is relevant to every sub-conversation
    } else if (node.subtaskId === (focusId === undefined ? this.focusId : focusId)) {
      score += 5;
    } else if (spine.includes(node.subtaskId) || spine.includes(node.id)) {
      score += 3;
    } else {
      score -= 2; // sibling / closed branch
    }
    if (node.expandRequested) {
      score += 8; // the model explicitly asked for this back
    }
    if (node.pinned) {
      score += 1000;
    }
    return score;
  }

  /**
   * Selects nodes for one prompt. Retained layers always survive (hard-truncated
   * if pathologically large); everything else is included in full, demoted to a
   * digest, or reduced to a stub the model can request back by id.
   */
  select({ budgetTokens = undefined, focusId = undefined } = {}) {
    const budget = Number.isFinite(budgetTokens) && budgetTokens > 0
      ? Math.floor(budgetTokens)
      : this.budgetTokens;
    const focus = focusId === undefined ? this.focusId : focusId;
    const focusPath = this.focusPath(focus);
    const candidates = [...this.nodes.values()]
      .filter((node) => node.state !== "dropped")
      .map((node) => ({ node, score: this.scoreNode(node, { focusId: focus, focusPath }) }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.node.turn !== b.node.turn) {
          return a.node.turn - b.node.turn;
        }
        return a.node.id.localeCompare(b.node.id);
      });

    const included = [];
    const digested = [];
    const stubs = [];
    let used = 0;

    for (const { node, score } of candidates) {
      const retained = CONTEXT_LAYERS[node.layer]?.retained || node.pinned;
      const wantsFull = node.state === "active" || node.expandRequested;
      const fullTokens = node.tokens;

      if (retained) {
        const cap = Math.max(64, Math.floor(budget * RETAINED_NODE_BUDGET_SHARE));
        const text = fullTokens > cap
          ? `${node.text.slice(0, cap * 4)}\n[truncated: retained node exceeded its budget share]`
          : node.text;
        const tokens = estimateTokens(text);
        used += tokens;
        included.push({ node, text, tokens, score, form: fullTokens > cap ? "truncated" : "full" });
        continue;
      }

      const digestText = node.digest ?? autoDigest(node.text, this.digestChars);
      const digestTokens = estimateTokens(digestText);

      if (wantsFull && used + fullTokens <= budget) {
        used += fullTokens;
        included.push({ node, text: node.text, tokens: fullTokens, score, form: "full" });
        continue;
      }
      // An explicit `expand` must always yield more than the default digest, so
      // a node the model asked for takes whatever budget is left as a window
      // instead of silently staying collapsed. `expandOffset` pages that window
      // through the node so content past the head stays reachable.
      if (node.expandRequested) {
        const remaining = budget - used;
        if (remaining >= MIN_PARTIAL_TOKENS) {
          const start = Math.min(Math.max(0, node.expandOffset ?? 0), Math.max(0, node.text.length - 1));
          const slice = node.text.slice(start, start + remaining * 4 - 120);
          const after = node.text.length - (start + slice.length);
          const header = start > 0 ? `[window from char ${start} of ${node.text.length}]\n` : "";
          const footer = after > 0
            ? `\n[window: ${after} more chars after char ${start + slice.length}; re-expand with a higher "offset", or collapse/drop other nodes to load more]`
            : "";
          const text = `${header}${slice}${footer}`;
          const tokens = estimateTokens(text);
          used += tokens;
          included.push({ node, text, tokens, score, form: "partial" });
          continue;
        }
      }
      if (used + digestTokens <= budget && digestTokens < fullTokens) {
        used += digestTokens;
        const entry = { node, text: digestText, tokens: digestTokens, score, form: "digest" };
        included.push(entry);
        digested.push(entry);
        continue;
      }
      if (!wantsFull && used + fullTokens <= budget) {
        // A short node that was collapsed earlier still fits verbatim.
        used += fullTokens;
        included.push({ node, text: node.text, tokens: fullTokens, score, form: "full" });
        continue;
      }
      stubs.push({ node, score, tokens: fullTokens });
    }

    return {
      budgetTokens: budget,
      usedTokens: used,
      focusId: focus,
      focusPath,
      included,
      digested,
      stubs,
    };
  }

  /** Renders a selection as the prompt context block. */
  render({ budgetTokens = undefined, focusId = undefined, selection = null } = {}) {
    const picked = selection ?? this.select({ budgetTokens, focusId });
    const focusNode = picked.focusId ? this.nodes.get(picked.focusId) : null;
    const lines = [
      `## Context (revision ${this.revision} | budget ${picked.budgetTokens} tokens | used ~${picked.usedTokens}${
        focusNode ? ` | focus [${focusNode.id}] ${focusNode.label} (subtask level ${focusNode.level})` : " | focus: root task"
      })`,
    ];

    for (const layerName of CONTEXT_LAYER_NAMES) {
      const entries = picked.included
        .filter((entry) => entry.node.layer === layerName)
        .sort((a, b) => (a.node.turn === b.node.turn
          ? a.node.id.localeCompare(b.node.id)
          : a.node.turn - b.node.turn));
      if (!entries.length) {
        continue;
      }
      lines.push(`### ${CONTEXT_LAYERS[layerName].title}`);
      for (const entry of entries) {
        const flags = [
          `L${entry.node.level}`,
          entry.node.pinned ? "pinned" : null,
          entry.form === "digest" ? "digest" : null,
          entry.form === "partial" ? "window" : null,
          entry.form === "truncated" ? "truncated" : null,
        ].filter(Boolean);
        lines.push(`[${entry.node.id}] ${entry.node.label} (${flags.join(", ")})`);
        if (entry.text) {
          lines.push(entry.text.trimEnd());
        }
      }
    }

    if (picked.stubs.length) {
      lines.push('### Context index (not loaded — request with {"op":"expand","node":"<id>"})');
      for (const stub of picked.stubs) {
        lines.push(
          `- [${stub.node.id}] ${stub.node.label} (${stub.node.layer}, L${stub.node.level}, ~${stub.tokens} tokens)`,
        );
      }
    }
    if (picked.digested.length || picked.stubs.length) {
      lines.push(
        `Context pressure: ${picked.digested.length} node(s) digested, ${picked.stubs.length} unloaded. Expand what the current step needs.`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Builds the minimal context needed to (re)enter a sub-conversation: mission
   * and contract invariants, the ancestor spine, and the subtask's own nodes.
   * Everything else is excluded, not merely deprioritized.
   */
  buildSubConversation(subtaskId, { budgetTokens = undefined } = {}) {
    const spine = this.focusPath(subtaskId);
    const keep = new Set(spine);
    const relevant = [...this.nodes.values()].filter((node) => {
      if (node.state === "dropped") {
        return false;
      }
      if (CONTEXT_LAYERS[node.layer]?.retained || node.pinned) {
        return true;
      }
      return keep.has(node.subtaskId) || keep.has(node.id) || node.subtaskId === null;
    });
    const scoped = new ContextGraph({
      budgetTokens: Number.isFinite(budgetTokens) ? budgetTokens : this.budgetTokens,
      digestChars: this.digestChars,
    });
    scoped.turn = this.turn;
    for (const node of relevant) {
      scoped.nodes.set(node.id, { ...node });
    }
    scoped.edges = this.edges.filter((edge) => scoped.nodes.has(edge.from) && scoped.nodes.has(edge.to));
    scoped._subtaskStack = spine.filter((id) => scoped.nodes.has(id));
    scoped.revision = this.revision;
    return scoped;
  }

  // ------------------------------------------------------- graph "language"

  /**
   * Applies model-authored context operations. Every op is validated and
   * reported so telemetry can show what the model did to its own context.
   * Unknown ops are `rejected`; ops that would change nothing are reported as
   * `noops` so the caller can tell the model to move on instead of re-sending
   * the same reshaping every turn (observed live with gpt-oss-20b, 2026-07-25).
   */
  applyOps(ops, { turn = undefined } = {}) {
    const list = Array.isArray(ops) ? ops.slice(0, this.maxOpsPerTurn) : [];
    const applied = [];
    const rejected = [];
    const noops = [];
    const overflow = Array.isArray(ops) ? Math.max(0, ops.length - list.length) : 0;
    if (overflow) {
      rejected.push({ op: "(overflow)", error: `only ${this.maxOpsPerTurn} context ops per turn are applied` });
    }
    for (const raw of list) {
      const outcome = this._applyOp(raw, { turn });
      if (outcome.noop) {
        noops.push({ op: outcome.op, node: outcome.nodeId ?? null, error: outcome.error });
      } else if (outcome.ok) {
        applied.push({ op: outcome.op, node: outcome.nodeId ?? null, detail: outcome.detail ?? null });
      } else {
        rejected.push({ op: raw?.op ?? "(missing)", error: outcome.error });
      }
    }
    if (applied.length) {
      this.revision += 1;
    }
    return { applied, rejected, noops };
  }

  _applyOp(raw, { turn }) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "op is not an object" };
    }
    const op = typeof raw.op === "string" ? raw.op.trim() : "";
    if (!CONTEXT_OP_TYPES.includes(op)) {
      return { ok: false, error: `unknown context op "${op || "(empty)"}"` };
    }
    const nodeId = typeof raw.node === "string" ? raw.node.trim() : "";
    const needsNode = ["pin", "unpin", "boost", "expand", "collapse", "drop", "focus"].includes(op);
    const node = nodeId ? this.nodes.get(nodeId) : null;
    if (needsNode && !node) {
      return { ok: false, error: `node "${nodeId || "(missing)"}" not found` };
    }

    switch (op) {
      case "pin":
        if (node.pinned) {
          return { ok: false, noop: true, op, nodeId: node.id, error: `node "${node.id}" is already pinned` };
        }
        node.pinned = true;
        node.state = node.state === "dropped" ? "active" : node.state;
        return { ok: true, op, nodeId: node.id };
      case "unpin":
        if (!node.pinned) {
          return { ok: false, noop: true, op, nodeId: node.id, error: `node "${node.id}" is not pinned` };
        }
        node.pinned = false;
        return { ok: true, op, nodeId: node.id };
      case "boost": {
        const next = clamp01(raw.importance, Math.min(1, node.importance + 0.2));
        if (next <= node.importance) {
          return {
            ok: false,
            noop: true,
            op,
            nodeId: node.id,
            error: `node "${node.id}" importance is already ${node.importance.toFixed(2)}`,
          };
        }
        node.importance = next;
        return { ok: true, op, nodeId: node.id, detail: `importance=${node.importance.toFixed(2)}` };
      }
      case "expand": {
        const offset = Number.isFinite(raw.offset) && raw.offset > 0 ? Math.floor(raw.offset) : 0;
        // Re-expanding at a new offset pages the window through a long node; only
        // a repeat at the same offset is a no-op.
        if (node.expandRequested && offset === (node.expandOffset ?? 0)) {
          return {
            ok: false,
            noop: true,
            op,
            nodeId: node.id,
            error: `node "${node.id}" is already expanded at offset ${offset} (loaded as far as the budget allows); use it, page further with a higher "offset", or collapse/drop another node to make room`,
          };
        }
        if (offset >= node.text.length) {
          return {
            ok: false,
            op,
            nodeId: node.id,
            error: `offset ${offset} is past the end of node "${node.id}" (${node.text.length} chars)`,
          };
        }
        node.expandRequested = true;
        node.expandOffset = offset;
        node.state = "active";
        node.importance = clamp01(Math.max(node.importance, 0.9), 0.9);
        return { ok: true, op, nodeId: node.id, detail: offset ? `offset=${offset}` : null };
      }
      case "collapse": {
        const digest = typeof raw.text === "string" && raw.text.trim()
          ? raw.text.trim()
          : autoDigest(node.text, this.digestChars);
        if (node.state === "digested" && node.digest === digest && !node.expandRequested) {
          return { ok: false, noop: true, op, nodeId: node.id, error: `node "${node.id}" is already collapsed` };
        }
        node.digest = digest;
        node.state = "digested";
        node.expandRequested = false;
        return { ok: true, op, nodeId: node.id };
      }
      case "drop":
        if (CONTEXT_LAYERS[node.layer]?.retained) {
          return { ok: false, error: `layer "${node.layer}" is retained and cannot be dropped` };
        }
        if (node.state === "dropped") {
          return { ok: false, noop: true, op, nodeId: node.id, error: `node "${node.id}" is already dropped` };
        }
        node.state = "dropped";
        node.pinned = false;
        return { ok: true, op, nodeId: node.id };
      case "note": {
        const text = typeof raw.text === "string" ? raw.text.trim() : "";
        if (!text) {
          return { ok: false, error: "note requires text" };
        }
        const layer = CONTEXT_LAYERS[raw.layer] && raw.layer !== "mission" && raw.layer !== "contract"
          ? raw.layer
          : "plan";
        const created = this.add({
          layer,
          label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : "model note",
          text,
          importance: raw.importance !== undefined ? clamp01(raw.importance, 0.8) : 0.8,
          kind: "model-note",
          source: "model",
          turn,
        });
        return { ok: true, op, nodeId: created.id };
      }
      case "link": {
        const edge = this.link(
          typeof raw.from === "string" ? raw.from.trim() : "",
          typeof raw.to === "string" ? raw.to.trim() : "",
          typeof raw.relation === "string" ? raw.relation.trim() : "supports",
        );
        if (!edge) {
          return { ok: false, error: "link requires two existing distinct node ids" };
        }
        return { ok: true, op, nodeId: edge.from, detail: `${edge.relation} -> ${edge.to}` };
      }
      case "open_subtask": {
        const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
        if (!label) {
          return { ok: false, error: "open_subtask requires a label" };
        }
        const created = this.openSubtask({
          label,
          text: typeof raw.text === "string" ? raw.text.trim() : "",
          turn,
        });
        return { ok: true, op, nodeId: created.id, detail: `level ${created.level + 1}` };
      }
      case "close_subtask": {
        if (!this.focusId && !nodeId) {
          return { ok: false, error: "no open subtask to close" };
        }
        const summary = this.closeSubtask({
          id: nodeId || undefined,
          text: typeof raw.text === "string" ? raw.text : "",
          turn,
        });
        if (!summary) {
          return {
            ok: false,
            error: nodeId ? `node "${nodeId}" is not an open subtask` : "no open subtask to close",
          };
        }
        return { ok: true, op, nodeId: summary.id };
      }
      case "focus": {
        if (node.kind !== "subtask") {
          return { ok: false, error: `node "${node.id}" is not a subtask` };
        }
        if (this.focusId === node.id) {
          return { ok: false, noop: true, op, nodeId: node.id, error: `node "${node.id}" is already the focus` };
        }
        this._subtaskStack = this.focusPath(node.id);
        return { ok: true, op, nodeId: node.id };
      }
      default:
        return { ok: false, error: `unhandled context op "${op}"` };
    }
  }

  /**
   * Reforms the graph around a described gap: nodes whose label/text match the
   * gap terms are expanded and boosted so the next prompt carries them in full.
   * Deterministic keyword matching keeps this auditable — no extra model call.
   */
  reform({ gap = "", maxExpansions = 3, turn = undefined } = {}) {
    const terms = String(gap ?? "")
      .toLowerCase()
      .split(/[^a-z0-9._/$-]+/)
      .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
    const candidates = [...this.nodes.values()].filter(
      (node) => node.state !== "dropped" && !node.expandRequested,
    );
    const scored = candidates
      .map((node) => {
        const haystack = `${node.label} ${node.text}`.toLowerCase();
        const hits = terms.reduce((count, term) => (haystack.includes(term) ? count + 1 : count), 0);
        return { node, hits };
      })
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => (b.hits === a.hits ? a.node.id.localeCompare(b.node.id) : b.hits - a.hits))
      .slice(0, Math.max(1, maxExpansions));

    const expanded = [];
    for (const entry of scored) {
      entry.node.expandRequested = true;
      entry.node.state = "active";
      entry.node.importance = clamp01(Math.max(entry.node.importance, 0.9), 0.9);
      expanded.push(entry.node.id);
    }
    // The gap note is the point of the reform turn — the model must see which gap
    // it declared and what was expanded for it. In a droppable layer it would be
    // demoted to a stub under exactly the budget pressure that caused the gap, so
    // it is retained with a TTL instead.
    const note = this.add({
      layer: "contract",
      label: "context gap",
      text: gap
        ? `Reported context gap: ${gap}${expanded.length ? `\nExpanded for you: ${expanded.join(", ")} — use it now.` : "\nNo stored node matched; gather it with a read_file/search_text/web_research action."}`
        : "Context reported as insufficient without a stated gap. State the gap in `context_gap` or gather context with an action.",
      importance: 1,
      kind: "context-gap",
      ttlTurns: 1,
      turn,
    });
    this.revision += 1;
    return { expanded, noteId: note.id, terms };
  }

  // ----------------------------------------------------------------- reports

  stats() {
    const byLayer = {};
    let active = 0;
    let dropped = 0;
    let digestedNodes = 0;
    for (const node of this.nodes.values()) {
      byLayer[node.layer] = (byLayer[node.layer] ?? 0) + 1;
      if (node.state === "dropped") {
        dropped += 1;
      } else if (node.state === "digested") {
        digestedNodes += 1;
      } else {
        active += 1;
      }
    }
    return {
      revision: this.revision,
      turn: this.turn,
      nodes: this.nodes.size,
      active,
      digested: digestedNodes,
      dropped,
      pinned: [...this.nodes.values()].filter((node) => node.pinned).length,
      edges: this.edges.length,
      byLayer,
      budgetTokens: this.budgetTokens,
      focusId: this.focusId,
      level: this.level,
      openSubtasks: [...this._subtaskStack],
    };
  }

  toJSON() {
    return {
      budgetTokens: this.budgetTokens,
      decayFactor: this.decayFactor,
      digestChars: this.digestChars,
      revision: this.revision,
      turn: this.turn,
      nodeSeq: this._nodeSeq,
      subtaskSeq: this._subtaskSeq,
      subtaskStack: [...this._subtaskStack],
      nodes: [...this.nodes.values()].map((node) => ({ ...node })),
      edges: this.edges.map((edge) => ({ ...edge })),
    };
  }

  static fromJSON(data) {
    const graph = new ContextGraph({
      budgetTokens: data?.budgetTokens,
      decayFactor: data?.decayFactor,
      digestChars: data?.digestChars,
    });
    graph.revision = Number.isFinite(data?.revision) ? data.revision : 0;
    graph.turn = Number.isFinite(data?.turn) ? data.turn : 0;
    graph._nodeSeq = Number.isFinite(data?.nodeSeq) ? data.nodeSeq : 0;
    graph._subtaskSeq = Number.isFinite(data?.subtaskSeq) ? data.subtaskSeq : 0;
    for (const node of Array.isArray(data?.nodes) ? data.nodes : []) {
      if (node && typeof node.id === "string") {
        graph.nodes.set(node.id, { ...node, tokens: estimateTokens(node.text ?? "") });
      }
    }
    graph.edges = (Array.isArray(data?.edges) ? data.edges : []).filter(
      (edge) => edge && graph.nodes.has(edge.from) && graph.nodes.has(edge.to),
    );
    graph._subtaskStack = (Array.isArray(data?.subtaskStack) ? data.subtaskStack : []).filter((id) =>
      graph.nodes.has(id),
    );
    return graph;
  }

  // ----------------------------------------------------------------- private

  _nextNodeId() {
    do {
      this._nodeSeq += 1;
    } while (this.nodes.has(`c${this._nodeSeq}`));
    return `c${this._nodeSeq}`;
  }

  _nextSubtaskId() {
    do {
      this._subtaskSeq += 1;
    } while (this.nodes.has(`s${this._subtaskSeq}`));
    return `s${this._subtaskSeq}`;
  }

  /**
   * Retained layers bypass the budget, so their count must be bounded too: when
   * too many live at once the oldest expiring one is evicted, keeping the
   * standing policies and the newest corrections.
   */
  _enforceRetainedCap(added) {
    if (!CONTEXT_LAYERS[added?.layer]?.retained) {
      return;
    }
    const live = [...this.nodes.values()].filter(
      (node) => node.layer === added.layer && node.state !== "dropped",
    );
    if (live.length <= MAX_RETAINED_NODES_PER_LAYER) {
      return;
    }
    const evictable = live
      .filter((node) => !node.pinned && node.id !== added.id)
      .sort((a, b) => (a.turn === b.turn ? a.id.localeCompare(b.id) : a.turn - b.turn));
    // Prefer expiring corrections over standing rules.
    const victim = evictable.find((node) => node.ttlTurns) ?? evictable[0];
    if (victim) {
      this.nodes.delete(victim.id);
      this.edges = this.edges.filter((edge) => edge.from !== victim.id && edge.to !== victim.id);
    }
  }

  /** Hard cap on graph size: the weakest dropped/digested nodes are evicted. */
  _enforceNodeCap() {
    if (this.nodes.size <= this.maxNodes) {
      return;
    }
    const evictable = [...this.nodes.values()]
      .filter((node) => !node.pinned && !CONTEXT_LAYERS[node.layer]?.retained)
      .sort((a, b) => this.scoreNode(a) - this.scoreNode(b));
    let toRemove = this.nodes.size - this.maxNodes;
    for (const node of evictable) {
      if (toRemove <= 0) {
        break;
      }
      this.nodes.delete(node.id);
      toRemove -= 1;
    }
    this.edges = this.edges.filter((edge) => this.nodes.has(edge.from) && this.nodes.has(edge.to));
  }
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "need",
  "needs",
  "want",
  "have",
  "into",
  "more",
  "context",
  "file",
  "files",
  "please",
  "about",
  "which",
  "what",
  "how",
  "not",
  "enough",
]);
