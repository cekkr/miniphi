import fs from "fs/promises";
import path from "path";

const DEFAULT_MAX_SNIPPETS = 4;
const DEFAULT_MAX_SNIPPET_BYTES = 4000;
const DEFAULT_MAX_ACTIONS = 4;
const DEFAULT_MAX_OUTPUT_CHARS = 1500;
const DEFAULT_MAX_BLOCK_CHARS = 4000;
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", ".miniphi", "dist", "build", "coverage"]);
const SEARCH_MAX_FILES = 2000;
const SEARCH_MAX_FILE_BYTES = 512 * 1024;
const SEARCH_MAX_MATCHES = 20;

const PATH_TOKEN_PATTERN =
  /(?:[\w.-]+[\\/])+[\w.-]+|\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|c|h|cpp|hpp|sh|bash|txt|yml|yaml|toml|css|html)\b/g;
const COMMAND_PATTERN =
  /^(npm|npx|node|git|python3?|py|pip3?|pytest|make|cargo|go|eslint|tsc|jest|mocha|vitest|bash|sh|ls|dir|cat|rg|grep)\b/;
const QUOTED_TERM_PATTERN = /["'`]([^"'`]{3,80})["'`]/;
const TARGETED_TERM_PATTERN = /\b(?:usages?\s+of|references?\s+to|occurrences?\s+of|calls?\s+to)\s+([\w.$-]{2,60})/i;
const SEARCH_PHRASE_PATTERN = /\b(?:search(?:ing)?\s+for|look(?:ing)?\s+for|grep\s+for|locate|find)\s+([\w.$-]{3,60})/i;
const SEARCH_TERM_STOPWORDS = new Set([
  "usages",
  "usage",
  "references",
  "reference",
  "occurrences",
  "calls",
  "the",
  "all",
  "any",
  "for",
  "file",
  "files",
  "code",
]);

function truncateOutput(text, maxChars) {
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[output truncated at ${maxChars} chars]`;
}

/**
 * Returns the workspace-relative POSIX path when `candidate` resolves inside
 * `cwd`, otherwise null. This is the only gate between model-provided strings
 * and the local filesystem, so absolute paths and `..` escapes are rejected.
 */
export function resolveWorkspacePath(candidate, cwd) {
  if (typeof candidate !== "string" || !candidate.trim() || typeof cwd !== "string" || !cwd) {
    return null;
  }
  const trimmed = candidate.trim().replace(/^["'`]|["'`]$/g, "");
  if (!trimmed || /^[a-z]+:\/\//i.test(trimmed)) {
    return null;
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    return null;
  }
  const resolved = path.resolve(cwd, trimmed);
  const relative = path.relative(path.resolve(cwd), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/**
 * Resolves model-requested `missing_snippets` entries that name repo-relative
 * files and reads their (bounded) content so the caller can re-prompt with the
 * requested context instead of only printing the request.
 */
export async function resolveMissingSnippets({
  snippets,
  cwd,
  maxCount = DEFAULT_MAX_SNIPPETS,
  maxBytes = DEFAULT_MAX_SNIPPET_BYTES,
} = {}) {
  const resolved = [];
  const unresolved = [];
  const list = Array.isArray(snippets) ? snippets : [];
  for (const snippet of list) {
    if (resolved.length >= maxCount) {
      unresolved.push(snippet);
      continue;
    }
    // Descriptive requests often embed the path ("Current parser in src/x.js").
    const candidates = [snippet, ...(String(snippet ?? "").match(PATH_TOKEN_PATTERN) ?? [])];
    let entry = null;
    for (const candidate of candidates) {
      const relative = resolveWorkspacePath(candidate, cwd);
      if (!relative) {
        continue;
      }
      const absolute = path.resolve(cwd, relative);
      try {
        const stats = await fs.stat(absolute);
        if (!stats.isFile()) {
          continue;
        }
        const raw = await fs.readFile(absolute, "utf8");
        const truncated = raw.length > maxBytes;
        entry = {
          request: snippet,
          path: relative,
          bytes: stats.size,
          truncated,
          content: truncated ? raw.slice(0, maxBytes) : raw,
        };
        break;
      } catch {
        // Missing/unreadable candidates fall through to the next token.
      }
    }
    if (entry) {
      resolved.push(entry);
    } else {
      unresolved.push(snippet);
    }
  }
  return { resolved, unresolved };
}

/**
 * Renders resolved snippets as a prompt context block.
 */
export function buildSnippetContextBlock(resolved, { maxChars = DEFAULT_MAX_BLOCK_CHARS } = {}) {
  if (!Array.isArray(resolved) || resolved.length === 0) {
    return null;
  }
  const lines = ["Requested snippets (auto-fetched):"];
  for (const entry of resolved) {
    lines.push(`--- ${entry.path} (${entry.bytes} bytes${entry.truncated ? ", truncated" : ""}) ---`);
    lines.push(entry.content.trimEnd());
  }
  const block = lines.join("\n");
  return block.length > maxChars ? `${block.slice(0, maxChars)}\n[snippets truncated]` : block;
}

function cleanSearchTerm(term) {
  if (typeof term !== "string") {
    return null;
  }
  const cleaned = term.replace(/[.,:;!?]+$/, "").trim();
  if (cleaned.length < 3 || SEARCH_TERM_STOPWORDS.has(cleaned.toLowerCase())) {
    return null;
  }
  return cleaned;
}

function extractSearchTerm(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  // "usages of X" / "references to X" names the target directly; try it first.
  const targeted = cleanSearchTerm(text.match(TARGETED_TERM_PATTERN)?.[1]);
  if (targeted) {
    return targeted;
  }
  if (/\b(search|look for|find|grep|locate|usages?|references?)\b/i.test(text)) {
    const quoted = cleanSearchTerm(text.match(QUOTED_TERM_PATTERN)?.[1]);
    if (quoted) {
      return quoted;
    }
  }
  return cleanSearchTerm(text.match(SEARCH_PHRASE_PATTERN)?.[1]);
}

async function statWorkspaceEntry(relative, cwd) {
  try {
    return await fs.stat(path.resolve(cwd, relative));
  } catch {
    return null;
  }
}

/**
 * Deterministically maps one plan segment onto a safe default agent command.
 * Conservative by design: anything ambiguous returns type "unmapped" (or
 * "sub-prompt" when the plan flagged the step for further decomposition) so
 * MiniPhi never guesses at side-effectful work.
 */
export async function mapSegmentToAction(segment, { cwd } = {}) {
  if (!segment || typeof segment !== "object") {
    return { type: "unmapped", reason: "invalid segment" };
  }
  const text = [segment.title, segment.description]
    .filter((part) => typeof part === "string")
    .join(". ");
  const recommendation =
    typeof segment.recommendation === "string" ? segment.recommendation.trim() : "";

  if (recommendation && COMMAND_PATTERN.test(recommendation)) {
    return { type: "run_cmd", command: recommendation, source: "recommendation" };
  }

  const pathTokens = text.match(PATH_TOKEN_PATTERN) ?? [];
  for (const token of pathTokens) {
    const relative = resolveWorkspacePath(token, cwd);
    if (!relative) {
      continue;
    }
    const stats = await statWorkspaceEntry(relative, cwd);
    if (stats?.isFile()) {
      return { type: "read_file", target: relative, source: "path-token" };
    }
    if (stats?.isDirectory()) {
      return { type: "list_dir", target: relative, source: "path-token" };
    }
  }

  const term = extractSearchTerm(text);
  if (term) {
    return { type: "search_text", term, source: "description" };
  }

  if (segment.requiresSubprompt) {
    return { type: "sub-prompt", reason: "plan flagged requires_subprompt" };
  }
  return { type: "unmapped", reason: "no safe deterministic mapping" };
}

async function searchTextInWorkspace(term, cwd, { maxMatches = SEARCH_MAX_MATCHES } = {}) {
  const matches = [];
  let scanned = 0;
  const walk = async (dir) => {
    if (matches.length >= maxMatches || scanned >= SEARCH_MAX_FILES) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxMatches || scanned >= SEARCH_MAX_FILES) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Dot-directories (.git, .miniphi, ...) are agent/VCS state, not sources.
        if (!entry.name.startsWith(".") && !SEARCH_SKIP_DIRS.has(entry.name)) {
          await walk(full);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      scanned += 1;
      try {
        const stats = await fs.stat(full);
        if (stats.size > SEARCH_MAX_FILE_BYTES) {
          continue;
        }
        const content = await fs.readFile(full, "utf8");
        if (content.includes("\u0000")) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < maxMatches; i += 1) {
          if (lines[i].includes(term)) {
            const relative = path.relative(cwd, full).split(path.sep).join("/");
            matches.push(`${relative}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
          }
        }
      } catch {
        // unreadable file: skip
      }
    }
  };
  await walk(path.resolve(cwd));
  return matches;
}

async function executeAction(action, cwd, { maxOutputChars }) {
  if (action.type === "read_file") {
    const raw = await fs.readFile(path.resolve(cwd, action.target), "utf8");
    return truncateOutput(raw, maxOutputChars);
  }
  if (action.type === "list_dir") {
    const entries = await fs.readdir(path.resolve(cwd, action.target), { withFileTypes: true });
    const listing = entries
      .slice(0, 50)
      .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
      .join("\n");
    return truncateOutput(listing, maxOutputChars);
  }
  if (action.type === "search_text") {
    const matches = await searchTextInWorkspace(action.term, cwd);
    return matches.length
      ? truncateOutput(matches.join("\n"), maxOutputChars)
      : `no matches for "${action.term}"`;
  }
  throw new Error(`unsupported action type ${action.type}`);
}

/**
 * Executes the mappable steps of a focused plan branch. Read-only filesystem
 * actions run natively (no shell). `run_cmd` recommendations execute only when
 * the caller injects `runCommand` (command-policy gated); otherwise they are
 * recorded as deferred so workspace mode keeps its no-arbitrary-shell contract.
 */
export async function executeFocusedBranchActions({
  segments,
  cwd,
  maxActions = DEFAULT_MAX_ACTIONS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  runCommand = null,
  sessionDeadline = null,
  logger = null,
} = {}) {
  const log = typeof logger === "function" ? logger : () => {};
  const results = [];
  const seenSignatures = new Set();
  let executed = 0;
  const list = Array.isArray(segments) ? segments : [];
  for (const segment of list) {
    if (
      Number.isFinite(sessionDeadline) &&
      sessionDeadline > 0 &&
      Date.now() >= sessionDeadline
    ) {
      results.push({ branch: segment?.id ?? null, title: segment?.title ?? null, action: null, status: "skipped-session" });
      break;
    }
    const action = await mapSegmentToAction(segment, { cwd });
    const base = {
      branch: segment?.id ?? null,
      title: segment?.title ?? null,
      action,
    };
    if (action.type === "sub-prompt" || action.type === "unmapped") {
      results.push({ ...base, status: action.type });
      continue;
    }
    // Sibling branches often map to the same concrete action; run it once and
    // mark repeats so they neither consume budget nor bloat the prompt block.
    const signature = `${action.type}:${action.target ?? action.term ?? action.command ?? ""}`;
    if (seenSignatures.has(signature)) {
      results.push({ ...base, status: "duplicate" });
      continue;
    }
    if (executed >= maxActions) {
      results.push({ ...base, status: "skipped-budget" });
      continue;
    }
    seenSignatures.add(signature);
    if (action.type === "run_cmd" && typeof runCommand !== "function") {
      results.push({ ...base, status: "deferred-command" });
      continue;
    }
    executed += 1;
    try {
      const output =
        action.type === "run_cmd"
          ? truncateOutput(await runCommand(action.command), maxOutputChars)
          : await executeAction(action, cwd, { maxOutputChars });
      results.push({ ...base, status: "executed", output });
      log(
        `[PlanExecutor] ${action.type} ${action.target ?? action.term ?? action.command ?? ""} (branch ${segment?.id ?? "?"})`,
      );
    } catch (error) {
      results.push({
        ...base,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { results, executedCount: executed };
}

/**
 * Renders executed-action results as a prompt context block; only executed
 * actions contribute output so the block stays high-signal.
 */
export function buildExecutedActionsBlock(results, { maxChars = DEFAULT_MAX_BLOCK_CHARS } = {}) {
  const executed = (Array.isArray(results) ? results : []).filter(
    (entry) => entry.status === "executed",
  );
  if (!executed.length) {
    return null;
  }
  const lines = ["Executed plan actions:"];
  for (const entry of executed) {
    const target = entry.action?.target ?? entry.action?.term ?? entry.action?.command ?? "";
    lines.push(`--- step ${entry.branch ?? "?"}: ${entry.action.type} ${target} ---`);
    lines.push(String(entry.output ?? "").trimEnd());
  }
  const block = lines.join("\n");
  return block.length > maxChars ? `${block.slice(0, maxChars)}\n[actions truncated]` : block;
}

/**
 * Builds the per-branch progress artifact persisted next to the plan so
 * follow-up runs can resume from the first incomplete branch.
 */
export function buildPlanProgress({ planId, focusBranch, results, previous = null } = {}) {
  const branches = { ...(previous?.branches ?? {}) };
  for (const entry of Array.isArray(results) ? results : []) {
    if (!entry?.branch) {
      continue;
    }
    branches[entry.branch] = {
      status: entry.status,
      action: entry.action?.type ?? null,
      target: entry.action?.target ?? entry.action?.term ?? entry.action?.command ?? null,
      error: entry.error ?? null,
      updatedAt: new Date().toISOString(),
    };
  }
  const firstIncomplete =
    Object.entries(branches).find(
      ([, value]) =>
        value.status !== "executed" && value.status !== "unmapped" && value.status !== "duplicate",
    )?.[0] ?? null;
  return {
    planId: planId ?? null,
    focusBranch: focusBranch ?? null,
    branches,
    firstIncompleteBranch: firstIncomplete,
    updatedAt: new Date().toISOString(),
  };
}
