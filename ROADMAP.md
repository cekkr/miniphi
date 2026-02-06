# MiniPhi Roadmap

This roadmap keeps MiniPhi development outcome-driven, JSON-first, and locally reproducible.
Each milestone includes explicit exit criteria and proof runs so progress stays measurable over time.

## Scope and non-goals
- Scope: local file manipulation agent for coding projects with LM Studio JSON-first prompts.
- Non-goals until v0.1 ships: broad research automation, multi-agent orchestration, remote writes.

## Guiding principles
- JSON-first: every model exchange is schema-validated with deterministic fallbacks.
- Local-only: edits and helpers operate within the working directory and `.miniphi/`.
- Reproducible: every slice closes only after a real MiniPhi run and recorded stop reason.
- Evaluation-driven: prompt/response changes must pass ai-agent-evals style checks (JSON compliance, tool-call accuracy, task adherence, token usage) before a slice closes.
- Minimal drift: if a new roadmap item is added, defer or remove a lower-priority item.

## Milestones

### v0.1 Local file agent (Active)
Objective: deliver a stable local file-edit loop with strict JSON validation, resumable plans, and audit trails.

Exit criteria:
- Planner -> actions -> edits -> summary loop works with strict JSON validation and deterministic fallbacks.
- File edits apply via patch/write with diff summaries and rollback on mismatch.
- Command execution is gated by command-policy with timeouts and max retries; runs end with a clear stop reason.
- Passes `samples/get-started` plus one real repo run without manual patching.

Slices (do in order):
1) Core loop hardening
   - Scope: prompt hygiene, schema enforcement, request building/compaction, response parsing (needs_more_context/missing_snippets), recursion caps, stop reasons in `.miniphi/`.
   - Proof runs:
     - `miniphi "Tighten lint config"` (or similar) against this repo.
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-<id> --session-timeout 900 --no-navigator`.
     - Inspect `.miniphi/prompt-exchanges/` and `.miniphi/prompt-exchanges/stepwise/<id>/` for schema id/response_format on requests, raw JSON responses, and captured missing snippets.
   - Recent test evidence:
     - Stepwise CLI unit tests (`cli-benchmark`, `cli-recompose`, `cli-smoke`) confirm offline CLI entrypoints execute successfully.
     - These tests do not yet exercise request composer or response interpreter flows backed by LM Studio.
   - `node src/index.js command-library --limit 1` completed (no commands matched the current filters).
   - `npm test` passed after modularizing `run`, `analyze-file`, and `workspace` command handlers.
   - Live LM Studio run: `node src/index.js run --cmd "node -v" --task "Summarize the Node version output." --command-policy allow --assume-yes` returned JSON analysis with `v21.5.0` and recorded an analysis summary.
   - `npm test` passed after extracting recompose/benchmark helpers into shared libs.
   - Live LM Studio run (2026-01-15): `node src/index.js run --cmd "node -v" --task "Summarize the Node version output." --command-policy allow --assume-yes` emitted JSON with `v21.5.0` but the harness timed out after 122s (model load completed).
   - Live recompose run (2026-01-15): `node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean --recompose-mode live` requested missing snippets (`README.md`, `src/shared/logger.js`, `src/shared/persistence/memory-store.js`, `src/flows/steps/normalize.js`, `src/flows/steps/validate.js`) before the harness timed out; prompt log under `.miniphi/recompose/2026-01-15T00-28-01-102Z-recompose/prompts.log`.
   - Composer/interpreter runs (LM Studio):
     - `node scripts/prompt-composer.js --send --response-file .miniphi/prompt-chain/response.json` returned JSON-only content and saved a response payload.
     - `node scripts/prompt-interpret.js --response-file .miniphi/prompt-chain/response.json` parsed the response JSON without salvage.
     - Fix applied: prompt chain template path now uses chain-relative `prompt-template.json` (previous absolute-in-chain path caused ENOENT).
   - Schema enforcement run:
     - `npm run sample:lmstudio-json-series` completed with a JSON final report and passing verification (`npm test`).
   - Cache prune dry run:
     - `node src/index.js cache-prune --dry-run` reported 8 executions, 144 prompt exchanges, and 7 prompt journals retained (no deletions at retention 200).
   - Local eval coverage snapshot:
     - `node scripts/local-eval-report.js --output .miniphi/evals/local-eval-report.json` showed response_format coverage at 12.5% (prompt-plan 13, navigation-plan 5) with tool_calls/tool_definitions and rawResponseText at 100%.
   - Local eval coverage update (2026-01-16):
     - `node scripts/local-eval-report.js --output .miniphi/evals/local-eval-report.json` now reports response_format/schema name coverage at 100% across 144 prompt exchanges (log-analysis + recompose + navigator + planner).
   - LM Studio endpoint resolution (2026-01-17):
     - WS/REST base URLs now resolve through `src/libs/lmstudio-endpoints.js` and the runtime consumes the resolved endpoints for consistent transport wiring.
   - Live analyze-file run (2026-01-16):
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-20260116c --prompt-journal-status paused --no-stream --session-timeout 300` completed; prompt exchange includes `schemaId: log-analysis` and `request.response_format` for the main analysis prompt.
   - Prompt budget compaction (2026-01-16):
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-20260116d --prompt-journal-status paused --no-stream --session-timeout 300` trimmed the context supplement budget (20%) instead of dropping summary level.
   - Live analyze-file rerun (2026-01-29):
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-20260129b --prompt-journal-status paused --no-stream --session-timeout 900 --no-navigator --resume-truncation 7ddf165f-070f-4910-9971-df2cd0a45f12` returned a valid JSON summary and completed the truncation plan (1/1).
   - Live analyze-file run (2026-01-29):
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-20260129c --prompt-journal-status paused --no-stream --session-timeout 300` succeeded after auto-skipping planner/navigator due to the low session timeout.
   - Live analyze-file run (2026-02-02):
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 0 --prompt-journal live-romeo-json-20260202c --prompt-journal-status paused --no-stream --session-timeout 120 --no-navigator` emitted deterministic fallback JSON after a session timeout; prompt journal recorded schema metadata and a truncation plan.
   - Live analyze-file run (2026-02-03):
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-20260203a --prompt-journal-status paused --no-stream --session-timeout 900 --no-navigator` returned a non-fallback JSON summary; stepwise journal metadata shows stop_reason fields were null.
   - Live analyze-file run (2026-02-03, navigator enabled):
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-20260203b --prompt-journal-status paused --no-stream --session-timeout 900` returned a non-fallback JSON summary with planner/navigator active; stepwise journal metadata shows stop_reason fields were null.
   - LM Studio health gate (2026-02-06):
     - `node src/index.js lmstudio-health --timeout 10 --json` confirms REST connectivity (falls back to `/models` when `/status` is unsupported) and the run pipeline now probes LM Studio before prompting; use `--no-health` to skip or force WS transport in config.
   - Note: short `--session-timeout` values (<= 300s) can starve the final analysis prompt after planner/navigator overhead on this host; prefer >= 900s or add `--no-navigator` for time-boxed runs.
   - Live bash prompt tests (2026-01-16):
     - `node --test unit-tests-js/cli-bash-advanced.test.js` passed against `samples/bash`; tests isolate `.miniphi` roots and use a temp config with `prompt.timeoutSeconds=120` to avoid LM Studio timeouts (runtime ~9 min).
   - Recompose roundtrip run (2026-01-11):
     - `node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean` fell back to the workspace overview after 3 attempts; prompt log captured in `.miniphi/recompose/2026-01-11T21-10-44-250Z-recompose/prompts.log`.
     - Repair attempted 9 files but skipped all because regenerated code matched the candidate; final comparison still reported 9 mismatches.
     - `npm test` passed (CLI benchmark/recompose/prompt-template smoke coverage).
   - Unit test sweep (2026-01-17):
     - `npm test` passed (includes updated navigation schema prompt-template checks).
   - Live workspace stepwise run (2026-01-24):
     - `node src/index.js workspace --task "Audit JSON-first enforcement across run/analyze-file/workspace/decomposer/navigator; verify stop_reason + tool_calls logging; propose fixes + doc updates" --prompt-journal devstral-step-20260123a --prompt-journal-status paused --model mistralai/devstral-small-2-2512 --no-stream --session-timeout 300` fell back after navigator/decomposer timeouts; stepwise journal captured fallback JSON with stop_reason `timeout`.
   - Live workspace stepwise run (2026-01-24):
     - `node src/index.js workspace --task "Audit JSON-first enforcement across run/analyze-file/workspace/decomposer/navigator; verify stop_reason + tool_calls logging; propose fixes + doc updates" --prompt-journal phi4-step-20260123b --prompt-journal-status paused --model microsoft/phi-4-reasoning-plus --no-stream --session-timeout 300` returned valid prompt-plan JSON; navigator fallback recorded `invalid-response` for missing helper_script.language; prompt decomposition persisted under `.miniphi/prompt-exchanges/decompositions/` with slug-safe filenames and the stepwise journal stored JSON responses with prompt-exchange links.
   - Exit criteria: JSON-only output with strict parsing (strip <think> blocks + fences + short preambles), request payloads include schema id + response_format and compaction metadata in `.miniphi/prompt-exchanges/`, response analysis surfaces needs_more_context/missing_snippets, stop reason recorded.
   - Conclusion: keep the prompt-chain sample template path chain-relative (matches composer expectations), add a guardrail note in prompt-chain docs/templates to prevent embedding repo-relative paths, capture tool_calls/tool_definitions in prompt scoring telemetry to validate evaluator coverage, enforce explicit null helper_script guidance in navigator prompts, and avoid JSON repair salvage beyond schema-only retries in the analyzer.
  - Next steps (prioritized, add proof per item):
    - Proof run: implicit `miniphi "<task>" --cmd "..."/--file ...` routes to `run`/`analyze-file` with schema compliance + stop reason recorded.
    - Proof run: prompt-chain `compose` + `interpret` steps pass strict JSON parsing (no preamble salvage) and emit deterministic fallback with `stop_reason` when invalid.
  - Deferred (lower priority while the above are in flight):
    - Re-run the recompose workspace overview with a higher `--workspace-overview-timeout` and inspect `.miniphi/recompose/.../prompts.log` to identify prompt/response failures under strict parsing.

2) Reliable edit pipeline
   - Scope: pinned file references with hashes, diff guards, rollback on mismatch.
   - Implementation: recompose writes now flow through a guarded writer that logs diff summaries + rollback copies under `.miniphi/recompose/<session>/edits/edits.jsonl`.
   - Proof runs:
     - Targeted edit on a repo file with diff summary + rollback check.
     - Rerun with a prompt journal to confirm determinism.
   - Exit criteria: diff guard prevents mismatched writes and rollback path is verified.

3) Usable CLI + docs
   - Scope: onboarding quickstart, config/profile summary, minimal regression benchmark.
   - Proof runs:
     - `samples/get-started` walkthrough.
     - `npm run sample:lmstudio-json-series`.
   - Exit criteria: docs match CLI behavior and sample runs complete without manual patching.

### v0.2 Reliability and reuse
Objective: make the agent predictable across sessions and workloads.

Exit criteria:
- Prompt and plan reuse reduce repeated tokens without breaking schema validity.
- Helper and command libraries show consistent reuse across at least two different repos.
- Workspace caching and capability inventory remain accurate across runs.
- Offline evaluation harness (ai-agent-evals style) runs locally and records JSON compliance + tool-call accuracy metrics with a stored report.

Focus areas:
- Prompt decomposition resume improvements and branch selection hygiene.
- Evaluation harness for prompt/response quality (JSON validity, tool-call accuracy, task adherence, token metrics).
- Nitpick evaluation harness (writer/critic loops, blind browsing sources, and context-aware model selection).

Nitpick exit criteria:
- `miniphi nitpick --task "<long-form task>" --rounds 2` completes with JSON-only plan/draft/critique/revision steps and stores a session under `.miniphi/nitpick/`.
- `miniphi nitpick --blind --task "<long-form task>"` captures research + web snapshots under `.miniphi/research/` + `.miniphi/web/` and produces a final draft using cited sources.

Deferred (lower priority while nitpick + blind browsing harden):
- Helper script lifecycle (versioning, replay, and output summarization).

### v0.3 Distribution and sustainability
Objective: prepare MiniPhi for wider distribution and long-term maintenance.

Exit criteria:
- Packaging and release process documented and repeatable.
- Retention policy or pruning for `.miniphi/` artifacts is implemented.
- Regression coverage covers core agent flows (run/workspace/analyze-file) with clear smoke checks.

Focus areas:
- Packaging (`npm publish` readiness) and release notes workflow.
- Benchmarks coverage expansion beyond Bash recomposition.
- Telemetry and performance summaries (opt-in, local-only).
- Deferred: fallback cache and prompt composition heuristics to reduce repeated failures.

## Operating checklist (for each slice)
- Run a real `miniphi` task or sample; capture prompt journal and stop reason.
- Apply JSON-backed edits and summarize diffs.
- Record failures and fallbacks in `.miniphi/` before iterating.
- Close the slice only when exit criteria and proof runs are satisfied.

## Governance
- ROADMAP.md is the source of truth; AI_REFERENCE.md carries the active slice summary.
- Keep items small and outcome-based; defer lower-priority work when adding new items.
