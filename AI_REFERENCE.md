# After a prompt
- Keep `README.md` and this reference in sync whenever MiniPhi gains a new command, argument, or workflow.
- Benchmark follow-up work must target MiniPhi's runtime (prompt orchestration, analyzers, LM Studio clients) instead of touching the benchmark scripts unless absolutely required for coverage.
- Every Phi-4 prompt must declare the exact JSON schema expected in the response (fields, types, nullability) so large workspaces stay deterministic.

# MiniPhi Reference

## Current Status
- Layered LM Studio runtime is live: `LMStudioManager` handles JIT loading and `/api/v0` diagnostics, `Phi4Handler` streams reasoning and enforces JSON schema contracts, and `EfficientLogAnalyzer` plus `PythonLogSummarizer` compress command/file output.
- CLI entrypoints cover commands (`run`), file analysis (`analyze-file`), research snapshots (`web-research`), `.miniphi` audit trails (`history-notes`), recomposition workflows (`recompose`), and benchmark automation (`benchmark recompose|analyze|plan scaffold`).
- Default workflow (`node src/index.js run --cmd "npm test" --task "Analyze failures"`) executes a command, compresses stdout/stderr, and streams Phi-4 reasoning in real time (requires LM Studio at `http://127.0.0.1:1234` with `microsoft/phi-4-reasoning-plus`).
- Hidden `.miniphi/` workspace, managed by `MiniPhiMemory`, snapshots every execution (`executions/<id>`, `prompt.json`, `analysis.json`, compression segments, TODOs, recursive indexes), mirrors each sub-prompt as JSON under `.miniphi/prompt-exchanges/`, and now archives LM-generated helper scripts + run logs inside `.miniphi/helpers/`.
- `PromptSchemaRegistry` loads `docs/prompts/*.schema.json`, injects the schema block into every Phi-4 call (main prompts, scoring prompts, decomposers), and rejects responses that fail validation before they hit history storage.
- `WorkspaceProfiler` (plus `FileConnectionAnalyzer` and the new `CapabilityInventory`) inspects the repo tree, renders ASCII file-connection graphs, captures repo/package scripts, and injects the combined hints into every Phi-4 prompt; `PromptRecorder` mirrors the exchanges and `PromptPerformanceTracker` stores scores + telemetry inside `miniphi-prompts.db`.
- `ApiNavigator` runs in parallel with the npm-based analyzers, asking LM Studio's API for navigation guidance, synthesizing single-use Node.js/Python helper scripts, executing them immediately, and feeding the navigation block + helper output back into downstream prompts while storing the code and stdout/stderr artifacts under `.miniphi/helpers/`.
- `PromptDecomposer` preflights complex tasks, emits JSON trees + human-readable outlines of sub-prompts/actions, and persists them under `.miniphi/prompt-exchanges/decompositions/` so runs can resume mid-branch with the saved outline.
- `PromptStepJournal` sits next to `PromptRecorder`, emitting `.miniphi/prompt-exchanges/stepwise/<session>/` JSON steps whenever `--prompt-journal [id]` is passed so operators (or downstream AI supervisors) can review every Phi/API prompt, the resulting commands or file analyses, and then pause/resume via `--prompt-journal-status paused|completed|closed`.
- Resource monitoring (RAM/CPU/VRAM) ships via `ResourceMonitor`, streaming warnings to the console and recording rollups under `.miniphi/health/resource-usage.json` alongside `.miniphi/history/benchmarks.json`.
- Research, history, and benchmark helpers store artifacts inside `.miniphi/research/`, `.miniphi/history-notes/`, and `.miniphi/benchmarks/`, making every Phi-4 conversation or benchmark sweep reproducible.
- `RecomposeTester` and `RecomposeBenchmarkRunner` drive `samples/recompose/hello-flow`, cache code-to-markdown descriptions, repair mismatches with diff-driven prompts, and export Phi transcript logs next to every JSON report so reviews stay auditable.
- Workspace-first prompts now exist: `node src/index.js workspace --task "..."` (or `miniphi "..."`) anchors planning in the current working directory, loads navigation hints, and persists prompt-decomposition plans without executing arbitrary commands.
- `samples/get-started/` contains a runnable Node.js onboarding project plus curated prompt suites so contributors can test the new workspace-centric flows end-to-end (environment discovery, README drafting, targeted edits, feature work, verification).
- Global shared memory now lives under `~/.miniphi/` so prompt scoring (`miniphi-prompts.db`), OS profiles, command-policy preferences, and rollout metrics survive across repositories and don't need to be checked into source control.
- `CommandAuthorizationManager` enforces `--command-policy ask|session|allow|deny`, respects `--assume-yes`, and pairs with `--command-danger` plus ApiNavigator danger metadata so risky commands require explicit approval, while direct file references (`@"path/to/file"`) are hashed, archived under `.miniphi/prompt-exchanges/fixed-references/`, and injected into every downstream prompt.
- `SchemaAdapterRegistry` normalizes LM Studio API responses (starting with ApiNavigator’s `schema_version` field) so new JSON layouts can self-describe and be adapted without touching the CLI core.
- Optional `config.json` (or `--config`/`MINIPHI_CONFIG`) lets teams pin LM Studio endpoints, prompt defaults, GPU modes, context budgets, resource thresholds, and chunk sizes without retyping flags.

## Reference documents
- `README.md` - human-friendly overview, quickstart, command tour, `.miniphi` layout, and current status summary.
- `docs/NodeJS LM Studio API Integration.md` - SDK vs REST instrumentation, including the `/api/v0` behaviors mirrored in `LMStudioRestClient`.
- `docs/miniphi-cli-implementation.md` - compression heuristics, architectural rationale, and orchestration background.
- `docs/studies/APIs/REST API v0 _ LM Studio Docs.html` - offline REST docs consumed by `LMStudioRestClient`.
- `docs/os-defaults/windows.md` + `docs/prompts/windows-benchmark-default.md` - Windows helper defaults and reusable Phi prompt preset.
- `docs/studies/todo/author.md` - human editing backlog.
- `samples/recompose/hello-flow/benchmark-plan.yaml` + `WHY_SAMPLES.md` - canonical recomposition benchmark plan and guidance for new sweeps.
- `samples/get-started/README.md` - describes the onboarding sample and curated prompt files that exercise workspace-first behavior.
- `samples/bash-it/` - frozen copy of Bash’s full source tree with complex directories, perfect for exercising recursive analysis, recomposition, and benchmark workflows without cloning upstream Bash.
- `~/.miniphi/` - global hidden folder for shared telemetry (prompt DB, command-policy preferences, system profile snapshots) that every project run can reuse.

### Prompt journaling regression sample
- `samples/besh/bsh.c` is the intentionally giant “besh” shell file for recursive summarization and chirurgic editing drills. It is ideal for validating the new stepwise journaling pipeline.
- `npm run sample:besh-journal` runs `analyze-file` on `samples/besh/bsh.c` with `--prompt-journal besh-regression --prompt-journal-status paused`; it outputs a paused ledger under `.miniphi/prompt-exchanges/stepwise/besh-regression/` so another AI (or you) can sign off on the captured steps before resuming.
- To continue the regression after reviewing or modifying the repo, rerun the command with the same journal id (and optionally the same `--prompt-id`) but set `--prompt-journal-status completed` so the ledger shows exactly when the session resumed and closed.

## High-Priority Fundamentals
1. **Narrative-only recomposition inputs.** `samples/recompose/*/descriptions` must stay prose-only so recomposition requires reasoning instead of copy/paste. Keep `hello-flow` aligned with the storytelling rules in its README.
2. **Multi-prompt orchestration.** Each MiniPhi invocation should expand into multiple Phi-4 prompts (workspace scan, plan, targeted edits). Persist those task trees and transcripts under `.miniphi/` so future runs can resume mid-branch.
3. **JSON schema enforcement.** Store and reuse schema templates for every Phi-4 interaction (main prompt plus sub-prompts) so long-running editing sessions can diff responses line-by-line.

## Issues & Constraints
- Persistence is local JSON only; `.miniphi/` lacks pruning, encryption, or sync tooling and can grow quickly on long projects.
- There is no automated test suite; compression heuristics, Phi prompts, and LM Studio integrations still rely on manual verification.
- Packaging, retention policies, and richer summarization backends are in flight; use `node src/index.js ...` or `npx miniphi ...` directly until publishing hardening lands.
- Benchmark suites currently focus on Bash recomposition; other language samples (GPU stressors, Windows helpers, etc.) are still TODO.

## Next Steps (runtime-focused)
1. Wire `.miniphi/indices` and `.miniphi/history/benchmarks.json` directly into the prompt builder so `run`/`analyze-file` commands can reuse benchmark findings without re-reading large files.
2. Expand `PromptDecomposer` into a first-class planner that detects multi-goal commands, proposes sub-prompts with schema references, and lets operators resume a given branch through `--prompt-id`.
3. Add config profiles (named presets inside `config.json`) for LM Studio endpoints, GPU modes, prompt templates, and retention policies, and emit CLI help describing the active profile.
4. Layer richer summarization backends (semantic chunking, embeddings, AST diffs) on top of `EfficientLogAnalyzer` so Phi receives higher-signal context for code and book workspaces.
5. Ship `.miniphi` maintenance helpers (prune executions, archive research, health-check workspace size) and expose them via a new CLI subcommand.
6. Harden orchestration observability: log LM Studio `/api/v0/status` snapshots, context settings, and resource baselines before each Phi call, then persist them next to every prompt exchange.
7. Build a `.miniphi` diff viewer that compares two `history-notes` snapshots or prompt exchanges, highlighting which files, prompts, or health metrics changed between runs.
8. Teach `web-research` to feed saved research snippets into follow-up `run`/`analyze-file` prompts automatically so investigations keep their citations without manual copy/paste.
9. Add a CLI helper for replaying `.miniphi/prompt-exchanges/*.json` (per scope or per sub-prompt) so teams can iterate on specific Phi calls without re-running the parent command.
10. Extend `WorkspaceProfiler` with explicit outline support (`SUMMARY.md`, `book.json`, manifest files) so document-heavy repos send richer cues into every Phi-4 prompt.
11. Surface top-performing prompts from `miniphi-prompts.db` (`prompt-scores` helper) so operators can pick known-good templates for similar objectives.
12. Integrate recomposition telemetry with the main runtime: allow `benchmark analyze` summaries to be referenced inside standard prompts to guide future refactors instead of tweaking the benchmark scripts themselves.
13. **Self-edit orchestration verdict.** ApiNavigator + helper script storage proves MiniPhi can now learn workspace navigation paths from the model itself; the remaining step toward full self-editing maturity is piping those helper results into guarded `miniphi run` loops that patch this repo, capture diffs for review, and roll back automatically when the LM plan disagrees with the observed edits.

### General vision Next Steps
1. Layer heuristics + comment harvesting onto the new AST call-flow generator so each `shell.c::main` step includes “why” context (startup vs trap vs job-control) instead of just callee metadata.
2. Persist the `EXPLAIN-003` chunks (and future benchmarks) into a dedicated `.miniphi/benchmarks/bash/` namespace so orchestration layers can retrieve them without rescanning 5K-line files.
3. Catalog the “special” builtins (`set`, `trap`, `exec`, etc.) inside the benchmark output to document how `execute_simple_command` toggles `CMD_IGNORE_RETURN` under `set -e`.
4. Add an LM Studio `/api/v0/status` pre-flight to the benchmark harness so each run archives model availability, context size (4096 default), and health data next to its log.
5. Produce a follow-up EXPLAIN focused on `parse.y` error recovery (still depth ≤ 1) to document how `jump_to_top_level(FORCE_EOF)` influences benchmark failure cases.
6. Wire the `.miniphi/` indexes into an actual Layer 3 orchestrator: retrieval-augmented prompting, task trees, and resumable progress tracking.
7. Extend the configuration layer into named profiles so teams can swap context budgets, GPU modes, CLI presets, and retention policies without retyping flags.
8. Integrate richer summarization backends (node embeddings, semantic chunking) and expose file/directory analyzers described in `docs/miniphi-cli-implementation.md`.
9. Hardening: add smoke tests (mock LM Studio), richer error diagnostics (server unreachable, model missing), telemetry hooks for compression/token metrics, `.miniphi` health checks/pruning tools, and pre-flight REST diagnostics (list models + context) before orchestrations kick off.
10. Document the LM Studio + Python prerequisites, `.miniphi` workspace expectations, and the new `miniphi` command so adopters know how to install and configure the CLI.
11. Grow the benchmark suite beyond `samples/bash` (e.g., synthetic GPU-stress cases, LM Studio failure drills) and wire log outputs back into `.miniphi/health` for consolidated observability.
12. Add a CLI helper to replay or diff `.miniphi/prompt-exchanges/*.json` records so operators can iterate on each sub-prompt without rerunning the entire parent MiniPhi command.
13. Extend `web-research` with additional providers (local docs, offline corpora, cached citations) and feed the saved research snapshots directly into `run`/`analyze-file` prompts.
14. Layer diff tooling atop `.miniphi/history-notes` so operators can compare two snapshots (JSON or Markdown) and pinpoint which executions/health files changed between runs.
15. Build richer recomposition suites under `samples/recompose/*` (multi-language projects, deeply nested directories) and surface automated mismatch diffs when the round-trip diverges from the canonical code.
16. Teach `WorkspaceProfiler` to read explicit outlines (e.g., `SUMMARY.md`, `book.json`) so book/document workspaces come with even richer editing cues (chapter order, dependencies, TODO markers) before Phi-4 is prompted.
17. Expose a `prompt-scores` CLI helper that surfaces the best rows from `miniphi-prompts.db`, summarizes rolling averages/follow-up rates, and optionally auto-suggests the next prompt template per workspace/objective.
18. **[P0 – Recursive decomposition handoff]** Wire the saved plan outline into `run`/`analyze-file` controls so operators can resume a specific branch (`--prompt-branch`, `--start-at <plan-id>`), mark steps complete inside `.miniphi/prompt-exchanges/decompositions/`, and show plan-progress meters alongside the streamed Phi reasoning.
19. **[P1 – File connection graphing]** Persist the generated ASCII connection graph, include cross-language edges (e.g., JS imports that feed Python scripts), and add a CLI helper (e.g., `file-connections describe <file>`) so operators can inspect the graph outside the prompt context.
20. **[P1 – Script scout automation]** Create a `script-scout` workflow that enumerates available CLI programs/venvs, lets Phi-4 design an ad-hoc script (e.g., locate a reference in thousands of files or parse a giant `.log`), optionally installs missing Python deps on demand, executes the script, and caches the winning “prompt + toolchain” combo for future reuse (“prompt best composition caching”).
21. **[P0 – JSON schema coverage tooling]** Add a schema-lint command that verifies every Phi prompt references a `docs/prompts/*.schema.json`, extend the catalog to cover recomposition + benchmark prompts, and block dispatch if the declared schema drifts from the stored template.
22. **[P1 – Capability inventories]** Teach the capability inventory to probe commands/scripts (dry-run `npm run <script> -- --help`, list `scripts/*.ps1`, etc.), persist capability snapshots under `.miniphi/indices/capabilities.json`, and allow operators to diff two snapshots before rerunning a command.
23. **[P1 – Realtime stdout + parallel orchestration]** Extend `CliExecutor` with realtime stdout sampling + tailing hooks so long-running jobs can be analyzed mid-flight, add background-process orchestration (e.g., keep a server running while executing tests), and ensure every helper process is auto-closed or refreshed when recompiles are requested.
24. **[P2 – Prompt telemetry richness]** Layer a `prompt-telemetry report` CLI on top of the new structured metadata so teams can query `miniphi-prompts.db` by workspace, command, schema, or capability set, and visualize whether the chosen tools matched the available inventory.
25. **[P2 – Post-run validation advisor]** At the end of every MiniPhi run, have a `PostRunAdvisor` ask LM Studio (or follow heuristics) for the top commands that validate syntax/code quality for the touched languages; echo those commands to the operator and, if unknown, auto-query the APIs for the correct invocations.

## Upcoming Implementation Studies

### Get-started prompt suite and runnable sample
- Create `samples/get-started/` mirroring the `hello-flow` layout (`code/`, `prompts/`, `runs/`), but centered on a multi-step onboarding story: (1) detect host OS + available tools, (2) scaffold a README for the repo found in the current CWD, (3) tweak an existing function to change a small behavior, (4) add a feature plus CLI usage, and (5) run/verify everything with Node so regressions are obvious. The sample code should expose assertions (for example `npm test` or `node code/index.js --verify`) so MiniPhi can prove both compilation and result stability.
- Include scripted prompt files such as `prompts/01-environment.md`, `prompts/02-readme.md`, etc., describing the expected objectives and the JSON schema each Phi call must honor (list required fields, enumerations, and the “essential/general/specific prompt” separation).
- Wire the new sample into `samples/WHY_SAMPLES.md` and the CLI docs so contributors know how to run `node src/index.js run --cmd "node samples/get-started/code/index.js --smoke"` and how to replay the curated prompts for regression checks.

### Project-centric CLI and bare `miniphi "<prompt>"` entrypoint
- Restructure `src/index.js` so the default command operates on `process.cwd()` without forcing `--cmd`. If a user executes `miniphi "Draft the README"` the CLI should treat the first positional string as the objective, infer `command="(workspace-edit)"`, and run the same workspace-scan + plan pipeline that `run` uses today.
- Introduce a `workspace` (or `plan-run`) mode that shells out only when the prompt tree instructs it to; expose flags like `--cwd`, `--auto-approve-commands`, `--require-approval`, and `--assume-yes` so project-centric sessions can stay inside the repo root by default.
- Update `README.md` and `docs/miniphi-cli-implementation.md` once the UX is wired so it is obvious MiniPhi edits the current project rather than just summarizing CLI output.

### Command authorization and danger scoring
- Add a `CommandAuthorizationManager` (likely under `src/libs/command-authorization.js`) that gates every call to `CliExecutor.executeCommand`. It needs policy presets (session-only approval, per-command confirmation, always allow), persistence under `.miniphi/prefs/command-policy.json`, and CLI flags to override (`--command-policy ask|allow|deny`).
- Teach `ApiNavigator` (and any helper that synthesizes commands) to emit structured entries with predicted danger levels. Extend `NAVIGATION_SCHEMA` to something like:
  ```json
  "actions": [
    {
      "command": "npm run build",
      "reason": "compile to validate the new feature",
      "danger": "low|mid|high", // low=safe/read-only, mid=repo-scoped mutations, high=destructive/system-wide
      "authorization_hint": "needs network" // optional explanation
    }
  ]
  ```
  Every field must include a `description` in the schema so the Phi prompt explains expectations, and enumerations must list their allowed values explicitly.
- Pipe the parsed danger metadata into the authorization manager so low-risk commands follow the global policy while `mid|high` prompts always pause for confirmation unless the operator opted into auto-approval.

### Schema agility for API-generated commands
- At the moment the Phi prompts are locked to the JSON templates inside `docs/prompts/*.schema.json`. To let the APIs evolve their command payloads, add a schema negotiation handshake: API responses should include a `schema_version` or `schema_uri`, and `PromptSchemaRegistry` needs methods to register dynamic schema adapters (for example `command-plan@v2`) at runtime.
- Implement adapter surfaces (input and output) so when a schema update lands the CLI can map `v1` command objects to the new `v2` structure before passing them downstream. Persist the adapter metadata under `.miniphi/indices/schema-adapters.json` and guard each prompt with the selected schema id so replaying history stays deterministic.

### Direct file references inside prompts
- Extend the CLI argument parser to scan the operator objective for `@"path/to/file.ext"` tokens (quotes optional) and treat them as “pinned inputs”. Resolve each path relative to `cwd`, read the contents (with a size cap), and attach the snippets to the workspace context (`workspaceContext.fixedReferences`).
- Update the prompt builders (main log-analysis prompt plus the decomposer + navigator payloads) to list the referenced files, include SHA-256 hashes for traceability, and, when reasonable, inline short excerpts so Phi treats those files as authoritative.
- Store the reference metadata under `.miniphi/prompt-exchanges/<id>/fixed-references.json` so reruns keep the exact same attachments even if the files change later.

### Recursive prompt analysis and VRAM-aware context sizing
- Promote the existing `PromptDecomposer` into a recursive “prompt analyzer” pipeline. Each user objective should trigger a stack of meta-prompts: (1) objective classification (“what are the goals?”), (2) checklist + sub-prompts, (3) optional sub-sub prompts if a leaf exceeds the current context window. Persist every layer as JSON plus Markdown outlines under `.miniphi/prompt-exchanges/decompositions/`.
- Build a GPU telemetry helper (for example `src/libs/gpu-context-budgeter.js`) that polls `nvidia-smi`/AMDGPU sensors in real time (reuse `ResourceMonitor.#queryNvidiaSmi`) and computes a safe Phi context length. When VRAM pressure is high, clamp `contextLength` and summarization depth; when the GPU is idle, let prompts expand to the configured max (default 4096 today).
- Feed the resource snapshot into the decomposer (`limits.dynamicContextBudget`) so recursive prompts stay inside whatever LM Studio can currently handle.

### Placeholder / “I forgot it” capture
- Add a standing backlog entry (e.g., append to `docs/studies/notes/TODOs.md`) that records unspecified user follow-ups. Each MiniPhi session should write a stub note such as “Forgotten requirement for <date>: [context]” so the missing information is not lost.
