import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pre-written rules a run is navigated by, and the protocol used to write a
 * project's own handbook.
 *
 * Two documents with two different jobs, and conflating them is why the
 * operator's earlier instruction to "use AGENTS.bootstrap.md" could not simply
 * be obeyed:
 *
 *  - `docs/guidelines/agent-navigation.md` is ~80 lines of procedure and is
 *    injected into *every* turn. It has to be small: the reference host loads
 *    prism-ml/bonsai-27b with an 8192-token window, so a 33 KB protocol in the
 *    system prompt would consume the entire budget the task needs.
 *  - `docs/guidelines/AGENTS.bootstrap.md` is the full construction protocol
 *    (vendored from the operator's ai-agents-bootstrap repository). It is never
 *    sent whole to a small model. It is the input to a one-time bootstrap step
 *    that *produces* the workspace's `AGENTS.md`, and that generated handbook —
 *    project-specific, and short — is what later turns actually read.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const GUIDELINES_DIR = path.join(REPO_ROOT, "docs", "guidelines");

export const NAVIGATION_RULES_PATH = path.join(GUIDELINES_DIR, "agent-navigation.md");
export const BOOTSTRAP_PROTOCOL_PATH = path.join(GUIDELINES_DIR, "AGENTS.bootstrap.md");

/** Upstream home of the protocol, preferred when the operator has it checked out. */
export const UPSTREAM_BOOTSTRAP_ENV = "MINIPHI_AGENTS_BOOTSTRAP";

const RULES_BLOCK = /<!--\s*BEGIN RULES\s*-->([\s\S]*?)<!--\s*END RULES\s*-->/;

const readIfPresent = async (file) => {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * The navigation rules, stripped to the block between the RULES markers so the
 * file can carry its own rationale without spending prompt tokens on it.
 */
export async function loadNavigationRules({ file = NAVIGATION_RULES_PATH } = {}) {
  const raw = await readIfPresent(file);
  if (!raw) {
    return null;
  }
  const match = RULES_BLOCK.exec(raw);
  return (match ? match[1] : raw).trim() || null;
}

/**
 * The full AGENTS.md construction protocol.
 *
 * Resolution order: an explicit path, then `$MINIPHI_AGENTS_BOOTSTRAP`, then the
 * vendored copy. The env override exists so the operator's own working copy is
 * authoritative on their machine while the repository still works for everyone
 * else — a checkout-specific absolute path in the code would be neither.
 */
export async function loadBootstrapProtocol({ file = null } = {}) {
  const candidates = [
    file,
    process.env[UPSTREAM_BOOTSTRAP_ENV],
    BOOTSTRAP_PROTOCOL_PATH,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const raw = await readIfPresent(path.resolve(candidate));
    if (raw) {
      return { text: raw, path: path.resolve(candidate) };
    }
  }
  return null;
}

/**
 * The workspace's own handbook, when it has one. Truncated rather than dropped:
 * a handbook longer than the budget still answers the first questions a turn
 * asks (identity, principles, commands), and those live at the top.
 */
export async function loadWorkspaceHandbook({ workspaceRoot, maxChars = 6000 } = {}) {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const raw = await readIfPresent(path.join(workspaceRoot, name));
    if (raw && raw.trim()) {
      const text =
        raw.length > maxChars
          ? `${raw.slice(0, maxChars)}\n\n[handbook truncated at ${maxChars} of ${raw.length} chars — read ${name} for the rest]`
          : raw;
      return { name, text: text.trim(), bytes: raw.length, truncated: raw.length > maxChars };
    }
  }
  return null;
}

/**
 * Everything the system prompt should carry about *how to work here*, assembled
 * once per session.
 *
 * @returns {Promise<{block:string|null, rules:string|null, handbook:object|null, sources:string[]}>}
 */
export async function composeGuidelines({
  workspaceRoot,
  includeNavigationRules = true,
  handbookMaxChars = 6000,
} = {}) {
  const sources = [];
  const rules = includeNavigationRules ? await loadNavigationRules() : null;
  if (rules) {
    sources.push(path.relative(REPO_ROOT, NAVIGATION_RULES_PATH));
  }
  const handbook = workspaceRoot
    ? await loadWorkspaceHandbook({ workspaceRoot, maxChars: handbookMaxChars })
    : null;
  if (handbook) {
    sources.push(handbook.name);
  }
  const parts = [];
  if (rules) {
    parts.push(`Operating rules for this run (follow them; they override habit):\n\n${rules}`);
  }
  if (handbook) {
    parts.push(
      `This workspace has its own handbook (${handbook.name}). It is authoritative about this project:\n\n${handbook.text}`,
    );
  }
  return {
    block: parts.length ? parts.join("\n\n") : null,
    rules,
    handbook,
    sources,
  };
}

export default composeGuidelines;
