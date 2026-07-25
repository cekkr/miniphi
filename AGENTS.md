# MiniPhi — AI Agent Reference

MiniPhi is a **local, LM Studio-powered CLI agent for file manipulation and repo work in the current working directory**. It scans the workspace, compresses long command/log output into high-signal chunks, prompts a locally served model under strict JSON-schema contracts, and leaves a full audit trail under `.miniphi/`. This file is the fast-access operational reference for agents; read it before changing behavior.

Maturity: **v0.1 (Active), pre-release.** The planner → actions → summary loop and strict-JSON validation are shipped; the guarded main-flow **edit** pipeline is not yet wired outside `recompose` (see [Current Status](#12-current-status-known-gaps-and-roadmap-snapshot)).

MiniPhi is **not**: a hosted chatbot, a remote/cloud agent, a general research or multi-agent orchestration platform, or a tool that writes outside the working directory and `.miniphi/`. The `nitpick`, `web-research`, `web-browse`, `recompose`, and `benchmark` commands are auxiliary/development surfaces, not the core file-agent loop. `mistralai/devstral-small-2-2512` is the *preset default*, not a guarantee it is installed — prefer `--model auto`.

---

## 1. Read This First — sources of truth

Source-of-truth order (highest authority first); on conflict, inspect the behavior and fix the mismatch in scope rather than trusting a doc:

1. **[`LICENSE`](LICENSE)** — ISC legal terms.
2. **[`docs/prompts/*.schema.json`](docs/prompts)** — executable JSON contracts every model exchange must satisfy. These override prose.
3. **Current source under [`src/`](src)** and config resolution ([`src/libs/config-loader.js`](src/libs/config-loader.js), [`config.example.json`](config.example.json)).
4. **[`ROADMAP.md`](ROADMAP.md)** — the milestone plan, exit criteria, guiding principles, and "Where we are" status snapshot. This is the roadmap source of truth; **this file carries only the active-slice summary and proofs.**
5. **[`README.md`](README.md)** — user-facing overview, install, quickstart, command overview. Does not prove a command still works.
6. **[`OPTIMIZATIONS.md`](OPTIMIZATIONS.md)** — cross-cutting optimization roadmap for the whole `src/` runtime pipeline.
7. **[`docs/miniphi-cli-implementation.md`](docs/miniphi-cli-implementation.md)** and **[`docs/NodeJS LM Studio API Integration.md`](docs/NodeJS%20LM%20Studio%20API%20Integration.md)** — architecture, compression heuristics, and LM Studio SDK/REST behavior.
8. Historical proof-run logs live in git history (pre-2026-07 revisions of `ROADMAP.md`), not here.

Rules for conflicts: a roadmap does not prove a feature exists; a README does not prove a command runs; a test proves only what it asserts. Running code does not override a JSON-first or local-only principle — the code may be the bug. If a conflict cannot be resolved safely, record it under [Known Gaps](#12-current-status-known-gaps-and-roadmap-snapshot) and ask for direction.

---

## 2. Collaboration and Maintenance Rules

- **Doc sync:** Keep [`README.md`](README.md) (human/user-facing) and this file (maintainer/agent-facing) in sync whenever MiniPhi gains or changes a command, flag, or workflow. User quickstart edits belong in README; JSON contracts, `.miniphi/` layout, deep flag reference, and file ownership belong here or in [`docs/`](docs).
- **Roadmap authority:** [`ROADMAP.md`](ROADMAP.md) owns milestones and exit criteria. When adding a roadmap item, defer or remove a lower-priority one (minimal drift). Move a slice from `Planned` → `Shipped` only after a real proof run.
- **Optimization/backlog recording:** Route cross-cutting optimization ideas to [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md); route long-lived backlog/parking-lot notes to [`docs/studies/notes/`](docs/studies/notes) and git history. Do not turn this file into a changelog.
- **Instrumentation is not scope:** Benchmark/recompose/test scripts are runtime validation. Treat their failures as **runtime bugs** to fix in `src/`; only edit the scripts/tests to expand coverage or logging. Do not edit a test's intent or a generic utility just to make a narrow unit test pass — use tests to improve MiniPhi behavior.
- **Two-tier testing:** `npm test` MUST stay offline and deterministic (stubbed REST clients; live tests self-skip). Live behavior is gated behind `MINIPHI_LMSTUDIO_INTEGRATION=1` and MUST assert on *executed* model output, not just JSON shape.
- **Generated/runtime data:** `.miniphi/` (project) and `~/.miniphi/` (global) are runtime state, gitignored, never the owner of behavior. `dev_samples/test_tasks/*.json` is generated from [`dev_samples/task-tests.md`](dev_samples/task-tests.md) via [`scripts/sync-test-task-catalog.js`](scripts/sync-test-task-catalog.js) — edit the Markdown source, then regenerate.
- **Dirty-tree preservation:** Preserve unrelated working-tree changes; never use destructive cleanup to simplify discovery.
- **No placeholder notes in docs:** Only write optional notes into `.miniphi/history/forgotten-notes.md` when `--forgotten-note` is supplied.
- **Focus:** MiniPhi is a local file-manipulation agent for coding projects. Defer broad research/multi-agent scope until v0.1 exit criteria are met.

---

## 3. Essential Project Principles

Each principle is concrete enough to reject a wrong implementation.

### JSON-first, or fail deterministically
Every model exchange is schema-validated. Embed a schema id from [`docs/prompts/`](docs/prompts), set `response_format=json_schema` via [`buildJsonSchemaResponseFormat`](src/libs/json-schema-utils.js), and validate before use. Non-JSON is failure: strip `<think>`/markdown fences, parse strictly ([`parseStrictJsonObject`](src/libs/core-utils.js)), and on drift emit a **deterministic fallback JSON** — never salvage JSON out of mixed prose. Chunk selection, truncation plans, and `missing_snippets` must be structured fields, never narrative, even when the prose answer is correct.

### Local-only
Edits and helpers operate strictly inside the working directory and `.miniphi/`. No remote writes. Repo-relative path resolution is path-escape-safe ([`resolveWorkspacePath`](src/libs/plan-executor.js)). Web features (`web-research`, `web-browse`, blind `nitpick`) are read-only capture surfaces.

### Fit the live hardware, not static presets
Model choice and context budgets come from the **live** LM Studio inventory (installed models, loaded context, memory), never from presets alone. `--model auto` ranks installed models per task intent. **Never advertise a static `context_length`:** [`LMStudioRestClient`](src/libs/lmstudio-api.js) sends `context_length` only when explicitly configured, because a JIT-loaded model may have a smaller context and LM Studio rejects the request with `400 "Context size has been exceeded"`.

### Decompose small, expand recursively
Never ask a local model for a deep nested artifact in one completion. Ask for a **shallow** plan first (children empty, `requires_subprompt` flags), then expand each flagged branch with a focused compact follow-up, capped by `maxDepth`, `maxExpansions` (default 4), and the session deadline.

### Reproducible and bounded
Every slice closes only after a real `miniphi` run with a recorded stop reason. Cap recursion/retries, enforce helper timeouts, and persist a canonical stop reason so runaway loops cannot hang the CLI.

---

## 4. Critical Implementation Contracts

Named invariants an adjacent edit is most likely to break. Each links its enforcing code and test.

- **Schema-validation contract is shared.** All LM Studio calls (run/analyze/navigator/decomposer/benchmark) build response formats and validate through [`json-schema-utils.js`](src/libs/json-schema-utils.js) and [`PromptSchemaRegistry.validateOutcome`](src/libs/prompt-schema-registry.js). Do not add a bespoke validator. Prompt-decomposer/navigator schemas MUST require `needs_more_context` and `missing_snippets`. Enforced by [`json-schema-utils.test.js`](unit-tests-js/json-schema-utils.test.js), [`prompt-schema-registry.test.js`](unit-tests-js/prompt-schema-registry.test.js).
- **Preamble = invalid.** A `<think>`/markdown preamble before JSON is a hard failure with `stop_reason: preamble_detected`; the fallback is saved, prose is never salvaged. Status metadata (`ok`/`schema_invalid`/`invalid_json`/`preamble_detected`) is preserved in prompt exchanges. Enforced by [`efficient-log-analyzer-stop.test.js`](unit-tests-js/efficient-log-analyzer-stop.test.js).
- **REST `context_length` is opt-in only.** See the hardware principle above. Enforced by [`lmstudio-rest-context-length.test.js`](unit-tests-js/lmstudio-rest-context-length.test.js). Never re-add a default `context_length` to REST requests.
- **Canonical stop reasons.** Persisted artifacts use canonical `stopReason` + `stopReasonCode` (e.g. `session-timeout`, `invalid-response`); success markers like `completed` normalize to null. Legacy aliases are normalized by writers and by [`stop-reason-migrator.js`](src/libs/stop-reason-migrator.js). Enforced by [`miniphi-memory-stop-reason.test.js`](unit-tests-js/miniphi-memory-stop-reason.test.js), [`task-execution-register-stop-reason.test.js`](unit-tests-js/task-execution-register-stop-reason.test.js), [`stop-reason-migrator.test.js`](unit-tests-js/stop-reason-migrator.test.js).
- **Prompt-log tool metadata is always present.** Prompt exchanges and journals retain `tool_calls`, `tool_definitions`, and `request.tool_definitions` keys even when null, so eval coverage treats every exchange uniformly. Canonicalized through [`prompt-log-normalizer.js`](src/libs/prompt-log-normalizer.js) (shared by [`PromptRecorder`](src/libs/prompt-recorder.js) and [`PromptStepJournal`](src/libs/prompt-step-journal.js)). Enforced by [`prompt-log-links.test.js`](unit-tests-js/prompt-log-links.test.js).
- **Command execution is policy-gated.** Every shell command routes through [`CommandAuthorizationManager`](src/libs/command-authorization-manager.js) with policy `ask|session|allow|deny` (default `ask`) and per-command `danger`. `run_cmd` plan recommendations stay **deferred** until a policy-gated `runCommand` is injected; the read-only plan executor MUST NOT run commands. Enforced by [`plan-executor.test.js`](unit-tests-js/plan-executor.test.js).
- **Bounded orchestration.** Cap recursion/retries; honor `--session-timeout` (remaining budget is passed to each prompt); skip navigator/decomposer follow-ups once the budget expires and log the skip reason. Session-capped timeout normalization enforced by [`runtime-defaults.test.js`](unit-tests-js/runtime-defaults.test.js).
- **Missing snippets round-trip, once.** Analyzer `missing_snippets` that name repo-relative files are auto-fetched (path-escape safe) and the workspace flow re-prompts exactly once (`workspace-summary-snippets` scope) — never a loop. Enforced by [`plan-executor.test.js`](unit-tests-js/plan-executor.test.js).

---

## 5. Architecture and Data/Control Flow

Primary loop (free-form task, `run`, `analyze-file`, `nitpick`) dispatched through the primary-flow bridge:

`miniphi "<task>"` → [`src/index.js`](src/index.js) (parse, config, health gate, workspace context) → [`executePrimaryCommand`](src/commands/primary-flow.js) → `handleWorkspaceCommand` / `handleRunCommand` / `handleAnalyzeFileCommand` / `handleNitpickCommand`

Inside a primary command:

`WorkspaceProfiler`/`CapabilityInventory` context → `PromptDecomposer` (shallow plan → recursive branch expansion) → `PlanExecutor` (read-only leaf actions + missing-snippet fetch) → `LMStudioHandler` (schema-enforced chat over `LMStudioManager`/`LMStudioRestClient`) → `EfficientLogAnalyzer` (compressed output → log-analysis JSON) → `ApiNavigator` (optional follow-up commands/helpers) → persistence via `MiniPhiMemory` + `PromptRecorder` + `TaskExecutionRegister`

Auxiliary commands (`web-research`, `web-browse`, `history-notes`, `command-library`, `helpers`, `cache-prune`, `migrate-stop-reasons`, `lmstudio-health`, `models`, `recompose`, `benchmark`, `prompt-template`) branch directly in [`src/index.js`](src/index.js) before the primary flow.

Boundaries: LM Studio is an external local HTTP/WS service (default `http://127.0.0.1:1234`), REST-first with WebSocket fallback. All persistence is local JSON under `.miniphi/` (project) and `~/.miniphi/` (global, incl. the SQLite prompt DB). A Python subprocess ([`log_summarizer.py`](log_summarizer.py)) is invoked for line summarization. Puppeteer drives headless browsing for `web-browse`/blind `nitpick`.

---

## 6. Linked Source Tree and File Reference

This is a large repository (~77 source files). Entry points, registries, boundaries, and hotspots get their own linked `###` subsection below; repetitive leaf files are grouped under linked directory subsections that name the grouping rule and call out exceptions. Every source file is linked at least once so it is discoverable.

### [`src/index.js`](src/index.js)

CLI entry point and top-level command router (also the `miniphi` bin). Owns argument parsing, `config.json`/profile resolution, the LM Studio REST **health gate**, workspace-context construction, transport preference resolution, and dispatch. Change this file for global flag handling, command registration, or the health gate — **not** for per-command behavior (that lives in [`src/commands/`](src/commands)).

- **Key behavior and landmarks:**
  - `COMMANDS` list (includes `run`, `analyze-file`, `workspace`, `nitpick`, `recompose`, `benchmark`, `models`, `lmstudio-health`, `web-research`, `web-browse`, `history-notes`, `command-library`, `helpers`, `cache-prune`, `migrate-stop-reasons`, `prompt-template`).
  - Implicit-task routing (`implicitWorkspaceTask`, `implicitTaskMode`): an unrecognized first argument becomes a free-form task routed to `workspace`; `--cmd`/`--file` re-route it to `run`/`analyze-file`.
  - `--model auto` resolution (`requestedModel` → [`resolveAutoModel`](src/libs/model-catalog.js)).
  - `handleLmStudioProtocolFailure` disables navigator/decomposer after REST transport failures and prints a rerun reminder.
- **Depends on:** every `src/commands/*` handler and most `src/libs/*`.
- **Common mistakes:** Do not add per-command logic here; register the command in `COMMANDS` and dispatch to a handler. Do not reorder the health gate to run after the first prompt.

### [`src/commands/primary-flow.js`](src/commands/primary-flow.js)

Shared dispatch for the primary modes. `buildPrimaryCommandContext` normalizes the command context; `executePrimaryCommand` routes `workspace`/`run`/`analyze-file`/`nitpick` and returns a `handledBy` marker. Change this to alter which modes share the primary pipeline.

### Command handlers — [`src/commands/`](src/commands)

Grouping rule: one file per CLI verb, each exporting a single `handle<Verb>Command(context)` (see the [Interface Ownership Map](#8-interface-ownership-map)). Keep flag parsing in [`src/index.js`](src/index.js) and business logic in these handlers.

- Primary modes: [`run.js`](src/commands/run.js), [`analyze-file.js`](src/commands/analyze-file.js), [`workspace.js`](src/commands/workspace.js) (implicit free-form task target; wires [`PlanExecutor`](src/libs/plan-executor.js) and the missing-snippet round-trip), [`nitpick.js`](src/commands/nitpick.js) (writer/critic loop, ~1150 lines — the largest handler; owns rounds, blind research, and minimum-word validation).
- LM Studio / models: [`lmstudio-health.js`](src/commands/lmstudio-health.js) (`probeLmStudioHealth`, `handleLmStudioHealthCommand`), [`models.js`](src/commands/models.js).
- Audit / maintenance: [`cache-prune.js`](src/commands/cache-prune.js), [`migrate-stop-reasons.js`](src/commands/migrate-stop-reasons.js), [`history-notes.js`](src/commands/history-notes.js), [`command-library.js`](src/commands/command-library.js), [`helpers.js`](src/commands/helpers.js).
- Web / research: [`web-research.js`](src/commands/web-research.js), [`web-browse.js`](src/commands/web-browse.js).
- Dev / benchmark: [`recompose.js`](src/commands/recompose.js), [`benchmark.js`](src/commands/benchmark.js), [`prompt-template.js`](src/commands/prompt-template.js).

### [`src/libs/lmstudio-api.js`](src/libs/lmstudio-api.js)

LM Studio SDK wrapper + REST client — the transport boundary. `LMStudioManager` performs JIT model loading and `/api/v0` diagnostics; `LMStudioRestClient` targets `/api/v0` + OpenAI-compat routes. `normalizeLmStudioWsUrl` / `normalizeLmStudioHttpUrl` normalize endpoints. Change this for REST/WS wire behavior.

- **Common mistakes:** Do not send `context_length` unconditionally (see the contract). LM Studio's newer `/api/v1` (stateful chat, `models/load`/`unload`) exists but the client still targets `/api/v0` + OpenAI-compat — do not assume `/api/v1`.
- **Tests:** [`lmstudio-api-status.test.js`](unit-tests-js/lmstudio-api-status.test.js), [`lmstudio-rest-context-length.test.js`](unit-tests-js/lmstudio-rest-context-length.test.js).

### [`src/libs/lmstudio-handler.js`](src/libs/lmstudio-handler.js)

LM Studio chat handler: streaming reasoning, JSON-schema enforcement, retries, history, and `--session-timeout` wiring. Exports `LMStudioHandler` (default) and `LMStudioProtocolError` (thrown on protocol/transport failures). Change this for prompt-dispatch, streaming, or schema-enforcement behavior.

- **Called by / depends on:** [`lmstudio-runtime.js`](src/libs/lmstudio-runtime.js) bootstraps it; validation via [`json-schema-utils.js`](src/libs/json-schema-utils.js); parsing via [`phi4-stream-parser.js`](src/libs/phi4-stream-parser.js).
- **Common mistakes:** Do not swallow `LMStudioProtocolError` — [`src/index.js`](src/index.js) relies on it to disable navigator/decomposer after transport failure.

### [`src/libs/lmstudio-runtime.js`](src/libs/lmstudio-runtime.js)

Centralizes LM Studio bootstrap: handler setup, REST/WS wiring, compatibility checks, and prompt-scoring configuration. Adjacent transport files: [`lmstudio-client-options.js`](src/libs/lmstudio-client-options.js) (build REST client options from config), [`lmstudio-endpoints.js`](src/libs/lmstudio-endpoints.js) (`resolveLmStudioEndpoints`), [`lmstudio-transport.js`](src/libs/lmstudio-transport.js) (transport preference), [`lmstudio-status-utils.js`](src/libs/lmstudio-status-utils.js), [`lmstudio-error-utils.js`](src/libs/lmstudio-error-utils.js) (error classification, `buildStopReasonInfo`, `isContextOverflowError`, `isSessionTimeoutMessage`). Tests: [`lmstudio-error-utils.test.js`](unit-tests-js/lmstudio-error-utils.test.js), [`lmstudio-status-utils.test.js`](unit-tests-js/lmstudio-status-utils.test.js), [`lmstudio-health.test.js`](unit-tests-js/lmstudio-health.test.js).

### [`src/libs/adaptive-lmstudio-handler.js`](src/libs/adaptive-lmstudio-handler.js) + [`src/libs/rl-router.js`](src/libs/rl-router.js)

Optional Q-learning routing across model pools and prompt profiles. `AdaptiveLMStudioHandler` wraps the handler; `QLearningRouter` (with `featurizeObservation`, `buildActionKey`, bucket helpers) chooses model + profile per prompt and updates from prompt scores/schema validity. State persists at `.miniphi/indices/prompt-router.json`. Enable via `rlRouter` config or `--rl-router`/`--rl-models`. Tests: [`cli-rl-routing.test.js`](unit-tests-js/cli-rl-routing.test.js).

### [`src/libs/json-schema-utils.js`](src/libs/json-schema-utils.js)

Shared JSON-schema response-format builder and validator — the single source for schema enforcement. Key functions: `buildJsonSchemaResponseFormat`, `validateJsonAgainstSchema`, `validateJsonObjectAgainstSchema`, `classifyJsonSchemaValidation`, `summarizeJsonSchemaValidation`, `sanitizeResponseSchemaName`. **Common mistake:** do not write a second validator in a handler; extend this. Tests: [`json-schema-utils.test.js`](unit-tests-js/json-schema-utils.test.js).

### [`src/libs/prompt-schema-registry.js`](src/libs/prompt-schema-registry.js) + [`src/libs/schema-adapter-registry.js`](src/libs/schema-adapter-registry.js)

`PromptSchemaRegistry` loads schemas from [`docs/prompts/*.schema.json`](docs/prompts), injects instruction blocks, and exposes `validateOutcome()` with normalized metadata (`status`, `error`, `preambleDetected`) shared by the handler, analyzer, navigator, and decomposer. `SchemaAdapterRegistry` normalizes evolving JSON layouts (`schema_version`) at runtime so prompt revisions do not require client patches. Tests: [`prompt-schema-registry.test.js`](unit-tests-js/prompt-schema-registry.test.js).

### [`src/libs/prompt-decomposer.js`](src/libs/prompt-decomposer.js)

`PromptDecomposer` (default export) plans branches under the `prompt-plan` schema. First completion is a SHALLOW plan (children empty, `requires_subprompt` flags); each flagged branch is expanded with a focused compact follow-up (children renumbered `parentId.N`), capped by `maxDepth`, `maxExpansions` (default 4), and the session deadline. Telemetry lands in `branchExpansions` (`expanded`/`failed`/`skipped-budget`/`skipped-depth`/`skipped-session`); per-branch exchanges recorded as `prompt-decomposition-branch`. Disable via `--no-plan-expansion` or `prompt.decomposer.expandSubprompts=false`; cap via `--max-plan-expansions`. `benchmark general` keeps expansion off. Tests: [`prompt-decomposer-recursive.test.js`](unit-tests-js/prompt-decomposer-recursive.test.js), [`prompt-decomposer-focus.test.js`](unit-tests-js/prompt-decomposer-focus.test.js), [`prompt-decomposer-retry.test.js`](unit-tests-js/prompt-decomposer-retry.test.js).

### [`src/libs/api-navigator.js`](src/libs/api-navigator.js)

`ApiNavigator` requests navigation plans (`navigation-plan` schema), normalizes actions, emits branch-focused sub-prompt hints (`focusBranch`, `focusSegmentBlock`, `nextSubpromptBranch`), attaches per-command `danger`, and optionally runs single-use Node/Python helpers, archiving code + stdout/stderr under `.miniphi/helpers/`. Auto-disables after REST timeouts. Tests: [`api-navigator-retry.test.js`](unit-tests-js/api-navigator-retry.test.js).

### [`src/libs/plan-executor.js`](src/libs/plan-executor.js)

Executes the focused plan branch's mappable leaf steps as **read-only** native actions (`read_file`/`list_dir`/`search_text`); `run_cmd` stays deferred unless a policy-gated `runCommand` is injected. Key functions: `resolveWorkspacePath` (path-escape safe), `mapSegmentToAction`, `executeFocusedBranchActions` (dedup across siblings, budgets, session-deadline checks), `resolveMissingSnippets`/`buildSnippetContextBlock` (repo-relative auto-fetch → single re-prompt), `buildExecutedActionsBlock` (feeds `executedActionsBlock` into the workspace-summary prompt), `buildPlanProgress` (persisted via [`MiniPhiMemory.savePlanProgress`](src/libs/miniphi-memory.js), `firstIncompleteBranch` for `--plan-branch` resume). Tests: [`plan-executor.test.js`](unit-tests-js/plan-executor.test.js). **Common mistake:** never let this execute a command or escape the workspace root.

### [`src/libs/efficient-log-analyzer.js`](src/libs/efficient-log-analyzer.js)

`EfficientLogAnalyzer` (default) orchestrates command/file analysis: chunked summarization, `log-analysis` schema enforcement, `truncation_strategy`/carryover handling, and deterministic fallback JSON (exports `LOG_ANALYSIS_FALLBACK_SCHEMA`). Normalizes missing `needs_more_context`/`missing_snippets` to defaults. `summary`/`summary_updates` are kept near the top of the JSON to surface during streaming. Depends on [`python-log-summarizer.js`](src/libs/python-log-summarizer.js), [`stream-analyzer.js`](src/libs/stream-analyzer.js), [`truncation-utils.js`](src/libs/truncation-utils.js). Tests: [`efficient-log-analyzer-stop.test.js`](unit-tests-js/efficient-log-analyzer-stop.test.js), [`romeo-miniphi-flow.test.js`](unit-tests-js/romeo-miniphi-flow.test.js), [`truncation-utils.test.js`](unit-tests-js/truncation-utils.test.js).

### [`src/libs/core-utils.js`](src/libs/core-utils.js)

Shared cross-cutting helpers — a hotspot imported almost everywhere. Notable: strict JSON parsing (`parseStrictJson`, `parseStrictJsonObject`, `sanitizeJsonResponseText`, `extractJsonBlock`), plan formatting (`buildPlanSegments`, `buildFocusedPlanSegments`, `applyRequestedPlanBranchFocus`, `formatPlanSegmentsBlock`), analysis extraction (`extractSummaryFromAnalysis`, `extractMissingSnippetsFromAnalysis`, `extractNeedsMoreContextFlag`, `extractContextRequestsFromAnalysis`, `normalizeTruncationPlan`), `normalizeDangerLevel`, `shouldForceFastMode`, `resolveLmStudioHttpBaseUrl`. Tests: [`fast-mode-utils.test.js`](unit-tests-js/fast-mode-utils.test.js), [`plan-focus-segments.test.js`](unit-tests-js/plan-focus-segments.test.js). **Common mistake:** do not fork a private JSON parser — reuse the strict parsers here so preamble handling stays consistent.

### [`src/libs/agent-commands.js`](src/libs/agent-commands.js)

Defines `DEFAULT_AGENT_COMMANDS` and `buildAgentCommandsBlock` — the compact "Agent commands (defaults)" block (workspace/list_dir/read_file/search_text/edit_file/run_cmd/analyze_file/web_research/web_browse) injected into workspace prompts so Phi sees core local actions cheaply. Tests: [`agent-commands.test.js`](unit-tests-js/agent-commands.test.js).

### [`src/libs/command-authorization-manager.js`](src/libs/command-authorization-manager.js)

`CommandAuthorizationManager` enforces `ask|allow|deny|session` policy and prompts for approval; `normalizeCommandPolicy` canonicalizes the flag. Command runner is [`cli-executor.js`](src/libs/cli-executor.js) (`CliExecutor`: streaming output, timeouts, silence detection). Policy persists to `~/.miniphi/preferences/command-policy.json`.

### [`src/libs/model-catalog.js`](src/libs/model-catalog.js) + [`src/libs/model-selector.js`](src/libs/model-selector.js) + [`src/libs/model-presets.js`](src/libs/model-presets.js)

Live model selection behind `--model auto` and the `models` command. `model-catalog.js`: `fetchModelCatalog` (`/api/v0/models`, OpenAI-compat `/v1/models` fallback), `scoreModelForTask`, `rankModelsForTask`, `resolveAutoModel`. `model-selector.js`: `classifyTaskIntent`, `selectModelForIntent`, `selectNitpickModels`. `model-presets.js`: `MODEL_PRESETS`, `DEFAULT_MODEL_KEY`, `DEFAULT_CONTEXT_LENGTH = 16384`, `resolveModelConfig`. **Known gap:** preset default may not be installed on the host — prefer `--model auto`. Tests: [`model-catalog.test.js`](unit-tests-js/model-catalog.test.js), [`model-selector.test.js`](unit-tests-js/model-selector.test.js).

### [`src/libs/miniphi-memory.js`](src/libs/miniphi-memory.js) + [`src/libs/global-memory.js`](src/libs/global-memory.js) + [`src/libs/memory-store-base.js`](src/libs/memory-store-base.js)

Persistence layer. `MiniPhiMemory` (extends `MemoryStoreBase`) owns the project `.miniphi/` layout (executions, prompt exchanges, helpers, indices, nitpick, research, web, health, `savePlanProgress`). `GlobalMiniPhiMemory` owns `~/.miniphi/` (shared helpers, templates, preferences, prompt telemetry DB). Shared IO/slug/index helpers in [`memory-store-utils.js`](src/libs/memory-store-utils.js). Tests: [`miniphi-memory-stop-reason.test.js`](unit-tests-js/miniphi-memory-stop-reason.test.js).

### Prompt logging & execution registers

Grouping rule: everything that records a model exchange or operation step under `.miniphi/`.

- [`prompt-recorder.js`](src/libs/prompt-recorder.js) — `PromptRecorder`, canonical exchange log (full request/response, `tool_calls`, `tool_definitions`; canonicalizes to omit duplicated `promptText`/`response.text`).
- [`prompt-step-journal.js`](src/libs/prompt-step-journal.js) — `PromptStepJournal`, stepwise `.miniphi/prompt-exchanges/stepwise/<id>/` ledger linking to exchanges via `links.promptExchangeId` (POSIX-relative).
- [`prompt-log-normalizer.js`](src/libs/prompt-log-normalizer.js) — shared tool/request/response/error normalization consumed by both recorders (see contract). Tests: [`prompt-recorder.test.js`](unit-tests-js/prompt-recorder.test.js), [`prompt-step-journal.test.js`](unit-tests-js/prompt-step-journal.test.js), [`prompt-log-links.test.js`](unit-tests-js/prompt-log-links.test.js).
- [`task-execution-register.js`](src/libs/task-execution-register.js) — `TaskExecutionRegister` writes `executions/<id>/task-execution.json` (LM Studio request/response register + exchange links), normalizing `error.stop_reason*` via the normalizer.
- [`prompt-performance-tracker.js`](src/libs/prompt-performance-tracker.js) — `PromptPerformanceTracker`, SQLite scoring/telemetry (semantic grading only under `--debug-lm`).
- [`stop-reason-migrator.js`](src/libs/stop-reason-migrator.js) — `migrateStopReasonArtifacts`, one-shot normalization over existing `.miniphi` JSON (behind the `migrate-stop-reasons` command).

### Workspace context & capabilities

Grouping rule: scan the repo and build prompt context blocks. [`workspace-profiler.js`](src/libs/workspace-profiler.js) (`WorkspaceProfiler` — code/docs/data profile, ASCII connection graphs), [`workspace-scanner.js`](src/libs/workspace-scanner.js) (`scanWorkspace`/`resolveWorkspaceScan`/`filterWorkspaceFiles`, cached), [`workspace-snapshot.js`](src/libs/workspace-snapshot.js), [`workspace-context-utils.js`](src/libs/workspace-context-utils.js) (`buildWorkspaceHintBlock`, `buildPromptTemplateBlock`, `buildPromptCompositionBlock`), [`capability-inventory.js`](src/libs/capability-inventory.js) (`CapabilityInventory` — package scripts, `.bin`, OS commands), [`file-connection-analyzer.js`](src/libs/file-connection-analyzer.js) (`FileConnectionAnalyzer` — JS/Python import graph). Tests: [`workspace-scan-cache.test.js`](unit-tests-js/workspace-scan-cache.test.js), [`cli-workspace-scan.test.js`](unit-tests-js/cli-workspace-scan.test.js), [`workspace-summary-budget.test.js`](unit-tests-js/workspace-summary-budget.test.js).

### Analysis, streaming & resources

[`python-log-summarizer.js`](src/libs/python-log-summarizer.js) (`PythonLogSummarizer` — runs [`log_summarizer.py`](log_summarizer.py)), [`stream-analyzer.js`](src/libs/stream-analyzer.js) (`StreamAnalyzer` — chunked large-file reads), [`phi4-stream-parser.js`](src/libs/phi4-stream-parser.js) (`Phi4StreamParser` — splits `<think>` from solution tokens), [`truncation-utils.js`](src/libs/truncation-utils.js), [`resource-monitor.js`](src/libs/resource-monitor.js) (`ResourceMonitor` — CPU/RAM/VRAM sampling → `.miniphi/health/`).

### File editing, config & CLI utilities

[`file-edit-guard.js`](src/libs/file-edit-guard.js) (`writeFileWithGuard` — diff summary + rollback copy; currently **recompose-only**, the basis for the planned main-flow `edit_file`), [`config-loader.js`](src/libs/config-loader.js) (`loadConfig` — `config.json`/profiles), [`cli-utils.js`](src/libs/cli-utils.js) (`parseNumericSetting`, `resolveDurationMs`), [`runtime-defaults.js`](src/libs/runtime-defaults.js) (shared timeout defaults), [`core-utils.js`](src/libs/core-utils.js) (above).

### Prompt templates & chains

[`prompt-template-baselines.js`](src/libs/prompt-template-baselines.js) (`PromptTemplateBaselineBuilder` — truncation/log-analysis baselines, no LM Studio call), [`prompt-chain-utils.js`](src/libs/prompt-chain-utils.js) (option sets, learned-option merges for the `scripts/prompt-*` chain).

### Auxiliary feature libs

Grouping rule: back the non-core commands. Web: [`web-researcher.js`](src/libs/web-researcher.js) (`WebResearcher` — DuckDuckGo Instant Answer + HTML fallback), [`web-browser.js`](src/libs/web-browser.js) (`WebBrowser` — Puppeteer). Recompose/benchmark: [`recompose-tester.js`](src/libs/recompose-tester.js), [`recompose-harness.js`](src/libs/recompose-harness.js), [`recompose-benchmark-runner.js`](src/libs/recompose-benchmark-runner.js), [`recompose-utils.js`](src/libs/recompose-utils.js), [`benchmark-general.js`](src/libs/benchmark-general.js), [`benchmark-analyzer.js`](src/libs/benchmark-analyzer.js). Maintenance: [`cache-pruner.js`](src/libs/cache-pruner.js) (`pruneMiniPhiCache`), [`history-notes.js`](src/libs/history-notes.js) (`HistoryNotesManager`).

### Prompt schemas — [`docs/prompts/`](docs/prompts)

The JSON contract source of truth (authority tier 2). Core loop: [`prompt-plan.schema.json`](docs/prompts/prompt-plan.schema.json), [`navigation-plan.schema.json`](docs/prompts/navigation-plan.schema.json), [`log-analysis.schema.json`](docs/prompts/log-analysis.schema.json), [`prompt-score.schema.json`](docs/prompts/prompt-score.schema.json). Nitpick: [`nitpick-plan`](docs/prompts/nitpick-plan.schema.json), [`nitpick-research-plan`](docs/prompts/nitpick-research-plan.schema.json), [`nitpick-draft`](docs/prompts/nitpick-draft.schema.json), [`nitpick-critique`](docs/prompts/nitpick-critique.schema.json). Recompose: [`recompose-file-plan`](docs/prompts/recompose-file-plan.schema.json), [`recompose-file-narrative`](docs/prompts/recompose-file-narrative.schema.json), [`recompose-codegen`](docs/prompts/recompose-codegen.schema.json), [`recompose-workspace-overview`](docs/prompts/recompose-workspace-overview.schema.json). Prompt-chain: [`prompt-chain-response`](docs/prompts/prompt-chain-response.schema.json). All use `additionalProperties: false`; cached templates live under `.miniphi/prompt-exchanges/templates/`.

---

## 7. Features and Recurring Development Pitfalls

### Recursive plan decomposition — Shipped
- **Behavior:** shallow plan then focused per-branch expansion; produced a proven 21-step depth-3 plan on a 30B local model.
- **Flow and owners:** [`PromptDecomposer`](src/libs/prompt-decomposer.js) → telemetry under `.miniphi/prompt-exchanges/decompositions/`.
- **Constraints:** capped by `maxDepth`, `maxExpansions` (default 4), session deadline; off in `benchmark general`.
- **Tests:** [`prompt-decomposer-recursive.test.js`](unit-tests-js/prompt-decomposer-recursive.test.js).

### Plan execution bridge — Active (core landed 2026-07-15)
- **Behavior:** focused-branch leaf steps run as read-only actions and feed the workspace-summary prompt; repo-relative `missing_snippets` auto-fetch and re-prompt once; per-branch progress persists with `firstIncompleteBranch`.
- **Flow and owners:** [`workspace.js`](src/commands/workspace.js) → [`PlanExecutor`](src/libs/plan-executor.js) → [`MiniPhiMemory.savePlanProgress`](src/libs/miniphi-memory.js).
- **Tests and gaps:** [`plan-executor.test.js`](unit-tests-js/plan-executor.test.js) (9 tests). **Gaps:** `--plan-branch` does not yet auto-default to `firstIncompleteBranch`; executor is not yet wired into `run`/`analyze-file`; no live proof of the `missing_snippets` re-prompt firing end-to-end.

### Live model catalog + `--model auto` — Shipped
- **Behavior:** ranks installed models per task intent; `models` command prints the ranking.
- **Owners:** [`model-catalog.js`](src/libs/model-catalog.js), [`models.js`](src/commands/models.js). **Tests:** [`model-catalog.test.js`](unit-tests-js/model-catalog.test.js).

### Nitpick writer/critic loop — Shipped (auxiliary)
- **Behavior:** two-model draft/revise loop with JSON schemas and minimum-word validation by actual word count; `--blind` forces web research + browsing; `--auto-expand-rounds` retries expansion.
- **Owners:** [`nitpick.js`](src/commands/nitpick.js) with the `nitpick-*` schemas. **Tests:** [`nitpick-two-student-essay.test.js`](unit-tests-js/nitpick-two-student-essay.test.js), [`nitpick-auto-expand-rounds.test.js`](unit-tests-js/nitpick-auto-expand-rounds.test.js).

### Guarded edit pipeline — Known gap / Planned
- **Status:** [`file-edit-guard.js`](src/libs/file-edit-guard.js) (diff + rollback) exists but is wired **only inside recompose**. The main run/workspace flow has no `edit_file` action yet (ROADMAP slice 3).

### Pitfall: JIT context overflow from a static `context_length`
- **Symptom:** every REST call returns `400 "Context size has been exceeded"`.
- **Cause/invariant:** advertising a static context to a JIT-loaded smaller model. Only send `context_length` when explicitly configured.
- **Risk area:** [`lmstudio-api.js`](src/libs/lmstudio-api.js) (`LMStudioRestClient`). **Regression check:** [`lmstudio-rest-context-length.test.js`](unit-tests-js/lmstudio-rest-context-length.test.js). **Status:** fixed regression risk.

### Pitfall: salvaging JSON from prose
- **Symptom:** a model reply with a `<think>` preamble is accepted and corrupts downstream state.
- **Cause/invariant:** preamble = failure; emit deterministic fallback with `stop_reason: preamble_detected`, never regex JSON out of prose.
- **Risk area:** [`core-utils.js`](src/libs/core-utils.js) strict parsers, [`efficient-log-analyzer.js`](src/libs/efficient-log-analyzer.js). **Status:** active invariant.

### Pitfall (live only): LM Studio wedge after long generations
- **Symptom:** after several long `max_tokens: -1` generations, the server reports `state: loaded` but even a 30-token completion times out; every prompt hits the 120s timeout (decomposer disables itself, analysis emits fallback JSON; runs still exit 0 with canonical stop reasons).
- **Fix:** restart LM Studio (reload the model), then rerun. **Prevention:** before a proof run, probe with a tiny real completion (`POST /api/v0/chat/completions`, `max_tokens: 30`) — `lmstudio-health`/`/models` both look healthy while wedged. **Status:** active known live hazard; candidate v0.2 automation.

### Pitfall: 4k context stalls on this host
- **Symptom:** decomposer REST calls fail; live `analyze-file` drops summary detail to level 0.
- **Cause/invariant:** LM Studio context can stall ~4k here. Workspace-summary log-analysis prompts cap the budget at `2200` tokens; trim prompts or load a larger model. **Status:** deliberate limitation / active tuning area.

---

## 8. Interface Ownership Map

CLI verbs → handlers (registered in `COMMANDS` in [`src/index.js`](src/index.js)). `run`/`analyze-file`/`workspace`/`nitpick` route through [`executePrimaryCommand`](src/commands/primary-flow.js); the rest branch directly in `index.js`.

| Command | Handler |
| --- | --- |
| `miniphi "<task>"` (implicit) / `workspace` | [`workspace.js`](src/commands/workspace.js) |
| `run` | [`run.js`](src/commands/run.js) |
| `analyze-file` | [`analyze-file.js`](src/commands/analyze-file.js) |
| `nitpick` | [`nitpick.js`](src/commands/nitpick.js) |
| `models` | [`models.js`](src/commands/models.js) |
| `lmstudio-health` | [`lmstudio-health.js`](src/commands/lmstudio-health.js) |
| `web-research` / `web-browse` | [`web-research.js`](src/commands/web-research.js) / [`web-browse.js`](src/commands/web-browse.js) |
| `recompose` / `benchmark` | [`recompose.js`](src/commands/recompose.js) / [`benchmark.js`](src/commands/benchmark.js) |
| `prompt-template` | [`prompt-template.js`](src/commands/prompt-template.js) |
| `helpers` / `command-library` | [`helpers.js`](src/commands/helpers.js) / [`command-library.js`](src/commands/command-library.js) |
| `history-notes` / `cache-prune` / `migrate-stop-reasons` | [`history-notes.js`](src/commands/history-notes.js) / [`cache-prune.js`](src/commands/cache-prune.js) / [`migrate-stop-reasons.js`](src/commands/migrate-stop-reasons.js) |

Global flags (every command): `--config <path>`, `--profile <name>`, `--verbose`, `--debug-lm`. Env overrides: `MINIPHI_CONFIG`, `MINIPHI_PROFILE`, `MINIPHI_MODEL`, `MINIPHI_FORCE_REST=1`. Prompt bin: the `miniphi` executable maps to [`src/index.js`](src/index.js) (`package.json` `bin`). Run `miniphi --help` for the full flag surface.

---

## 9. Build, Run, Test, Debug, and Release

Prerequisites: **Node.js 20+**, **Python 3.9+** (for [`log_summarizer.py`](log_summarizer.py)), **LM Studio** reachable at `http://127.0.0.1:1234` with a model loaded. Platforms: macOS, Windows, Linux.

```bash
npm install                                   # dependencies
node src/index.js "<task>"                    # run from source (or `miniphi "<task>"` after npm link)
node src/index.js lmstudio-health --timeout 10   # fast REST health probe before long runs
npm test                                      # offline deterministic suite (node --test; live tests self-skip)
MINIPHI_LMSTUDIO_INTEGRATION=1 npm test       # add the live LM Studio-gated tier (needs LM Studio running)
npm run ci:migrate-stop-reasons               # strict dry-run stop-reason/JSON check for CI
npm run benchmark                             # node benchmark/run-tests.js
node scripts/sync-test-task-catalog.js        # regenerate dev_samples/test_tasks/*.json from task-tests.md
```

- `npm test` and `npm run lint` both run `node --test ./unit-tests-js/**/*.test.js`.
- Live proofs run real `miniphi` tasks; prefer `--model auto` and capture a `--prompt-journal`.
- **Mutating/external:** `run` (and navigator follow-ups) execute shell commands under [`CommandAuthorizationManager`](src/libs/command-authorization-manager.js); `web-research`/`web-browse`/blind `nitpick` reach the network; live tests require LM Studio. Everything else writes only under `.miniphi/`.
- Debug helpers: [`scripts/lmstudio-json-debug.js`](scripts/lmstudio-json-debug.js), [`scripts/lmstudio-json-series.js`](scripts/lmstudio-json-series.js), [`scripts/local-eval-report.js`](scripts/local-eval-report.js), [`scripts/prompt-composer.js`](scripts/prompt-composer.js) + [`scripts/prompt-interpret.js`](scripts/prompt-interpret.js).
- Release: `npm publish` readiness is a v0.3 goal (not yet done); `bin.miniphi` → `src/index.js` is wired.

---

## 10. Test Ownership Map

Offline deterministic suite under [`unit-tests-js/`](unit-tests-js) (run per slice). Do not hard-code a total count; the suite generates its own.

- **JSON schema / validation:** [`json-schema-utils.test.js`](unit-tests-js/json-schema-utils.test.js), [`prompt-schema-registry.test.js`](unit-tests-js/prompt-schema-registry.test.js).
- **Transport / error taxonomy / timeouts:** [`lmstudio-api-status.test.js`](unit-tests-js/lmstudio-api-status.test.js), [`lmstudio-error-utils.test.js`](unit-tests-js/lmstudio-error-utils.test.js), [`lmstudio-status-utils.test.js`](unit-tests-js/lmstudio-status-utils.test.js), [`lmstudio-health.test.js`](unit-tests-js/lmstudio-health.test.js), [`lmstudio-rest-context-length.test.js`](unit-tests-js/lmstudio-rest-context-length.test.js), [`runtime-defaults.test.js`](unit-tests-js/runtime-defaults.test.js).
- **Stop reasons / persistence:** [`miniphi-memory-stop-reason.test.js`](unit-tests-js/miniphi-memory-stop-reason.test.js), [`task-execution-register-stop-reason.test.js`](unit-tests-js/task-execution-register-stop-reason.test.js), [`stop-reason-migrator.test.js`](unit-tests-js/stop-reason-migrator.test.js), [`cli-migrate-stop-reasons.test.js`](unit-tests-js/cli-migrate-stop-reasons.test.js), [`prompt-recorder.test.js`](unit-tests-js/prompt-recorder.test.js), [`prompt-step-journal.test.js`](unit-tests-js/prompt-step-journal.test.js), [`prompt-log-links.test.js`](unit-tests-js/prompt-log-links.test.js).
- **Planning / navigation / execution:** [`plan-executor.test.js`](unit-tests-js/plan-executor.test.js), [`plan-focus-segments.test.js`](unit-tests-js/plan-focus-segments.test.js), [`prompt-decomposer-recursive.test.js`](unit-tests-js/prompt-decomposer-recursive.test.js), [`prompt-decomposer-focus.test.js`](unit-tests-js/prompt-decomposer-focus.test.js), [`prompt-decomposer-retry.test.js`](unit-tests-js/prompt-decomposer-retry.test.js), [`api-navigator-retry.test.js`](unit-tests-js/api-navigator-retry.test.js).
- **Analysis / truncation:** [`efficient-log-analyzer-stop.test.js`](unit-tests-js/efficient-log-analyzer-stop.test.js), [`romeo-miniphi-flow.test.js`](unit-tests-js/romeo-miniphi-flow.test.js), [`truncation-utils.test.js`](unit-tests-js/truncation-utils.test.js).
- **Model selection:** [`model-catalog.test.js`](unit-tests-js/model-catalog.test.js), [`model-selector.test.js`](unit-tests-js/model-selector.test.js).
- **CLI routing / commands:** [`cli-implicit-run.test.js`](unit-tests-js/cli-implicit-run.test.js), [`cli-implicit-analyze-file.test.js`](unit-tests-js/cli-implicit-analyze-file.test.js), [`cli-smoke.test.js`](unit-tests-js/cli-smoke.test.js), [`cli-workspace-scan.test.js`](unit-tests-js/cli-workspace-scan.test.js), [`cli-cache-prune.test.js`](unit-tests-js/cli-cache-prune.test.js), [`cli-get-started-sample.test.js`](unit-tests-js/cli-get-started-sample.test.js), [`cli-recompose.test.js`](unit-tests-js/cli-recompose.test.js), [`cli-benchmark.test.js`](unit-tests-js/cli-benchmark.test.js), [`cli-rl-routing.test.js`](unit-tests-js/cli-rl-routing.test.js), [`cli-uppercase-files.test.js`](unit-tests-js/cli-uppercase-files.test.js).
- **Benchmark catalog / suite:** [`benchmark-task-catalog.test.js`](unit-tests-js/benchmark-task-catalog.test.js), [`cli-benchmark-general-suite.test.js`](unit-tests-js/cli-benchmark-general-suite.test.js), [`workspace-summary-budget.test.js`](unit-tests-js/workspace-summary-budget.test.js), [`workspace-scan-cache.test.js`](unit-tests-js/workspace-scan-cache.test.js).
- **Web / misc:** [`web-researcher-fallback.test.js`](unit-tests-js/web-researcher-fallback.test.js), [`agent-commands.test.js`](unit-tests-js/agent-commands.test.js), [`fast-mode-utils.test.js`](unit-tests-js/fast-mode-utils.test.js), [`legacy-module-cleanup.test.js`](unit-tests-js/legacy-module-cleanup.test.js), [`nitpick-two-student-essay.test.js`](unit-tests-js/nitpick-two-student-essay.test.js), [`nitpick-auto-expand-rounds.test.js`](unit-tests-js/nitpick-auto-expand-rounds.test.js).
- **Live-gated tier (`MINIPHI_LMSTUDIO_INTEGRATION=1`):** [`lmstudio-code-generation.live.test.js`](unit-tests-js/lmstudio-code-generation.live.test.js) (executes generated code), [`cli-bash-advanced.test.js`](unit-tests-js/cli-bash-advanced.test.js), [`benchmark-general-live-lm.test.js`](unit-tests-js/benchmark-general-live-lm.test.js).
- **Known gaps:** no guarded main-flow edit test yet (recompose-only today); live coverage depends on a healthy, un-wedged LM Studio.

---

## 11. Data, Security, Privacy, and Compatibility Boundaries

- **Canonical vs derived:** source of truth is [`docs/prompts/*.schema.json`](docs/prompts) and `src/`. Everything under `.miniphi/` and `~/.miniphi/` is derived/runtime audit data, plain JSON, gitignored (`.gitignore` ignores `.miniphi/`, `miniphi.config.json`, `current-benchmarks/`, and `miniphi-prompts.db*`). `dev_samples/test_tasks/*.json` is generated from [`dev_samples/task-tests.md`](dev_samples/task-tests.md).
- **Local-only writes:** no remote writes; edits and helpers stay within the working directory and `.miniphi/`. Path resolution is escape-safe ([`resolveWorkspacePath`](src/libs/plan-executor.js)).
- **Command trust:** shell execution is gated by [`CommandAuthorizationManager`](src/libs/command-authorization-manager.js) (`ask` default) with per-command `danger` levels; navigator follow-ups inherit `--command-danger`. Navigator skips MiniPhi CLI entrypoints to prevent recursive runs.
- **Secrets:** none stored in the repo; `.miniphi/` is unencrypted local JSON — do not write credentials into it. The SQLite prompt DB (`miniphi-prompts.db`) lives under `~/.miniphi/` and is gitignored.
- **Compatibility:** REST client targets LM Studio `/api/v0` + OpenAI-compat; `/api/v1` (stateful chat, model load/unload) exists but is not yet adopted (v0.2). Stop-reason and prompt-log schemas are versioned and migratable via `migrate-stop-reasons`; `SchemaAdapterRegistry` normalizes evolving response layouts.
- **Retention:** `.miniphi/` grows quickly with no encryption; use `cache-prune` retention caps.

---

## 12. Current Status, Known Gaps, and Roadmap Snapshot

Authoritative plan and exit criteria: [`ROADMAP.md`](ROADMAP.md). This is the active-slice summary.

### Shipped
- Strict JSON loop: schema registry + shared validation, canonical stop reasons, prompt exchanges/journals/task-execution registers, one-shot stop-reason migration.
- Recursive decomposition (shallow-first + per-branch expansion, `branchExpansions` telemetry), proven live on this repo.
- Live model catalog + `--model auto` + `models` command; REST `context_length` wire fix.
- Two-tier test suite (offline deterministic + live-gated on executed output).
- Plan execution bridge **core** (read-only branch actions, missing-snippet auto-fetch + single re-prompt, per-branch progress persistence).

### Experimental / Scaffold
- Guarded writer ([`file-edit-guard.js`](src/libs/file-edit-guard.js)) is recompose-only; the main-flow `edit_file` action is not wired.
- RL prompt routing ([`rl-router.js`](src/libs/rl-router.js)) is opt-in.

### Known Gaps (driving the active slice)
- `--plan-branch` does not auto-default to `firstIncompleteBranch` on resume (only a printed hint).
- Plan executor not yet wired into `run`/`analyze-file`; `run_cmd` recommendations not yet executed under policy in run mode.
- No live proof of the `missing_snippets` re-prompt firing end-to-end.
- `model-presets.js` default may not be installed on the host; `--model auto` is opt-in, not the config default.
- Context sizing is JIT-inherited (LM Studio `/api/v1/models/load` not yet adopted).

### Near-Term Priorities (v0.1)
1. Close the **Plan execution bridge** slice (defaults + `run`/`analyze-file` wiring + live re-prompt proof).
2. **Reliable edit pipeline** — guarded `edit_file` in the main flow with diff + rollback and a post-edit validation command.
3. **Usable CLI + docs** — onboarding quickstart; make `--model auto` the documented posture when the configured model is absent.

---

## 13. Task Start and Handoff Checklist

Before changing code:
1. Read every applicable `AGENTS.md`, then [`ROADMAP.md`](ROADMAP.md) for the active slice, and the relevant [`docs/prompts/*.schema.json`](docs/prompts) contract.
2. Check `git status`; preserve unrelated changes.
3. Identify the owning file subsection above and its focused tests before editing; verify the handbook's claim against current code.
4. Check the relevant feature path and the recurring pitfalls (context overflow, prose-salvage, LM Studio wedge) before touching prompts, transport, or schemas.

Before finishing / committing:
1. Run [`node src/index.js lmstudio-health --timeout 10`](src/index.js) if the change touches transport/prompts, then `npm test` (and the live tier if the change affects live behavior). Report tests run, skipped, and any gaps honestly.
2. Update the affected file subsection, feature/pitfall entry, interface map, and test map **in the same change**; remove stale claims.
3. Sync [`README.md`](README.md) for user-visible flag/command changes and [`ROADMAP.md`](ROADMAP.md) when a slice's status changes; route optimization ideas to [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md).
4. Confirm `AGENTS.md` describes the repo *after* the change: no new behavior still labeled `Planned`, no incomplete work labeled `Shipped`, no moved/deleted path left as an owner, all local Markdown links valid.
