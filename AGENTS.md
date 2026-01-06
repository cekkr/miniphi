# After a prompt
- Keep `README.md` and this reference in sync whenever MiniPhi gains a new command, argument, or workflow.
- Benchmark/recompose/test scripts are instrumentation; treat failures as runtime bugs and only edit scripts to expand coverage or logging.
- Every LM Studio prompt must declare the exact JSON schema and use `response_format=json_schema`; reject non-JSON responses and re-prompt or emit deterministic fallback JSON. Navigator now falls back to a deterministic JSON block with `stop_reason` after timeouts, and decomposer emits a fallback plan when schema fields are missing.
- JSON request payloads and JSON responses are mandatory; never use narrative-only exchanges for chunk selection, truncation plans, or missing snippet requests.
- Prompt/response instrumentation must retain response text, tool_calls, and tool_definitions so evaluation datasets can score tool-call accuracy and task adherence (see `thirds/ai-agent-evals`).
- Keep scope focused on a local file-manipulation agent for coding projects; defer broad research or multi-agent exploration until the v0.1 exit criteria are met.
- Roadmap items need explicit exit criteria; if a new item is added, remove or defer a lower-priority one.
- Prevent infinite loops: cap recursive prompts and retries, enforce helper timeouts, and persist a clear stop reason in `.miniphi/`.
- Do not change generic libraries just to satisfy a narrow unit test; use tests to improve MiniPhi behavior instead of editing test intent or broad utilities.
- Avoid writing placeholder notes into docs; only record optional notes in `.miniphi/history/forgotten-notes.md` when `--forgotten-note` is supplied.

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
- Strip `<think>`/markdown preambles, parse strictly, and treat non-JSON as failure; trigger a deterministic fallback JSON if the model drifts.
- Never salvage JSON from mixed prose; only accept payloads that are valid JSON after stripping `<think>` blocks and JSON fences.
- All suggested actions must be structured arrays/objects with reasons and a declared `schema_version`/`schema_uri`; normalize through `SchemaAdapterRegistry` before use.
- Chunk selection, truncation plans, and missing snippets must be expressed as structured JSON fields, never prose; reject narrative responses even if they are correct.
- EfficientLogAnalyzer normalizes missing `needs_more_context`/`missing_snippets` to defaults when the model omits them.

## Runtime posture
- Default LM Studio endpoint: `http://127.0.0.1:1234` (REST) with WebSocket fallback; default model `mistralai/devstral-small-2-2512` (swap to `ibm/granite-4-h-tiny` or `microsoft/phi-4-reasoning-plus` via `--model` or `defaults.model`).
- CLI entrypoints: `run`, `analyze-file`, `workspace` (`miniphi "<task>"`), `recompose`, `benchmark recompose|analyze|plan scaffold`, and helper/command-library browsers.
- Audit trails live in `.miniphi/` (`executions/`, `prompt-exchanges/`, `helpers/`, `history/`, `indices/`); helper scripts are versioned with stdout/stderr logs.
- Transport failover is automatic (REST -> WS) after timeouts; timeouts and max-retry settings are configurable via CLI flags or `config*.json` (profiles supported).
- Capability inventory + command-policy (`ask|session|allow|deny`) should be surfaced in prompts so commands and helpers match the host environment.

## How to work the roadmap (stay outcome-focused)
- `ROADMAP.md` is the source of truth; keep this file to the current slice summary and proofs.
- Start with an LM Studio health check (`scripts/lmstudio-json-debug.js` or `/api/v0/status` via the CLI) before prompting.
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
- Proof: run `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-<id>` and confirm JSON-only output with no duplicated workspace directives.

Next slices (see `ROADMAP.md` for full scope and exit criteria):
- Reliable edit pipeline.
- Usable CLI + docs.

Rule: if progress stalls on a slice, switch to another live `miniphi` run instead of revisiting the same mini-detail.

## Runtime building blocks (capsule)
- LMStudioManager / LMStudioHandler: JIT model loading, REST/WS transport, schema enforcement, streaming JSON parsing.
- PromptSchemaRegistry / SchemaAdapterRegistry: load schemas from `docs/prompts/*.schema.json`, inject schema ids, adapt versions.
- PromptDecomposer + ApiNavigator: plan branches, propose commands/helpers, execute safe helpers, feed outputs back into prompts.
- PromptStepJournal / PromptRecorder / PromptPerformanceTracker: persist per-step exchanges under `.miniphi/prompt-exchanges/` with telemetry.
- EfficientLogAnalyzer + PythonLogSummarizer: compress outputs, honor `needs_more_context` and truncation plans; store hints in `.miniphi/executions/<id>/analysis.json`.
- WorkspaceProfiler / CapabilityInventory / FileConnectionAnalyzer: cache repo shape + available commands, feed into prompts, and attach ASCII graphs or capability snapshots.
- ResourceMonitor: stream RAM/CPU/VRAM warnings and store rollups under `.miniphi/health/`.
- Helper + command library: versioned scripts in `.miniphi/helpers/`, normalized commands in `.miniphi/helpers/command-library.json` with replay via `node src/index.js helpers|command-library`.
- Benchmarks/recompose harness: `RecomposeTester` and `benchmark recompose|analyze|plan scaffold` drive `samples/recompose/hello-flow` with per-run artifacts under `.miniphi/benchmarks/`.
- Config: optional `config.json`/profiles for endpoints, models, context budgets, timeouts, and chunk sizes.

## Testing loops to run often
- `node src/index.js run --cmd "npm test" --task "Analyze failures"` (default flow; watch JSON validity + truncation handling).
- `miniphi "Draft release notes"` (or similar) with `--prompt-journal <id>` to inspect recursion + stepwise JSON.
- `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-<id>` (live JSON-only check; inspect prompt compaction in `.miniphi/prompt-exchanges/`).
- `npm run sample:lmstudio-json-series` (schema-enforced multi-step LM Studio session without repo edits).
- `npm run sample:besh-journal` (large-file truncation + journaling regression).
- `node scripts/prompt-composer.js --send --response-file .miniphi/prompt-chain/response.json` plus `node scripts/prompt-interpret.js --response-file .miniphi/prompt-chain/response.json` to iterate on prompt-chain JSON composition and learned options.
- `RECOMPOSE_MODE=live ./run-log-benchmarks.sh` (when touching recomposition/benchmark stack; archive output folders).
- `node src/index.js helpers --limit 5` and `node src/index.js command-library --limit 5` to confirm helper reuse/recording.
- `node --test unit-tests-js/romeo-miniphi-flow.test.js` (exercise EfficientLogAnalyzer file flow with stubbed Phi and chunked summaries).

## Romeo unit test quick use
- Run `node --test unit-tests-js/romeo-miniphi-flow.test.js` to validate MiniPhi log/file analysis against `samples/txt/romeoAndJuliet-part1.txt`.
- The test uses stubbed Phi responses and a summarizer to assert JSON-only analysis with correct chunk limits and outputs.
- No LM Studio is required; use failures to fix MiniPhi prompt, JSON handling, or chunk selection logic rather than editing the test or generic utilities.

## Reference docs
- `ROADMAP.md` for the long-lived milestone plan and exit criteria.
- `README.md` for overview/CLI quickstart; `docs/miniphi-cli-implementation.md` for architecture and compression heuristics.
- `docs/NodeJS LM Studio API Integration.md` + `docs/studies/APIs/REST API v0 _ LM Studio Docs.html` for SDK/REST behavior.
- `scripts/lmstudio-json-debug.js` + `scripts/lmstudio-json-series.js` for fast LM Studio sanity checks.
- `scripts/prompt-composer.js` + `scripts/prompt-interpret.js` for prompt-chain JSON request/response iteration (see `samples/prompt-chain/`).
- `docs/prompts/*.schema.json` are the schema source of truth; cached templates live under `.miniphi/prompt-exchanges/templates/`.
- Samples: `samples/get-started/`, `samples/recompose/hello-flow/`, `samples/bash-it/`, `samples/besh/`.
- Global cache: `~/.miniphi/` holds the prompt DB, capability snapshots, and shared helper metadata.

## Issues & constraints
- Persistence is local JSON only; `.miniphi/` can grow quickly and lacks pruning or encryption.
- LM Studio context can stall around 4k on this host; trim prompts or load a larger model when decomposer REST calls fail.
- Live analyze-file runs can still exceed prompt budget and drop summary detail to level 0; keep tuning compaction (schema descriptions, chunk ranges, workspace hint duplication) and record compaction markers in prompt exchanges.
- Windows path quoting for navigator helpers remains fragile; prefer `python3` and log resolved paths.
- Automated tests are sparse; rely on live LM Studio runs + sample workflows until coverage expands.
- Benchmarks skew toward Bash recomposition; diversify when touching orchestration assumptions.

## Prompt templates and baselines
- Use `node src/index.js prompt-template --baseline <name> ...` to emit canonical prompts; saved under `.miniphi/prompt-exchanges/templates/`.
- Truncation/log-analysis templates expose `truncation_strategy` and carryover fields; reuse them instead of inventing new schemas.

## Archived/backlog
- Historical idea/backlog lists now live in `docs/studies/notes/author.md` and git history. Refer there when you need the longer parking lot; keep this file focused on active guidance.
