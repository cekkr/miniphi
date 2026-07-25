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
- Context is budgeted, layered, and reshapeable — never a growing transcript. Every prompt is a
  selection over the context graph (priority / importance / subtask level) sized to the model's
  loaded window; what does not fit degrades to a digest or a requestable stub, and the model can
  reform its own context through `context_ops` instead of guessing.
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
- Models are JIT-loaded at the server default context (8192–16384 on the reference hosts); MiniPhi
  now *sizes its prompts* to that window (slice 5) but still cannot *choose* it
  (LM Studio `/api/v1/models/load` exists for this — v0.2).
- The layered context graph is wired into the interactive agent only; the headless
  `workspace`/`run`/`analyze-file` flows still assemble ad-hoc prompt blocks.
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

5) Multi-layered context + context graph language — **CORE LANDED 2026-07-25 (live-proven)**
   - Problem: LM Studio prompts are hard-capped by the model's *loaded* context window (8k–16k on
     the reference hosts), yet the agent appended every observation to one flat transcript and fed
     the last N entries. Long tasks therefore lost the task itself, corrective nudges, or the file
     under edit — whichever fell off the window — and there was no way to re-establish the context
     needed to continue a sub-conversation.
   - Delivered (`src/libs/context-graph.js` + `src/agent/agent-session.js`):
     - Context is a graph of layered nodes selected per prompt against a token budget on three
       axes: **priority** (layer: mission/contract > plan > subtask > evidence > scratch),
       **importance** (0..1, decayed per turn, boostable), and **subtask level** (depth in the task
       tree). `mission`/`contract` are retained invariants; everything else degrades to a digest,
       then to a one-line stub in a requestable "Context index".
     - The budget follows reality: `deriveContextBudget` sizes it from `loaded_context_length`
       (`resolveContextWindow` in `model-catalog.js`) minus the system-prompt/schema/output
       reserve; an unknown window keeps the conservative default instead of trusting
       `max_context_length`. Override with `--context-budget` / `config.context.budgetTokens`.
     - **Context graph language**: the `agent-action` schema gained `context_ops` /
       `context_sufficient` / `context_gap` (also standalone in `docs/prompts/context-ops.schema.json`)
       so the model reshapes its own context — `expand`, `pin`, `boost`, `collapse`, `drop`,
       `note`, `link`, `open_subtask`, `close_subtask`, `focus`. Ops are applied deterministically;
       rejections and no-ops are fed back so the model learns the language across turns.
     - Sub-conversations: `open_subtask` scopes gathered evidence to a level; `close_subtask`
       collapses it into one parent-level outcome node, and `buildSubConversation(id)` rebuilds the
       minimal context (invariants + ancestor spine + own evidence) to resume a branch.
     - `context_sufficient: false` triggers a bounded deterministic **reform** (keyword-matched
       expansion of the nodes covering the stated gap) and one re-prompt; graph state persists to
       `.miniphi/agent-sessions/<id>/context-graph.json` with stable node ids.
   - Live proofs (2026-07-25, `gpt-oss-20b` at 16384 loaded context, budget forced to 700 tokens):
     1. Wire contract: LM Studio accepted the extended schema and returned
        `{"op":"expand","node":"c3"}` selecting the *relevant* digested node out of two.
     2. Task under pressure: with two files larger than the whole budget, the run ended
        `completed` having written the value buried in the right one; the mission and contract
        layers stayed loaded while evidence was demoted.
     3. Graph-only content: with the answer held **only** in a digested research node (on no disk,
        so no read/search could reach it), the model emitted `expand`, received the window, and
        wrote the correct value — `completed`.
   - Fixes made during the proofs (each regression-covered):
     - An `expand` that cannot fit returns the largest window the budget allows instead of silently
       staying a digest, and `{"op":"expand","offset":N}` pages that window through a long node so
       its tail stays reachable. Before paging existed, a model that needed a value ~6k chars into a
       file wrote a fabricated placeholder instead.
     - Read output is truncated **once**, with its `[output truncated]` marker intact. A second
       blind 1200-char slice in the session used to cut the marker off, so the model believed it had
       seen a whole file — the direct cause of that fabricated placeholder.
     - Repeated no-op ops are reported back (`noops`) instead of looking applied; only a repeat at
       the *same* offset is a no-op.
     - Corrective feedback (schema violations, duplicate/invalid actions, rejected ops, and the
       reform gap note) moved from the droppable `scratch` layer into retained-with-TTL nodes after
       live runs showed the nudge itself being demoted to a stub under exactly the budget pressure
       it was meant to correct. Retained layers are population-capped so they cannot grow unbounded.
     - A turn that only reshapes context earns a bounded re-prompt instead of counting as
       "no actions"; `list_dir "/"` resolves to the workspace root.
   - Regression: `unit-tests-js/context-graph.test.js` (22), `agent-context-layers.test.js` (11),
     live-gated `agent-context-graph.live.test.js` (2, both passing against `gpt-oss-20b`). Full
     offline suite after the slice: 212 tests, 204 passing, 8 live-gated skips, 0 failures.
     Run live files alone — concurrent long generations wedge LM Studio on the reference host
     (`fetch failed` on the chat route while `/api/v0/models` still answers; it recovers on its own).
   - Remaining before close:
     1. Bring the layered context into the **headless** flows (`workspace`, `run`, `analyze-file`)
        so plan-executor outputs and analyzer snippets become nodes instead of ad-hoc blocks.
     2. Resume a persisted graph across sessions (`ContextGraph.fromJSON` is covered; nothing wires
        it into `AgentSession` startup yet).
     3. A live run where the model drives `open_subtask`/`close_subtask` through a multi-file task.
   - Exit criteria: a live task larger than the loaded context window completes without prompt
     overflow, with the graph showing demotion + at least one model-driven reform, and the same
     session resumable from its persisted graph.

6) Idle-vs-stall observability — **DEFERRED to v0.2** (note kept; superseded in priority by slice 5)
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
   - Deferred 2026-07-25 to make room for the multi-layered context slice (one-in-one-out rule).

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
