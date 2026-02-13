# MiniPhi Optimization Roadmap (v0.1)

This document tracks cross-cutting optimizations for MiniPhi so improvements span the full `src/`
pipeline (CLI orchestration, LM Studio integration, memory, prompts, and workspace profiling), not
just `src/libs/efficient-log-analyzer.js`.

If a new roadmap item is added, defer or remove a lower-priority one so the list stays short and
actionable. Every item must have explicit exit criteria.

## Project status and goals

MiniPhi is a local LM Studio-powered file-manipulation agent with JSON-first prompt contracts,
strict schema validation, and persistent `.miniphi/` telemetry. The goals for v0.1 are:

- Reliable planner -> actions -> edits -> summary loop using LM Studio with strict JSON.
- Safe local-only operations with command authorization, timeouts, and clear stop reasons.
- Consistent instrumentation for prompt/response artifacts (including tool calls/definitions).
- Repeatable workflows across `run`, `analyze-file`, `workspace`, `recompose`, and `benchmark`.

The current architecture is functional but concentrated in a large CLI entrypoint (`src/index.js`)
and a few oversized libraries, which makes improvements drift toward the log analyzer instead of the
full pipeline.

## Redundancy and optimization candidates (observed)

These are the main areas where duplication or confusion is likely to slow development:

- CLI orchestration is monolithic: `src/index.js` handles parsing, setup, execution, logging, and
  post-processing for all commands, creating repeated patterns and a single large change surface.
- Workspace scanning was duplicated across `workspace-profiler` and
  `workspace-context-utils`; the shared cache layer is now in place, but we still need to keep all
  call sites on the same resolver path.
- Prompt logging overlaps: `src/libs/prompt-recorder.js` and
  `src/libs/prompt-step-journal.js` both persist prompt/response data with similar metadata but
  different shapes, risking divergence.
- Memory storage duplication: `src/libs/miniphi-memory.js` and
  `src/libs/global-memory.js` both implement directory layout + JSON index management with similar
  boilerplate.
- JSON parsing/validation paths are scattered: `src/libs/lmstudio-handler.js`,
  `src/libs/efficient-log-analyzer.js`, and `src/libs/core-utils.js` each handle JSON extraction or
  schema enforcement separately.
- Legacy/compatibility files are small but add cognitive overhead; keep only with a documented
  compatibility reason.
- Benchmark and recompose utilities are instrumentation; improvements should target the runtime
  pipeline rather than editing these scripts to mask runtime issues.

## Optimization roadmap (ordered by priority)

### P0 - Modularize CLI orchestration

Move command-specific flows out of `src/index.js` into dedicated modules so changes are localized.

Exit criteria:
- `src/index.js` only handles argument parsing, help, and command dispatch.
- Each command (`run`, `analyze-file`, `workspace`, `recompose`, `benchmark`, etc.) has a dedicated
  module under `src/commands/` (or equivalent) with its own unit tests or smoke coverage.
- CLI behavior and help output remain unchanged for existing commands.

Status:
- Command handlers for `run`, `analyze-file`, `workspace`, `recompose`, `benchmark`, `prompt-template`,
  `web-research`, `history-notes`, `command-library`, and `helpers` now live under `src/commands/`;
  keep these explicit entrypoints, but make natural-language prompts the default path into the same
  command flows (implicit `miniphi "<task>"` should reach these handlers when appropriate).
- Workspace snapshot + command-library/prompt-composition helpers moved into
  `src/libs/workspace-snapshot.js` so `src/index.js` can stay focused on CLI dispatch.
- Recompose harness + general-purpose benchmark helpers live under `src/libs/recompose-harness.js` and
  `src/libs/benchmark-general.js`.
- LM Studio runtime bootstrap (handler init, compatibility probe, prompt scoring wiring) now lives in
  `src/libs/lmstudio-runtime.js`.
- Remaining extraction: the core run/analyze/workspace orchestration still lives in `src/index.js`.

### P0 - Unified JSON schema enforcement + fallback

Centralize JSON parsing/validation and deterministic fallbacks so every LM Studio call uses the same
path (run/analyze/workspace/decomposer/navigator).

Exit criteria:
- A single JSON validation module is used by `LMStudioHandler`, `EfficientLogAnalyzer`, and prompt
  decomposition/navigation flows.
- All model calls set `response_format=json_schema` with explicit schema ids; parsing strips
  `<think>` blocks and JSON fences (including short preambles) while rejecting prose, and non-JSON
  responses produce deterministic fallback payloads.
- Prompt/response artifacts retain response text, tool_calls, and tool_definitions for scoring.

Status:
- Complete. Remaining runtime schema-validation call sites now consume the shared parse-outcome contract.
- EfficientLogAnalyzer now skips JSON repair heuristics and relies on schema-only retries plus deterministic fallbacks to keep JSON-first behavior consistent.
- `json-schema-utils` now exposes shared schema-validation outcome helpers
  (`classifyJsonSchemaValidation`, `validateJsonObjectAgainstSchema`) so
  `PromptDecomposer` and `ApiNavigator` consume one strict parse path
  (preamble detection + invalid JSON + schema-invalid classification) instead of duplicating
  response interpretation logic.
- PromptDecomposer now reuses schema-validation artifacts from the request call and no longer
  re-validates the same LM Studio payload during parse; ApiNavigator follows the same pattern.
- Fixed a branch-focus regression in `PromptDecomposer._parsePlan()` where omitted
  `--plan-branch` could reference `focus` before initialization and force fallbacks.
- Regression coverage:
  `node --test unit-tests-js/json-schema-utils.test.js unit-tests-js/prompt-decomposer-focus.test.js`
  plus full `npm test` (`72/72` passing).
- Live proof runs:
  `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file for shared JSON parsing regression checks" --summary-levels 1 --prompt-journal p2-json-parse-analyze-20260210-1919 --prompt-journal-status paused --no-stream --session-timeout 900`
  and
  `node ..\\..\\src\\index.js workspace --task "Audit this sample workspace and propose next shell checks." --prompt-journal p2-json-parse-workspace-sample-20260210-1923 --prompt-journal-status paused --no-stream --session-timeout 900`
  both returned non-fallback JSON with `response_format=json_schema` + schema-valid prompt exchanges.
- `PromptSchemaRegistry` now exposes `validateOutcome()` and `validate()` now carries
  shared status metadata (`status`, `error`, `preambleDetected`) while preserving
  compatibility fields (`valid`, `errors`, `parsed`) for existing callers.
- Remaining runtime call sites (`LMStudioHandler`, `EfficientLogAnalyzer`) now consume
  the same shared parse-outcome contract through `PromptSchemaRegistry`.
- Schema-validation prompt artifacts now preserve status metadata consistently across
  planner/navigator/main analysis exchanges (`schemaValidation.status`, e.g. `ok`,
  `schema_invalid`, `invalid_json`, `preamble_detected`).
- Regression coverage:
  `node --test unit-tests-js/prompt-schema-registry.test.js unit-tests-js/json-schema-utils.test.js`
  plus full `npm test` (`77/77` passing).
- Additional live proof runs:
  `node src/index.js run --cmd "node -v" --task "Validate shared schema outcome metadata on run flow" --command-policy allow --assume-yes --no-stream --session-timeout 300 --prompt-journal p2-shared-schema-run-20260210-1945 --prompt-journal-status paused`
  and
  `node ..\\..\\src\\index.js workspace --task "Validate schema validation status propagation after shared contract update." --prompt-journal p2-shared-schema-workspace-20260211-0600 --prompt-journal-status paused --no-stream --session-timeout 900`
  completed with JSON responses; prompt exchanges show schema-valid status metadata for
  `prompt-plan`, `navigation-plan`, and `log-analysis`.

### P0 - Shared persistence helpers

Reduce duplication between project and global memory by extracting common read/write/index helpers.

Exit criteria:
- `MiniPhiMemory` and `GlobalMiniPhiMemory` reuse a shared helper module for JSON file management and
  index updates.
- No behavior changes to `.miniphi/` or `~/.miniphi/` layout.
- All existing tests for memory/prompt indexing still pass.

Status:
- Complete. `memory-store-utils` now provides shared index upsert helpers used by project/global
  memory stores; `npm test` passes.

### P1 - Workspace scan and cache unification

Unify workspace traversal so directory walking happens once per run and is reused across modules.

Exit criteria:
- `WorkspaceProfiler` and `workspace-context-utils` share a common scanning/cache layer.
- A single scan populates manifests, stats, and ignored directories for all commands.
- Workspace profiling output remains identical (aside from stable ordering).

Status:
- In progress. `src/libs/workspace-scanner.js` now exposes
  `createWorkspaceScanCache()`, `resolveWorkspaceScan()`, and `resolveWorkspaceScanSync()` so
  async/sync callers share one cache key contract and one traversal implementation.
- `workspace-context-utils`, `workspace-profiler`, `workspace-snapshot`, and
  `recompose-tester` now thread the same `scanCache` object so list + manifest + profile calls can
  reuse one scan result during the run.
- Directory entries are now name-sorted in `workspace-scanner` to keep manifest ordering stable and
  deterministic.
- New regression coverage:
  `node --test unit-tests-js/workspace-scan-cache.test.js unit-tests-js/cli-workspace-scan.test.js unit-tests-js/cli-smoke.test.js`
  plus full `npm test` (`40/40` passing).
- Live proof runs:
  `node src/index.js workspace --task "Audit this repo workspace and report top optimization targets with file references." --prompt-journal p1-workspace-cache-20260207-133119 --prompt-journal-status paused --no-stream --session-timeout 600`
  recorded deterministic fallback stop metadata (`analysis-error`, context overflow),
  and `node ..\\..\\src\\index.js workspace --task "Audit this sample workspace and summarize key files." --prompt-journal p1-workspace-cache-sample-20260207-133119 --prompt-journal-status paused --no-stream --session-timeout 600`
  completed with non-fallback JSON and null stop reason fields.

### P1 - Prompt logging consolidation

Clarify the roles of `PromptRecorder` and `PromptStepJournal` or merge overlapping payloads.

Exit criteria:
- A documented contract defines what each artifact captures and how they link to each other.
- Duplicated fields are removed or canonicalized across the two systems.
- Prompt journals still contain the full prompt, response, and tool metadata required by evals.

Status:
- In progress. PromptStepJournal now stores `tool_calls`/`tool_definitions` in the same shape as
  prompt exchanges and the contract is documented in AGENTS.md; analysis steps now link to prompt
  exchanges when LM Studio responses are recorded. Plan/navigation journal steps now store raw JSON
  responses (human-readable blocks move to metadata) so stepwise audits match schema fidelity.
  PromptRecorder now canonicalizes request/response fields (`response_format`, `rawResponseText`,
  `promptText`) to trim duplicate payloads; remaining work is to decide how to further compact
  prompt/response data across recorder and journals without losing eval coverage. PromptRecorder
  now normalizes `tool_calls`/`tool_definitions` from camelCase response payloads so evaluator
  tooling sees consistent shapes and now applies the same canonicalization for request-side
  `tool_definitions`.
  Analysis steps now record stop-reason fields (reason/code/detail) from analysis diagnostics so
  session timeouts and invalid-response fallbacks are visible in stepwise journals.
- Prompt logging normalization now shares a single utility module (`src/libs/prompt-log-normalizer.js`)
  used by both `PromptRecorder` and `PromptStepJournal`, so request/response/tool metadata
  canonicalization happens in one place.
- Prompt exchanges now retain canonical tool metadata keys even when no tools are present:
  `response.tool_calls`, `response.tool_definitions`, and `request.tool_definitions` persist as
  `null`/`[]` instead of being dropped, so eval/report tooling can score every exchange with a
  deterministic shape.
- Step journals now normalize object responses before persistence, ensuring deterministic JSON text
  snapshots and canonical `tool_calls`/`tool_definitions` fields even when callers pass camelCase
  payloads.
- Prompt error payload canonicalization now extends to task-execution persistence:
  `task-execution-register` and `prompt-recorder` both normalize `error.stop_reason`,
  `error.stop_reason_code`, and `error.stop_reason_detail` through
  `prompt-log-normalizer`.
- Persisted stop-reason detail now prefers explicit error text over placeholder codes when both are
  present (for example, keeps `session-timeout: session deadline exceeded.` instead of
  `analysis-error`), reducing low-signal diagnostics in execution artifacts.
- Regression coverage added:
  `node --test unit-tests-js/prompt-step-journal.test.js unit-tests-js/prompt-recorder.test.js unit-tests-js/task-execution-register-stop-reason.test.js unit-tests-js/cli-implicit-run.test.js unit-tests-js/miniphi-memory-stop-reason.test.js`.
- Additional regression coverage:
  `node --test unit-tests-js/prompt-recorder.test.js` now validates that tool metadata keys remain
  present when no tools are supplied.
- Live proof run:
  `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file for prompt logging proof" --summary-levels 0 --prompt-journal p1-logging-proof-20260207-215410 --prompt-journal-status paused --no-stream --no-navigator --session-timeout 300`
  produced canonical prompt exchange fields in `.miniphi/prompt-exchanges/9a7c2d51-8457-4b50-bf32-033cc610286a.json`
  and canonical journal tool metadata in
  `.miniphi/prompt-exchanges/stepwise/p1-logging-proof-20260207-215410/steps/step-001.json`.
- Live proof run:
  `node src/index.js run --cmd "node -v" --task "Post-patch prompt logging check" --command-policy allow --assume-yes --no-stream --session-timeout 300 --prompt-journal run-live-20260213-toolmeta --prompt-journal-status paused`
  persisted deterministic tool metadata keys in `.miniphi/prompt-exchanges/f4c403dd-2b1d-476a-b6b2-3afe696cfb7a.json`;
  `node scripts/local-eval-report.js --limit 1 --output .miniphi/evals/local-eval-report-codex-20260213-limit1.json`
  reported 100% coverage for `toolCalls` + `toolDefinitions` on the newest exchange.
- Live proof runs:
  `node src/index.js "Summarize node version output with implicit routing" --cmd "node -v" --no-stream --no-summary --cwd . --prompt-journal implicit-run-live-proof --prompt-journal-status paused --session-timeout 1 --command-policy allow --assume-yes`
  validated implicit `"<task>" + --cmd` routing with canonical stop fields in
  `.miniphi/indices/executions-index.json`.
  `node src/index.js run --config <temp-rest-failure-config> --no-health --cmd 'node -e "console.log(Math.random())"' --task "Force REST prompt failure canonicalization proof 2" --no-stream --no-summary --command-policy allow --assume-yes --session-timeout 90`
  validated canonical task-execution error stop fields in
  `.miniphi/executions/07df17bb-c22c-418e-b34d-4adc55683837/task-execution.json`.

### P1 - LM Studio transport and error taxonomy

Normalize REST/WS fallback, error classification, and telemetry for all LM Studio calls.

Exit criteria:
- A single place resolves LM Studio endpoints and transport choices.
- Errors carry consistent codes/metadata for timeouts, schema failures, and transport fallbacks.
- Session timeouts and retry caps are enforced uniformly across handlers and analyzers.

Status:
- In progress. Shared error classification now lives in `src/libs/lmstudio-error-utils.js` and is
  used by `lmstudio-handler`, `api-navigator`, and `prompt-decomposer`; LM Studio bootstrap +
  compatibility checks moved into `src/libs/lmstudio-runtime.js`, and endpoint/transport resolution
  now flows through `src/libs/lmstudio-endpoints.js` with shared WS/REST base wiring. Remaining work:
  align error metadata payloads across handlers/analyzers (navigator/decomposer now record
  stop-reason codes/details; invalid-response classification catches "no valid JSON") and align
  session timeout + retry caps. Model load failures due to LM Studio resource guardrails now
  fall back to REST-only when available (WS disabled). Session timeout guardrails now auto-skip
  planner/navigator prompts when the session budget is at or below the prompt timeout. A REST
  health gate now probes LM Studio before prompting (skips when transport is forced to WS) and
  persists stop reasons if the probe fails; when /status reports a smaller context length, the
  run now clamps the prompt context length and updates the REST client default to reduce
  context-overflow failures. Status field parsing is now centralized in
  `src/libs/lmstudio-status-utils.js` and reused by health probes, workspace status snapshots,
  and runtime compatibility checks.
- Stop-reason taxonomy now normalizes to canonical codes (`rest-failure`, `connection`,
  `timeout`, `network`, `invalid-response`, `protocol`, `context-overflow`,
  `session-timeout`) with human labels via `lmstudio-error-utils`.
- LM Studio execution telemetry now includes normalized `reasonLabel` plus
  `stop_reason`/`stop_reason_code`/`stop_reason_detail` in both `LMStudioHandler` task events and
  `LMStudioRestClient` request events, aligning analyzer/navigator/decomposer stop metadata.
- Session-capped request timeout math is now shared by `api-navigator` and
  `prompt-decomposer` through `resolveSessionCappedTimeoutMs` in `runtime-defaults`.
- `LMStudioRestClient.getStatus()` now reports `ok: false` when both `/status` and `/models`
  fail, avoiding false healthy snapshots on connection failures.
- Workspace-summary analysis now applies conservative compaction defaults and a hard prompt budget
  cap (`2200` tokens) with dataset-mode truncation fallback, mitigating `n_keep >= n_ctx` failures
  when LM Studio reports incomplete context metadata for 4k runtime profiles.
- Nested decomposition context now threads branch-focused sub-prompt hints end-to-end:
  `core-utils` adds `buildFocusedPlanSegments()`, PromptDecomposer emits deterministic `focus`
  blocks (`focusBranch`, `focusReason`, `nextSubpromptBranch`), and run/analyze/workspace prompt
  metadata now sets `subContext` plus task-plan focus fields so model routing can select profiles
  using task + branch context.
- Prompt decomposition records persisted under `.miniphi/prompt-exchanges/decompositions/` and
  stepwise journals now include focus metadata (`focusBranch`, `focusSegmentBlock`,
  `nextSubpromptBranch`) for resumable nested follow-ups.
- Regression coverage added:
  `node --test unit-tests-js/plan-focus-segments.test.js unit-tests-js/prompt-decomposer-focus.test.js`
  plus full `npm test` (`47/47` passing).
- Regression coverage added:
  `node --test unit-tests-js/lmstudio-api-status.test.js unit-tests-js/lmstudio-error-utils.test.js unit-tests-js/runtime-defaults.test.js`
  plus full `npm test` (`56/56` passing).
- Live proof run:
  `node src/index.js workspace --task "Audit this repo workspace and report top optimization targets with file references." --prompt-journal p1-overflow-fix-20260207-215410 --prompt-journal-status paused --no-stream --session-timeout 600`
  completed without fallback; step artifact records compaction metadata under
  `.miniphi/prompt-exchanges/stepwise/p1-overflow-fix-20260207-215410/steps/step-001.json`.
- Live proof run:
  `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file and prioritize nested sub-prompts for follow-up checks." --summary-levels 1 --prompt-id p1-nested-focus-20260207 --prompt-journal p1-nested-focus-20260207 --prompt-journal-status paused --no-stream --no-navigator --session-timeout 900 --plan-branch 1`
  completed with non-fallback JSON and branch-focused plan context recorded in
  `.miniphi/prompt-exchanges/stepwise/p1-nested-focus-20260207/steps/step-001.json` and
  `.miniphi/prompt-exchanges/2d6c14c6-fd64-436e-81f2-6b80db419c28.json`.
- Live proof run:
  `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file and prioritize nested sub-prompts for follow-up checks." --summary-levels 1 --prompt-id p1-nested-focus-20260207 --prompt-journal p1-nested-focus-20260207 --prompt-journal-status paused --no-stream --no-navigator --session-timeout 900 --plan-branch 1.3`
  resumed the cached decomposition with branch focus continuity (`branch: 1.3`,
  `focusBranch: 1.3`, `focusReason: requested-branch`) in
  `.miniphi/prompt-exchanges/stepwise/p1-nested-focus-20260207/steps/step-005.json`.
- Live proof run:
  `node src/index.js lmstudio-health --config <temp-config-with-lmStudio.rest.baseUrl=http://127.0.0.1:1> --timeout 2 --json`
  now reports deterministic failure payload (`ok: false`, `stop_reason: rest-failure`,
  `stop_reason_code: rest-failure`) instead of a false healthy status when REST is unreachable.
- Stop-reason persistence closeout:
  `.miniphi` writers now canonicalize stop reasons through `buildStopReasonInfo` in
  `miniphi-memory` (execution/health/nitpick/fallback cache), prompt journal metadata/notes,
  prompt-exchange response normalization, and recompose step-events. Legacy strings such as
  `fallback`, `partial-fallback`, `offline-fallback`, `invalid-json`, `lmstudio-health`,
  `lmstudio-protocol`, `command-denied`, and `no-token-timeout` now normalize to canonical codes.
- One-shot historical normalization command:
  `migrate-stop-reasons` now scans existing `.miniphi/**/*.json` artifacts and rewrites legacy
  stop reason aliases in-place (`--dry-run`, `--json`, `--strict`, and `--parse-error-report`
  supported, optional `--include-global` for `~/.miniphi`).
- Regression coverage:
  `node --test unit-tests-js/miniphi-memory-stop-reason.test.js unit-tests-js/lmstudio-error-utils.test.js unit-tests-js/prompt-recorder.test.js unit-tests-js/prompt-step-journal.test.js unit-tests-js/task-execution-register-stop-reason.test.js unit-tests-js/cli-implicit-run.test.js unit-tests-js/stop-reason-migrator.test.js unit-tests-js/cli-migrate-stop-reasons.test.js`
  plus full `npm test` (`69/69` passing).
- Live proof runs:
  `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file for stop reason canonicalization proof" --summary-levels 0 --prompt-journal p1-stop-reason-canonical-20260210-045239 --prompt-journal-status paused --no-stream --no-navigator --session-timeout 300`
  and
  `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Timeout proof for canonical stop reason v2" --summary-levels 0 --prompt-journal p1-stop-reason-timeout2-20260210-045626 --prompt-journal-status paused --no-stream --no-navigator --session-timeout 1`
  persisted canonical stop reasons in `.miniphi/indices/executions-index.json` and corresponding
  stepwise session notes.
  `node src/index.js run --cmd "node -v" --task "Timeout detail preference proof" --no-stream --no-summary --session-timeout 1 --command-policy allow --assume-yes`
  persisted canonical timeout detail text (`session-timeout: session deadline exceeded.`) in
  `.miniphi/executions/00da664c-f88c-4582-ad42-a2484dc885bb/execution.json`.
  `node src/index.js migrate-stop-reasons --json`
  migrated historical local artifacts in one pass (`filesScanned: 1157`, `filesChanged: 142`,
  `fieldsUpdated: 308`, `writeErrors: 0`).
  `node src/index.js migrate-stop-reasons --history-root . --dry-run --strict --parse-error-report --json`
  now fails fast for CI when malformed JSON exists and reports the exact malformed path list in
  `parseErrorFiles`.

### P2 - Legacy/ad-hoc cleanup pass

Audit small compatibility modules and move or remove only when the dependency surface is explicit.

Exit criteria:
- Each legacy module has a documented owner and reason to exist, or it is removed with references
  updated in scripts/tests.
- Benchmark/recompose tools remain functional and unchanged in intent.

Status:
- In progress. Removed `src/libs/lms-phi4.js` (unused legacy shim) and moved internal source fully
  onto direct `lmstudio-handler` imports.
- Added regression guard `unit-tests-js/legacy-module-cleanup.test.js` to assert the legacy shim
  stays removed and source imports do not regress.
- Validation:
  `node --test unit-tests-js/legacy-module-cleanup.test.js` and full `npm test` (`66/66` passing).
- Live proof run:
  `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "P2 legacy cleanup proof run" --summary-levels 0 --prompt-journal p2-legacy-cleanup-20260210 --prompt-journal-status paused --no-stream --no-navigator --session-timeout 300`
  completed with non-fallback JSON summary and persisted prompt-journal artifacts.
- Recompose/benchmark guard proof:
  `node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean --recompose-mode offline`
  still completes and writes report artifacts after the legacy shim removal (`recompose-report.json`
  + prompt logs), confirming instrumentation remains functional.

## Focus rule (guardrail)

Avoid changes that touch only `src/libs/efficient-log-analyzer.js` unless the issue is explicitly a
log-analysis defect. For new features or refactors, inspect `src/index.js` and the adjacent runtime
libraries (`lmstudio-handler`, `prompt-*`, `workspace-*`, `miniphi-memory`, `cli-executor`) so
improvements target the entire pipeline.
