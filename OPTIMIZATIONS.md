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
- Workspace scanning is duplicated: `src/libs/workspace-profiler.js` and
  `src/libs/workspace-context-utils.js` both traverse the filesystem with overlapping ignore rules
  and manifest logic.
- Prompt logging overlaps: `src/libs/prompt-recorder.js` and
  `src/libs/prompt-step-journal.js` both persist prompt/response data with similar metadata but
  different shapes, risking divergence.
- Memory storage duplication: `src/libs/miniphi-memory.js` and
  `src/libs/global-memory.js` both implement directory layout + JSON index management with similar
  boilerplate.
- JSON parsing/validation paths are scattered: `src/libs/lmstudio-handler.js`,
  `src/libs/efficient-log-analyzer.js`, and `src/libs/core-utils.js` each handle JSON extraction or
  schema enforcement separately.
- Legacy/compatibility files (ex: `src/libs/lms-phi4.js`) are small but add cognitive overhead;
  keep only with a documented compatibility reason.
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

### P1 - Prompt logging consolidation

Clarify the roles of `PromptRecorder` and `PromptStepJournal` or merge overlapping payloads.

Exit criteria:
- A documented contract defines what each artifact captures and how they link to each other.
- Duplicated fields are removed or canonicalized across the two systems.
- Prompt journals still contain the full prompt, response, and tool metadata required by evals.

Status:
- In progress. PromptStepJournal now stores `tool_calls`/`tool_definitions` in the same shape as
  prompt exchanges and the contract is documented in AGENTS.md; remaining work is to reduce any
  duplicated prompt/response payloads beyond the canonical fields.

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
  unify error metadata payloads across handlers/analyzers and align session timeout + retry caps.

### P2 - Legacy/ad-hoc cleanup pass

Audit small compatibility modules and move or remove only when the dependency surface is explicit.

Exit criteria:
- Each legacy module has a documented owner and reason to exist, or it is removed with references
  updated in scripts/tests.
- Benchmark/recompose tools remain functional and unchanged in intent.

## Focus rule (guardrail)

Avoid changes that touch only `src/libs/efficient-log-analyzer.js` unless the issue is explicitly a
log-analysis defect. For new features or refactors, inspect `src/index.js` and the adjacent runtime
libraries (`lmstudio-handler`, `prompt-*`, `workspace-*`, `miniphi-memory`, `cli-executor`) so
improvements target the entire pipeline.
