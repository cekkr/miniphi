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
- Test suite: 133 tests — 128 offline deterministic, 5 live-gated (code generation, targeted
  bug-fix editing, stateful class generation, bash multi-file prompts) — 0 failures.

Known gaps (drive the slices below):
- Plans are produced but not executed: steps and `recommended_tools` never become actions.
- `needs_more_context`/`missing_snippets` are printed, not auto-fetched and re-prompted.
- Model-proposed edits only apply inside recompose; the main loop has no guarded edit path.
- `model-presets.js` defaults drift from installed models (default preset model is not even
  installed on the reference host); auto-selection exists but is opt-in.
- Models are JIT-loaded at the server default context (8192 on the reference host); MiniPhi
  cannot yet size context deliberately (LM Studio `/api/v1/models/load` exists for this).

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

2) Plan execution bridge — **ACTIVE**
   - Problem: decomposition now yields actionable trees whose leaves name concrete files and
     commands, but nothing consumes them; likewise the analyzer's `missing_snippets` requests
     die on stdout.
   - Scope:
     - Execute leaf steps of the focused branch: map step descriptions/`recommendation` and
       `recommended_tools` onto the default agent commands (list_dir/read_file/search_text/
       run_cmd), gated by the existing command-policy and danger levels.
     - Auto-fetch `missing_snippets` that resolve to repo-relative paths, attach them as fixed
       references, and re-prompt once instead of only printing the request.
     - Persist per-branch execution status (done/failed/blocked + stop reason) next to the plan
       so `--plan-branch` resumes from the first incomplete branch by default.
   - Caps: reuse decomposition budgets (max actions per branch, session deadline, recursion
     depth); every executed action logged to the prompt journal.
   - Proof run: one live `miniphi "<task>"` against this repo where at least one branch executes
     end-to-end (search/read + follow-up prompt with fetched context) without manual patching.
   - Exit criteria: plan progress artifact written under `.miniphi/`; `missing_snippets`
     round-trip proven (request -> auto-fetch -> re-prompt -> non-fallback JSON); unit tests
     cover action mapping and the snippet round-trip with stubbed clients.

3) Reliable edit pipeline
   - Scope: bring the guarded writer (diff summary + rollback, today recompose-only) into the
     main run/workspace flow behind an `edit_file` action; edits arrive as schema-validated
     JSON (full-file `content` or find/replace), following the contract already proven by the
     live code-generation tests.
   - Proof runs: a targeted live edit on a repo file with diff summary + rollback verification,
     then a rerun with a prompt journal to confirm determinism; live gated suite stays green
     (`MINIPHI_LMSTUDIO_INTEGRATION=1 node --test unit-tests-js/lmstudio-code-generation.live.test.js`).
   - Exit criteria: diff guard blocks mismatched writes, rollback path verified, and a
     validation command (test/lint) runs after the edit with its result recorded.

4) Usable CLI + docs
   - Scope: onboarding quickstart, config/profile summary, minimal regression benchmark; make
     `--model auto` the documented default posture when the configured model is not installed
     (health gate should say so explicitly).
   - Proof runs: `samples/get-started` walkthrough; `npm run sample:lmstudio-json-series`.
   - Exit criteria: docs match CLI behavior and sample runs complete without manual patching.

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

## Operating checklist (for each slice)
- Run a real `miniphi` task or sample; capture prompt journal and stop reason.
- Apply JSON-backed edits and summarize diffs.
- Record failures and fallbacks in `.miniphi/` before iterating.
- Close the slice only when exit criteria and proof runs are satisfied, then move its detailed
  evidence log to git history (keep only the closing proof here).

## Governance
- ROADMAP.md is the source of truth; AGENTS.md carries the active-slice summary and proofs.
- Keep items small and outcome-based; defer lower-priority work when adding new items.
