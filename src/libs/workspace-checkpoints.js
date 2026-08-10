import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A private version history of everything the agent changes, so a bad turn is
 * *reverted* rather than patched blind.
 *
 * The guarded writer already kept per-file `.rollback` copies, but a rollback
 * copy is not a history: it has no notion of a coherent state, no score, and
 * nothing consults it. Observed on the photos-social sample — the agent
 * replaced a working 302-line `server/index.js` with a 22-line fragment, the
 * app died with `ReferenceError: url is not defined`, and the run spent its
 * remaining turns trying to *repair forward* from a state strictly worse than
 * one it had held ten minutes earlier. The recovery it needed was one command
 * and nothing could issue it.
 *
 * Implementation is a **shadow git repository**: a separate `--git-dir` with
 * the workspace as its work tree. Real git means real diffs, cheap storage and
 * a format the operator already knows how to inspect — and because the git dir
 * lives under `.miniphi/`, the project's own repository is never touched, never
 * staged, never committed to. If git is unavailable the whole thing degrades to
 * disabled; it is an assistive memory, never a precondition for running.
 *
 * Each checkpoint carries a **score** derived from the workspace validator and
 * the project's own test suite, which is what lets both the runtime and the
 * model choose a target: "go back to the last state that actually worked" is
 * only answerable if the states are ranked.
 */

const GIT_DIR_NAME = "changes.git";
const INDEX_FILE = "checkpoints.json";
// Never snapshot installed or generated trees; they are large, restorable by
// other means, and would dominate every diff.
const EXCLUDED = [
  "node_modules/",
  ".git/",
  ".miniphi/",
  "*.log",
  ".DS_Store",
];

/**
 * The same exclusions as git pathspecs, applied on every `add`.
 *
 * `info/exclude` alone is not enough once `--force` is in play: force overrides
 * all exclude sources at once. Naming them as pathspecs keeps MiniPhi's own
 * boundaries (never snapshot installed code, never recurse into the history
 * itself) while still overriding the *workspace's* `.gitignore`.
 */
const EXCLUDE_PATHSPECS = [
  ":(exclude)node_modules/**",
  ":(exclude)**/node_modules/**",
  ":(exclude).miniphi/**",
  ":(exclude).git/**",
  ":(exclude)**/.git/**",
  ":(exclude)**/*.log",
  ":(exclude)**/.DS_Store",
];

/**
 * Ranks two validation outcomes. Higher is better; the comparison is what makes
 * "did this turn make things worse?" a decidable question instead of a feeling.
 *
 * Ordering, most significant first: a workspace that boots and validates beats
 * one that does not; fewer outstanding issues beats more; a passing test suite
 * beats an absent or failing one.
 */
export function scoreCheckpoint({ validation = null, tests = null } = {}) {
  const valid = validation?.valid === true;
  const issues = Array.isArray(validation?.issues) ? validation.issues.length : null;
  const testsPassed = tests?.passed === true;
  // A validator that could not run at all is worse than one reporting issues:
  // it usually means the app does not start.
  const ran = validation != null;
  let score = 0;
  if (valid) {
    score += 1000;
  }
  if (ran) {
    score += 100;
    score -= Math.min(99, (issues ?? 99) * 10);
  }
  if (testsPassed) {
    score += 200;
  }
  return {
    score,
    valid,
    issues,
    testsPassed,
    ran,
  };
}

export class WorkspaceCheckpoints {
  /**
   * @param {{
   *   workspaceRoot: string,
   *   baseDir: string,          // the `.miniphi` directory
   *   enabled?: boolean,
   *   logger?: Function|null,
   * }} options
   */
  constructor(options = undefined) {
    this.workspaceRoot = options?.workspaceRoot ?? process.cwd();
    this.baseDir = options?.baseDir ?? path.join(this.workspaceRoot, ".miniphi");
    this.gitDir = path.join(this.baseDir, GIT_DIR_NAME);
    this.indexPath = path.join(this.baseDir, INDEX_FILE);
    this.enabled = options?.enabled !== false;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this._ready = false;
    this._checkpoints = [];
  }

  _log(message) {
    if (this.logger) {
      this.logger(`[checkpoints] ${message}`);
    }
  }

  async _git(args, { allowFailure = false } = {}) {
    try {
      const { stdout } = await run(
        "git",
        ["--git-dir", this.gitDir, "--work-tree", this.workspaceRoot, ...args],
        { cwd: this.workspaceRoot, maxBuffer: 32 * 1024 * 1024 },
      );
      return { ok: true, stdout: stdout.trim() };
    } catch (error) {
      if (!allowFailure) {
        throw error;
      }
      return { ok: false, stdout: "", error: error?.stderr || error?.message || String(error) };
    }
  }

  /** Creates the shadow repository. Safe to call repeatedly. */
  async prepare() {
    if (!this.enabled || this._ready) {
      return this._ready;
    }
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      const exists = await fs
        .access(path.join(this.gitDir, "HEAD"))
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await run("git", ["init", "--quiet", "--bare", this.gitDir], { cwd: this.workspaceRoot });
        // A bare repo has no work tree of its own, which is exactly what we
        // want: every command supplies the workspace explicitly.
        await this._git(["config", "core.worktree", this.workspaceRoot]);
        await this._git(["config", "user.email", "miniphi@localhost"]);
        await this._git(["config", "user.name", "MiniPhi"]);
        await fs.writeFile(
          path.join(this.gitDir, "info", "exclude"),
          `${EXCLUDED.join("\n")}\n`,
          "utf8",
        );
      }
      await this._loadIndex();
      this._ready = true;
      return true;
    } catch (error) {
      this.enabled = false;
      this._log(`disabled: ${error?.message ?? error}`);
      return false;
    }
  }

  async _loadIndex() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath, "utf8"));
      this._checkpoints = Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : [];
    } catch {
      this._checkpoints = [];
    }
  }

  async _saveIndex() {
    await fs
      .writeFile(
        this.indexPath,
        JSON.stringify(
          { schemaVersion: "workspace-checkpoints@v1", checkpoints: this._checkpoints },
          null,
          2,
        ),
        "utf8",
      )
      .catch(() => {});
  }

  /**
   * Records the current workspace state.
   *
   * @param {{label:string, turn?:number|null, validation?:object|null, tests?:object|null, files?:string[]}} entry
   * @returns {Promise<object|null>} the stored checkpoint, or null when nothing changed
   */
  async record(entry = {}) {
    if (!(await this.prepare())) {
      return null;
    }
    try {
      // `--force` is load-bearing, not defensive. The shadow repo is a different
      // repository with a different purpose, but git still reads the
      // workspace's own `.gitignore` — and the agent's output is very often
      // exactly what that file excludes. Observed live: the photos-social
      // sample gitignores `server/` because it is generated, so the history
      // faithfully snapshotted the read-only `html-template/` and skipped the
      // entire application it was supposed to protect.
      //
      // But `--force` overrides *every* exclusion, including this repo's own,
      // so what must not be snapshotted is stated here as pathspecs instead:
      // the exclusion belongs to MiniPhi, not to the project being worked on.
      await this._git(["add", "--all", "--force", "--", ".", ...EXCLUDE_PATHSPECS]);
      const status = await this._git(["status", "--porcelain"], { allowFailure: true });
      const hasHistory = this._checkpoints.length > 0;
      if (hasHistory && status.ok && !status.stdout) {
        return null; // nothing changed since the last checkpoint
      }
      // An explicit rating is how a *restore* records the truth: the workspace
      // now is the target state, so it carries the target's score. Re-deriving
      // it from a fabricated validation scored a successfully recovered
      // workspace as 0, which read as a fresh regression and triggered another
      // revert, and another — four in a row before the guard caught it.
      const rating = entry.rating ?? scoreCheckpoint(entry);
      const message = [
        entry.label ?? "checkpoint",
        "",
        JSON.stringify({
          turn: entry.turn ?? null,
          score: rating.score,
          valid: rating.valid,
          issues: rating.issues,
          testsPassed: rating.testsPassed,
        }),
      ].join("\n");
      const committed = await this._git(["commit", "--quiet", "--allow-empty", "-m", message], {
        allowFailure: true,
      });
      if (!committed.ok) {
        this._log(`commit failed: ${committed.error}`);
        return null;
      }
      const head = await this._git(["rev-parse", "HEAD"]);
      const checkpoint = {
        id: head.stdout.slice(0, 12),
        commit: head.stdout,
        label: entry.label ?? "checkpoint",
        turn: entry.turn ?? null,
        at: new Date().toISOString(),
        files: Array.isArray(entry.files) ? entry.files.slice(0, 50) : [],
        ...rating,
      };
      this._checkpoints.push(checkpoint);
      await this._saveIndex();
      this._log(
        `${checkpoint.id} "${checkpoint.label}" score=${checkpoint.score}${checkpoint.issues != null ? ` issues=${checkpoint.issues}` : ""}`,
      );
      return checkpoint;
    } catch (error) {
      this._log(`record failed: ${error?.message ?? error}`);
      return null;
    }
  }

  /** Every checkpoint, oldest first. */
  list() {
    return this._checkpoints.slice();
  }

  /** The most recent checkpoint, or null. */
  latest() {
    return this._checkpoints.at(-1) ?? null;
  }

  /**
   * The highest-scoring checkpoint, preferring the most recent on a tie — the
   * answer to "go back to the last state that actually worked".
   */
  best() {
    let best = null;
    for (const checkpoint of this._checkpoints) {
      if (!best || checkpoint.score >= best.score) {
        best = checkpoint;
      }
    }
    return best;
  }

  /**
   * True when the newest checkpoint scores worse than the best one before it —
   * i.e. the last turn made the workspace measurably worse.
   */
  regression() {
    if (this._checkpoints.length < 2) {
      return null;
    }
    const current = this._checkpoints.at(-1);
    let bestBefore = null;
    for (const checkpoint of this._checkpoints.slice(0, -1)) {
      if (!bestBefore || checkpoint.score >= bestBefore.score) {
        bestBefore = checkpoint;
      }
    }
    if (!bestBefore || current.score >= bestBefore.score) {
      return null;
    }
    return { current, bestBefore, delta: bestBefore.score - current.score };
  }

  /**
   * Restores the workspace to a checkpoint. The current state is recorded first
   * so a revert is itself undoable — an agent that reverts by mistake must not
   * lose the work it reverted away from.
   */
  async restore(id, { label = null } = {}) {
    if (!(await this.prepare())) {
      return { ok: false, error: "checkpoints are disabled" };
    }
    const target = this._checkpoints.find(
      (checkpoint) => checkpoint.id === id || checkpoint.commit === id,
    );
    if (!target) {
      return { ok: false, error: `no checkpoint "${id}"` };
    }
    // Snapshot the current state first so a revert is itself undoable. When
    // nothing has changed since the last checkpoint this records nothing, which
    // is correct — that checkpoint already *is* the pre-revert state.
    await this.record({ label: label ?? `before reverting to ${target.id}` });
    // `checkout <commit> -- .` restores files that exist in the target but
    // leaves behind any file created *after* it, producing a hybrid state that
    // matches no checkpoint at all — the stray file is tracked, so `clean` will
    // not remove it either. `read-tree -u --reset` makes the index and the work
    // tree equal the recorded tree exactly, deletions included.
    const reset = await this._git(["read-tree", "-u", "--reset", target.commit], {
      allowFailure: true,
    });
    if (!reset.ok) {
      return { ok: false, error: reset.error };
    }
    // Anything untracked that appeared since (build output, stray drafts).
    await this._git(["clean", "-fd", "--", this.workspaceRoot], { allowFailure: true });
    const restored = await this.record({
      label: `reverted to ${target.id} (${target.label})`,
      rating: {
        score: target.score,
        valid: target.valid,
        issues: target.issues,
        testsPassed: target.testsPassed,
        ran: target.ran,
      },
    });
    this._log(`restored ${target.id} "${target.label}"`);
    return { ok: true, target, checkpoint: restored };
  }

  /** Changed-file summary between a checkpoint and the working tree. */
  async diffSummary(id) {
    if (!(await this.prepare())) {
      return null;
    }
    const target = this._checkpoints.find(
      (checkpoint) => checkpoint.id === id || checkpoint.commit === id,
    );
    if (!target) {
      return null;
    }
    const diff = await this._git(["diff", "--stat", target.commit, "--"], { allowFailure: true });
    return diff.ok ? diff.stdout : null;
  }

  stats() {
    return {
      enabled: this.enabled,
      gitDir: this.enabled ? this.gitDir : null,
      checkpoints: this._checkpoints.length,
      best: this.best()?.id ?? null,
      latest: this.latest()?.id ?? null,
    };
  }
}

export default WorkspaceCheckpoints;
