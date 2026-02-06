# After a prompt
- Keep `README.md` for human documentation and this AGENTS.md for AI in sync whenever MiniPhi gains a new command, argument, or workflow and source code status.
- Benchmark/recompose/test scripts are instrumentation; treat failures as runtime bugs and only edit scripts to expand coverage or logging.
- Every LM Studio prompt must declare the exact JSON schema and use `response_format=json_schema`; reject non-JSON responses and re-prompt or emit deterministic fallback JSON. Navigator now falls back to a deterministic JSON block with `stop_reason` after timeouts, and decomposer emits a fallback plan when schema fields are missing.
- JSON request payloads and JSON responses are mandatory; never use narrative-only exchanges for chunk selection, truncation plans, or missing snippet requests.
- Prompt/response instrumentation must retain response text, tool_calls, and tool_definitions so evaluation datasets can score tool-call accuracy and task adherence (see `thirds/ai-agent-evals`).
- Keep scope focused on a local file-manipulation agent for coding projects; defer broad research or multi-agent exploration until the v0.1 exit criteria are met.
- Roadmap items need explicit exit criteria; if a new item is added, remove or defer a lower-priority one.
- Prevent infinite loops: cap recursive prompts and retries, enforce helper timeouts, and persist a clear stop reason in `.miniphi/`.
- Stop reasons now include code/detail (for example: `session-timeout`, `invalid-response`) and the analyzer emits deterministic fallback JSON when the session budget expires before Phi responds.
- Do not change generic libraries just to satisfy a narrow unit test; use tests to improve MiniPhi behavior instead of editing test intent or broad utilities.
- Avoid writing placeholder notes into docs; only record optional notes in `.miniphi/history/forgotten-notes.md` when `--forgotten-note` is supplied.
- Use `OPTIMIZATIONS.md` as the high-priority optimization roadmap; avoid isolated changes to `src/libs/efficient-log-analyzer.js` unless the issue is log-analysis-specific and review the full `src/` pipeline (`src/index.js`, `lmstudio-handler`, `prompt-*`, `workspace-*`, `miniphi-memory`, `cli-executor`) before proposing edits.

## High priority references

- `OPTIMIZATIONS.md` is the optimization roadmap for cross-cutting improvements across the entire `src/` runtime pipeline.


## What goes where

- **README.md** is user-facing: overview, install, quickstart, and a *short* command overview.
- **AGENTS.md** is maintainer/agent-facing: JSON schema rules, safety constraints, deeper CLI flag reference, `.miniphi/` layout, and implementation-oriented notes.

When you add or change CLI behavior:
1. Update README’s “Get started” / “Commands (overview)” if it affects everyday usage.
2. Put the detailed reference (all flags, internal workflows, prompt contracts) in this file or under `docs/`.

# MiniPhi Reference

## Core guardrails
- MiniPhi is a local LM Studio-powered agent for file manipulation in the current working directory; no remote writes.
- `recompose` is the natural-language agent unit-test harness driven through `src/index.js`; keep semantics aligned with the main run/workspace flows.
- JSON-first prompts are mandatory: embed a schema id from `docs/prompts/*.schema.json`, set `response_format=json_schema`, and validate every response before using it.
- Keep context manageable by decomposing tasks; cap recursion, retries, and helper runtimes, and persist resumable plans in `.miniphi/`.
- LM Studio health and capability inventory must gate prompts; helper scripts live under `.miniphi/` with timeouts and audit trails.
- Benchmarks and recomposition runs are treated as runtime validation, not side projects.
- Roadmap slices close only when proven by a real `miniphi` run that applies JSON-backed edits and records a stop reason.

### JSON-first operating rules
- Schemas live in `docs/prompts/` with `additionalProperties: false` and required `needs_more_context` + `missing_snippets` fields; keep schema ids/versioning visible in prompts.
- ApiNavigator and PromptDecomposer validate responses via `json-schema-utils` and require `needs_more_context` + `missing_snippets` in their schemas.
- Strip `<think>`/markdown preambles, parse strictly, and treat non-JSON as failure; trigger a deterministic fallback JSON if the model drifts.
- Never salvage JSON from mixed prose; only accept payloads that are valid JSON after stripping `<think>` blocks and JSON fences.
- Prompt-chain interpreter treats preambles as invalid and emits a deterministic fallback with `stop_reason: preamble_detected` when strict parsing fails.
- All suggested actions must be structured arrays/objects with reasons and a declared `schema_version`/`schema_uri`; normalize through `SchemaAdapterRegistry` before use.
- Chunk selection, truncation plans, and missing snippets must be expressed as structured JSON fields, never prose; reject narrative responses even if they are correct.
- When requesting `missing_snippets`, prefer repo-relative file paths (for example: `src/index.js`) so recompose can auto-fetch context.
- EfficientLogAnalyzer normalizes missing `needs_more_context`/`missing_snippets` to defaults when the model omits them.
- Log-analysis responses include `summary` (final natural-language update) and `summary_updates` (chronological progress updates); keep them near the top of the JSON to surface during streaming output.

## Runtime posture
- Default LM Studio endpoint: `http://127.0.0.1:1234` (REST) with WebSocket fallback; default model `mistralai/devstral-small-2-2512` (swap to `ibm/granite-4-h-tiny` or `microsoft/phi-4-reasoning-plus` via `--model` or `defaults.model`).
- Transport default: REST-first (`lmStudio.transport: "rest"`); override with `lmStudio.transport: "ws"` or env `MINIPHI_FORCE_REST=1` for forced REST.
- CLI entrypoints: `run`, `analyze-file`, `workspace` (`miniphi "<task>"`), `recompose`, `benchmark recompose|analyze|plan scaffold`, `cache-prune`, `lmstudio-health`, `web-browse`, `nitpick`, and helper/command-library browsers.
- Audit trails live in `.miniphi/` (`executions/` incl. `task-execution.json`, `prompt-exchanges/`, `helpers/`, `history/`, `indices/` incl. `prompt-router.json`, `web-index.json`, `nitpick-index.json`, `recompose/<session>/edits`, `recompose/<session>/step-events.jsonl`); helper scripts are versioned with stdout/stderr logs.
- Health probes (`lmstudio-health`) write snapshots to `.miniphi/health/lmstudio-status.json` (timeout configurable via `lmStudio.health.timeoutMs`).
- Transport failover is automatic (REST -> WS) after timeouts; timeouts and max-retry settings are configurable via CLI flags or `config*.json` (profiles supported).
- Capability inventory + command-policy (`ask|session|allow|deny`) should be surfaced in prompts so commands and helpers match the host environment.

## How to work the roadmap (stay outcome-focused)
- `ROADMAP.md` is the source of truth; keep this file to the current slice summary and proofs.
- Start with an LM Studio health check (`node src/index.js lmstudio-health --timeout 10` or `scripts/lmstudio-json-debug.js`) before prompting.
- For every slice, run a real task: `miniphi "<task>"` or `node src/index.js run --cmd "<cmd>" --task "<objective>" --prompt-journal <id>`. Verify recursive decomposition produces actionable branches and valid JSON.
- When schemas fail, re-prompt or fall back to deterministic JSON and record the cause in `.miniphi` before iterating; do not loop on the same wording.
- Prefer switching to a new real-task run (or another sample) over rephrasing the same mini-detail; use helper/command-library reuse to vary the action set.
- Close a step only after the JSON was applied to files, diffs were summarized, and a validation command/test passed.

## Active roadmap: v0.1 local file agent
Full plan and future milestones live in `ROADMAP.md`. This section tracks the active slice and proofs.

Exit criteria:
- Planner -> actions -> edits -> summary loop works with strict JSON validation and deterministic fallbacks.
- File edits apply via patch/write with diff summaries and rollback on mismatch.
- Command execution is gated by command-policy with timeouts and max retries; runs end with a clear stop reason.
- Passes `samples/get-started` plus one real repo run without manual patching.

Current slice: Core loop hardening
- Focus: prompt hygiene, schema enforcement, recursion caps, stop reasons in `.miniphi/`.
- Proof: run `miniphi "Tighten lint config"` (or similar) against this repo.
- Proof: run `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-<id>` and confirm JSON-only output with strict parsing (strip <think> blocks + fences + short preambles) and no duplicated workspace directives.

Next slices (see `ROADMAP.md` for full scope and exit criteria):
- Reliable edit pipeline.
- Usable CLI + docs.

Rule: if progress stalls on a slice, switch to another live `miniphi` run instead of revisiting the same mini-detail.

## Runtime building blocks (capsule)
- LMStudioManager / LMStudioHandler / LMStudioRuntime: JIT model loading, REST/WS transport, schema enforcement, streaming JSON parsing, and prompt scoring setup.
- AdaptiveLMStudioHandler + QLearningRouter: optional RL routing across model pools and prompt profiles; state persists under `.miniphi/indices/prompt-router.json` via `rlRouter`.
- PromptSchemaRegistry / SchemaAdapterRegistry: load schemas from `docs/prompts/*.schema.json`, inject schema ids, adapt versions.
- json-schema-utils: shared response_format builder + schema validator across LM Studio calls (run/analyze/navigator/decomposer).
- PromptDecomposer + ApiNavigator: plan branches, propose commands/helpers, execute safe helpers, feed outputs back into prompts.
- PromptStepJournal / PromptRecorder / PromptPerformanceTracker: persist per-step exchanges under `.miniphi/prompt-exchanges/` with telemetry.
- EfficientLogAnalyzer + PythonLogSummarizer: compress outputs, honor `needs_more_context` and truncation plans; store hints in `.miniphi/executions/<id>/analysis.json`.
- WorkspaceProfiler / CapabilityInventory / FileConnectionAnalyzer: cache repo shape + available commands, feed into prompts, and attach ASCII graphs or capability snapshots.
- ResourceMonitor: stream RAM/CPU/VRAM warnings and store rollups under `.miniphi/health/`.
- Helper + command library: versioned scripts in `.miniphi/helpers/`, normalized commands in `.miniphi/helpers/command-library.json` with replay via `node src/index.js helpers|command-library`.
- Benchmarks/recompose harness: `RecomposeTester` and `benchmark recompose|analyze|plan scaffold` drive `samples/recompose/hello-flow` with per-run artifacts under `.miniphi/benchmarks/`.
- Config: optional `config.json`/profiles for endpoints, models, context budgets, timeouts, chunk sizes, and RL routing.

## Testing loops to run often
- `node src/index.js run --cmd "npm test" --task "Analyze failures"` (default flow; watch JSON validity + truncation handling).
- `miniphi "Draft release notes"` (or similar) with `--prompt-journal <id>` to inspect recursion + stepwise JSON.
- `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-<id>` (live JSON-only check; inspect prompt compaction in `.miniphi/prompt-exchanges/`).
- `npm run sample:lmstudio-json-series` (schema-enforced multi-step LM Studio session without repo edits).
- `npm run sample:besh-journal` (large-file truncation + journaling regression).
- `node scripts/prompt-composer.js --send --response-file .miniphi/prompt-chain/response.json` plus `node scripts/prompt-interpret.js --response-file .miniphi/prompt-chain/response.json` to iterate on prompt-chain JSON composition and learned options.
- `RECOMPOSE_MODE=live ./run-log-benchmarks.sh` (when touching recomposition/benchmark stack; archive output folders).
- `node src/index.js lmstudio-health --timeout 10` for a quick REST probe before long-running runs.
- `node src/index.js helpers --limit 5` and `node src/index.js command-library --limit 5` to confirm helper reuse/recording.
- `node scripts/local-eval-report.js --output .miniphi/evals/local-eval-report.json` to capture JSON/tool-call coverage from prompt exchanges.
- `node --test unit-tests-js/cli-bash-advanced.test.js` to run live bash sample prompts (requires LM Studio; long-running).
- `node --test unit-tests-js/romeo-miniphi-flow.test.js` (exercise EfficientLogAnalyzer file flow with stubbed Phi and chunked summaries).

## Romeo unit test quick use
- Run `node --test unit-tests-js/romeo-miniphi-flow.test.js` to validate MiniPhi log/file analysis against `samples/txt/romeoAndJuliet-part1.txt`.
- The test uses stubbed Phi responses and a summarizer to assert JSON-only analysis with correct chunk limits and outputs.
- No LM Studio is required; use failures to fix MiniPhi prompt, JSON handling, or chunk selection logic rather than editing the test or generic utilities.

## Reference docs
- `ROADMAP.md` for the long-lived milestone plan and exit criteria.
- `README.md` for overview/CLI quickstart; `docs/miniphi-cli-implementation.md` for architecture and compression heuristics.
- `docs/NodeJS LM Studio API Integration.md` + `docs/APIs/lmstudio-docs/1_developer/` for SDK/REST behavior (REST + OpenAI-compat).
- `scripts/lmstudio-json-debug.js` + `scripts/lmstudio-json-series.js` for fast LM Studio sanity checks.
- `scripts/prompt-composer.js` + `scripts/prompt-interpret.js` for prompt-chain JSON request/response iteration (see `samples/prompt-chain/`).
- `scripts/local-eval-report.js` for local JSON/tool-call coverage reports over `.miniphi/prompt-exchanges/`.
- `docs/prompts/*.schema.json` are the schema source of truth (including `nitpick-plan`, `nitpick-research-plan`, `nitpick-draft`, `nitpick-critique`); cached templates live under `.miniphi/prompt-exchanges/templates/`.
- Samples: `samples/get-started/`, `samples/recompose/hello-flow/`, `samples/bash-it/`, `samples/besh/`.
- Global cache: `~/.miniphi/` holds the prompt DB, capability snapshots, and shared helper metadata.

## Issues & constraints
- Persistence is local JSON only; `.miniphi/` can grow quickly, so use `cache-prune` retention caps (no encryption yet).
- LM Studio context can stall around 4k on this host; trim prompts or load a larger model when decomposer REST calls fail.
- Live analyze-file runs can still exceed prompt budget and drop summary detail to level 0; keep tuning compaction (schema descriptions, chunk ranges, workspace hint duplication) and record compaction markers in prompt exchanges.
- Windows path quoting for navigator helpers remains fragile; prefer `python3` and log resolved paths.
- Automated tests are sparse; rely on live LM Studio runs + sample workflows until coverage expands.
- Benchmarks skew toward Bash recomposition; diversify when touching orchestration assumptions.

## Prompt templates and baselines
- Use `node src/index.js prompt-template --baseline <name> ...` to emit canonical prompts; saved under `.miniphi/prompt-exchanges/templates/`.
- Truncation/log-analysis templates expose `truncation_strategy` and carryover fields; reuse them instead of inventing new schemas.

## Deep reference (moved from README.md)

### Workspace-first prompts
- `node src/index.js workspace --task "Plan README refresh"` scans the current working directory, summarizes capabilities, and saves a recursive outline without executing arbitrary shell commands.
- Running `npx miniphi "Audit the docs structure" --verbose` (or `miniphi "<task>"` when installed globally) now triggers the same workflow: when the CLI does not recognize the first argument as a command it treats the free-form text as the task and assumes the CWD is the project root. If `--cmd` or `--file` is supplied alongside the free-form task, MiniPhi routes into `run` or `analyze-file` respectively.
- Workspace summaries combine `WorkspaceProfiler`, `CapabilityInventory`, and `ApiNavigator` hints so the model starts with concrete file paths, package scripts, and helper suggestions before editing anything.
- Workspace mode (`miniphi "<task>"`) now emits a log-analysis JSON summary after planning; record it in the prompt journal and treat it like other analysis responses.
- Cached prompt scaffolds from `.miniphi/prompt-exchanges/templates/` (project) and `~/.miniphi/prompts/templates/` (global) are surfaced inside that summary so Phi can reuse proven JSON baselines (truncation-first, log-analysis, etc.) without wasting tokens re-explaining the schema on every run.
- Command-library suggestions now merge the project `.miniphi/helpers/command-library.json` entries with the global `~/.miniphi/helpers/command-library.json` cache so the CLI can surface vetted commands (with schema ids and context budgets) regardless of which repo first learned them.
- Recent prompt/command compositions (schema ids + context budgets) are cached in both project and global stores; workspace prompts include a compact “recent compositions” block so Phi can reuse low-token baselines before inventing new scaffolds.
- Use this mode whenever you want MiniPhi to propose edits (README rewrites, code tweaks, task plans) grounded in the current repo before running `miniphi run --cmd ...`.
- Append `@"path/to/file.js"` (quotes optional) anywhere in your prompt to pin that file as a fixed reference-the CLI resolves the file relative to the current directory, hashes the contents, stores the snapshot under `.miniphi/prompt-exchanges/fixed-references/`, and injects a summary of the file into every downstream prompt for deterministic reasoning.

### Step-by-step prompt journals
- Pass `--prompt-journal <id>` (or omit the value to reuse the auto-generated `--prompt-id`) to enable the new prompt-step journal stored under `.miniphi/prompt-exchanges/stepwise/<id>/`. Every model/API prompt, response, and downstream operation (shell commands, analyzer runs, navigator helpers) is recorded in order so another agent can audit the session before continuing.
- Pair `--prompt-journal-status paused|completed|closed` with repeated runs to explicitly pause or finish a journal; when omitted, the journal now defaults to `paused` after the run. A common pattern is `--prompt-journal session-123 --prompt-journal-status paused` to capture the latest step, review it asynchronously, then resume with `--prompt-journal session-123 --prompt-journal-status completed`.
- When `--session-timeout` elapses, navigator follow-ups and truncation helpers are skipped and logged with reason `session-timeout` inside the journal steps.
- Navigator follow-ups that resolve to MiniPhi CLI entrypoints are skipped and logged with reason `cli-command` to avoid recursive CLI runs.
- Journals coexist with `--prompt-id <id>` so you can persist the Phi chat history and the higher-level operation ledger together. The files are plain JSON so they are easy to diff, summarize, or feed back into MiniPhi as fixed references.
- Try `npm run sample:besh-journal` to see the feature in action: it analyzes the one-file `samples/besh/bsh.c` project, records every summarization prompt, and leaves the journal paused so another agent (or you) can review it before resuming. When you need long-haul signal, wrap the command in a loop (`until npm run sample:besh-journal -- --prompt-journal-status active --verbose; do sleep 60; done`) so `.miniphi/prompt-exchanges/stepwise/` keeps accruing attempts until a clean pass lands.

### Prompt logging contract
- PromptRecorder is the canonical exchange log under `.miniphi/prompt-exchanges/` and stores the full request payload, raw response text, `tool_calls`, and `tool_definitions`.
- PromptRecorder canonicalizes exchange payloads to reduce duplication: `request.response_format` is the canonical response format key, `promptText` is omitted when it matches the last user message, and `response.text` is omitted when it matches `rawResponseText` (which remains the full response text).
- PromptStepJournal under `.miniphi/prompt-exchanges/stepwise/<id>/` records the stepwise operations with prompt/response text and links to PromptRecorder entries via `links.promptExchangeId`/`links.promptExchangePath` when available.
- TaskExecutionRegister writes `executions/<id>/task-execution.json` with every LM Studio API request/response plus links to prompt exchanges so you can pause, fix prompt/schema issues, and resume from the last good call.
- Plan/navigation journal steps now store the raw JSON payload in `response`; any human-readable block moves into `metadata.summaryBlock` for quick scanning without losing schema fidelity.
- Journal step tool metadata uses `tool_calls`/`tool_definitions` so eval tooling can treat prompt exchanges and journals uniformly.
- Analysis steps now attach prompt-exchange links when LM Studio responses are recorded via `LMStudioHandler`.
- Prompt-chain interpreter validation errors are recorded in `.miniphi/prompt-chain/validation-report.json` for prompt-chain debugging.

### Prompt template baselines
- `node src/index.js prompt-template --baseline truncation --task "Teach me to split the jest log" --dataset-summary "Captured 50k lines of Jest output"` prints a ready-to-send Phi prompt that reuses the log-analysis schema (including `truncation_strategy`).
- `node src/index.js prompt-template --baseline log-analysis --task "Summarize the failing jest suites" --schema-id log-analysis` prints the base log/command-analysis prompt (schema block included) so you can version control the JSON contract that MiniPhi expects before dispatching Phi.
- Each invocation writes a template artifact under `.miniphi/prompt-exchanges/templates/<id>.json` so decomposers, helpers, or future runs can replay the exact scaffold. Metadata captures dataset size hints, helper-command focus, and the JSON keys that must persist between chunks.
- Use `--total-lines`, `--target-lines`, `--history-keys`, `--helper-focus`, and `--notes` to pin the truncation budget and the carryover ledger; `--output <path>` saves the rendered prompt to a file, while `--no-workspace` skips workspace profiling when you only need a generic template.
- The command never talks to LM Studio; it simply builds the deterministic baseline around the stored schema so you can version control the generated templates and share them across repos.

### Command authorization & shared memory
- Every run now consults a shared home-level store at `~/.miniphi/` for prompt telemetry, performance data, system profiles, and operator preferences. `miniphi-prompts.db` was relocated there so the scoring database survives across projects.
- Commands are gated by the new `CommandAuthorizationManager`; choose `--command-policy ask|session|allow|deny` (default: `ask`) and opt into `--assume-yes` when you want to auto-approve prompts in non-interactive shells. Use `--command-danger <low|mid|high>` to describe how risky your `--cmd` invocation is so navigator follow-ups inherit the right defaults.
- Navigation prompts returned by `ApiNavigator` now include per-command `danger` fields, so MiniPhi only interrupts you when a potentially destructive command is queued.
- Direct file references and command policies are persisted inside `.miniphi/prompt-exchanges/fixed-references/` (project scope) and `~/.miniphi/preferences/command-policy.json` (global scope) so reruns can replay the exact same context even if the workspace changed in between.
- A lightweight `SchemaAdapterRegistry` sits between LM Studio responses and the CLI; ApiNavigator already emits a `schema_version` field and the adapter normalizes new JSON layouts at runtime so future prompt revisions can evolve without patching the client.

### What ships today
- **Layered LM Studio runtime.** `LMStudioManager` performs JIT model loading and `/api/v0` diagnostics, `LMStudioHandler` streams reasoning while enforcing JSON schema contracts, and `EfficientLogAnalyzer` + `PythonLogSummarizer` compress live command output or saved files before the model thinks.
- **CLI entrypoints + default workflow.** `node src/index.js run --cmd "npm test" --task "Analyze failures"` is the canonical loop, while `analyze-file`, `lmstudio-health`, `web-research`, `web-browse`, `nitpick`, `history-notes`, `cache-prune`, `recompose`, and `benchmark recompose|analyze|plan scaffold` cover file replay, health probes, research snapshots, browsing captures, writer/critic tests, `.miniphi` audits, pruning, recomposition, and benchmark sweeps.
- **Persistent `.miniphi/` workspace.** `miniPhiMemory` snapshots each run under `executions/<id>/`, stores `prompt.json`, `analysis.json`, `task-execution.json` (LM Studio request/response register), helper scripts, TODO queues, and mirrors every sub-prompt as JSON inside `.miniphi/prompt-exchanges/` and `.miniphi/helpers/`. Prompt exchange records retain response text, `tool_calls`, `tool_definitions`, and the `promptJournalId` link.
- **Schema registry + enforcement.** `PromptSchemaRegistry` injects schema blocks from `docs/prompts/*.schema.json` into every model call (main prompts, scoring prompts, decomposers) and rejects invalid responses before they touch history storage.
- **Workspace context analyzers.** `WorkspaceProfiler`, `FileConnectionAnalyzer`, and `CapabilityInventory` scan the repository, render ASCII connection graphs, capture package/repo scripts plus `.bin` tools, and feed those hints into every prompt so Phi knows which capabilities already exist.
- **ApiNavigator helper loops.** Navigation prompts can request single-use Node.js or Python helpers, execute them immediately, and archive the code plus stdout/stderr artifacts under `.miniphi/helpers/` for later runs. Use `node src/index.js helpers --limit 6` to inspect those artifacts (and `--run <id> [--version <n>]` with optional `--stdin/--stdin-file` and `--helper-timeout/--helper-silence-timeout` to replay them safely).
- **Prompt decomposition + planning.** `PromptDecomposer` emits JSON trees and human-readable outlines under `.miniphi/prompt-exchanges/decompositions/`, letting operators resume multi-step tasks mid-branch.
- **REST-aware helper guards.** ApiNavigator and PromptDecomposer automatically disable themselves after LM Studio REST timeouts/connection failures and the CLI prints a reminder to rerun once the APIs recover, preventing repeated hangs on a broken transport.
- **Resource guard rails + health logs.** `ResourceMonitor` samples CPU, RAM, and VRAM in real time, streams warnings to the console, and records rollups under `.miniphi/health/resource-usage.json` alongside `.miniphi/history/benchmarks.json`.
- **Research/history/benchmark archives.** Research snapshots, browsing captures, nitpick sessions, history notes, and benchmark artifacts land in `.miniphi/research/`, `.miniphi/web/`, `.miniphi/nitpick/`, `.miniphi/history-notes/`, and `.miniphi/benchmarks/`, keeping every conversation reproducible.
- **Recomposition + benchmark harness.** `RecomposeTester` and `RecomposeBenchmarkRunner` power `samples/recompose/hello-flow`, retry workspace/plan prompts with `missing_snippets` context when available, repair mismatches with diff-driven prompts, log guarded writes (diff summaries + rollback copies) under `.miniphi/recompose/<session>/edits/`, persist prompt step events under `.miniphi/recompose/<session>/step-events.jsonl`, and export Phi transcripts next to each JSON report.
- **Prompt telemetry + scoring.** `PromptPerformanceTracker` records workspace focus, commands, schema IDs, capability summaries, and prompt lineage inside `miniphi-prompts.db` so future runs can reuse proven setups. Semantic scoring is only enabled when `--debug-lm` is supplied; otherwise heuristic scoring runs without an extra model load.
- **Adaptive RL prompt routing.** Optional Q-learning router chooses a model + prompt profile per prompt using mode/schema/workspace/task/sub-context signals, updates from prompt scores/schema validity/error signals, and persists state at `.miniphi/indices/prompt-router.json` (enable via `rlRouter` config or `--rl-router`/`--rl-models`, optional `--rl-state`).
- **Config profiles and overrides.** Optional `config.json` (or `--config`/`MINIPHI_CONFIG`) pins LM Studio endpoints, prompt defaults, GPU modes, context budgets, resource thresholds, and chunk sizes without retyping flags.
- **Endpoint normalization + prompt defaults.** `lmStudio.clientOptions.baseUrl` can point to either `http://` or `ws://` servers; miniPhi normalizes the WebSocket endpoint automatically, mirrors the same host for the REST client, and lets you omit `prompt.system` entirely to fall back to MiniPhi's built-in system prompt.
- **Samples.** `samples/recompose/hello-flow` remains the canonical recomposition benchmark, while `samples/get-started` introduces a workspace-onboarding scenario with curated prompts for environment detection, README drafting, feature tweaks, and verification commands.
- **Batch benchmark logger.** `./run-log-benchmarks.sh` executes `npm run sample:besh-journal`, all recompose directions, and `npm run benchmark`, storing stdout, git status snapshots, and copies of new artifacts under `current-benchmarks/<timestamp>/`. Set `RECOMPOSE_MODE=live` or `RECOMPOSE_DIRECTIONS=code-to-markdown,...` to customize which combinations run, and wrap the script in `until RECOMPOSE_MODE=live ./run-log-benchmarks.sh; do sleep 120; done` to keep gathering timestamped dossiers until all phases complete cleanly.

miniPhi currently targets macOS, Windows, and Linux and expects LM Studio to be reachable at `http://127.0.0.1:1234`. The defaults assume `mistralai/devstral-small-2-2512` (or `mistralai/devstral-small-2507`) is already downloaded in LM Studio; you can switch to `ibm/granite-4-h-tiny` or `microsoft/phi-4-reasoning-plus` with `--model` or `defaults.model`.

### Architecture snapshot
1. **LMStudioManager** (src/libs/lmstudio-api.js) performs JIT model loading and surfaces the `/api/v0` REST primitives (list models, chat/completion probes, embeddings, runtime stats).
2. **LMStudioHandler** (src/libs/lmstudio-handler.js) wraps LM Studio calls, enforces reasoning streams, wires `--session-timeout`, and declares the JSON schema that each downstream model call must respect.
3. **LMStudioRuntime** (src/libs/lmstudio-runtime.js) centralizes LM Studio setup, compatibility checks, REST/WS wiring, and prompt scoring configuration.
4. **JsonSchemaUtils** (src/libs/json-schema-utils.js) builds `response_format=json_schema` payloads and validates JSON responses before downstream handlers apply fallbacks.
5. **EfficientLogAnalyzer + PythonLogSummarizer** compress streamed stdout/stderr or files by chunk, annotate the segments, and feed the high-signal slices to the model while embedding the proper JSON schema from `docs/prompts/`.
6. **miniPhiMemory + PromptRecorder** archive prompts, compressed context, responses, TODOs, scoring metadata, recursive prompt plans, and capability outlines under `.miniphi/` so future runs can rehydrate any exchange.
7. **WorkspaceProfiler + FileConnectionAnalyzer + CapabilityInventory** scan the repository tree ahead of a run so each prompt is prefixed with facts about the code/docs split, import/dependency graph, and available scripts/binaries.
8. **PromptPerformanceTracker** scores every prompt/response pair inside `miniphi-prompts.db` (SQLite), captures prompt lineage/schema IDs/commands/capabilities, and exposes the structured telemetry to scoring prompts and future runs.

### src/ file map
- `src/index.js`: CLI entrypoint and command router; loads config, builds workspace context, and wires LM Studio, memory, and analyzers for all commands.
- `src/commands/`: Command handlers extracted from `src/index.js` (run, analyze-file, workspace, recompose, benchmark, prompt-template, web-research, web-browse, nitpick, history-notes, cache-prune, command-library, helpers).
- `src/libs/api-navigator.js`: Requests navigation plans from LM Studio, normalizes actions, and optionally runs helper scripts.
- `src/libs/benchmark-general.js`: General-purpose benchmark flow, resource baselines, and summaries.
- `src/libs/benchmark-analyzer.js`: Reads benchmark run JSON files, produces summary artifacts, and records history entries.
- `src/libs/cache-pruner.js`: Prunes `.miniphi` artifacts using retention caps and index metadata.
- `src/libs/capability-inventory.js`: Scans package scripts, `scripts/`, `.bin` tools, and OS commands to summarize available capabilities.
- `src/libs/cli-executor.js`: Cross-platform shell command runner with streaming output, timeouts, and silence detection.
- `src/libs/cli-utils.js`: CLI parsing helpers for numeric flags and duration parsing.
- `src/libs/command-authorization-manager.js`: Enforces command policies (`ask|allow|deny|session`) and prompts for approval.
- `src/libs/config-loader.js`: Loads `config.json` or `miniphi.config.json`, applies profiles, and merges settings.
- `src/libs/core-utils.js`: Shared helpers for plan formatting, JSON parsing, danger normalization, and LM Studio URL handling.
- `src/libs/efficient-log-analyzer.js`: Orchestrates command/file analysis with summarization, schema enforcement, and truncation plans.
- `src/libs/file-connection-analyzer.js`: Builds a lightweight import graph (JS/Python) and hotspot summary for the workspace.
- `src/libs/file-edit-guard.js`: Guarded write helper that captures diff summaries and rollback copies for recompose edits.
- `src/libs/global-memory.js`: Home-level `.miniphi` store for shared helpers, templates, preferences, and prompt telemetry.
- `src/libs/history-notes.js`: Captures `.miniphi` snapshots (optionally with git metadata) into JSON and Markdown.
- `src/libs/json-schema-utils.js`: Shared helpers to build JSON schema response_format blocks and validate responses.
- `src/libs/lms-phi4.js`: Legacy alias for `lmstudio-handler` exports.
- `src/libs/lmstudio-api.js`: LM Studio SDK wrapper and REST client utilities, including URL normalization and model lifecycle.
- `src/libs/lmstudio-client-options.js`: Build LM Studio REST client options from config defaults.
- `src/libs/lmstudio-error-utils.js`: Shared LM Studio error classification and transport/timeout detection.
- `src/libs/lmstudio-handler.js`: LM Studio chat handler with streaming, schema enforcement, retries, and history management.
- `src/libs/lmstudio-runtime.js`: LM Studio runtime bootstrap for handler setup, REST wiring, and prompt scoring.
- `src/libs/memory-store-utils.js`: JSON file IO helpers, slug/relative path utilities, composition key builders, and index upsert helpers.
- `src/libs/model-selector.js`: Task intent classifier and model selection helpers (writer/critic defaults).
- `src/libs/miniphi-memory.js`: Project `.miniphi` store layout and persistence for executions, prompts, helpers, and indexes.
- `src/libs/model-presets.js`: Model presets, aliases, default context lengths, and config resolution.
- `src/libs/phi4-stream-parser.js`: Stream transformer that separates `<think>` blocks from solution tokens.
- `src/libs/prompt-chain-utils.js`: Utilities for prompt-chain templates, option sets, and learned option merges.
- `src/libs/prompt-decomposer.js`: LM Studio-backed task decomposition with JSON plan schema enforcement.
- `src/libs/prompt-performance-tracker.js`: SQLite-based prompt scoring and telemetry capture, with optional semantic grading.
- `src/libs/prompt-recorder.js`: Writes prompt/response exchanges under `.miniphi/prompt-exchanges/`.
- `src/libs/prompt-schema-registry.js`: Loads schemas from `docs/prompts/`, builds instruction blocks, validates responses.
- `src/libs/prompt-step-journal.js`: Stepwise prompt journal manager for `.miniphi/prompt-exchanges/stepwise/`.
- `src/libs/prompt-template-baselines.js`: Builds baseline prompts for truncation and log-analysis workflows.
- `src/libs/task-execution-register.js`: Records per-execution LM Studio API request/response pairs under `executions/<id>/task-execution.json`.
- `src/libs/python-log-summarizer.js`: Runs the Python summarizer and chunks line-based inputs.
- `src/libs/recompose-harness.js`: Recompose harness setup and LM Studio availability checks.
- `src/libs/recompose-benchmark-runner.js`: Runs recompose benchmark series and writes reports/logs.
- `src/libs/recompose-tester.js`: Recompose harness that converts between code and markdown using LM Studio.
- `src/libs/recompose-utils.js`: Recompose helpers for parsing, normalization, and narrative/diff summarization.
- `src/libs/resource-monitor.js`: Samples CPU/RAM/VRAM usage and persists session summaries.
- `src/libs/runtime-defaults.js`: Shared runtime timeout defaults.
- `src/libs/schema-adapter-registry.js`: Registers schema adapters for request/response normalization.
- `src/libs/stream-analyzer.js`: Line-by-line file reader for chunked analysis of large files.
- `src/libs/web-researcher.js`: DuckDuckGo Instant Answer client for the `web-research` command.
- `src/libs/web-browser.js`: Puppeteer-backed browser fetcher for `web-browse` and blind nitpick sources.
- `src/libs/workspace-context-utils.js`: Builds workspace file manifests, README snippets, and prompt hint blocks.
- `src/libs/workspace-profiler.js`: Profiles workspace contents (code/docs/data) and optionally includes connection graphs.

### Command tour
- `run` executes a command and streams reasoning. Key flags: `--cmd`, `--task`, `--cwd`, `--timeout`, `--session-timeout`, `--no-navigator`, `--prompt-id`, `--plan-branch`, `--refresh-plan`, `--python-script`, `--summary-levels`, `--context-length`, and the resource monitor thresholds (`--max-memory-percent`, `--max-cpu-percent`, `--max-vram-percent`, `--resource-sample-interval`).
- `analyze-file` summarizes an existing file. Flags mirror `run` but swap `--cmd` for `--file`.
- `web-research` performs DuckDuckGo Instant Answer lookups. Use positional queries or `--query`, set `--max-results`, `--provider`, `--include-raw`, `--no-save`, and optional `--note`. Results live under `.miniphi/research/`.
- `web-browse` drives a headless browser (Puppeteer) to capture page text. Use `--url` (or positional URLs), `--url-file`, `--timeout/--timeout-ms`, `--wait-selector`/`--wait-ms`, `--selector` to scope extraction, `--max-chars`, `--include-html`, `--screenshot` (`--screenshot-dir`), `--headful`, and `--block-resources` to speed loads. Snapshots land under `.miniphi/web/`.
- `nitpick` runs a writer/critic loop to draft and revise long-form text with strict JSON schemas. Flags: `--writer-model`, `--critic-model`, `--model-pool`, `--rounds`, `--target-words`, `--blind` (forces web research + browsing), `--max-results`, `--max-sources`, `--max-source-chars`, `--research-rounds`, `--provider`, `--browser-timeout/--browser-timeout-ms`, `--output`, and `--print`. Sessions are saved under `.miniphi/nitpick/`.
- `history-notes` snapshots `.miniphi/` and optionally attaches git metadata. Use `--label`, `--history-root`, and `--no-git`.
- `cache-prune` trims older `.miniphi/` artifacts using retention caps. Use `--retain-*` overrides, `--dry-run`, `--json`, and `--cwd` to scope the workspace.
- `command-library` prints every command that Phi recommended via `recommended_fixes[].commands`; filter with `--search`, `--tag`, and `--limit`, or add `--json` to consume the output programmatically.
- `helpers` lists the versioned helper scripts saved under `.miniphi/helpers/`. Filter with `--workspace-type`, `--source`, `--search`, or `--limit`, dump JSON with `--json`, and rerun helpers via `--run <id> [--version <n>]` plus optional `--stdin`, `--stdin-file`, `--helper-timeout`, `--helper-silence-timeout`, and `--helper-cwd`.
- `recompose` operates on `samples/recompose` projects. Flags: `--sample`, `--direction code-to-markdown|markdown-to-code|roundtrip`, `--code-dir`, `--descriptions-dir`, `--output-dir`, `--clean`, `--report`, `--resume-descriptions`, and `--recompose-mode auto|live|offline` (default: auto; offline writes stub code). Use `--workspace-overview-timeout <seconds>` (or `--workspace-overview-timeout-ms <ms>`) to raise the dedicated workspace-overview prompt budget when Phi-4 needs more time before narration. Used for development and testing purposes.
- `benchmark recompose` automates timestamped runs (default sample `samples/recompose/hello-flow`). Mix in `--directions`, `--repeat`, `--run-prefix`, `--timestamp`, `--clean`, `--resume-descriptions`, or `--sample`.
- `benchmark analyze` reads `RUN-###.json` files, emits `SUMMARY.json|md|html`, and supports `--path` or positional directories plus repeated `--compare` flags to diff baselines vs candidates.
- `benchmark plan scaffold` inspects a sample (default `hello-flow`) and prints a commented YAML template; use `--sample`, `--benchmark-root`, and `--output` to persist it.
- `benchmark general` profiles the current workspace, refreshes prompt baselines, optionally executes `--cmd "<command>"` under watchdog timers, and records CPU/RAM deltas against `benchmark/baselines/general-purpose-baseline.json`. Tune it with `--task`, `--timeout`, `--silence-timeout`, `--cwd`, and the standard config/profile flags to keep truncation-first planning + helper synthesis under regression.

Every command accepts `--config <path>` (falls back to searching upward for `config.json`), optional `--profile <name>` to activate a named config preset, and `--verbose` for progress logs. `--debug-lm` enables the semantic prompt scoring evaluator and prints every objective + prompt while scoring runs.

### Frequently used flags
- `--task` describes what the model should do with the log or command output. If omitted, it defaults to `"Provide a precise technical analysis"` from `config.example.json`.
- `--prompt-id <id>` or `--config defaults.promptId` let you resume a chat session; transcripts are written to `.miniphi/prompt-sessions/<id>.json`.
- `--plan-branch <step-id>` focuses a saved plan branch (paired with `--prompt-id`) instead of recomputing the decomposition; add `--refresh-plan` to force a new plan even when one is cached.
- `--prompt-journal [id]` mirrors every prompt + downstream operation into `.miniphi/prompt-exchanges/stepwise/<id>/`; combine with `--prompt-journal-status paused|completed|closed` to pause/resume journals explicitly.
- `--python-script <path>` overrides the bundled `log_summarizer.py` (miniPhi will auto-detect `python3`, `python`, or `py`).
- `--resume-truncation <execution-id>` replays the truncation plan saved for a previous analyze-file run; use it as soon as the CLI tells you a plan was captured.
- `--truncation-chunk <priority|label>` selects which chunk goal from the saved plan should drive the follow-up run. When the plan contains a line range, MiniPhi restricts summarization to that slice automatically.
- When resuming a truncation plan, MiniPhi now auto-runs any helper commands declared in the plan, records helper and chunk completion metadata under `.miniphi/executions/<execution-id>/truncation-progress.json`, and prints the next suggested `--truncation-chunk` selector so you can chain follow-up runs without manual bookkeeping.
- `--session-timeout <s>` hard-stops the orchestration; the model receives the remaining budget with each prompt so runaway loops cannot hang the CLI, and follow-up helpers are skipped once the budget is exhausted.
- `--no-navigator` disables navigator prompts and follow-up commands for run/analyze-file/workspace when you want a single-pass run.
- When `--session-timeout` is paired with `--no-summary` and `--no-stream`, MiniPhi skips navigator/decomposer prompts to conserve the session budget (fast mode for long-running tests).
- When `--session-timeout` is at or below the prompt timeout, MiniPhi auto-skips planner/navigator prompts to preserve analysis time unless you raise the session budget.
- `--no-summary` skips the JSON footer if another system is reading stdout.
- `MINIPHI_CONFIG=/path/config.json` is honored if you prefer environment variables over flags.
- `MINIPHI_PROFILE=<name>` activates a named profile inside config.json so you can pin LM Studio endpoints, GPU modes, prompt templates, or retention policies without rewriting the base config.

### Hidden `.miniphi` workspace
miniPhi always writes to the nearest `.miniphi/` directory (creating one if it does not exist):
- `executions/<id>/` contains `execution.json`, `prompt.json`, `analysis.json`, `task-execution.json` (LM Studio request/response register), compression chunks, and any generated log segments.
- `prompt-exchanges/` captures every model request, including decompositions (`prompt-exchanges/decompositions/`) and sub-prompts, as JSON.
- `prompt-exchanges/stepwise/<session>/` hosts the new prompt journals so you can replay each API call + resulting operation step-by-step (useful for AI oversight or handoffs).
- `prompt-exchanges/templates/` is the catalog of baseline prompts generated by `prompt-template`; each entry records the rendered prompt, dataset hints, and helper focus so you can replay truncation strategies without re-authoring them.
- Every saved template is mirrored into `~/.miniphi/prompts/templates/` and the workspace hint block now lists the most relevant scaffolds (local + global) before Phi is prompted, so long-lived repos automatically reuse the best-known JSON shells.
- `.miniphi/helpers/command-library.json` accumulates any commands Phi recommended inside `recommended_fixes[].commands`, making it easy to replay previously suggested remediation steps or share them across runs.
- The workspace context passed to Phi now includes a short "Command library recommendations" block whenever the library has entries, so prompt plans automatically see the best-known remediation commands before generating new suggestions.
- `.miniphi/indices/prompt-compositions.json` stores recent schema/command/context combinations that produced usable JSON (with fallback and invalid attempts retired); global `~/.miniphi/helpers/prompt-compositions.json` mirrors the best entries so future runs can reuse low-token baselines automatically.
- Prompt contexts now also summarize `.miniphi/index.json` plus the latest `.miniphi/history/benchmarks.json` entries so Phi understands what prior executions and benchmark digests exist without re-reading the graphs.
- Every `.miniphi/executions/<id>/analysis.json` now includes any `context_requests` Phi emitted, giving you a persistent record of the exact snippets or descriptions the model asked for before rerunning the analyzer.
- `research/`, `web/`, `nitpick/`, `history-notes/`, and `benchmarks/` collect the outputs from their corresponding commands.
- `knowledge.json`, `todo.json`, and `prompts.json` retain condensed insights, future work items, and prompt hashes; recursive indexes live in `.miniphi/indices/` for faster lookups.
- `health/resource-usage.json` stores the last 50 resource-monitor snapshots, and `.miniphi/history/benchmarks.json` mirrors benchmark rollups.

All of these artifacts are plain text so you can sync them to your own dashboards or feed them into future orchestrators.

### Documentation and samples
- `OPTIMIZATIONS.md` is the optimization roadmap for full-pipeline improvements across `src/`.
- `AI_REFERENCE.md` holds the current status snapshot plus the near-term roadmap.
- `ROADMAP.md` tracks the long-lived milestone plan and explicit exit criteria.
- `docs/NodeJS LM Studio API Integration.md` explains how the LM Studio SDK and REST layers fit together.
- `docs/miniphi-cli-implementation.md` walks through compression heuristics, pipelines, and architectural decisions.
- `docs/APIs/lmstudio-docs/1_developer/` contains the current LM Studio developer docs; `docs/studies/APIs/REST API v0 _ LM Studio Docs.html` is the archived offline snapshot.
- `scripts/lmstudio-json-debug.js` is a small REST runner that prints the raw LM Studio completion + the parsed JSON object (useful for debugging system prompts / schema enforcement outside the CLI).
- `scripts/lmstudio-json-series.js` runs a multi-step, schema-enforced LM Studio session that applies file edits inside a sandbox copy of `samples/get-started/code` (use `npm run sample:lmstudio-json-series`).
- `scripts/prompt-composer.js` renders JSON-only prompt payloads from a prompt-chain definition (with option selections + templates) and can send them to LM Studio for rapid prompt iteration.
- `scripts/prompt-interpret.js` validates prompt-chain responses against a schema and updates learned options/selected options based on the JSON output.
- `unit-tests-js/lmstudio-json-schema.integration.test.js` is an optional integration test for LM Studio JSON-schema enforcement; run with `MINIPHI_LMSTUDIO_INTEGRATION=1 npm test` (requires LM Studio running).
- `docs/os-defaults/windows.md` and `docs/prompts/windows-benchmark-default.md` document the Windows helper workflow.
- `docs/studies/todo/author.md` tracks authoring tasks that still need human review.
- `samples/recompose/hello-flow` plus `samples/benchmark/` contain the recomposition harness and reference plans described in `WHY_SAMPLES.md`.
- `samples/prompt-chain/` includes a prompt-chain definition, JSON template, and option files for iterating on JSON-first prompt composition.
- `samples/besh/bsh.c` is a massive single-file shell used to stress recursive summarization; `npm run sample:besh-journal` walks through it with the prompt journal enabled.
- `samples/bash-it/` is a fixed copy of the Bash shell source tree (with its real multi-directory layout) so you can run unit-style MiniPhi tests, recomposition exercises, or benchmarking passes against a realistic, complex workspace without needing to clone GNU Bash separately.

### Project status
- Ready: layered LM Studio stack (`LMStudioManager`, `LMStudioHandler`, `EfficientLogAnalyzer`) is production ready with reasoning streaming, JSON schema guards, and prompt scoring.
- Ready: `.miniphi` memory, prompt transcripts, and research or history snapshots are stable across commands.
- Ready: helper utilities (danger normalization, navigation planners, LM Studio endpoint detection) now have automated coverage via `npm test` (`node --test ./unit-tests-js/**/*.test.js`).
- Warning: compression heuristics and Phi prompt templates still require manual verification because integration tests depend on live LM Studio responses (use `scripts/lmstudio-json-debug.js` or `MINIPHI_LMSTUDIO_INTEGRATION=1 npm test` when validating JSON-only contracts).
- In progress: packaging (`npm bin` publish), richer summarization backends, better telemetry, and retention policies for `.miniphi` artifacts are still underway.
- Next up: upcoming work focuses on runtime improvements (prompt orchestration, analyzers, LM Studio clients) rather than tweaking benchmark scripts; the `benchmark analyze` and `plan scaffold` tools already cover reporting needs.

## Archived/backlog
- Historical idea/backlog lists now live in `docs/studies/notes/author.md` and git history. Refer there when you need the longer parking lot; keep this file focused on active guidance.
