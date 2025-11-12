# After a prompt
- Update AI_REFERENCE.md references and next step.
- Update README.md with updated documentation for humans.

# MiniPhi Reference

## Current Status
- Layered LM Studio stack is live: `LMStudioManager` (JIT loading), `Phi4Handler` (reasoning-aware streaming) and `EfficientLogAnalyzer` (compression + Phi-4 orchestration) sit under `src/`.
- Native `/api/v0` instrumentation landed in `LMStudioRestClient` (`src/libs/lmstudio-api.js`), wrapping the docs in `docs/APIs/REST API v0 _ LM Studio Docs.html` so we can list/check models, run synchronous chat/completion/embedding calls, and capture runtime stats directly from the default server (`http://127.0.0.1:1234`, `microsoft/phi-4-reasoning-plus`, 4096-token baseline unless the model is reloaded).
- Cross-platform command runner (`CliExecutor`), streaming file utilities, and Python-backed summarizer script (`log_summarizer.py`) enable analysis of arbitrarily large logs/CLI outputs.
- `src/index.js` exposes two modes: `run` (execute + analyze a command) and `analyze-file` (summarize existing logs). Both automatically stream Phi-4 solutions unless `--no-stream` is provided.
- Default workflow: `node src/index.js run --cmd "npm test" --task "Analyze failures"` -> auto execute, compress, and reason using Phi-4 (requires LM Studio server + Phi-4 reasoning-plus downloaded).
- Python dependency: CLI auto-detects `python3`, `python`, or `py`; override path via `--python-script`. Summaries live under project root.
- Hidden `.miniphi/` workspace (managed by `MiniPhiMemory`) snapshots every execution: prompts, compression chunks, analysis, recursive indexes, and auto-extracted TODO lists for future orchestration reuse.
- Resource monitor + health archive: `ResourceMonitor` samples RAM/CPU/VRAM on Windows/macOS/Linux, emits warnings via new CLI flags, and persists rollups under `.miniphi/health/resource-usage.json`.
- `benchmark/scripts/bash-flow-explain.js` now uses `web-tree-sitter` (with a macro-aware fallback for `shell.c::main`) to emit depth-limited, ordered call-flow walkthroughs for the Bash sample; EXPLAIN-012.md is the latest AST-backed baseline mirrored under `.miniphi/benchmarks/bash/`.
- `benchmark/scripts/bash-recursive-prompts.js` orchestrates Phi-4 over REST-accessible LM Studio (http://127.0.0.1:1234), walks the Bash directory tree, recursively feeds file snippets, enforces the 20-minute prompt timeout, and records per-stage stats into `RECURSIVE-###.md` dossiers.
- Baseline benchmark harness: `node benchmark/run-tests.js` loads `benchmark/tests.config.json`, enforces 15-minute caps, timestamps stdout/stderr, and currently runs the `samples/bash` EXPLAIN generator into `samples/bash-results/`.
- Manual benchmark cycle `samples/bash-results/EXPLAIN-003.md` (depth-1 review of `shell.c → eval.c → execute_cmd.c`) is now available for reuse and includes a benchmark-specific follow-up list that feeds into the roadmap below.

## Issues & Constraints
- Persistence is local JSON only: `.miniphi/` has no pruning, encryption, or sync/export tooling yet, so long projects can grow large and data stays on-disk per machine.
- No automated tests; manual verification recommended before distribution. LM Studio server availability is assumed and not checked beforehand.
- `PythonLogSummarizer` requires a functioning Python runtime with stdlib only. Failure falls back to heuristic compression, which may degrade quality.
- Streaming parser assumes a single `<think>...</think>` block; nested/multiple reasoning sections not handled.
- CLI currently serial; parallel task decomposition, directory analyzers, and advanced compression strategies from the roadmap remain TODO.
- GPU telemetry falls back to vendor utilities; if neither `nvidia-smi` nor OS-specific probes exist, VRAM usage is marked "unknown" (still logged, but without enforcement).
- Benchmark harness presently covers only the Bash sample; additional suites (performance, regression, `.miniphi` integrity) still need to be encoded as configs/scripts.
- Prompt timeout currently hard-caps each Phi-4 interaction at 20 minutes; large recursive runs may need adaptive chunking instead of simple wall-clock cancellation.

## Next Steps
1. Layer heuristics + comment harvesting onto the new AST call-flow generator so each `shell.c::main` step includes “why” context (startup vs trap vs job-control) instead of just callee metadata.
2. Persist the `EXPLAIN-003` chunks (and future benchmarks) into a dedicated `.miniphi/benchmarks/bash/` namespace so orchestration layers can retrieve them without rescanning 5K-line files.
3. Catalog the “special” builtins (`set`, `trap`, `exec`, etc.) inside the benchmark output to document how `execute_simple_command` toggles `CMD_IGNORE_RETURN` under `set -e`.
4. Add an LM Studio `/api/v0/status` pre-flight to the benchmark harness so each run archives model availability, context size (4096 default), and health data next to its log.
5. Produce a follow-up EXPLAIN focused on `parse.y` error recovery (still depth ≤ 1) to document how `jump_to_top_level(FORCE_EOF)` influences benchmark failure cases.
6. Wire the `.miniphi/` indexes into an actual Layer 3 orchestrator: retrieval-augmented prompting, task trees, and resumable progress tracking.
7. Add structured config + profiles (JSON/YAML) so teams can predefine tasks, context budgets, GPU/offload prefs, CLI presets, and retention policies for the memory store.
8. Integrate richer summarization backends (node embeddings, semantic chunking) and expose file/directory analyzers described in `docs/miniphi-cli-implementation.md`.
9. Hardening: add smoke tests (mock LM Studio), richer error diagnostics (server unreachable, model missing), telemetry hooks for compression/token metrics, `.miniphi` health checks/pruning tools, and pre-flight REST diagnostics (list models + context) before orchestrations kick off.
10. Package as an npm bin (e.g., `miniphi`) and document LM Studio + Python prerequisites plus the new persistence workspace expectations for smoother adoption.
11. Grow the benchmark suite beyond `samples/bash` (e.g., synthetic GPU-stress cases, LM Studio failure drills) and wire log outputs back into `.miniphi/health` for consolidated observability.
