# After a prompt
- Keep `README.md` for human documentation and this AGENTS.md for AI in sync whenever MiniPhi gains a new command, argument, or workflow and source code status.
- Benchmark/recompose/test scripts are instrumentation; treat failures as runtime bugs and only edit scripts to expand coverage or logging.
- Every LM Studio prompt must declare the exact JSON schema and use `response_format=json_schema`; reject non-JSON responses and re-prompt or emit deterministic fallback JSON. Navigator now falls back to a deterministic JSON block with `stop_reason` after timeouts, and decomposer emits a fallback plan when schema fields are missing.
- JSON request payloads and JSON responses are mandatory; never use narrative-only exchanges for chunk selection, truncation plans, or missing snippet requests.
- Prompt/response instrumentation must retain response text, tool_calls, and tool_definitions so evaluation datasets can score tool-call accuracy and task adherence (see `thirds/ai-agent-evals`).
- Treat `thirds/cheetah` as the alternative graph-query engine for selecting and handling context supplied to LM Studio prompt and subprompt calls. The first opt-in adapter is wired into interactive `AgentSession` prompts and focused subtask prompts; the in-process `ContextGraph` remains the default and deterministic fallback.
- Keep scope focused on a local file-manipulation agent for coding projects; defer broad research or multi-agent exploration until the v0.1 exit criteria are met.
- Roadmap items need explicit exit criteria; if a new item is added, remove or defer a lower-priority one.
- Prevent infinite loops: cap recursive prompts and retries, enforce helper timeouts, and persist a clear stop reason in `.miniphi/`.
- Stop reasons now include code/detail (for example: `session-timeout`, `invalid-response`) and the analyzer emits deterministic fallback JSON when the session budget expires before Phi responds.
- Persisted `.miniphi` writers normalize legacy stop-reason aliases to canonical taxonomy values (`stopReason` + `stopReasonCode`) and clear success markers (for example `completed`) to null.
- Do not change generic libraries just to satisfy a narrow unit test; use tests to improve MiniPhi behavior instead of editing test intent or broad utilities.
- Avoid writing placeholder notes into docs; only record optional notes in `.miniphi/history/forgotten-notes.md` when `--forgotten-note` is supplied.
- Use `OPTIMIZATIONS.md` as the high-priority optimization roadmap; avoid isolated changes to `src/libs/efficient-log-analyzer.js` unless the issue is log-analysis-specific and review the full `src/` pipeline (`src/index.js`, `lmstudio-handler`, `prompt-*`, `workspace-*`, `miniphi-memory`, `cli-executor`) before proposing edits.

## High priority references

- `OPTIMIZATIONS.md` is the optimization roadmap for cross-cutting improvements across the entire `src/` runtime pipeline.
- `thirds/cheetah` is the Cheetah submodule and upstream home for reusable graph-query engine work.

## Cheetah submodule workflow

- Before inspecting, building, testing, or editing Cheetah, always initialize it and fast-forward its `main` branch:
  ```bash
  git submodule update --init --recursive thirds/cheetah
  git -C thirds/cheetah switch main
  git -C thirds/cheetah pull --ff-only origin main
  ```
- Read and follow `thirds/cheetah/AGENTS.md` before changing that repository.
- Implement general-purpose Cheetah fixes and features directly in `thirds/cheetah`; run its tests and commit those changes and push inside the Cheetah repository, not as ordinary MiniPhi files.
- After a Cheetah commit, record the new submodule commit in MiniPhi separately. Keep MiniPhi-specific adapters, configuration, prompt/subprompt integration, and compatibility tests in this repository.
- Do not duplicate reusable graph-query engine fixes in MiniPhi. Upstream them to Cheetah first, then update the submodule pointer.
- **The protocol client is the submodule's own Node binder** (`thirds/cheetah/binders/nodejs`, CommonJS, dependency-free), imported only through `src/libs/cheetah-binder.js`. A missing command, argument, or encoding is a change to `binders/nodejs/lib/*.js` with a test in `binders/nodejs/test/`, run with `node --test test/*.test.js` from that directory — not a new command string in MiniPhi. MiniPhi keeps only what is MiniPhi-shaped: opt-in configuration, project/session namespacing, what is worth mirroring, and how a Cheetah failure degrades.


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
- Context is a budgeted, layered graph — never a growing transcript. The interactive agent selects each prompt from `ContextGraph` (`src/libs/context-graph.js`) by priority (layer), importance, and subtask level against a budget derived from the model's **loaded** context window; overflow degrades to digests and requestable stubs, and the model reshapes its own context via `context_ops` (see "Multi-layered context" below).
- LM Studio health and capability inventory must gate prompts; helper scripts live under `.miniphi/` with timeouts and audit trails.
- Health gate defaults to REST probes; set `lmStudio.health.enabled=false` or pass `--no-health` to skip (auto-skips when transport is forced to WS).
- Benchmarks and recomposition runs are treated as runtime validation, not side projects.
- Roadmap slices close only when proven by a real `miniphi` run that applies JSON-backed edits and records a stop reason.

### JSON-first operating rules
- Schemas live in `docs/prompts/` with `additionalProperties: false` and required `needs_more_context` + `missing_snippets` fields; keep schema ids/versioning visible in prompts.
- ApiNavigator and PromptDecomposer validate responses via `json-schema-utils` and require `needs_more_context` + `missing_snippets` in their schemas.
- PromptSchemaRegistry now exposes `validateOutcome()` and normalizes validation metadata (`status`, `error`, `preambleDetected`) for shared use by LMStudioHandler, EfficientLogAnalyzer, ApiNavigator, and PromptDecomposer.
- Strip `<think>`/markdown preambles, parse strictly, and treat non-JSON as failure; trigger a deterministic fallback JSON if the model drifts.
- Never salvage JSON from mixed prose; only accept payloads that are valid JSON after stripping `<think>` blocks and JSON fences.
- `agent-action` anchored edits are literal substring replacements, not start/end ranges: replacing a whole block requires the whole old block in `anchor`. JavaScript proposals are syntax-checked before approval/commit; `invalid-content` leaves disk untouched and feeds the literal-anchor repair contract back into the next prompt.
- Prompt-chain interpreter treats preambles as invalid and emits a deterministic fallback with `stop_reason: preamble_detected` when strict parsing fails.
- All suggested actions must be structured arrays/objects with reasons and a declared `schema_version`/`schema_uri`; normalize through `SchemaAdapterRegistry` before use.
- Chunk selection, truncation plans, and missing snippets must be expressed as structured JSON fields, never prose; reject narrative responses even if they are correct.
- When requesting `missing_snippets`, prefer repo-relative file paths (for example: `src/index.js`) so recompose can auto-fetch context.
- EfficientLogAnalyzer normalizes missing `needs_more_context`/`missing_snippets` to defaults when the model omits them.
- Log-analysis responses include `summary` (final natural-language update) and `summary_updates` (chronological progress updates); keep them near the top of the JSON to surface during streaming output.
- Workspace-summary log-analysis prompts now use compact workspace context plus a conservative prompt budget cap (`2200` tokens) to avoid 4k-context overflow regressions when LM Studio status metadata is incomplete.

## Multi-layered context + context graph language

`src/libs/context-graph.js` holds the agent's context as a graph instead of a transcript, because LM Studio prompts are capped by the model's **loaded** context window (8k–16k on the reference hosts). It is pure/deterministic (no I/O, no model calls); persistence is the caller's job.

### Layers and selection
- Layers, highest priority first: `mission` (task + workspace root), `contract` (session policies and corrective feedback), `plan` (decisions, applied edits, subtask outcomes), `subtask` (open sub-conversation goals), `evidence` (action/research/snippet output), `scratch` (transient notes).
- `mission` and `contract` are **retained**: never digested or dropped, only hard-truncated (capped at 40% of the budget each, max 6 live nodes per layer). Everything else competes on `score = layerPriority*10 + importance*6 + recency + focus proximity` (+1000 when pinned, +8 when the model asked for it).
- Overflow degrades instead of vanishing: full text → digest → one-line stub listed under "Context index (not loaded)" with its node id, so the model can ask for it back. An **expanded** node that still cannot fit gets the largest window the budget allows (never a silent fallback to the digest), and `{"op":"expand","node":"cN","offset":N}` pages that window through a long node so its tail is reachable.
- Never truncate an observation twice. Read output is truncated once (`MAX_READONLY_OUTPUT_CHARS`) with its `[output truncated at N chars]` marker preserved; a second blind slice used to cut the marker off and a live model then treated a partial file as complete and fabricated a value. The graph — not the caller — is what shrinks long observations.
- Nodes carry `ttlTurns` for corrective feedback: retained (guaranteed visible) for the turn it applies to, then auto-expired so nudges cannot accumulate. **Never put a correction in `scratch`** — two live runs showed the nudge and the reform gap note demoted to stubs under exactly the budget pressure they were meant to correct, so the model never saw them. Anything the model must read next turn goes in `contract` with a TTL.
- `importance` decays every turn (`decay()`); pinned and retained nodes do not decay. Validation issues are pinned until they pass, then unpinned.

### Budget
- `deriveContextBudget({contextLength, reservedTokens, reservedOutputTokens})` = `loaded_context_length * 0.85` minus the system-prompt/schema estimate and the output reserve.
- `resolveContextWindow({restClient, modelId})` (`src/libs/model-catalog.js`) returns `loadedContextLength`/`maxContextLength`; only the **loaded** value is used as a budget. A not-yet-loaded model reports `jitUnknown` and the conservative 4000-token default applies — never size a prompt from `max_context_length`.
- Override with `--context-budget <tokens>` or `config.context.budgetTokens`.

### Cheetah alternative query engine
- The transport and every Cheetah command spelling come from the submodule's own Node binder (`thirds/cheetah/binders/nodejs`), reached through the single import site `src/libs/cheetah-binder.js`. That module bridges the binder's CommonJS to MiniPhi's ESM, re-exports the graph command builders (`buildNodeSet`, `buildRecall`, `buildEdgeSetBatch`, …) and `parseCheetahResponse`/`decodeCheetahPayload`, and wraps the binder's pipelined `CheetahClient` in the batch-shaped `CheetahTcpClient` (`execute(commands) -> responses[]`) the Cheetah modules are written against. **Never hand-encode a Cheetah `key=value` argument in MiniPhi**: props/references/batch items are base64 JSON and flags are `1`/`0`, and getting either wrong fails silently — build the command upstream instead. The connection is persistent (`DATABASE` is selected once per connection, not once per batch) and unref'd while idle so a finished run still exits; `CheetahContextEngine.close()` releases it explicitly. Because the binder ships in the submodule, `thirds/cheetah` must be initialized for any Cheetah-touching MiniPhi path to import.
- `src/libs/cheetah-context-engine.js` implements `CheetahContextEngine` and MiniPhi's Cheetah policy (project/session isolation, what is mirrored, how failures degrade). Enable it with `context.engine: "cheetah"` (or `MINIPHI_CONTEXT_ENGINE=cheetah`); connection settings live under `context.cheetah` and default to loopback port `4455`, a project-derived database, a 2500 ms timeout, and `required: false`.
- Context identity has two independent isolation boundaries. Unless `context.cheetah.database` is explicitly set, the canonical workspace path is SHA-256-derived into `miniphi_context_p_<hash>`. Every external node id is also namespaced by opaque SHA-256 project and session references, so projects cannot overlap even in an explicitly shared database or when they reuse the same session id. `context.cheetah.projectId` (or `MINIPHI_CHEETAH_PROJECT_ID`) supplies a stable project identity across workspace moves; without it, moving the workspace deliberately starts a new namespace. Never weaken `_localId()` to accept associations outside the exact project + session prefix.
- Every local context node persists bounded complete reference sentences in `context-graph.json`; terse tool/code fragments are quoted inside a grammatical source-labelled sentence rather than stored as orphaned keywords. The adapter mirrors stable project/session-scoped node ids, layer/label/state/importance metadata, model-authored relations, mission/subtask membership, and only those bounded reference sentences. It never mirrors full context blocks or the workspace path. Edge writes use idempotent `GRAPH_EDGE_SET_BATCH`; locally dropped/superseded nodes are removed with `GRAPH_NODE_DEL cascade=1`. Failed or partial batches clear local fingerprints so the whole metadata set is replayed on the next bounded attempt.
- Before every interactive agent prompt or focused subtask prompt, `AgentSession` calls `GRAPH_RECALL references=1` with the mission and current focus as seeds. Returned local node ids receive a selection-only score boost. Recalled reference sentences are candidates for `ContextReferenceComposer`, which uses the exact session model plus `docs/prompts/context-reference-selection.schema.json` and `response_format=json_schema` to select/order ids without rewriting evidence. It retries invalid JSON once, then emits a deterministic schema-valid selection. The selected sentence block reserves part of the same context budget; Cheetah cannot mutate durable importance, bypass retained layers, or bypass the budget.
- Reference candidates, prompt messages, `response_format`, raw response/reasoning text, usage, `tool_calls`, `tool_definitions`, validation outcomes, and selected ids persist in `.miniphi/agent-sessions/<id>/context-references.json` for MiniPhi reuse and operator inspection. Optional Cheetah failures fall back to the in-memory selector after a cooldown. `required: true` converts a Cheetah failure into the turn's deterministic JSON stop fallback. Engine selection/fallback/mirror/recall telemetry persists in `context-engine.json` and under `result.json.context.engine`.
- Current scope is the interactive `AgentSession` path (`ui` and its model-opened sub-conversations). Headless `run`/`workspace` decomposer integration, remote graph compaction, and cross-session recall are not implemented yet; do not claim they use Cheetah.
- **This is a separate Cheetah integration from Cheetah-learn.** This section's `CheetahContextEngine` mirrors the *agent's own session context* (mission/plan/subtask nodes) into a project-derived `miniphi_context_p_<hash>` database purely to boost in-session recall selection. `cheetah-learn` (see the "Delivered 2026-07-28" entry below) is a different feature entirely: it teaches and recalls *real-world facts* in a separately selected knowledge database (`miniphi_knowledge` by default; `wikidata` for the local Wikipedia workflow), and the optional `knowledge_lookup` action reads whichever knowledge database it is configured to use. Do not conflate the two — they use different databases, different node shapes (`ctx_*`-labeled context nodes vs. `topic:`/`hypothesis:` entities), and different opt-in config keys (`context.engine=cheetah` vs. `config.knowledgeLookup.enabled`).

### Cheetah complex live-performance status (2026-07-26)
- `unit-tests-js/agent-cheetah-complex-sample.live.test.js` copies `samples/get-started/code`, supplies four operator-selected files through the layered graph, and requires a validated `--doctor` implementation across `src/system-info.js`, `src/index.js`, `src/tests/smoke.js`, and `README.md`. It records elapsed time, turns/actions, written files, validation, project/database identity, mirror/recall counts, and fallbacks.
- Repeated the same human-readable session id across fresh workspaces; every run received a distinct `p_<sha256>` project reference and `miniphi_context_p_<sha256>` database. A separate explicit-shared-database unit test proves `_localId()` rejects other-project associations even when session and local node ids match.
- The run exposed and closed runtime defects: corrective TTLs were not forwarded; obsolete file reads/edit snapshots and validation failures stayed live; post-edit reads remained deduped; dropped nodes stayed mirrored; malformed JavaScript reached disk; literal anchor semantics were underspecified; raw action slicing let same-path conflicts starve later independent actions; and one validator branch emitted an empty diagnostic.
- Cheetah itself passed the live gate throughout. The schema-valid one-file GLM proof completed with 4 selections, 19 recalls, dropped-node deletion, and 0 fallbacks. The full acceptance workload remains **open** on the tested models: `qwen3-coder-30b-a3b-instruct` stopped `no-progress` after 9 turns / 584358 ms with 3 of 4 files changed (9 recall queries, 98 recalled associations, 0 fallbacks); `glm-4.7-flash` stopped `no-progress` after 3 turns / 284867 ms because its actions omitted required edit/path fields (3 queries, 24 recalls, 0 fallbacks). Do not call the complex edit pipeline live-proven until this test passes without weakening its validator.

### Complete-sentence recall live status (2026-07-26)
- A real MiniPhi → TCP → Cheetah run on the new server mirrored and recalled the mission plus an authoritative evidence sentence (`CHEETAH_CONTEXT_TOKEN=7419`): 2 nodes, 2 complete references, 1 recall query, and 0 fallbacks. The offline selector/session suites prove same-model schema wiring, grounding by returned id, prompt-budget reservation, `context-references.json` persistence, and deterministic timeout/invalid-response fallback.
- The requested full LM Studio run uses `qwen/qwen3-4b-thinking-2507` at `http://127.0.0.1:1234`. It exposed that this MLX backend rejects nullable JSON Schema union types (`"type" must be a string`); optional agent/context fields now use scalar types and omission instead, with the standalone/inlined schemas kept aligned. The repaired run then reached Cheetah recall (12 references, 0 graph fallbacks), but the loaded model worker remained in `processingPrompt` past the 300-second test cap and subsequent 16-token probes. The full same-model selector + edit proof therefore remains **open**; do not call it live-proven until `unit-tests-js/agent-cheetah-context.live.test.js` completes after the LM Studio worker is healthy.

### Context graph language (`context_ops`)
- Schema: `docs/prompts/context-ops.schema.json` (standalone) and the same fields inline in `docs/prompts/agent-action.schema.json`: `context_ops[]`, `context_sufficient`, `context_gap`. All optional/additive — turns that omit them stay valid.
- Ops: `expand` (load a stub/digest in full; stays loaded until collapsed/dropped), `pin`/`unpin`, `boost`, `collapse` (model-authored digest), `drop`, `note` (durable fact; `mission`/`contract` are runtime-owned and rejected), `link`, `open_subtask`, `close_subtask`, `focus`. Max 12 per turn.
- `applyOps()` returns `{applied, rejected, noops}`. Rejections *and* no-ops are fed back into the context so the model learns the language across turns; without that feedback a local model re-sends the same op every turn and the loop stalls.
- Sub-conversations: `open_subtask` scopes subsequent evidence to a level; `close_subtask` collapses that evidence into one parent-level outcome node so the parent conversation stays inside the budget. `buildSubConversation(id)` rebuilds the minimal context (invariants + ancestor spine + own evidence) for resuming a branch, excluding sibling branches outright.
- `context_sufficient: false` (+ `context_gap`) triggers a bounded deterministic `reform()`: keyword-matched nodes are expanded/boosted and the turn is re-prompted once (`maxContextReforms`, default 3). A turn that only reshapes context earns a bounded re-prompt (`maxContextOnlyTurns`, default 3) instead of counting as `no-actions`.
- Graph state persists to `.miniphi/agent-sessions/<id>/context-graph.json` (stable node ids); `result.json` carries `context` stats (nodes per layer, reforms, ops applied/rejected/no-op, budget, focus).

## Runtime posture
- Default LM Studio endpoint: `http://127.0.0.1:1234` (REST) with WebSocket fallback; default model `mistralai/devstral-small-2-2512` (swap to `ibm/granite-4-h-tiny` or `microsoft/phi-4-reasoning-plus` via `--model` or `defaults.model`).
- `--model auto` queries the live model inventory (native `GET /api/v1/models`, then bounded native-v0/OpenAI-compatible fallbacks) via `src/libs/model-catalog.js`, classifies the task intent (coding/writing/analysis/research), and picks the best installed chat model. Fresh `benchmark models` category scores are primary evidence; inventory purpose/context/load/tool/memory/quantization heuristics are the fallback and tie-break. After at least one fresh benchmark, headless `run`/`analyze-file`/`workspace` flows with no explicit configured model implicitly enable Auto; an explicit CLI/config/env model remains authoritative. `node src/index.js models [--task ...] [--json]` prints the normalized ranking and benchmark evidence. The interactive UI ranks `Auto` after task entry and also offers every exact discovered chat model.
- The REST client follows the current [LM Studio REST reference](https://lmstudio.ai/docs/developer/rest) for native v1 inventory and explicit lifecycle calls. `models --load <model> [--context-length <n>]` and `models --unload <instance-id>` map to exact v1 load/unload contracts; MiniPhi never implicitly unloads an operator-loaded instance. Schema-bound inference remains on the proven chat-completions route because every prompt must retain `response_format=json_schema`.
- `LMStudioRestClient` only sends `context_length` when explicitly configured (constructor option or per request); advertising the static default can exceed a JIT-loaded model's smaller context and LM Studio rejects the request with 400 "Context size has been exceeded".
- Reasoning is normalized through `src/libs/reasoning-profile.js` as `off|low|medium|high` (default `high`). It independently resolves LM Studio model effort from native-v1 `capabilityDetails.reasoning` and MiniPhi decomposition budgets (`0/1/2/4` branch expansions). The compatible strict-JSON route keeps `response_format=json_schema`; `LMStudioRestClient` adds `reasoning` only when advertised, retries once without it on a setting-specific rejection, caches support per model for the process, and records sent/fallback/ignored metadata. Explicit `--max-plan-expansions`, `--no-plan-expansion`, and decomposer config remain authoritative.
- REST authentication is optional through `LMSTUDIO_API_TOKEN` or `lmStudio.rest.apiToken`; authorization headers are redacted from execution-register instrumentation.
- `LMSTUDIO_REST_URL` is an operator override and takes precedence over configured REST endpoints; this keeps live tests and remote-host workflows from silently querying a checked-in loopback URL.
- Transport default: REST-first (`lmStudio.transport: "rest"`); override with `lmStudio.transport: "ws"` or env `MINIPHI_FORCE_REST=1` for forced REST.
- CLI entrypoints: `ui` (interactive agent, also the default for bare `miniphi` / free-form tasks on a TTY), `run`, `analyze-file`, `workspace` (`miniphi "<task>" --headless`), `recompose`, `benchmark models|general|recompose|analyze|plan scaffold`, `cache-prune`, `migrate-stop-reasons`, `lmstudio-health`, `web-browse`, `nitpick`, `cheetah-learn teach|ask|chat|questions|eval|wikipedia` (see "Cheetah-learn" below), and helper/command-library browsers.
- UI routing (`src/ui/route.js` `decideUiLaunch`): on a TTY, bare `miniphi`, the `ui` command, and a free-form task open the Ink UI; `--headless`/`--no-ui`, a non-TTY (scripts/CI), and every explicit subcommand run headless. This keeps direct arguments always available while the UI is the primary interface. Bare UI starts on a home screen with Start task plus an Easy benchmark action and fresh cached score table; a seeded task goes directly to task/model selection. The UI path (`launchInteractiveUi` in `src/index.js`) scans native v1, asks for the task, presents benchmark-informed `Auto` plus manual model choices, then asks for the reasoning profile and previews model/decomposer budgets before starting; the resolved model/load/reasoning snapshot is persisted in session/result JSON. It builds its own lightweight REST client (never a static `context_length`) and dynamic-imports `src/ui/launch.js` so Ink/React never load on headless runs.
- Audit trails live in `.miniphi/` (`executions/` incl. `task-execution.json`, `prompt-exchanges/`, `helpers/`, `history/`, `indices/` incl. `prompt-router.json`, `web-index.json`, `nitpick-index.json`, `recompose/<session>/edits`, `recompose/<session>/step-events.jsonl`); helper scripts are versioned with stdout/stderr logs.
- Health probes (`lmstudio-health`) write snapshots to `.miniphi/health/lmstudio-status.json` (timeout configurable via `lmStudio.health.timeoutMs`).
- `lmstudio-health --json` emits a machine-readable summary for CI checks.
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

Closed slice: Core loop hardening (2026-07-15)
- Closing proof: `node src/index.js "Improve the CLI argument parser with input validation and add unit tests for it" --model auto --verbose --no-navigator` auto-selected `qwen3-coder-30b-a3b-instruct`, produced a 21-step depth-3 plan via 4 recursive branch expansions (telemetry in `.miniphi/prompt-exchanges/decompositions/`), and ended with a schema-valid log-analysis JSON footer.

Current slice: Plan execution bridge
- Focus: execute leaf steps of the focused plan branch through the default agent commands (command-policy gated), auto-fetch repo-relative `missing_snippets` and re-prompt once, and persist per-branch execution status so `--plan-branch` resumes from the first incomplete branch.
- Proof (2026-07-15): `node src/index.js "Review src/libs/cli-utils.js and find usages of parseNumericSetting to plan stricter input validation" --model auto --verbose --no-navigator --prompt-journal live-plan-exec-proof` expanded 4 plan branches, executed 4 plan actions (`search_text parseNumericSetting` from branch 3), persisted per-branch progress with `firstIncompleteBranch: 3.1.3` under `.miniphi/prompt-exchanges/decompositions/*-progress.json`, journaled a `plan-actions` step (10 operations), and the pre-fed action outputs led to a schema-valid JSON footer with `needs_more_context: false` (the round-trip therefore did not need to fire; it is unit-test covered).
- Regression: `node --test unit-tests-js/plan-executor.test.js` (9 tests: mapping, path safety, dedup, budgets, snippet resolution, progress persistence).
- Remaining before slice close: default `--plan-branch` to `firstIncompleteBranch` on resume; extend executor wiring to `run`/`analyze-file` (with policy-gated `runCommand` in run mode); one live run where the `missing_snippets` re-prompt fires end-to-end.

Delivered 2026-07-15 — Interactive agent UI + guarded edits (live create-write proven):
- Bare `miniphi`/free-form tasks open an Ink+htm agent (`src/agent/` + `src/ui/`) that selects
  files, streams progress, and applies `write_file`/`edit_file` through `writeFileWithGuard`
  (diff + rollback) behind per-edit approval; `run_cmd` is approver/policy gated. Direct
  subcommands stay headless (`decideUiLaunch`; `--headless`/non-TTY). Offline-covered by
  `agent-executor`/`agent-session`/`agent-ui`/`agent-ui-app`/`ui-route` suites.
- Live proof (`qwen3-coder-30b-a3b-instruct`): agent proposed `write_file`, guard applied it,
  run finished `completed` in 3 turns. Anti-stall fix landed during the proof — the loop dedupes
  repeated identical read/edit actions and only auto-finishes after 2 no-progress turns when a
  write succeeded and optional workspace validation passed (else it records `no-progress`).

Delivered 2026-07-25 — Researched from-scratch project creation + browser validation:
- `agent-action` now includes read-only `web_research` (`query`, bounded `max_results`);
  `AgentSession` feeds structured search JSON into later turns, supports bounded preflight
  research, caps duplicate/repeated research, retries one transient LM request, and can require
  successful research before mutations.
- The loop accepts root `list_dir`, creates parent directories for new nested files, rejects
  multiple same-turn mutations to one path, does not call no-op work `completed`, and supports a
  preflight/post-edit `validateWorkspace` callback whose structured result persists in
  `result.json` and is fed back before completion.
- Live proof (`gpt-oss-20b`, LM Studio REST): exact prompt `Create an HTML page showing a 2D ball
  bouncing like a thrown basket ball. Use libraries at your choice` researched library options,
  created `index.html` from an empty workspace, and passed Chromium page-error + frame-change
  validation. Preserved proof artifacts live under `.miniphi/live-tests/` when
  `MINIPHI_BASKETBALL_OUTPUT` is set.

Delivered 2026-07-25 — Multi-layered context + context graph language (live-proven):
- `src/libs/context-graph.js` replaces the agent's flat observation window with a layered graph
  selected per prompt against a budget derived from LM Studio's **loaded** context window
  (`resolveContextWindow`, `deriveContextBudget`, `--context-budget`). Overflow degrades to
  digests, then to requestable stubs; `mission`/`contract` are retained invariants.
- The `agent-action` schema gained `context_ops` / `context_sufficient` / `context_gap` (also
  standalone in `docs/prompts/context-ops.schema.json`) so the model reshapes its own context
  (`expand`/`pin`/`boost`/`collapse`/`drop`/`note`/`link`/`open_subtask`/`close_subtask`/`focus`),
  with rejections *and* no-ops fed back so it learns the language. A declared `context_gap`
  triggers a bounded deterministic reform plus one re-prompt.
- Live proofs (`gpt-oss-20b`, 16384 loaded context, budget forced to 700 tokens): LM Studio
  accepted the extended schema and returned `{"op":"expand","node":"c3"}` for the *relevant*
  digested node; a task whose answer sat inside files larger than the whole budget finished
  `completed`; and content held **only** in a digested research node (on no disk, unreachable by
  read/search) was retrieved through `expand` and written correctly.
- Fixes found by those runs: an unfittable `expand` now returns the largest window the budget
  allows; corrective nudges moved from droppable `scratch` to retained-with-TTL nodes (a live run
  showed the nudge itself stubbed out); context-only turns get a bounded re-prompt;
  `list_dir "/"` resolves to the workspace root.

Delivered 2026-07-28 — Vision-model visual review action (live-proven):
- New auto-run `agent-action` type `visual_review` (`path`, optional `focus`) lets the interactive
  agent ask a *separate* vision-capable model to critique a rendered screenshot instead of guessing
  from source text alone — e.g. for a from-scratch bouncing-basketball page, whether the ball
  actually reads as round/orange/seamed and looks like it moved, the kind of subjective visual
  quality no regex/text check can see.
- `src/libs/vision-reviewer.js`: `screenshotLocalFile()` reuses the Puppeteer launch pattern already
  proven by `web-browser.js`/the basketball live test; `VisionReviewer.review()` sends the PNG as
  `image_url` content on the same proven `/chat/completions` route so `response_format=json_schema`
  (`docs/prompts/visual-review.schema.json`) still applies, with one retry on invalid JSON then a
  deterministic fallback (mirrors `ContextReferenceComposer`).
- Gating matches `web_research`'s existing optional-capability pattern exactly: `AgentSession` takes
  an injected `visionReview` function; `src/ui/launch.js` only wires one in when
  `selectVisionModel()` (`model-catalog.js`) finds a `vision`-capability entry in the live LM Studio
  catalog already fetched for `--model auto`. Without one, `visual_review` still validates against
  the schema but reports `unavailable` and the system prompt does not advertise it, so the model is
  never nudged toward an action it cannot use.
- Live proof against a real multi-model LM Studio host (`google/gemma-4-12b-qat`,
  `qwen3.5-9b-uncensored-hauhaucs-aggressive`, `devstral-small-2-24b-instruct-2512`,
  `gemma-4-26b-a4b-it` all advertised `vision`): a real Puppeteer screenshot of a local SVG circle
  sent to `devstral-small-2-24b-instruct-2512` returned a schema-valid critique
  (`quality_score: 95`, concrete `description`, an actionable `suggestions` entry) on the first
  attempt, no retry needed.
- Regression: `node --test unit-tests-js/vision-reviewer.test.js unit-tests-js/agent-executor.test.js unit-tests-js/agent-session.test.js unit-tests-js/model-catalog.test.js`.
- Not yet done: no full agent run has been proven where the model *chooses* `visual_review` on its
  own mid-generation (this slice proves the plumbing end-to-end, not that choice); screenshots are
  not persisted to `.miniphi/` for operator review.

Delivered 2026-07-28, extended 2026-08-01 — Cheetah-learn: ignorant-model teach/recall over world knowledge (live-proven):
- `cheetah-learn teach|ask|chat|questions|eval|wikipedia` (`src/commands/cheetah-learn.js`) drives
  a deliberately small, "ignorant" model (default `qwen2.5-coder-0.5b-instruct`, selectable with
  `--model`, and a distinct LM Studio host via `--base-url`/`--host`) that never answers facts from
  its own parameters: it
  **teaches** Cheetah what it reads (e.g. `rahular/simple-wikipedia` via the new
  `src/libs/hf-dataset-client.js`, a free-`datasets-server.huggingface.co` JSON client — no
  Python/parquet) and **recalls** from Cheetah to answer questions, implementing
  `thirds/cheetah/studies/GRAPH_LLM.md`'s documented teach/recall loop end to end for the first time
  in miniphi. New schemas `docs/prompts/cheetah-teach.schema.json` / `cheetah-recall.schema.json`
  carry a free-text `thinking` field (the viable "make it think" mechanism inside a strict-JSON
  contract for a non-reasoning model) and an explicit `no_new_information` commitment — literally
  "say what has to be saved because it's not known". `src/libs/cheetah-knowledge-client.js` is the
  adapter (reuses the `CheetahTcpClient` binder bridge; a distinct database
  `miniphi_knowledge`); `src/libs/cheetah-learner.js` orchestrates with nitpick.js's exact
  double-layer schema-retry-then-deterministic-fallback pattern. The bridge now also exposes the
  binder-owned Unicode-safe value writer and admin database reset; MiniPhi still never hand-encodes
  protocol command arguments.
- **Load-bearing anti-hallucination rule**: groundedness is adjudicated by the adapter, never taken
  from the model's own `grounded` field alone. `modelGrounded` requires a resolved anchor, a
  non-decline answer, and evidence matching a retrieved reference; `effectiveGrounded` may also be
  satisfied by returning that exact reference as a separately reported deterministic fallback.
  Live-proven twice: two `cheetah-learn eval` runs taught 30 real Simple
  Wikipedia rows and asked 3 known + 7 unknown questions; **0 of 7 unknown-topic questions leaked a
  hallucination**, even though the model repeatedly fabricated confident, plausible-sounding false
  content (invented a "popular music artist" for a place called Brokaw, a fake founding date/ruler
  for a *known* topic that should have grounded, a fashion figure for "Lakki Marwat"). Known-topic
  grounding was weaker (2/3) because the model's own `grounded` boolean is genuinely
  self-contradictory at this scale (see `small-model-prompt-engineering` memory for the generalized
  lessons: reframe "already known" as "already in the database probe", not the model's training;
  worked examples help extraction but can make the model echo unrelated example content verbatim in
  a recall/judgment prompt; lead evidence with the verbatim taught sentence, not a synthesized
  id-based triple).
- Local Wikipedia streaming is implemented by `src/libs/local-wikipedia-dataset.js` and
  `src/libs/cheetah-wikipedia-runner.js`, with the reusable entrypoint
  `scripts/run-cheetah-wikipedia-learning.js` and operator guide
  `docs/cheetah-wikipedia-learning.md`. The byte-stream reader handles top-level JSON-array shards,
  split UTF-8/escape boundaries, bounded articles, AppleDouble sidecar exclusion, and exact
  byte-offset resume. The runner checkpoints after every article, retains fixed early subjects,
  and runs read-only inference probes during ingestion. `--reset-database` uses the upstream Node
  binder's admin reset and is intentionally destructive; `--no-resume` only restarts input.
- `scripts/run-cheetah-wikipedia-soak.js` is the bounded reliability harness for multi-hour runs.
  It persists a fixed deadline and resumable session state under `.miniphi/cheetah/soak/`, stops on
  the first failed learn/benchmark/test step, and archives per-cycle checkpoint, complete Easy
  benchmark, stdout, stderr, and event snapshots so benchmark history is not lost when the normal
  model cache refreshes in place.
- Wikipedia source titles are authoritative graph identities. Each accepted article stores a
  bounded exact source reference even if the tiny model produces no usable triples. Proposed
  semantic edges pass deterministic object-in-source and relation-near-object checks first.
  Recall separately reports exact-anchor resolution, model-grounded answers, and deterministic
  exact-reference fallback for broad `What do you know about <subject>?` probes; the fallback may
  make that broad answer effectively grounded but never counts as model-grounded, and specific
  unanswered questions still decline. Episode values use the binder's Unicode-safe `putValue`
  operation rather than hand-encoded `INSERT` framing. All teach/recall prompts use exact schema
  instructions plus `response_format=json_schema`, and PromptRecorder retains full exchanges for
  evaluation.
- Live local-dump proof (2026-08-01): `SmolLM2-360M-Instruct-GGUF` under exact LM Studio key
  `smollm2-360m-instruct` at `http://192.168.56.1:1234`, database `wikidata`, and
  `E:\Models\datasets\wiki-data-2021` (605 real shards / 22.08 GiB; 605 sidecars skipped). A clean
  3-article slice plus resumed 10- and 20-article slices stored 33/33 exact memories, accepted 2 semantic
  edges, rejected 16 unsupported proposals, and completed 7 interleaved probes with no retention
  regressions. The final probe resolved/effectively grounded 3/3; model-grounded was 0/3 and all 3
  used explicitly reported deterministic reference fallback. This proves a bounded slice, not full
  dump ingestion or independent factual reliability from the 360M model.
- Open questions are retrievable: `agent:miniphi_learner -[:unsure_about]-> hypothesis:<slug>` (same
  shape as GRAPH_LLM.md's own turn 5/7), with resolution flipping `props.status` open→resolved
  instead of deleting the edge, so `cheetah-learn questions` is one cheap, cursor-pageable
  `GRAPH_NEIGHBORS` call — live-proven retrieving 11 accumulated questions in one call.
- The same knowledge base is now also available to the **normal** interactive agent as a new
  read-only, auto-run `knowledge_lookup` action (`subject`) — see the `agent-action` schema note
  above and the CheetahKnowledgeClient/CheetahLearner capsule entry. It reuses the deterministic
  `recallAnchorFacts` retrieval only (no second small-model call); is opt-in and off by default
  (`config.knowledgeLookup.enabled` / `MINIPHI_KNOWLEDGE_LOOKUP=1`) so a normal run never pays a
  startup reachability-probe cost; and is wired in by `src/ui/launch.js` only after a one-shot
  `SYSTEM_STATS` probe succeeds, mirroring `visual_review`'s exact "probe once, wire only if
  healthy, otherwise never advertise the action" pattern.
- Regression: `node --test unit-tests-js/hf-dataset-client.test.js
  unit-tests-js/local-wikipedia-dataset.test.js unit-tests-js/cheetah-wikipedia-runner.test.js
  unit-tests-js/cheetah-knowledge-client.test.js unit-tests-js/cheetah-learner.test.js
  unit-tests-js/cheetah-run-report.test.js unit-tests-js/cheetah-learn-command.test.js
  unit-tests-js/agent-executor.test.js unit-tests-js/agent-session.test.js` (offline,
  fake TCP-client/REST-client objects, same fixture style as
  `cheetah-context-engine.test.js`). Live end-to-end: `MINIPHI_LMSTUDIO_INTEGRATION=1
  MINIPHI_CHEETAH_INTEGRATION=1 LMSTUDIO_REST_URL=http://192.168.56.1:1234
  MINIPHI_LIVE_MODEL=qwen2.5-coder-0.5b-instruct node --test unit-tests-js/cheetah-learn.live.test.js`
  (teach → ask → questions round trip against a real host and a locally built `cheetah-server`;
  assertions stay structural since a 0.5B model is genuinely variable turn to turn).
- Not yet done: no `resolve` CLI subaction for open questions (`resolveOpenQuestion` exists and is
  unit-tested, just not exposed via a flag); `guessSubjectFromText`'s regex heuristic misses a large
  fraction of real Simple Wikipedia rows (continuation paragraphs, non-defining first sentences),
  which shrank both live eval samples well below the requested `--eval-limit`; no full agent run has
  been proven where the model *chooses* `knowledge_lookup` on its own mid-generation (this slice
  proves the plumbing end-to-end, not that choice, matching the same caveat `visual_review` shipped
  with); the interactive agent does not write newly-learned facts back into the knowledge base
  (read-only integration only).

Next steps to close "Reliable edit pipeline" (ordered — see `ROADMAP.md`):
1. Live anchored `edit_file` on an existing file (+ a hash-mismatch rollback) end-to-end.
2. Wire a post-edit validation command (policy-gated `run_cmd`) into the finish path; record its result.
3. Bring the guarded `write_file`/`edit_file` action into the headless run/workspace flow.
Then: Usable CLI + docs — onboarding polish; `--model auto` as documented default when the configured model is missing.

Rule: if progress stalls on a slice, switch to another live `miniphi` run instead of revisiting the same mini-detail.

## Runtime building blocks (capsule)
- LMStudioManager / LMStudioHandler / LMStudioRuntime: JIT model loading, REST/WS transport, schema enforcement, streaming JSON parsing, and prompt scoring setup.
- AdaptiveLMStudioHandler + QLearningRouter: optional RL routing across model pools and prompt profiles; state persists under `.miniphi/indices/prompt-router.json` via `rlRouter`.
- PromptSchemaRegistry / SchemaAdapterRegistry: load schemas from `docs/prompts/*.schema.json`, inject schema ids, adapt versions.
- json-schema-utils: shared response_format builder + schema validator across LM Studio calls (run/analyze/navigator/decomposer).
- PromptDecomposer + ApiNavigator: plan branches, emit branch-focused nested sub-prompt hints (`focusBranch`, `focusSegmentBlock`, `nextSubpromptBranch`), propose commands/helpers, execute safe helpers, feed outputs back into prompts.
- PromptDecomposer decomposes recursively: the first completion asks for a SHALLOW plan (children empty, `requires_subprompt` flags), then each flagged branch is expanded with a focused compact follow-up prompt (same prompt-plan schema, children renumbered `parentId.N`). The reasoning profile supplies max depth plus branch count/token/time budgets (`off=0`, `low=1`, `medium=2`, `high=4`); the session deadline remains a hard outer cap. Telemetry lands in `branchExpansions` (statuses: expanded/failed/skipped-budget/skipped-depth/skipped-profile-time/skipped-session), reasoning resolution/request metadata is retained in prompt records, and per-branch prompt exchanges are recorded as `prompt-decomposition-branch`. Disable via `--no-plan-expansion` or `prompt.decomposer.expandSubprompts=false`; cap via `--max-plan-expansions`. `benchmark general` keeps expansion off to preserve stage timing budgets.
- ModelCatalog (`src/libs/model-catalog.js`): live model inventory + task-intent scoring behind `--model auto` and the `models` command; fresh `ModelBenchmarkRunner` category results are primary ranking evidence and deterministic inventory heuristics remain the fallback/tie-break. `resolveContextWindow()` reports `loadedContextLength`/`maxContextLength`/`jitUnknown` for context budgeting.
- ModelBenchmarkRunner (`src/libs/model-benchmarks.js`): versioned Easy suite, strict schema validation/retry/fallback records, exact temporary v1 lifecycle cleanup, hardware/model/load-aware cache, normalized score table, and fresh-index filtering under `.miniphi/benchmarks/models/`.
- ContextGraph (`src/libs/context-graph.js`): the multi-layered context. Layered nodes (`mission`/`contract`/`plan`/`subtask`/`evidence`/`scratch`) selected per prompt by priority + importance + subtask level against a token budget (`deriveContextBudget` from the loaded window); overflow degrades full -> digest -> window -> requestable stub. Optional `preferredNodeIds` add a query-time score boost from an external graph engine without mutating importance. `applyOps()` implements the context graph language (`{applied, rejected, noops}`), `openSubtask`/`closeSubtask` scope and collapse sub-conversations, `reform({gap})` deterministically re-expands the nodes covering a declared gap, `buildSubConversation(id)` rebuilds the minimal context for a branch, and `toJSON`/`fromJSON` persist it (`.miniphi/agent-sessions/<id>/context-graph.json`). See "Multi-layered context + context graph language" above.
- Cheetah binder bridge (`src/libs/cheetah-binder.js`): MiniPhi's only import site for `thirds/cheetah/binders/nodejs`. Owns the CommonJS→ESM bridge, the `CheetahTcpClient` batch adapter over the binder's pipelined single-socket `CheetahClient` (no connect retries, idle socket unref'd), and the re-exported graph command builders + response codec. Everything protocol-shaped lives upstream; everything MiniPhi-shaped lives in the two modules below.
- CheetahContextEngine (`src/libs/cheetah-context-engine.js`): opt-in, project-isolated metadata + complete-reference-sentence mirror and `GRAPH_RECALL references=1` adapter, built on the binder's command builders. `context-reference-memory.js` derives local self-contained sentences; `context-reference-composer.js` uses the exact session model and the strict `context-reference-selection` schema to select grounded ids before prompt rendering. `createCheetahContextEngineFactory` derives the database and opaque project/session namespaces from config/env + workspace before wiring interactive sessions; dropped local nodes are cascade-deleted remotely, and telemetry plus selector exchanges persist separately from the canonical local graph.
- Interactive agent (`src/agent/` + `src/ui/`): `AgentSession` (`src/agent/agent-session.js`) is a UI-agnostic `EventEmitter` loop (plan → act → approve → apply → validate → repeat). Each turn requests strict `agent-action` JSON (schema `docs/prompts/agent-action.schema.json`), auto-runs read-only actions (`read_file`/`list_dir`/`search_text` via `executeReadonly`, `web_research` via the injected bounded researcher), and gates `write_file`/`edit_file`/`run_cmd` behind an injected `approver`. Every prompt is rendered from the session's `ContextGraph` rather than a transcript tail: `contextLength`/`contextBudgetTokens` size the budget, `_remember()` files each observation into a layer, the optional context engine supplies recalled ids and complete-sentence candidates before rendering, model `context_ops` are applied before the turn's actions (emitting `context-ops`), and `context_sufficient: false` triggers a bounded `context-reform`. Optional `initialResearchQueries`, `requireWebResearch`, and `maxWebResearchActions` make library-selection tests deterministic without changing the operator task; `validateWorkspace` runs preflight and after edits/finish, persists structured validation, and feeds issues into the next turn. The loop retries one transient model request, rejects same-turn mutation conflicts, and caps duplicate/no-progress loops. `agent-executor.js` normalizes actions (path-safe via `resolveWorkspacePath`), builds a two-phase mutation proposal (`buildMutationProposal` → diff, before/after, `expectedHash`) and commits through `writeFileWithGuard` (`commitMutation`, rollback dir under the session); new-file writes create missing parent directories. `approvers.js` provides `createHeadlessApprover` (policy `ask|allow|deny|session`, TTY prompt) and `createUiApprover` (emits `permission-request`, resolved by `session.resolvePermission`). Sessions persist under `.miniphi/agent-sessions/<id>/` (`session.json`, `transcript.jsonl`, `context-graph.json`, `context-engine.json`, `context-references.json`, `result.json`, `rollbacks/`). The Ink+htm UI (`src/ui/app.js`, `launch.js`, `components/*`) renders home/Easy benchmark table → file picker → prompt → benchmark-informed model picker → live progress → inline permission/diff modal → done; it uses no build step (htm binds to `React.createElement`) and no JSX-component peer deps (input/selection are built on Ink's `useInput`).
- VisionReviewer (`src/libs/vision-reviewer.js`): optional vision-model critique for a rendered local file, exposed to the interactive agent as the auto-run `visual_review` action (`path`, optional `focus`). `screenshotLocalFile` renders the file in headless Chromium (same Puppeteer launch pattern as `web-browser.js`/the basketball live test) and `VisionReviewer.review()` sends the PNG as `image_url` content on the proven `/chat/completions` route so `response_format=json_schema` (schema `docs/prompts/visual-review.schema.json`) still applies; one retry on invalid JSON, then a deterministic fallback, mirrors `ContextReferenceComposer`. `createVisionReviewAction()` composes both steps into the single function `AgentSession.visionReview` expects; `src/ui/launch.js` wires it in only when `selectVisionModel()` finds a `vision`-capability entry in the live LM Studio catalog (`--model auto`'s inventory), so the session's system prompt only advertises `visual_review` when a VLM is actually installed — otherwise the action still validates against the schema but reports `unavailable`, exactly like `web_research` without a configured researcher. Live-proven against a real host: real Puppeteer screenshot -> real `/chat/completions` call with `image_url` content -> schema-valid critique on the first attempt (`devstral-small-2-24b-instruct-2512`, one retry-free round trip).
- CheetahKnowledgeClient/CheetahLearner (`src/libs/cheetah-knowledge-client.js`, `src/libs/cheetah-learner.js`): the "ignorant model" teach/recall adapter behind `cheetah-learn` (see "Cheetah-learn" below) and behind the interactive agent's optional `knowledge_lookup` action above. Built on the same `CheetahTcpClient` and binder command builders as CheetahContextEngine, but a distinct selectable database (`miniphi_knowledge` by default; local Wikipedia uses `wikidata`) and data model: subjects anchor at type-agnostic `topic:<slug(name)>` ids so a name alone re-derives the same anchor; authoritative source memories retain exact bounded references independently from conservative semantic edges; open questions reuse `agent -[:unsure_about]-> hypothesis:<slug>` with resolution flipping `props.status` open→resolved. `resolveKnowledgeLookupConfig()`/`createKnowledgeLookupAction()` compose the reachability-gated agent action; `HfDatasetClient`/`fetchDisjointSamples` (`src/libs/hf-dataset-client.js`) page Hugging Face for teach/eval sampling; `local-wikipedia-dataset.js`/`cheetah-wikipedia-runner.js` stream and checkpoint local dumps; `CheetahRunReport` (`src/libs/cheetah-run-report.js`) is the `.miniphi/cheetah/runs/` operator log while the knowledge of record lives in Cheetah.
- PlanExecutor (`src/libs/plan-executor.js`): executes the focused plan branch's mappable leaf steps as read-only native actions (read_file/list_dir/search_text; `run_cmd` recommendations stay deferred unless a policy-gated `runCommand` is injected), dedupes identical actions across sibling branches, feeds outputs into the workspace-summary prompt (`executedActionsBlock`), and persists per-branch progress via `MiniPhiMemory.savePlanProgress` (`.miniphi/prompt-exchanges/decompositions/<slug>-progress.json`, `firstIncompleteBranch` for `--plan-branch` resume). It also resolves analyzer `missing_snippets` that name repo-relative files (path-escape safe) so the workspace flow re-prompts once with the fetched content (`workspace-summary-snippets` scope) instead of only printing the request.
- PromptStepJournal / PromptRecorder / PromptPerformanceTracker: persist per-step exchanges under `.miniphi/prompt-exchanges/` with telemetry.
- EfficientLogAnalyzer + PythonLogSummarizer: compress outputs, honor `needs_more_context` and truncation plans; store hints in `.miniphi/executions/<id>/analysis.json`.
- WorkspaceProfiler / CapabilityInventory / FileConnectionAnalyzer: cache repo shape + available commands, feed into prompts, and attach ASCII graphs or capability snapshots.
- ResourceMonitor: stream RAM/CPU/VRAM warnings and store rollups under `.miniphi/health/`.
- Helper + command library: versioned scripts in `.miniphi/helpers/`, normalized commands in `.miniphi/helpers/command-library.json` with replay via `node src/index.js helpers|command-library`.
- Benchmarks/recompose harness: `ModelBenchmarkRunner` drives the strict-JSON Easy per-model suite and `RecomposeTester` plus `benchmark recompose|analyze|plan scaffold` drive `samples/recompose/hello-flow`; artifacts live under `.miniphi/benchmarks/`.
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
- `node --test unit-tests-js/cheetah-context-engine.test.js unit-tests-js/context-reference-composer.test.js unit-tests-js/context-graph.test.js unit-tests-js/agent-context-layers.test.js` to validate Cheetah protocol framing, complete-sentence mirroring, strict same-model selection, recall-driven query boosts, fallback, and session telemetry without live services.
- With Cheetah and LM Studio running: `MINIPHI_LMSTUDIO_INTEGRATION=1 MINIPHI_CHEETAH_INTEGRATION=1 LMSTUDIO_REST_URL=http://127.0.0.1:1234 MINIPHI_LIVE_MODEL=qwen/qwen3-4b-thinking-2507 node --test unit-tests-js/agent-cheetah-context.live.test.js`.
- Run the complete multi-file performance proof against `samples/get-started/code` with the same variables and `node --test unit-tests-js/agent-cheetah-complex-sample.live.test.js`; it records turns, actions, elapsed time, graph mirror/recall counts, project/database identity, guarded edits, and functional validation.
- `node --test unit-tests-js/hf-dataset-client.test.js unit-tests-js/local-wikipedia-dataset.test.js unit-tests-js/cheetah-wikipedia-runner.test.js unit-tests-js/cheetah-wikipedia-soak.test.js unit-tests-js/cheetah-knowledge-client.test.js unit-tests-js/cheetah-learner.test.js unit-tests-js/cheetah-run-report.test.js unit-tests-js/cheetah-learn-command.test.js` to validate the cheetah-learn adapter/orchestration/CLI layer offline (fake TCP/REST clients, no live services): streamed local shards and resume, bounded stop reasons, fixed-subject probes, soak controls, Unicode-safe writes, source-grounded teach/recall, deterministic reference fallback, open-question record/resolve/list, and CLI dispatch plus `--no-save`.
- With a real `cheetah-server` (built via `go build -o cheetah-server ./src` in `thirds/cheetah`) and the LM Studio host serving `qwen2.5-coder-0.5b-instruct`: `MINIPHI_LMSTUDIO_INTEGRATION=1 MINIPHI_CHEETAH_INTEGRATION=1 LMSTUDIO_REST_URL=http://192.168.56.1:1234 MINIPHI_LIVE_MODEL=qwen2.5-coder-0.5b-instruct node --test unit-tests-js/cheetah-learn.live.test.js` for the full teach → ask → questions round trip.
- `node --test unit-tests-js/lmstudio-api-status.test.js unit-tests-js/lmstudio-error-utils.test.js unit-tests-js/runtime-defaults.test.js` to validate transport/error taxonomy and session-capped timeout normalization.
- `node --test unit-tests-js/cli-implicit-run.test.js unit-tests-js/task-execution-register-stop-reason.test.js unit-tests-js/miniphi-memory-stop-reason.test.js` to validate implicit run routing plus canonical stop-reason persistence across execution writers.
- `node --test unit-tests-js/stop-reason-migrator.test.js unit-tests-js/cli-migrate-stop-reasons.test.js` to validate one-shot historical stop-reason migration over existing `.miniphi` artifacts.
- `npm run ci:migrate-stop-reasons` to enforce strict parse-error fail-fast checks for persisted `.miniphi` JSON artifacts in CI flows.
- `node src/index.js helpers --limit 5` and `node src/index.js command-library --limit 5` to confirm helper reuse/recording.
- `node scripts/local-eval-report.js --output .miniphi/evals/local-eval-report.json` to capture JSON/tool-call coverage from prompt exchanges.
- `node --test unit-tests-js/plan-focus-segments.test.js unit-tests-js/prompt-decomposer-focus.test.js` to validate nested plan branch selection and decomposition focus hints.
- `node --test unit-tests-js/cli-bash-advanced.test.js` to run live bash sample prompts (requires LM Studio; long-running).
- `node --test unit-tests-js/romeo-miniphi-flow.test.js` (exercise EfficientLogAnalyzer file flow with stubbed Phi and chunked summaries).
- `node --test unit-tests-js/nitpick-two-student-essay.test.js` (exercise the two-model nitpick essay loop with mocked web research and a 1000+ word revision target).
- `node --test unit-tests-js/nitpick-auto-expand-rounds.test.js` (validate `--auto-expand-rounds` retries and strict minimum-word validation for final nitpick drafts).
- `node --test unit-tests-js/web-researcher-fallback.test.js` (verify DuckDuckGo HTML fallback parsing when API results are empty).
- `node scripts/sync-test-task-catalog.js` to regenerate `dev_samples/test_tasks/benchmark-catalog.json` + `dev_samples/test_tasks/general-purpose-suite.json` from `dev_samples/task-tests.md`.
- `node --test unit-tests-js/benchmark-task-catalog.test.js unit-tests-js/cli-benchmark-general-suite.test.js` to validate benchmark-catalog sync and `benchmark general` suite execution.
- `node --test unit-tests-js/api-navigator-retry.test.js unit-tests-js/prompt-decomposer-retry.test.js unit-tests-js/benchmark-general-live-lm.test.js` to validate live benchmark retry telemetry (`full -> compact`) across navigator, decomposer, and assessment flows.
- `node --test unit-tests-js/prompt-decomposer-recursive.test.js` to validate recursive branch expansion (renumbering, budget/depth/session caps, branch-local JSON failures) with a stubbed REST client.
- `node --test unit-tests-js/model-catalog.test.js unit-tests-js/model-selector.test.js unit-tests-js/model-benchmarks.test.js unit-tests-js/cli-benchmark-models.test.js` to validate live-model normalization, benchmark-informed Auto scoring, strict trials, lifecycle restoration, hardware/definition invalidation, and zero-inference cache hits.
- `node --test unit-tests-js/reasoning-profile.test.js unit-tests-js/lmstudio-rest-reasoning.test.js unit-tests-js/prompt-decomposer-recursive.test.js unit-tests-js/agent-ui-app.test.js` to validate monotonic reasoning budgets, inventory capability mapping, strict-schema parameter fallback/caching, branch caps, and the terminal profile picker.
- `node --test unit-tests-js/lmstudio-rest-context-length.test.js` to guard the context_length wire contract (omit unless explicitly configured).
- `node --test unit-tests-js/plan-executor.test.js` to validate plan-branch action mapping (path safety, search-term extraction, dedup, budgets), missing-snippet resolution, and plan-progress persistence.
- `node --test unit-tests-js/agent-executor.test.js unit-tests-js/agent-session.test.js` to validate the interactive agent core: action normalization/path-safety, two-phase guarded write/edit (diff, hash-mismatch rollback, anchor miss/ambiguity), the `agent-action` schema, and the scripted plan→act→approve→finish loop with a stubbed client. The same files cover `visual_review`/`knowledge_lookup` normalization/dispatch and their `unavailable` fallback when no vision model/knowledge base is configured.
- `node --test unit-tests-js/vision-reviewer.test.js` to validate the vision-model sub-call in isolation: image content on the request, schema-valid parsing, the invalid-JSON retry-then-fallback path, and `createVisionReviewAction` refusing to compose without a client/schema registry/model. Does not launch Chromium (no live Puppeteer dependency), matching every other non-`.live.` suite.
- `node --test unit-tests-js/context-graph.test.js unit-tests-js/agent-context-layers.test.js` to validate the multi-layered context: budget derivation from the loaded window, priority/importance/subtask-level selection, digest/window/stub demotion, TTL nudges, retained-layer caps, every context op (incl. rejections and no-ops), subtask open/close collapsing, `reform`, `buildSubConversation`, JSON round-trip, plus the session integration (layered prompt rendering, ops feedback, bounded reform and context-only turns, pinned validation issues).
- `MINIPHI_LMSTUDIO_INTEGRATION=1 LMSTUDIO_REST_URL=http://127.0.0.1:1234 MINIPHI_LIVE_MODEL=gpt-oss-20b node --test unit-tests-js/agent-context-graph.live.test.js` to run the live context-pressure proofs: a task whose evidence exceeds the whole budget completes without overflow, and content reachable **only** through an `expand` op is retrieved and written. Run live files **alone** — concurrent long generations (another live test, `npm test`, a second run) wedge LM Studio on the reference host and the file then fails with transport errors, not logic errors.
- `$env:MINIPHI_AGENT_PROJECT_INTEGRATION='1'; $env:LMSTUDIO_REST_URL='http://127.0.0.1:1234'; $env:MINIPHI_LIVE_MODEL='gpt-oss-20b'; $env:MINIPHI_BASKETBALL_OUTPUT=\"$PWD\\.miniphi\\live-tests\"; node --test unit-tests-js/agent-project-creation.live.test.js` (PowerShell) to run the exact from-scratch basketball prompt with preflight web research, guarded writes, structured validation, and Chromium motion/error checks.
- `node --test unit-tests-js/agent-ui.test.js unit-tests-js/agent-ui-app.test.js unit-tests-js/ui-route.test.js` to validate the Ink UI (file picker filter/toggle, permission/diff modal accept/reject, progress pane), the end-to-end App flow (prompt→run→approve→applied edit) via ink-testing-library, and the `decideUiLaunch` routing decision (TTY/headless/bare/free-form/explicit).
- `MINIPHI_LMSTUDIO_INTEGRATION=1 node --test unit-tests-js/lmstudio-code-generation.live.test.js` to run live code generation/editing checks (simple slugify module, targeted bug-fix edit, stateful class) against LM Studio with strict JSON-schema responses that are executed and asserted on. `unit-tests-js/cli-bash-advanced.test.js` is gated behind the same env var.

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
- `dev_samples/task-tests.md` + `dev_samples/test_tasks/` for the benchmark compendium clone and category-balanced benchmark-general regression suite.
- `docs/prompts/*.schema.json` are the schema source of truth (including `agent-action`, `context-ops`, `visual-review`, `nitpick-plan`, `nitpick-research-plan`, `nitpick-draft`, `nitpick-critique`, `cheetah-teach`, `cheetah-recall`); cached templates live under `.miniphi/prompt-exchanges/templates/`.
- The interactive agent turn schema is `agent-action` (`actions[]` with `type` ∈ read_file/list_dir/search_text/web_research/visual_review/knowledge_lookup/write_file/edit_file/run_cmd/finish, plus `needs_more_context`/`missing_snippets` and the optional context-graph fields `context_ops`/`context_sufficient`/`context_gap`); `AgentSession` validates every turn, retries once with a compact nudge, and otherwise falls back to a deterministic `finish` with a stop reason (`invalid-response`, `session-timeout`, `no-actions`, `no-progress`, `max-turns`, `cancelled`). `visual_review`'s own reply (from a separate vision-capable model, not the coding model) is schema-bound separately by `visual-review` (see VisionReviewer above). `knowledge_lookup` (`subject`) is auto-run and read-only like `web_research`/`visual_review`: it queries the Cheetah knowledge base `cheetah-learn` teaches via `recallAnchorFacts` and feeds the raw retrieved facts back as a context observation for the agent's own (usually larger) model to interpret, with no second LLM call of its own. It is genuinely optional — off by default (`config.knowledgeLookup.enabled` / `MINIPHI_KNOWLEDGE_LOOKUP=1`, opt-in like `context.engine=cheetah`, specifically so a normal run never pays a reachability-probe cost) and, when enabled, only wired into the session after a one-shot `SYSTEM_STATS` reachability probe against Cheetah succeeds (`src/ui/launch.js`), mirroring `visual_review`'s "unavailable" pattern exactly — the guide text and the capability are both absent unless the probe passed.
- `context-ops` (`docs/prompts/context-ops.schema.json`) is the standalone context graph language schema; the same op object is inlined in `agent-action`. The local validator has **no `$ref`/`$defs` support** (`validateSchemaData` in `json-schema-utils.js`), so schema fragments must be inlined, not referenced.
- Samples: `samples/get-started/`, `samples/recompose/hello-flow/`, `samples/bash-it/`, `samples/besh/`.
- Global cache: `~/.miniphi/` holds the prompt DB, capability snapshots, and shared helper metadata.

## Issues & constraints
- Persistence is local JSON only; `.miniphi/` can grow quickly, so use `cache-prune` retention caps (no encryption yet).
- LM Studio context can stall around 4k on this host; trim prompts or load a larger model when decomposer REST calls fail.
- The layered context graph covers the **interactive agent only**; `workspace`/`run`/`analyze-file` still build ad-hoc prompt blocks with their own budget caps. Persisted graphs are written but not yet reloaded on session start.
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
- Workspace summaries now include a compressed “Agent commands (defaults)” block (workspace/list_dir/read_file/search_text/edit_file/run_cmd/analyze_file/web_research/web_browse) with POSIX/relative paths where applicable so Phi sees the core local actions without spending extra prompt budget.
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
- Prompt exchanges retain deterministic tool metadata keys (`response.tool_calls`, `response.tool_definitions`, `request.tool_definitions`) even when null so eval coverage checks can treat every exchange uniformly.
- Schema-validation summaries in prompt exchanges should preserve `schemaValidation.status` + `schemaValidation.preambleDetected` when available (not just `valid/errors`) so downstream evals can distinguish `invalid_json` vs `schema_invalid` vs `preamble_detected`.
- Prompt logging canonicalization is shared through `src/libs/prompt-log-normalizer.js`; both PromptRecorder and PromptStepJournal consume the same tool/request/response normalization helpers.
- PromptStepJournal under `.miniphi/prompt-exchanges/stepwise/<id>/` records the stepwise operations with prompt/response text and links to PromptRecorder entries via `links.promptExchangeId`/`links.promptExchangePath` when available (paths are stored as POSIX, relative to `.miniphi`, for cross-platform consistency).
- TaskExecutionRegister writes `executions/<id>/task-execution.json` with every LM Studio API request/response plus links to prompt exchanges so you can pause, fix prompt/schema issues, and resume from the last good call.
- TaskExecutionRegister now normalizes persisted `error.stop_reason` / `error.stop_reason_code` / `error.stop_reason_detail` via the shared prompt log normalizer so execution logs match prompt-exchange taxonomy.
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
- **Layered LM Studio runtime.** `LMStudioManager` performs SDK JIT model loading, `LMStudioRestClient` handles native-v1 inventory/lifecycle plus compatible inference/diagnostics, `LMStudioHandler` streams reasoning while enforcing JSON schema contracts, and `EfficientLogAnalyzer` + `PythonLogSummarizer` compress live command output or saved files before the model thinks.
- **CLI entrypoints + default workflow.** `node src/index.js run --cmd "npm test" --task "Analyze failures"` is the canonical loop, while `analyze-file`, `lmstudio-health`, `web-research`, `web-browse`, `nitpick`, `history-notes`, `cache-prune`, `migrate-stop-reasons`, `recompose`, and `benchmark models|general|recompose|analyze|plan scaffold` cover file replay, health probes, research snapshots, browsing captures, writer/critic tests, `.miniphi` audits, stop-reason artifact normalization, pruning, model scoring, recomposition, and benchmark sweeps.
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
1. **LMStudioManager / LMStudioRestClient** (src/libs/lmstudio-api.js) provide SDK JIT handles, native-v1 model inventory and exact load/unload calls, plus the compatible schema-bound chat/completion, embedding, and diagnostic routes.
2. **LMStudioHandler** (src/libs/lmstudio-handler.js) wraps LM Studio calls, enforces reasoning streams, wires `--session-timeout`, and declares the JSON schema that each downstream model call must respect.
3. **LMStudioRuntime** (src/libs/lmstudio-runtime.js) centralizes LM Studio setup, compatibility checks, REST/WS wiring, and prompt scoring configuration.
4. **JsonSchemaUtils** (src/libs/json-schema-utils.js) builds `response_format=json_schema` payloads and validates JSON responses before downstream handlers apply fallbacks.
5. **EfficientLogAnalyzer + PythonLogSummarizer** compress streamed stdout/stderr or files by chunk, annotate the segments, and feed the high-signal slices to the model while embedding the proper JSON schema from `docs/prompts/`.
6. **miniPhiMemory + PromptRecorder** archive prompts, compressed context, responses, TODOs, scoring metadata, recursive prompt plans, and capability outlines under `.miniphi/` so future runs can rehydrate any exchange.
7. **WorkspaceProfiler + FileConnectionAnalyzer + CapabilityInventory** scan the repository tree ahead of a run so each prompt is prefixed with facts about the code/docs split, import/dependency graph, and available scripts/binaries.
8. **PromptPerformanceTracker** scores every prompt/response pair inside `miniphi-prompts.db` (SQLite), captures prompt lineage/schema IDs/commands/capabilities, and exposes the structured telemetry to scoring prompts and future runs.

### src/ file map
- `src/index.js`: CLI entrypoint and command router; loads config, builds workspace context, and wires LM Studio, memory, and analyzers for all commands.
- `src/commands/`: Command handlers extracted from `src/index.js` (run, analyze-file, workspace, recompose, benchmark, prompt-template, web-research, web-browse, nitpick, history-notes, cache-prune, migrate-stop-reasons, command-library, helpers) plus shared primary command dispatch in `src/commands/primary-flow.js`.
- `src/agent/`: interactive agent core — `agent-session.js` (event-driven plan→act→approve→apply loop), `agent-executor.js` (action normalization + guarded write/edit via `writeFileWithGuard`, read-only reuse of plan-executor), `approvers.js` (headless + UI permission approvers).
- `src/ui/`: Ink+htm terminal UI — `route.js` (`decideUiLaunch`), `launch.js` (session + approver + Ink render, dynamic-imported), `app.js` (phase orchestration), `file-scan.js`, `theme.js`, `html.js`/`ink-elements.js` (no-build htm binding), and `components/` (file-picker, prompt-input, progress-pane, permission-modal, text-input).
- `src/libs/api-navigator.js`: Requests navigation plans from LM Studio, normalizes actions, and optionally runs helper scripts.
- `src/libs/benchmark-general.js`: General-purpose benchmark flow, resource baselines, and summaries.
- `src/libs/benchmark-analyzer.js`: Reads benchmark run JSON files, produces summary artifacts, and records history entries.
- `src/libs/cache-pruner.js`: Prunes `.miniphi` artifacts using retention caps and index metadata.
- `src/libs/capability-inventory.js`: Scans package scripts, `scripts/`, `.bin` tools, and OS commands to summarize available capabilities.
- `src/libs/cli-executor.js`: Cross-platform shell command runner with streaming output, timeouts, and silence detection.
- `src/libs/cli-utils.js`: CLI parsing helpers for numeric flags and duration parsing.
- `src/libs/cheetah-binder.js`: The single import site for the Cheetah submodule's Node binder — CommonJS→ESM bridge, `CheetahTcpClient` batch adapter over the binder's pipelined socket, re-exported graph command builders and response codec.
- `src/libs/cheetah-context-engine.js`: Optional Cheetah context adapter — config resolution, metadata + complete-reference-sentence mirroring, bounded `GRAPH_RECALL references=1`, query-time preferred node ids/reference candidates, fallback, and telemetry.
- `src/libs/command-authorization-manager.js`: Enforces command policies (`ask|allow|deny|session`) and prompts for approval.
- `src/libs/config-loader.js`: Loads `config.json` or `miniphi.config.json`, applies profiles, and merges settings.
- `src/libs/context-graph.js`: Multi-layered context graph — layered nodes with persisted complete reference sentences, token budgeting, digest/window/stub demotion, the context graph language (`applyOps`), subtask open/close, deterministic `reform`, and JSON persistence.
- `src/libs/context-reference-memory.js`: Deterministic sentence segmentation, fragment completion, stable reference ids, bounds, and legacy-memory normalization.
- `src/libs/context-reference-composer.js`: Strict same-session-model selector for Cheetah sentence candidates, with grounded-id filtering, timeout/retry/fallback, prompt-budget rendering, and complete exchange audit data.
- `src/libs/core-utils.js`: Shared helpers for plan formatting, JSON parsing, danger normalization, and LM Studio URL handling.
- `src/libs/efficient-log-analyzer.js`: Orchestrates command/file analysis with summarization, schema enforcement, and truncation plans.
- `src/libs/file-connection-analyzer.js`: Builds a lightweight import graph (JS/Python) and hotspot summary for the workspace.
- `src/libs/file-edit-guard.js`: Guarded write helper that captures diff summaries and rollback copies for recompose edits.
- `src/libs/global-memory.js`: Home-level `.miniphi` store for shared helpers, templates, preferences, and prompt telemetry.
- `src/libs/history-notes.js`: Captures `.miniphi` snapshots (optionally with git metadata) into JSON and Markdown.
- `src/libs/json-schema-utils.js`: Shared helpers to build JSON schema response_format blocks and validate responses.
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
- `src/libs/web-researcher.js`: DuckDuckGo research client with Instant Answer + HTML fallback parsing for the `web-research` command.
- `src/libs/web-browser.js`: Puppeteer-backed browser fetcher for `web-browse` and blind nitpick sources.
- `src/libs/workspace-context-utils.js`: Builds workspace file manifests, README snippets, and prompt hint blocks.
- `src/libs/workspace-profiler.js`: Profiles workspace contents (code/docs/data) and optionally includes connection graphs.

### Command tour
- `ui` launches the interactive agent (also the default for bare `miniphi` and free-form tasks on a TTY). The flow is files → task → live `Auto`/manual model choice → run. Flags: `--task "<objective>"` (seed the prompt), `--model <id|auto>` (preselects the corresponding row), `--command-policy`, `--session-timeout`, `--context-budget <tokens>` (context-graph prompt budget; default derived from the selected model's loaded context window), `--cwd`; `--headless`/`--no-ui` opt out. Requires a TTY (non-TTY `ui` errors; non-TTY bare falls back to help). Sessions persist under `.miniphi/agent-sessions/<id>/`.
- `run` executes a command and streams reasoning. Key flags: `--cmd`, `--task`, `--cwd`, `--timeout`, `--session-timeout`, `--no-navigator`, `--prompt-id`, `--plan-branch`, `--refresh-plan`, `--python-script`, `--summary-levels`, `--context-length`, `--reasoning <off|low|medium|high>`, `--no-plan-expansion`, `--max-plan-expansions <n>`, and the resource monitor thresholds (`--max-memory-percent`, `--max-cpu-percent`, `--max-vram-percent`, `--resource-sample-interval`).
- `models` scans native v1 and lists the normalized live LM Studio inventory ranked for a task: `node src/index.js models [--task "<objective>"] [--json] [--timeout <s>]`. The top-ranked model is what `--model auto` resolves to. Explicit lifecycle flags are `--load <model-id> [--context-length <tokens>]` and `--unload <instance-id>`; load and unload are mutually exclusive.
- `analyze-file` summarizes an existing file. Flags mirror `run` but swap `--cmd` for `--file`.
- `web-research` performs DuckDuckGo Instant Answer lookups. Use positional queries or `--query`, set `--max-results`, `--provider`, `--include-raw`, `--no-save`, and optional `--note`. Results live under `.miniphi/research/`.
- `web-browse` drives a headless browser (Puppeteer) to capture page text. Use `--url` (or positional URLs), `--url-file`, `--timeout/--timeout-ms`, `--wait-selector`/`--wait-ms`, `--selector` to scope extraction, `--max-chars`, `--include-html`, `--screenshot` (`--screenshot-dir`), `--headful`, and `--block-resources` to speed loads. Snapshots land under `.miniphi/web/`.
- `nitpick` runs a writer/critic loop to draft and revise long-form text with strict JSON schemas plus minimum-word validation by actual word count on final drafts. Flags: `--writer-model`, `--critic-model`, `--model-pool`, `--rounds`, `--target-words`, `--auto-expand-rounds`, `--blind` (forces web research + browsing), `--max-results`, `--max-sources`, `--max-source-chars`, `--research-rounds`, `--provider`, `--browser-timeout/--browser-timeout-ms`, `--output`, and `--print`. Sessions are saved under `.miniphi/nitpick/`.
- `history-notes` snapshots `.miniphi/` and optionally attaches git metadata. Use `--label`, `--history-root`, and `--no-git`.
- `cache-prune` trims older `.miniphi/` artifacts using retention caps. Use `--retain-*` overrides, `--dry-run`, `--json`, and `--cwd` to scope the workspace.
- `migrate-stop-reasons` performs a one-shot normalization pass over existing `.miniphi` JSON artifacts so legacy stop reason aliases are rewritten to canonical fields and legacy prompt exchanges are backfilled with deterministic `tool_calls`/`tool_definitions` keys. Use `--dry-run` to preview changes, `--strict` for CI fail-fast parse-error handling, `--parse-error-report` to print malformed JSON paths, `--json` for machine-readable output, and `--include-global` to include `~/.miniphi`.
- `npm run ci:migrate-stop-reasons` wraps `migrate-stop-reasons --history-root . --dry-run --strict --parse-error-report --json` for CI-friendly enforcement.
- `command-library` prints every command that Phi recommended via `recommended_fixes[].commands`; filter with `--search`, `--tag`, and `--limit`, or add `--json` to consume the output programmatically.
- `helpers` lists the versioned helper scripts saved under `.miniphi/helpers/`. Filter with `--workspace-type`, `--source`, `--search`, or `--limit`, dump JSON with `--json`, and rerun helpers via `--run <id> [--version <n>]` plus optional `--stdin`, `--stdin-file`, `--helper-timeout`, `--helper-silence-timeout`, and `--helper-cwd`.
- `recompose` operates on `samples/recompose` projects. Flags: `--sample`, `--direction code-to-markdown|markdown-to-code|roundtrip`, `--code-dir`, `--descriptions-dir`, `--output-dir`, `--clean`, `--report`, `--resume-descriptions`, and `--recompose-mode auto|live|offline` (default: auto; offline writes stub code). Use `--workspace-overview-timeout <seconds>` (or `--workspace-overview-timeout-ms <ms>`) to raise the dedicated workspace-overview prompt budget when Phi-4 needs more time before narration. Used for development and testing purposes.
- `benchmark recompose` automates timestamped runs (default sample `samples/recompose/hello-flow`). Mix in `--directions`, `--repeat`, `--run-prefix`, `--timestamp`, `--clean`, `--resume-descriptions`, or `--sample`.
- `benchmark analyze` reads `RUN-###.json` files, emits `SUMMARY.json|md|html`, and supports `--path` or positional directories plus repeated `--compare` flags to diff baselines vs candidates.
- `benchmark plan scaffold` inspects a sample (default `hello-flow`) and prints a commented YAML template; use `--sample`, `--benchmark-root`, and `--output` to persist it.
- `benchmark general` profiles the current workspace, refreshes prompt baselines, optionally executes `--cmd "<command>"` under watchdog timers, and records CPU/RAM deltas against `benchmark/baselines/general-purpose-baseline.json`. Add `--live-lm` to run live LM Studio navigator/decomposer + schema-validated benchmark assessment calls (timeouts configurable via `--live-lm-timeout`, `--live-lm-timeout-ms`, `--live-lm-plan-timeout`, `--live-lm-plan-timeout-ms`); navigator/decomposer/assessment now retry once with compact payloads after timeout/context-overflow, and when both navigator + decomposer time out the benchmark flow still issues one ultra-compact `assessment-only` request instead of skipping assessment. Benchmark summaries persist adaptive per-stage timeout budgets plus resolved timeout telemetry. Tune with `--task`, `--timeout`, `--silence-timeout`, `--cwd`, and the standard config/profile flags.
- `benchmark models --easy` runs the deterministic strict-JSON core suite serially across installed chat models (or `--models <id,id>`). Each prompt embeds `model-benchmark-trial@v1`, sends `response_format=json_schema`, retains response/reasoning text, finish reason, tool calls, and tool definitions, retries one invalid response, and emits a deterministic fallback trial record. Results and raw attempts are cached under `.miniphi/benchmarks/models/`; the key covers the suite/schema revision, exact normalized model artifact, resolved load config, endpoint/runtime/hardware fingerprint, context length, and timeout. `--refresh` bypasses a hit; `--show` makes no inference calls. A temporary v1-loaded instance is unloaded by exact instance id, while an operator-loaded instance is reused and never implicitly unloaded. Fresh category scores automatically become primary evidence for Auto selection in headless flows, `models`, and the UI; partially benchmarked inventories assign untested models a neutral score prior so a weak measured model cannot dominate solely due to the 0–100 benchmark scale.

Every command accepts `--config <path>` (falls back to searching upward for `config.json`), optional `--profile <name>` to activate a named config preset, and `--verbose` for progress logs. `--debug-lm` enables the semantic prompt scoring evaluator and prints every objective + prompt while scoring runs.

### Frequently used flags
- `--task` describes what the model should do with the log or command output. If omitted, it defaults to `"Provide a precise technical analysis"` from `config.example.json`.
- `--prompt-id <id>` or `--config defaults.promptId` let you resume a chat session; transcripts are written to `.miniphi/prompt-sessions/<id>.json`.
- `--plan-branch <step-id>` focuses a saved plan branch (paired with `--prompt-id`) instead of recomputing the decomposition; MiniPhi now propagates the focused segment block into downstream analysis metadata (`subContext`, `taskPlanFocus*`) so routing can pick models/profiles by nested branch context. Add `--refresh-plan` to force a new plan even when one is cached.
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
- `ROADMAP.md` tracks the long-lived milestone plan and explicit exit criteria (status snapshot lives in its "Where we are" section; this file carries the active-slice summary).
- `docs/NodeJS LM Studio API Integration.md` explains how the LM Studio SDK and REST layers fit together.
- `docs/miniphi-cli-implementation.md` walks through compression heuristics, pipelines, and architectural decisions.
- `docs/APIs/lmstudio-docs/1_developer/` contains the current LM Studio developer docs; `docs/studies/APIs/REST API v0 _ LM Studio Docs.html` is the archived offline snapshot.
- `scripts/lmstudio-json-debug.js` is a small REST runner that prints the raw LM Studio completion + the parsed JSON object (useful for debugging system prompts / schema enforcement outside the CLI).
- `scripts/lmstudio-json-series.js` runs a multi-step, schema-enforced LM Studio session that applies file edits inside a sandbox copy of `samples/get-started/code` (use `npm run sample:lmstudio-json-series`).
- `scripts/prompt-composer.js` renders JSON-only prompt payloads from a prompt-chain definition (with option selections + templates) and can send them to LM Studio for rapid prompt iteration.
- `scripts/prompt-interpret.js` validates prompt-chain responses against a schema and updates learned options/selected options based on the JSON output.
- `unit-tests-js/lmstudio-code-generation.live.test.js` holds the live LM Studio JSON-schema code-generation tests; run with `MINIPHI_LMSTUDIO_INTEGRATION=1 npm test` (requires LM Studio running; plain `npm test` skips all live tests).
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

LM Studio SDK wrapper + REST client — the transport boundary. `LMStudioManager` performs SDK JIT model loading; `LMStudioRestClient` targets native v1 inventory/lifecycle, native-v0 diagnostics/inference, and OpenAI-compatible fallbacks. `listModelsNativeV1`, `loadModelV1`, and `unloadModelV1` implement the exact current REST contracts. `normalizeLmStudioWsUrl` / `normalizeLmStudioHttpUrl` normalize endpoints. Change this for REST/WS wire behavior.

- **Common mistakes:** Do not send `context_length` unconditionally (see the contract), persist authorization headers, unload a model family instead of one exact instance id, or move schema-bound prompts to `/api/v1/chat` without first proving that the route accepts `response_format=json_schema`.
- **Tests:** [`lmstudio-api-status.test.js`](unit-tests-js/lmstudio-api-status.test.js), [`lmstudio-api-v1.test.js`](unit-tests-js/lmstudio-api-v1.test.js), [`lmstudio-rest-context-length.test.js`](unit-tests-js/lmstudio-rest-context-length.test.js).

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

Live model selection behind `--model auto`, the `models` command, and the interactive model picker. `model-catalog.js`: `fetchModelCatalog` (native v1 first, then native-v0/OpenAI-compatible fallbacks), v1 normalization (`key`, structured quantization/capabilities, variants, loaded instances/config), benchmark-primary `scoreModelForTask`, `rankModelsForTask`, `resolveAutoModel`. `model-selector.js`: `classifyTaskIntent`, `selectModelForIntent`, `selectNitpickModels`. `model-benchmarks.js`: strict deterministic trials, cache keys/freshness, serialized lifecycle, and tables. UI ranking lives in [`src/ui/model-selection.js`](src/ui/model-selection.js), [`src/ui/components/model-picker.js`](src/ui/components/model-picker.js), and the Easy/table home section in [`src/ui/components/benchmark-dashboard.js`](src/ui/components/benchmark-dashboard.js); selection provenance persists through `AgentSession.configureModel`. `model-presets.js`: `MODEL_PRESETS`, `DEFAULT_MODEL_KEY`, `DEFAULT_CONTEXT_LENGTH = 16384`, `resolveModelConfig`. **Known gap:** headless configured default may not be installed — prefer `--model auto`; the Easy suite is core text/task coverage and does not yet implement guarded-edit execution, long-window/vision/image-generation trials, server-side GPU telemetry, or multi-model subprompt routing. Tests: [`model-catalog.test.js`](unit-tests-js/model-catalog.test.js), [`model-selector.test.js`](unit-tests-js/model-selector.test.js), [`model-benchmarks.test.js`](unit-tests-js/model-benchmarks.test.js), [`cli-benchmark-models.test.js`](unit-tests-js/cli-benchmark-models.test.js), [`cli-models-v1.test.js`](unit-tests-js/cli-models-v1.test.js), [`ui-model-selection.test.js`](unit-tests-js/ui-model-selection.test.js).

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
- **Layered context / Cheetah:** [`context-graph.test.js`](unit-tests-js/context-graph.test.js), [`context-reference-composer.test.js`](unit-tests-js/context-reference-composer.test.js), [`agent-context-layers.test.js`](unit-tests-js/agent-context-layers.test.js), [`cheetah-context-engine.test.js`](unit-tests-js/cheetah-context-engine.test.js).
- **Model selection:** [`model-catalog.test.js`](unit-tests-js/model-catalog.test.js), [`model-selector.test.js`](unit-tests-js/model-selector.test.js).
- **CLI routing / commands:** [`cli-implicit-run.test.js`](unit-tests-js/cli-implicit-run.test.js), [`cli-implicit-analyze-file.test.js`](unit-tests-js/cli-implicit-analyze-file.test.js), [`cli-smoke.test.js`](unit-tests-js/cli-smoke.test.js), [`cli-workspace-scan.test.js`](unit-tests-js/cli-workspace-scan.test.js), [`cli-cache-prune.test.js`](unit-tests-js/cli-cache-prune.test.js), [`cli-get-started-sample.test.js`](unit-tests-js/cli-get-started-sample.test.js), [`cli-recompose.test.js`](unit-tests-js/cli-recompose.test.js), [`cli-benchmark.test.js`](unit-tests-js/cli-benchmark.test.js), [`cli-rl-routing.test.js`](unit-tests-js/cli-rl-routing.test.js), [`cli-uppercase-files.test.js`](unit-tests-js/cli-uppercase-files.test.js).
- **Benchmark catalog / suite:** [`benchmark-task-catalog.test.js`](unit-tests-js/benchmark-task-catalog.test.js), [`cli-benchmark-general-suite.test.js`](unit-tests-js/cli-benchmark-general-suite.test.js), [`workspace-summary-budget.test.js`](unit-tests-js/workspace-summary-budget.test.js), [`workspace-scan-cache.test.js`](unit-tests-js/workspace-scan-cache.test.js).
- **Web / misc:** [`web-researcher-fallback.test.js`](unit-tests-js/web-researcher-fallback.test.js), [`agent-commands.test.js`](unit-tests-js/agent-commands.test.js), [`fast-mode-utils.test.js`](unit-tests-js/fast-mode-utils.test.js), [`legacy-module-cleanup.test.js`](unit-tests-js/legacy-module-cleanup.test.js), [`nitpick-two-student-essay.test.js`](unit-tests-js/nitpick-two-student-essay.test.js), [`nitpick-auto-expand-rounds.test.js`](unit-tests-js/nitpick-auto-expand-rounds.test.js).
- **Live-gated tier (`MINIPHI_LMSTUDIO_INTEGRATION=1`):** [`lmstudio-code-generation.live.test.js`](unit-tests-js/lmstudio-code-generation.live.test.js) (executes generated code), [`agent-cheetah-context.live.test.js`](unit-tests-js/agent-cheetah-context.live.test.js) and [`agent-cheetah-complex-sample.live.test.js`](unit-tests-js/agent-cheetah-complex-sample.live.test.js) (also require `MINIPHI_CHEETAH_INTEGRATION=1`), [`cli-bash-advanced.test.js`](unit-tests-js/cli-bash-advanced.test.js), [`benchmark-general-live-lm.test.js`](unit-tests-js/benchmark-general-live-lm.test.js).
- **Known gaps:** no guarded main-flow edit test yet (recompose-only today); live coverage depends on a healthy, un-wedged LM Studio.

---

## 11. Data, Security, Privacy, and Compatibility Boundaries

- **Canonical vs derived:** source of truth is [`docs/prompts/*.schema.json`](docs/prompts) and `src/`. Everything under `.miniphi/` and `~/.miniphi/` is derived/runtime audit data, plain JSON, gitignored (`.gitignore` ignores `.miniphi/`, `miniphi.config.json`, `current-benchmarks/`, and `miniphi-prompts.db*`). `dev_samples/test_tasks/*.json` is generated from [`dev_samples/task-tests.md`](dev_samples/task-tests.md).
- **Local-only writes:** no remote writes; edits and helpers stay within the working directory and `.miniphi/`. Path resolution is escape-safe ([`resolveWorkspacePath`](src/libs/plan-executor.js)).
- **Command trust:** shell execution is gated by [`CommandAuthorizationManager`](src/libs/command-authorization-manager.js) (`ask` default) with per-command `danger` levels; navigator follow-ups inherit `--command-danger`. Navigator skips MiniPhi CLI entrypoints to prevent recursive runs.
- **Secrets:** none stored in the repo; `.miniphi/` is unencrypted local JSON — do not write credentials into it. `LMSTUDIO_API_TOKEN`/configured REST tokens are used only as authorization headers and redacted from request instrumentation. The SQLite prompt DB (`miniphi-prompts.db`) lives under `~/.miniphi/` and is gitignored.
- **Compatibility:** REST discovery/lifecycle prefers native LM Studio v1 with bounded native-v0/OpenAI-compatible fallbacks; schema-bound inference remains on the proven compatible route. Stop-reason and prompt-log schemas are versioned and migratable via `migrate-stop-reasons`; `SchemaAdapterRegistry` normalizes evolving response layouts.
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
- Cheetah context querying is opt-in for interactive `AgentSession` prompts/subtasks; headless decomposition, remote compaction/deletion, and cross-session recall remain unwired.

### Known Gaps (driving the active slice)
- `--plan-branch` does not auto-default to `firstIncompleteBranch` on resume (only a printed hint).
- Plan executor not yet wired into `run`/`analyze-file`; `run_cmd` recommendations not yet executed under policy in run mode.
- No live proof of the `missing_snippets` re-prompt firing end-to-end.
- `model-presets.js` default may not be installed on the host; interactive UI defaults to an `Auto` row, while headless `--model auto` is still opt-in rather than the config default.
- Native v1 explicit load/unload is available under `models`, but normal agent runs still rely on JIT loading; automatic memory-fit loading/restoration is not implemented.

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
