/**
 * Decides whether an invocation should open the interactive agent UI or run
 * headless. Pure and side-effect free so it can be unit-tested in isolation.
 *
 * Contract (UI is the primary interface, direct arguments always available):
 *  - `--headless`/`--no-ui`, or a non-TTY stdio (scripts/CI) → always headless.
 *  - explicit `ui` command → UI.
 *  - bare `miniphi` (no command) on a TTY → UI.
 *  - a free-form task that resolved to workspace mode on a TTY → UI (seeded).
 *  - any explicit subcommand (run/analyze-file/benchmark/…) → headless.
 *
 * @param {{ command: string|null, bare: boolean, isImplicitTask: boolean,
 *           options: object, isTTY: boolean }} input
 * @returns {{ ui: boolean, reason: string }}
 */
export function decideUiLaunch({ command, bare, isImplicitTask, options, isTTY }) {
  if (options?.headless || options?.["no-ui"]) {
    return { ui: false, reason: "forced-headless" };
  }
  if (!isTTY) {
    return { ui: false, reason: "non-tty" };
  }
  if (command === "ui") {
    return { ui: true, reason: "ui-command" };
  }
  if (bare) {
    return { ui: true, reason: "bare" };
  }
  if (isImplicitTask && command === "workspace") {
    return { ui: true, reason: "free-form-task" };
  }
  return { ui: false, reason: "explicit-command" };
}
