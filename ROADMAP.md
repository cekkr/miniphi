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
     - `node src/index.js analyze-file --file samples/txt/romeoAndJuliet-part1.txt --task "Analyze romeo file" --summary-levels 1 --prompt-journal live-romeo-json-<id>`.
     - Inspect `.miniphi/prompt-exchanges/` and `.miniphi/prompt-exchanges/stepwise/<id>/` for schema id/response_format on requests, raw JSON responses, and captured missing snippets.
   - Exit criteria: JSON-only output with strict parsing (strip <think> blocks + fences + short preambles), request payloads include schema id + response_format and compaction metadata in `.miniphi/prompt-exchanges/`, response analysis surfaces needs_more_context/missing_snippets, stop reason recorded.

2) Reliable edit pipeline
   - Scope: pinned file references with hashes, diff guards, rollback on mismatch.
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
- Helper script lifecycle (versioning, replay, and output summarization).
- Evaluation harness for prompt/response quality (JSON validity, tool-call accuracy, task adherence, token metrics).

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
