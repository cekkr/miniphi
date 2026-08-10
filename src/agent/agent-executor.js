import fs from "fs/promises";
import { existsSync } from "node:fs";
import path from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { resolveWorkspacePath, executeReadonlyAction } from "../libs/plan-executor.js";
import { writeFileWithGuard } from "../libs/file-edit-guard.js";
import { normalizeReviewUrl } from "../libs/vision-reviewer.js";
import { summarizeDiff } from "../libs/recompose-utils.js";

const DEFAULT_MAX_OUTPUT_CHARS = 1500;
// A line that is only a markdown fence, anywhere in proposed file content.
const FENCE_LINE = /^[ \t]*(?:```|~~~)/m;
// Directory segments whose contents are installed or generated, never authored.
const VENDORED_PATH = /(?:^|\/)(node_modules|\.git|vendor|dist|build|\.venv|__pycache__)(?:\/|$)/;

export const READONLY_ACTION_TYPES = new Set(["read_file", "list_dir", "search_text"]);
export const RESEARCH_ACTION_TYPES = new Set(["web_research"]);
export const VISUAL_ACTION_TYPES = new Set(["visual_review"]);
export const KNOWLEDGE_ACTION_TYPES = new Set(["knowledge_lookup"]);
// Read-only page tooling: structure "as written" and "as rendered"
// (page_inspect), and the vision region decomposition (page_understand).
export const PAGE_ACTION_TYPES = new Set(["page_inspect", "page_understand"]);
// Reverting is a mutation of the workspace like any other, so it goes through
// the same approval gate rather than being a privileged side channel.
export const MUTATING_ACTION_TYPES = new Set([
  "write_file",
  "edit_file",
  "run_cmd",
  "revert_changes",
]);
const KNOWN_ACTION_TYPES = new Set([
  ...READONLY_ACTION_TYPES,
  ...RESEARCH_ACTION_TYPES,
  ...VISUAL_ACTION_TYPES,
  ...KNOWLEDGE_ACTION_TYPES,
  ...PAGE_ACTION_TYPES,
  ...MUTATING_ACTION_TYPES,
  "finish",
]);

const hashText = (text) => createHash("sha256").update(text ?? "", "utf8").digest("hex");

/**
 * JSON gets the same pre-write gate JavaScript already had.
 *
 * The guard refused to write unparseable `.js` but happily wrote unparseable
 * `.json`, which is the more damaging of the two for an agent: a broken
 * `package.json` breaks `npm install`, the start script and every later turn,
 * and the model only learns about it from a downstream validator one step
 * removed from the edit that caused it. Observed three times in one run —
 * a raw newline inside a string, a trailing comma, and two concatenated
 * objects — each written to disk before anything complained.
 */
/**
 * Removes a trailing markdown fence and anything after it from proposed content.
 *
 * A model that finishes a file and then emits a fence — sometimes with the start
 * of its next JSON object trailing behind it — has produced content that is
 * unambiguously wrong at the end and entirely correct before it. Observed live:
 * a complete 70-line `db.js` ending
 * "export const getDbPath = () => DB_PATH;\n```}, { ", rejected wholesale for a
 * defect in its last four characters.
 *
 * Only a *trailing* fence is stripped, and only when nothing but a fence remains
 * afterwards. A fence in the middle of a file means something else entirely — a
 * truncated or interleaved response — and must still be rejected, because
 * salvaging that would silently write half a file.
 */
export function stripTrailingFence(content) {
  if (typeof content !== "string" || !content) {
    return { content, stripped: false };
  }
  const match = /\n[ \t]*(?:```|~~~)[^\n]*(?:\n[\s\S]{0,40})?$/.exec(content);
  if (!match) {
    return { content, stripped: false };
  }
  const trimmed = `${content.slice(0, match.index)}\n`;
  return FENCE_LINE.test(trimmed)
    ? { content, stripped: false }
    : { content: trimmed, stripped: true };
}

const validateJsonSyntax = (filePath, content) => {
  if (path.extname(filePath).toLowerCase() !== ".json") {
    return null;
  }
  try {
    JSON.parse(content);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const fenceHint = FENCE_LINE.test(content)
      ? " The content also contains a markdown code fence line (``` or ~~~); `content` must be the raw file text only."
      : "";
    return `proposed ${filePath} is not valid JSON; no file was changed: ${detail}.${fenceHint} Common causes: a literal newline inside a string (escape it as \\n), a trailing comma before } or ], or text after the closing brace.`;
  }
};

const validateJavaScriptSyntax = (filePath, content) => {
  const extension = path.extname(filePath).toLowerCase();
  if (![".js", ".mjs", ".cjs"].includes(extension)) {
    return null;
  }
  const args =
    extension === ".cjs"
      ? ["--check"]
      : ["--input-type=module", "--check"];
  const checked = spawnSync(process.execPath, args, {
    input: content,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 256 * 1024,
  });
  if (!checked.error && checked.status === 0) {
    return null;
  }
  const detail = String(
    checked.stderr || checked.stdout || checked.error?.message || "syntax check failed",
  )
    .trim()
    .slice(0, 1200);
  // A markdown code fence inside `content` is one of the most common ways a
  // local model breaks a file, and the parser's report of it is useless: the
  // fence is not valid JavaScript, so the error surfaces as an unrelated
  // "Unexpected end of input" pointing at whatever line the fence landed on.
  // Naming it converts an unfixable message into a one-line fix.
  const fenceHint = FENCE_LINE.test(content)
    ? "\nThe content contains a markdown code fence line (``` or ~~~). `content` must be the raw file text only: no fences, no language tag, no surrounding prose. Remove the fence lines and re-send."
    : "";
  return `proposed ${filePath} has invalid JavaScript syntax; no file was changed:\n${detail}${fenceHint}`;
};

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
  if (VISUAL_ACTION_TYPES.has(type)) {
    return "visual";
  }
  if (KNOWLEDGE_ACTION_TYPES.has(type)) {
    return "knowledge";
  }
  if (PAGE_ACTION_TYPES.has(type)) {
    return "page";
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
  const target =
    action.path ??
    action.url ??
    action.term ??
    action.query ??
    action.subject ??
    action.command ??
    "";
  return `${action.type}${target ? ` ${target}` : ""}`.trim();
}

/**
 * A model writing `/html-template/home.html` means "from the workspace root",
 * not "from the filesystem root" — `list_dir` has treated a bare `/` that way
 * since 2026-07-25. Every other path-scoped action rejected it as an absolute
 * path, which costs a whole turn to a leading character. Seen live: turn 10 of
 * a photos-social run spent both its page actions on `/html-template/...` and
 * got `invalid` for both.
 *
 * Only a *leading* slash is stripped. `..` traversal and true escapes are still
 * resolved and rejected by {@link resolveWorkspacePath}, so this widens the
 * spelling accepted, never the sandbox.
 */
const workspaceRelative = (value, cwd) => {
  if (typeof value !== "string" || !value) {
    return value;
  }
  // A real absolute path *inside* the workspace is the model naming the file
  // the way it appears in a log line. Rewrite it rather than reject it.
  if (path.isAbsolute(value)) {
    const relative = path.relative(cwd, value);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  const stripped = value.replace(/^[/\\]+/, "");
  if (stripped === value) {
    return value;
  }
  // Blindly stripping the slash off an absolute path outside the workspace
  // turns `/Users/me/proj/server/db.js` into a *nested* junk path that resolves
  // happily inside the sandbox — MiniPhi would have created
  // `<workspace>/Users/me/proj/server/db.js`. Seen live on the turn that first
  // tried to write `db.js`. So only accept the strip when the result plausibly
  // names something in this workspace: a bare filename, or a first segment that
  // already exists here.
  const [head] = stripped.split(/[/\\]/);
  if (!stripped.includes("/") && !stripped.includes("\\")) {
    return stripped;
  }
  return existsSync(path.resolve(cwd, head)) ? stripped : value;
};

// Below this an existing file is small enough that a large proportional shrink
// is unremarkable, so the guard stays out of the way.
const OVERWRITE_GUARD_MIN_LINES = 30;
// A `write_file` leaving less than this fraction of an existing file is treated
// as a fragment rather than a rewrite.
const OVERWRITE_GUARD_RATIO = 0.5;

/**
 * Catches the single most destructive thing an agent does: sending a *patch*
 * as the whole file.
 *
 * `write_file` replaces the entire target, and the system prompt has always
 * said so. Nothing enforced it. Observed live on the photos-social sample: a
 * working 302-line `server/index.js` — register, login, upload, feed, profile,
 * likes, comments — was replaced by a 22-line fragment containing one route and
 * no imports at all. It passed the JavaScript syntax check, because a fragment
 * referencing undefined globals is perfectly valid JavaScript; the application
 * simply ceased to exist, and the only reason it was recoverable is the
 * guarded writer's rollback copy.
 *
 * `edit_file` with full `content` remains the deliberate way to say "yes, I
 * really do mean to replace all of it", so an intentional rewrite is still one
 * action away — it just cannot happen by accident.
 */
const detectPartialOverwrite = (action, beforeContent, afterContent) => {
  if (action.type !== "write_file" || typeof beforeContent !== "string" || !beforeContent) {
    return null;
  }
  const beforeLines = beforeContent.split("\n").length;
  const afterLines = String(afterContent ?? "").split("\n").length;
  if (beforeLines < OVERWRITE_GUARD_MIN_LINES || afterLines >= beforeLines * OVERWRITE_GUARD_RATIO) {
    return null;
  }
  return (
    `refusing to overwrite ${action.path}: it currently has ${beforeLines} lines and your content has only ${afterLines}. ` +
    "write_file replaces the ENTIRE file, so this would delete the rest of it — and content this much shorter is almost always a patch fragment sent as a whole file. " +
    "No file was changed. To change part of the file, send edit_file with an `anchor` copied verbatim from the current text plus its `replacement`. " +
    "If you really do intend to replace the whole file, read it first and send edit_file with the complete new `content` and no anchor."
  );
};

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

  if (type === "revert_changes") {
    // `checkpoint` is optional: with none, the runtime picks the best-scoring
    // state, which is the answer the model usually wants and the one it is
    // least able to work out for itself.
    const checkpoint =
      typeof rawAction.checkpoint === "string" ? rawAction.checkpoint.trim() : "";
    if (checkpoint) {
      action.checkpoint = checkpoint.slice(0, 64);
    }
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

  if (type === "knowledge_lookup") {
    const subject = typeof rawAction.subject === "string" ? rawAction.subject.trim() : "";
    if (!subject) {
      return { ok: false, error: "knowledge_lookup requires a non-empty subject" };
    }
    action.subject = subject.slice(0, 200);
    return { ok: true, action, category };
  }

  if (PAGE_ACTION_TYPES.has(type)) {
    // Same two-target shape as visual_review, and the same loopback-only rule
    // for the URL form: a model-authored string must never become an arbitrary
    // outbound request from the operator's machine.
    const pageUrl = normalizeReviewUrl(rawAction.url);
    if (rawAction.url && !pageUrl) {
      return {
        ok: false,
        error: `url "${rawAction.url}" must be an http(s) loopback address (e.g. http://127.0.0.1:3000/feed)`,
      };
    }
    if (pageUrl) {
      action.url = pageUrl;
    } else {
      const pagePath = resolveWorkspacePath(workspaceRelative(rawAction.path, cwd), cwd);
      if (!pagePath) {
        return {
          ok: false,
          error: `${type} needs either a workspace-relative path to an HTML file or a loopback url; path "${rawAction.path ?? ""}" is empty, absolute, or escapes the workspace`,
        };
      }
      action.path = pagePath;
    }
    const focus = typeof rawAction.focus === "string" ? rawAction.focus.trim() : "";
    if (focus) {
      action.focus = focus.slice(0, 400);
    }
    if (type === "page_inspect") {
      const mode = typeof rawAction.mode === "string" ? rawAction.mode.trim().toLowerCase() : "";
      action.mode = ["source", "rendered", "both", "auto"].includes(mode) ? mode : "auto";
    }
    return { ok: true, action, category };
  }

  if (type === "visual_review") {
    // A review target is either a workspace file or a loopback URL. The URL
    // form exists because an app the agent just wrote only renders once its own
    // server is running — a `file://` screenshot of the entry HTML shows the
    // unpopulated template, which the vision model then reports as a defect.
    const reviewUrl = normalizeReviewUrl(rawAction.url);
    if (rawAction.url && !reviewUrl) {
      return {
        ok: false,
        error: `url "${rawAction.url}" must be an http(s) loopback address (e.g. http://127.0.0.1:3000/)`,
      };
    }
    if (reviewUrl) {
      action.url = reviewUrl;
    } else {
      const visualPath = resolveWorkspacePath(workspaceRelative(rawAction.path, cwd), cwd);
      if (!visualPath) {
        return {
          ok: false,
          error: `visual_review needs either a workspace-relative path or a loopback url; path "${rawAction.path ?? ""}" is empty, absolute, or escapes the workspace`,
        };
      }
      action.path = visualPath;
    }
    const focus = typeof rawAction.focus === "string" ? rawAction.focus.trim() : "";
    if (focus) {
      action.focus = focus.slice(0, 400);
    }
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
  const relPath = rootList ? "." : resolveWorkspacePath(workspaceRelative(rawAction.path, cwd), cwd);
  if (!relPath) {
    // "path is empty, absolute, or escapes the workspace" is accurate and
    // useless when the field is simply absent — and absent is the common case.
    // Seen live: `edit_file` with a correct `anchor` and no `path` at all, twice
    // in one turn; the model knew exactly which text to change and never said
    // which file it was in. Name that mistake instead of listing three causes.
    if (rawAction.path === undefined || rawAction.path === null || rawAction.path === "") {
      const known =
        typeof rawAction.anchor === "string" && rawAction.anchor
          ? ` You gave an anchor (${JSON.stringify(rawAction.anchor.slice(0, 60))}) but no file to find it in.`
          : "";
      return {
        ok: false,
        error: `${type} did not include a "path", so there is no file to act on.${known} Add the workspace-relative path of the file, for example "server/db.js", and re-send this action.`,
      };
    }
    return {
      ok: false,
      error: `path "${rawAction.path}" is empty, absolute, or escapes the workspace`,
    };
  }
  action.path = relPath;

  // Reading vendored code is legitimate research; *writing* it is not. A model
  // that hits a dependency error reaches for the dependency: seen live, an
  // `ERR_PACKAGE_PATH_NOT_EXPORTED` from `hono` was answered with a `write_file`
  // to `server/node_modules/hono/package.json`. That "fix" corrupts an
  // installed package, survives into every later run, and produces failures
  // that no longer point at anything the agent wrote. The real remedy is always
  // in the agent's own code or its manifest.
  if (MUTATING_ACTION_TYPES.has(type)) {
    const vendored = VENDORED_PATH.exec(relPath);
    if (vendored) {
      return {
        ok: false,
        error: `refusing to modify ${relPath}: ${vendored[1]} holds installed/generated code that must not be edited by hand. Fix this in your own source or in package.json (change the import, add the right package, or pin a different version) and re-install with run_cmd.`,
      };
    }
  }

  if (type === "write_file") {
    if (typeof rawAction.content !== "string") {
      // "requires string content" is accurate and useless: a model that omits
      // `content` has almost always *described* the file in `reason` instead,
      // and repeats the same shape next turn. Naming that mistake is what makes
      // the correction actionable. Seen live on consecutive turns with
      // prism-ml/bonsai-27b, whose `reason` read "Creating the main server entry
      // point with Express setup..." while `content` was absent entirely.
      return {
        ok: false,
        error:
          "write_file did not include a `content` field, so nothing could be written. The complete new text of the file goes in the action's `content` field as a single JSON string; `reason` is only a one-line explanation and its text is never written to disk. Re-send this action with `content` filled in, and keep the file small enough to emit in full.",
      };
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

  const truncation = detectPartialOverwrite(action, beforeContent, afterContent);
  if (truncation) {
    return { ok: false, status: "partial-content", error: truncation };
  }

  let syntaxError =
    validateJavaScriptSyntax(action.path, afterContent ?? "") ??
    validateJsonSyntax(action.path, afterContent ?? "");
  if (syntaxError) {
    // A trailing fence is the model over-running the end of its own JSON string,
    // not a mistake in the file it wrote. Repair it — but only when the repair
    // actually produces a valid file. A fence that leaves broken code behind is
    // evidence, and stripping it would hide the very thing the error must name.
    const fence = stripTrailingFence(afterContent);
    if (fence.stripped) {
      const repairedError =
        validateJavaScriptSyntax(action.path, fence.content) ??
        validateJsonSyntax(action.path, fence.content);
      if (!repairedError) {
        afterContent = fence.content;
        syntaxError = null;
      }
    }
  }
  if (syntaxError) {
    return {
      ok: false,
      status: "invalid-content",
      error: syntaxError,
    };
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
