# MiniPhi Roadmap

This roadmap keeps MiniPhi development outcome-driven, JSON-first, and locally reproducible.
Each milestone has explicit exit criteria and closes only on a real proof run. Historical
proof-run logs live in git history (see pre-2026-07 revisions of this file); this file stays
forward-looking.

## Scope and non-goals
- Scope: local file manipulation agent for coding projects with LM Studio JSON-first prompts.
- Non-goals until v0.1 ships: broad research automation, multi-agent orchestration, remote writes.

## Guiding principles
- JSON-first: every model exchange is schema-validated with deterministic fallbacks.
- Local-only: edits and helpers operate within the working directory and `.miniphi/`.
- Reproducible: every slice closes only after a real MiniPhi run and recorded stop reason.
- Fit the hardware: model choice and context budgets come from the **live** LM Studio inventory
  (installed models, loaded context, available memory), never from static presets alone.
  Lesson learned 2026-07-15: advertising a static `context_length` broke every REST call against
  JIT-loaded models; the wire contract now only sends what was explicitly configured.
- Decompose small, expand recursively: never ask a local model for a deep nested artifact in one
  completion. Ask shallow, then expand flagged branches with focused follow-up prompts under
  budget/depth/session caps. (This turned decomposition from always-failing to a proven
  21-step depth-3 plan on a 30B local model.)
- Two-tier testing: `npm test` is offline and deterministic (stubbed REST clients);
  live behavior is gated behind `MINIPHI_LMSTUDIO_INTEGRATION=1` and asserts on *executed*
  model output (generated code is imported and behaviorally tested), not just JSON shape.
- Minimal drift: if a new roadmap item is added, defer or remove a lower-priority item.

## Where we are (2026-07-15)
Proven and regression-covered:
- Strict JSON loop: schema registry + shared validation outcomes, canonical stop reasons,
  prompt exchanges/journals/task-execution registers, stop-reason migration for old artifacts.
- Recursive decomposition: shallow-first plan + per-branch expansion (`branchExpansions`
  telemetry, `--max-plan-expansions`, `--no-plan-expansion`), proven live against this repo.
- Live model management: `models` command and `--model auto` rank installed models per task
  intent (purpose, context, loaded state, memory fit); catalog falls back to OpenAI-compat
  `/v1/models` when the native route is unavailable.
- Interactive agent UI (2026-07-15): bare `miniphi`/free-form tasks open an Ink+htm agent that
  selects files, streams progress, and applies **guarded edits** (diff + rollback via
  `writeFileWithGuard`) behind per-edit operator approval; direct subcommands stay headless.
  Core is offline-covered (executor/session/UI/routing suites); a live LM Studio proof of a
  model-proposed edit applied end-to-end is still pending.
- Test suite: 166 tests — 161 offline deterministic, 5 live-gated (code generation, targeted
  bug-fix editing, stateful class generation, bash multi-file prompts) — 0 failures.

Known gaps (drive the slices below):
- Plans are produced but not executed in the **headless** flow: workspace maps leaves to
  read-only actions, but run/analyze-file don't yet consume plan actions.
- `needs_more_context`/`missing_snippets` auto-fetch + re-prompt is wired in workspace and the
  interactive agent; a live end-to-end firing is still unproven.
- Guarded model-proposed edits now exist in the **interactive agent** path; the **headless**
  run/workspace analyzer flow still has no `edit_file` action (live proof pending for both).
- `model-presets.js` defaults drift from installed models (default preset model is not even
  installed on the reference host); auto-selection exists but is opt-in.
- Models are JIT-loaded at the server default context (8192 on the reference host); MiniPhi
  cannot yet size context deliberately (LM Studio `/api/v1/models/load` exists for this).
- "Idle vs stall" is indistinguishable to the operator: when nothing is computing, a static
  screen / silent stdout looks the same whether MiniPhi is *waiting for input* or *hung*. See the
  detailed future-fix note under v0.1 slice 5.

## Milestones

### v0.1 Local file agent (Active)
Objective: deliver a stable local file-edit loop with strict JSON validation, resumable plans,
and audit trails.

Exit criteria:
- Planner -> actions -> edits -> summary loop works with strict JSON validation and
  deterministic fallbacks.
- File edits apply via patch/write with diff summaries and rollback on mismatch.
- Command execution is gated by command-policy with timeouts and max retries; runs end with a
  clear stop reason.
- Passes `samples/get-started` plus one real repo run without manual patching.

Slices (in order):

1) Core loop hardening — **CLOSED 2026-07-15**
   - Delivered: prompt hygiene + compaction ladders (full -> compact -> minimal), shared
     schema-validation contract across handler/analyzer/navigator/decomposer, canonical stop
     reasons everywhere (incl. one-shot migration), recursive branch expansion, live model
     catalog + `--model auto`, REST `context_length` wire fix, deterministic offline suite +
     gated live suite.
   - Closing proof (2026-07-15): `node src/index.js "Improve the CLI argument parser with input
     validation and add unit tests for it" --model auto --verbose --no-navigator` auto-selected
     `qwen3-coder-30b-a3b-instruct`, expanded 4 branches into a 21-step depth-3 plan
     (telemetry in `.miniphi/prompt-exchanges/decompositions/`), and ended with a schema-valid
     log-analysis JSON footer. Full per-run history: git log of this file.

2) Plan execution bridge — **ACTIVE** (core landed 2026-07-15)
   - Problem: decomposition now yields actionable trees whose leaves name concrete files and
     commands, but nothing consumes them; likewise the analyzer's `missing_snippets` requests
     die on stdout.
   - Landed (workspace flow, `src/libs/plan-executor.js` + `src/commands/workspace.js`):
     - Focused-branch leaf steps map deterministically onto read-only native actions
       (read_file/list_dir/search_text) with budgets, session-deadline checks, and dedup of
       identical actions across sibling branches; `run_cmd` recommendations stay deferred until
       a policy-gated `runCommand` is injected. Outputs feed the workspace-summary prompt.
     - Repo-relative `missing_snippets` are auto-fetched (path-escape safe) and the summary
       re-prompts once (`workspace-summary-snippets`); executed actions often pre-feed enough
       context that the model no longer asks — the desired steady state.
     - Per-branch progress persists via `MiniPhiMemory.savePlanProgress`
       (`decompositions/<slug>-progress.json`, `firstIncompleteBranch`); CLI prints the resume
       hint; the journal records a `plan-actions` step.
     - Proof run (2026-07-15): live `miniphi` run expanded 4 branches, executed 4 plan actions,
       persisted progress, and returned a non-fallback JSON footer with
       `needs_more_context: false`. Regression: `unit-tests-js/plan-executor.test.js` (9 tests).
   - Remaining before close:
     - Default `--plan-branch` to `firstIncompleteBranch` when resuming with a saved progress
       artifact (currently only a printed hint).
     - Extend executor wiring to `run`/`analyze-file`; inject policy-gated `runCommand` in run
       mode so command recommendations execute under CommandAuthorizationManager.
     - One live run where the `missing_snippets` re-prompt fires end-to-end
       (request -> auto-fetch -> re-prompt -> non-fallback JSON).

3) Reliable edit pipeline — **core + live create-write landed 2026-07-15; edit/validate proof pending**
   - Scope: bring the guarded writer (diff summary + rollback, previously recompose-only) into an
     agent loop behind `write_file`/`edit_file` actions; edits arrive as schema-validated JSON
     (full-file `content` or unique-anchor find/replace) via the `agent-action` schema.
   - Landed (`src/agent/`): `AgentSession` runs a plan→act→approve→apply loop; `agent-executor`
     normalizes actions (path-safe), builds a two-phase mutation **proposal** (diff + before/after
     + `expectedHash`) and commits through `writeFileWithGuard` with a per-session `rollbacks/`
     dir; `run_cmd` is CommandAuthorizationManager/approver-gated. Offline coverage:
     `agent-executor.test.js` (guarded write, hash-mismatch rollback, anchor miss/ambiguity,
     path-escape), `agent-session.test.js` (scripted loop, rejection, off-schema fallback, dedup).
   - Closing proof (2026-07-15, live `qwen3-coder-30b-a3b-instruct`): agent proposed
     `write_file slug.js`, the guard applied it (`written`, correct content), and the run finished
     `completed` in 3 turns. **Anti-stall fix made during the proof:** without it the model
     re-proposed the identical write every turn (guard returned `unchanged`) and spun to
     `max-turns`; the loop now dedupes repeated identical read/edit actions and only
     auto-finishes after 2 no-progress turns when a write succeeded and optional validation
     passed (regression: `agent-session.test.js` "dedupes repeated identical writes").
   - Live from-scratch proof (2026-07-25, `gpt-oss-20b`): the exact basketball-page
     prompt ran in an empty workspace after bounded DuckDuckGo library research, wrote
     `index.html` through the guarded writer, passed structured workspace validation, and
     passed Chromium page-error + visible-frame-change checks. The proof added agent-native
     `web_research`, preflight/post-edit validation feedback, transient LM retry, root
     `list_dir`, nested-directory writes, same-turn mutation conflict protection, and
     no-progress/research-loop caps. Regression:
     `unit-tests-js/agent-project-creation.live.test.js` plus the agent executor/session suites.
   - Next steps to close (in order):
     1. Live **anchored `edit_file`** on an existing repo file: prove the diff guard applies a
        unique-anchor edit, then a hash-mismatch case rolls back (offline-covered today, not live).
     2. Wire a **post-edit validation command** into the agent finish path (policy-gated
        `run_cmd`, e.g. the file's test/lint) and record its result in the session `result.json`.
        The generic validation callback/result persistence and browser-backed live proof are
        landed; command-policy integration remains.
     3. Extend the same guarded `write_file`/`edit_file` action into the **headless**
        run/workspace analyzer flow (interactive path is the proven reference).
   - Exit criteria: diff guard blocks mismatched writes, rollback path verified, and a validation
     command runs after the edit with its result recorded — proven on a real run.

4) Usable CLI + docs — **advanced 2026-07-15 (interactive UI is now the primary interface)**
   - Delivered: interactive Ink+htm agent UI as the default front door (file picker, live
     progress, inline permission/diff approval) with all direct subcommands preserved for
     scripting (`decideUiLaunch` routing; `--headless`/non-TTY fall back to the classic pipeline);
     README leads with the UI, AGENTS documents the agent loop + schema + file map. Routing is
     offline-covered (`ui-route`, `agent-ui`, `agent-ui-app` suites).
   - Remaining: onboarding quickstart polish, config/profile summary, minimal regression
     benchmark; make `--model auto` the documented default when the configured model is missing.
   - Proof runs: `samples/get-started` walkthrough (interactive + `--headless`);
     `npm run sample:lmstudio-json-series`.
   - Exit criteria: docs match CLI behavior and sample runs complete without manual patching.

5) Idle-vs-stall observability — **NOTE / future fix (not started)**
   - Problem: when no computation is running, the operator cannot tell whether MiniPhi is
     *waiting for input* or *stalled/hung*. A static UI frame or silent stdout looks identical for:
     an unanswered permission prompt, the empty task box / file picker, a long in-flight model
     turn, a blocked headless approver, or an actually-wedged LM Studio call. This is the "stall"
     users report — often it is just waiting for input, but nothing distinguishes that from a bug.
   - Where it bites (code hooks for whoever picks this up):
     - Interactive UI: `src/ui/components/progress-pane.js` animates the spinner only while
       `running` and shows a generic "thinking…"; it does not distinguish "awaiting your keypress"
       (a pending `permission-request`, the prompt box, the picker) from "awaiting the model", and
       gives no elapsed time, so a hang looks like normal work. `src/ui/app.js` holds the
       `running`/`pending` state that a clearer banner would key off.
     - Agent loop: `AgentSession._requestTurn` (`src/agent/agent-session.js`) has no per-turn
       watchdog beyond the REST client timeout; between the request and a response there is no
       heartbeat. `_budgetExhausted()`/`sessionDeadline` bound the whole run but do not surface a
       mid-turn stall.
     - Headless: a caller that does not subscribe to session events sees nothing during model
       calls (looks stalled); the `ask`-policy readline approver waits on stdin with only its
       one-line question printed.
   - Proposed fix:
     - Explicit operator-facing state: `WAITING FOR YOU` (permission/prompt/picker) vs `WORKING`
       (model/tool in flight) vs `IDLE/DONE`; emit an `awaiting-approval` / `awaiting-input`
       status from `AgentSession` so both UI and headless can render it.
     - Heartbeat on long model turns: elapsed timer ("waiting on <model> — Ns") wired off a
       per-turn watchdog; consider streaming (`chatStream`) so partial tokens prove liveness.
     - Stall watchdog: if a turn exceeds a threshold with no tokens/response, surface a `stalled?`
       hint plus the LM Studio wedge remedy (see the "Known live-run hazard" note) and a canonical
       `stall`/`session-timeout` stop reason instead of hanging silently.
   - Exit criteria: at any moment the operator can tell from the screen (or headless output)
     whether MiniPhi is computing, waiting on them, or stalled; a hung model turn is reported
     within a bounded time rather than appearing as indefinite "thinking".

### v0.2 Reliability, reuse, and model management
Objective: make the agent predictable across sessions, workloads, and model inventories.

Exit criteria:
- Deliberate model lifecycle: adopt LM Studio `/api/v1` (`models/load`, `models/unload`) so
  MiniPhi loads the selected model at a task-appropriate context instead of inheriting the
  JIT default, and can unload to free memory before loading a larger model.
- `--model auto` honored from config (`defaults.model: "auto"`) with the catalog ranking
  persisted per run; presets reduced to fallback hints, not the source of truth.
- Prompt and plan reuse reduce repeated tokens without breaking schema validity.
- Helper and command libraries show consistent reuse across at least two different repos.
- Offline evaluation harness (ai-agent-evals style) runs locally and records JSON compliance +
  tool-call accuracy metrics with a stored report.
- Benchmark compendium (`dev_samples/test_tasks/`) stays in sync with `dev_samples/task-tests.md`;
  category-balanced `benchmark general` suite runs offline in unit tests.
- Live `benchmark general --live-lm` retry ladders stay deterministic with persisted attempt
  telemetry and canonical stop reasons (carried over from v0.1 hardening).

Nitpick exit criteria (unchanged):
- `miniphi nitpick --task "<long-form task>" --rounds 2` completes with JSON-only
  plan/draft/critique/revision steps and stores a session under `.miniphi/nitpick/`.
- `miniphi nitpick --blind --task "<long-form task>"` captures research + web snapshots and
  produces a final draft using cited sources.

Deferred within v0.2:
- Nitpick evaluation harness; helper script lifecycle (versioning, replay, output summaries);
  full external benchmark repo mirroring (WebArena/OSWorld-scale assets).

### v0.3 Distribution and sustainability
Objective: prepare MiniPhi for wider distribution and long-term maintenance.

Exit criteria:
- Packaging and release process documented and repeatable (`npm publish` readiness).
- Retention policy/pruning for `.miniphi/` artifacts implemented (cache-prune defaults audited).
- Regression coverage spans core agent flows (run/workspace/analyze-file) with clear smoke
  checks, plus the live-gated tier documented as a pre-release checklist.

Focus areas:
- Benchmarks coverage beyond Bash recomposition.
- Telemetry and performance summaries (opt-in, local-only).
- Deferred: fallback cache and prompt-composition heuristics to reduce repeated failures.

## Testing tiers (run per slice)
- Offline deterministic: `npm test` — no LM Studio required; live tests self-skip.
- Live gated: `MINIPHI_LMSTUDIO_INTEGRATION=1 npm test` (or targeted
  `node --test unit-tests-js/lmstudio-code-generation.live.test.js
  unit-tests-js/cli-bash-advanced.test.js`) — asserts on executed model output.
- Live proofs: real `miniphi` runs recorded in the active slice with prompt journals and stop
  reasons; prefer `--model auto` so proofs exercise the catalog too.
- Known live-run hazard (2026-07-15): after several long `max_tokens: -1` generations the LM
  Studio server can wedge — the model still reports `state: loaded` but even a 30-token
  completion times out, so every MiniPhi prompt hits its 120s timeout (decomposer disables
  itself, analysis emits fallback JSON; runs still exit 0 with canonical stop reasons).
  Fix: restart the LM Studio app (reload the model), then rerun. Prevention: before a proof
  run, probe with a tiny real completion (e.g. POST /api/v0/chat/completions, max_tokens 30),
  not just `lmstudio-health`/`/models`, which both look healthy while wedged. Candidate v0.2
  automation: extend the health gate with a micro-completion probe + stall stop reason.

## Operating checklist (for each slice)
- Run a real `miniphi` task or sample; capture prompt journal and stop reason.
- Apply JSON-backed edits and summarize diffs.
- Record failures and fallbacks in `.miniphi/` before iterating.
- Close the slice only when exit criteria and proof runs are satisfied, then move its detailed
  evidence log to git history (keep only the closing proof here).

## Governance
- ROADMAP.md is the source of truth; AGENTS.md carries the active-slice summary and proofs.
- Keep items small and outcome-based; defer lower-priority work when adding new items.
