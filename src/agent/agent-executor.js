import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { resolveWorkspacePath, executeReadonlyAction } from "../libs/plan-executor.js";
import { writeFileWithGuard } from "../libs/file-edit-guard.js";
import { summarizeDiff } from "../libs/recompose-utils.js";

const DEFAULT_MAX_OUTPUT_CHARS = 1500;

export const READONLY_ACTION_TYPES = new Set(["read_file", "list_dir", "search_text"]);
export const RESEARCH_ACTION_TYPES = new Set(["web_research"]);
export const MUTATING_ACTION_TYPES = new Set(["write_file", "edit_file", "run_cmd"]);
const KNOWN_ACTION_TYPES = new Set([
  ...READONLY_ACTION_TYPES,
  ...RESEARCH_ACTION_TYPES,
  ...MUTATING_ACTION_TYPES,
  "finish",
]);

const hashText = (text) => createHash("sha256").update(text ?? "", "utf8").digest("hex");

/**
 * Buckets an action type into the interaction category the session uses to
 * decide whether it runs automatically (readonly), needs operator approval
 * (mutating), or ends the loop (finish).
 */
export function classifyActionType(type) {
  if (READONLY_ACTION_TYPES.has(type)) {
    return "readonly";
  }
  if (RESEARCH_ACTION_TYPES.has(type)) {
    return "research";
  }
  if (MUTATING_ACTION_TYPES.has(type)) {
    return "mutating";
  }
  if (type === "finish") {
    return "finish";
  }
  return "unknown";
}

/** Short human-readable label for logs and UI rows. */
export function describeAction(action) {
  if (!action || typeof action !== "object") {
    return "(invalid action)";
  }
  const target = action.path ?? action.term ?? action.query ?? action.command ?? "";
  return `${action.type}${target ? ` ${target}` : ""}`.trim();
}

const normalizeDanger = (danger) => {
  const normalized = typeof danger === "string" ? danger.toLowerCase() : "";
  return normalized === "low" || normalized === "high" ? normalized : "mid";
};

/**
 * Validates a model-produced action and resolves any path against the workspace.
 * Returns `{ ok: true, action, category }` with a normalized action, or
 * `{ ok: false, error }`. This is the single gate between model JSON and any
 * side effect: absolute paths and `..` escapes are rejected via
 * {@link resolveWorkspacePath}.
 */
export function normalizeAgentAction(rawAction, cwd) {
  if (!rawAction || typeof rawAction !== "object") {
    return { ok: false, error: "action is not an object" };
  }
  const type = typeof rawAction.type === "string" ? rawAction.type.trim() : "";
  if (!KNOWN_ACTION_TYPES.has(type)) {
    return { ok: false, error: `unknown action type "${type || "(empty)"}"` };
  }
  const category = classifyActionType(type);
  const action = {
    type,
    reason: typeof rawAction.reason === "string" ? rawAction.reason.trim() : "",
    danger: normalizeDanger(rawAction.danger),
  };

  if (type === "finish") {
    return { ok: true, action, category };
  }

  if (type === "search_text") {
    const term = typeof rawAction.term === "string" ? rawAction.term.trim() : "";
    if (!term) {
      return { ok: false, error: "search_text requires a non-empty term" };
    }
    action.term = term;
    return { ok: true, action, category };
  }

  if (type === "web_research") {
    const query = typeof rawAction.query === "string" ? rawAction.query.trim() : "";
    if (!query) {
      return { ok: false, error: "web_research requires a non-empty query" };
    }
    const parsedMaxResults = Number(rawAction.max_results);
    action.query = query;
    action.maxResults = Number.isFinite(parsedMaxResults)
      ? Math.max(1, Math.min(10, Math.floor(parsedMaxResults)))
      : 5;
    return { ok: true, action, category };
  }

  if (type === "run_cmd") {
    const command = typeof rawAction.command === "string" ? rawAction.command.trim() : "";
    if (!command) {
      return { ok: false, error: "run_cmd requires a command" };
    }
    action.command = command;
    return { ok: true, action, category };
  }

  // The workspace root is a valid list target, but resolveWorkspacePath
  // intentionally returns null for paths that collapse to the root. Models also
  // write the root as "/" or "\" meaning "the workspace" (seen live with
  // gpt-oss-20b, 2026-07-25); those resolve to the sandbox root, not the disk root.
  const rootList =
    type === "list_dir" &&
    (rawAction.path === undefined ||
      rawAction.path === null ||
      rawAction.path === "." ||
      rawAction.path === "./" ||
      rawAction.path === "" ||
      rawAction.path === "/" ||
      rawAction.path === "\\" ||
      rawAction.path === "./.");
  // Remaining types (read_file/list_dir/write_file/edit_file) are path-scoped.
  const relPath = rootList ? "." : resolveWorkspacePath(rawAction.path, cwd);
  if (!relPath) {
    return {
      ok: false,
      error: `path "${rawAction.path ?? ""}" is empty, absolute, or escapes the workspace`,
    };
  }
  action.path = relPath;

  if (type === "write_file") {
    if (typeof rawAction.content !== "string") {
      return { ok: false, error: "write_file requires string content" };
    }
    action.content = rawAction.content;
    return { ok: true, action, category };
  }

  if (type === "edit_file") {
    const hasAnchor = typeof rawAction.anchor === "string" && rawAction.anchor.length > 0;
    const hasReplacement = typeof rawAction.replacement === "string";
    const hasContent = typeof rawAction.content === "string";
    if (hasAnchor && hasReplacement) {
      action.anchor = rawAction.anchor;
      action.replacement = rawAction.replacement;
    } else if (hasContent) {
      action.content = rawAction.content;
    } else {
      return {
        ok: false,
        error: "edit_file requires anchor+replacement or a full content replacement",
      };
    }
    if (typeof rawAction.expected_hash === "string" && rawAction.expected_hash) {
      action.expectedHash = rawAction.expected_hash;
    }
    return { ok: true, action, category };
  }

  // read_file / list_dir need only the resolved path.
  return { ok: true, action, category };
}

const readFileOrNull = async (absolute) => {
  try {
    return await fs.readFile(absolute, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

/**
 * Computes the concrete before/after content for a mutating file action without
 * writing anything, so the operator can review a diff before approving. Returns
 * `{ ok, proposal }` or `{ ok: false, status, error }` for problems the model
 * should be told about (missing file, anchor not found/ambiguous).
 */
export async function buildMutationProposal({ action, cwd }) {
  const absolute = path.resolve(cwd, action.path);
  const beforeContent = await readFileOrNull(absolute);

  let afterContent;
  if (action.type === "write_file") {
    afterContent = action.content;
  } else if (action.type === "edit_file") {
    if (beforeContent === null) {
      return { ok: false, status: "missing-file", error: `file not found: ${action.path}` };
    }
    if (typeof action.anchor === "string") {
      const occurrences = beforeContent.split(action.anchor).length - 1;
      if (occurrences === 0) {
        return { ok: false, status: "anchor-not-found", error: `anchor not found in ${action.path}` };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          status: "anchor-ambiguous",
          error: `anchor occurs ${occurrences} times in ${action.path}; make it unique`,
        };
      }
      afterContent = beforeContent.replace(action.anchor, action.replacement);
    } else {
      afterContent = action.content;
    }
  } else {
    return { ok: false, status: "unsupported", error: `not a file mutation: ${action.type}` };
  }

  const proposal = {
    type: action.type,
    path: action.path,
    danger: action.danger,
    reason: action.reason,
    beforeContent: beforeContent ?? "",
    afterContent: afterContent ?? "",
    isNewFile: beforeContent === null,
    // Guard the eventual write against changes between preview and commit.
    expectedHash: beforeContent === null ? null : hashText(beforeContent),
    diff: summarizeDiff(beforeContent ?? "", afterContent ?? ""),
  };
  return { ok: true, proposal };
}

/**
 * Applies a previously-built mutation proposal through the guarded writer so the
 * write is hash-verified with a rollback copy under `rollbackDir`. Returns the
 * {@link writeFileWithGuard} result (`written`/`unchanged`/`hash-mismatch`/`rollback`/`failed`).
 */
export async function commitMutation({ proposal, cwd, rollbackDir }) {
  const targetPath = path.resolve(cwd, proposal.path);
  return writeFileWithGuard({
    targetPath,
    content: proposal.afterContent,
    expectedHash: proposal.expectedHash ?? null,
    rollbackDir: rollbackDir ?? null,
    rollbackLabel: proposal.path,
    diffSummaryFn: summarizeDiff,
  });
}

/**
 * Runs a read-only action and returns its bounded text output. Delegates to the
 * shared plan-executor primitive so search/list/read stay identical to the
 * non-interactive flow.
 */
export async function executeReadonly({ action, cwd, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS }) {
  // The shared primitive keys file actions off `target`; our normalized actions
  // use `path`. Translate so read/list/search stay identical to the plan flow.
  const mapped =
    action.type === "search_text"
      ? { type: "search_text", term: action.term }
      : { type: action.type, target: action.path };
  return executeReadonlyAction(mapped, cwd, { maxOutputChars });
}

export { hashText };
