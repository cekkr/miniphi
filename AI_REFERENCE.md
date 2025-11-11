# After a prompt
- Update AI_REFERENCE.md references and next step.
- Update README.md with updated documentation for humans.

# MiniPhi Reference

## Current Status
- Layered LM Studio stack is live: `LMStudioManager` (JIT loading), `Phi4Handler` (reasoning-aware streaming) and `EfficientLogAnalyzer` (compression + Phi-4 orchestration) sit under `src/`.
- Cross-platform command runner (`CliExecutor`), streaming file utilities, and Python-backed summarizer script (`log_summarizer.py`) enable analysis of arbitrarily large logs/CLI outputs.
- `src/index.js` exposes two modes: `run` (execute + analyze a command) and `analyze-file` (summarize existing logs). Both automatically stream Phi-4 solutions unless `--no-stream` is provided.
- Default workflow: `node src/index.js run --cmd "npm test" --task "Analyze failures"` -> auto execute, compress, and reason using Phi-4 (requires LM Studio server + Phi-4 reasoning-plus downloaded).
- Python dependency: CLI auto-detects `python3`, `python`, or `py`; override path via `--python-script`. Summaries live under project root.
- Hidden `.miniphi/` workspace (managed by `MiniPhiMemory`) snapshots every execution: prompts, compression chunks, analysis, recursive indexes, and auto-extracted TODO lists for future orchestration reuse.

## Issues & Constraints
- Persistence is local JSON only: `.miniphi/` has no pruning, encryption, or sync/export tooling yet, so long projects can grow large and data stays on-disk per machine.
- No automated tests; manual verification recommended before distribution. LM Studio server availability is assumed and not checked beforehand.
- `PythonLogSummarizer` requires a functioning Python runtime with stdlib only. Failure falls back to heuristic compression, which may degrade quality.
- Streaming parser assumes a single `<think>...</think>` block; nested/multiple reasoning sections not handled.
- CLI currently serial; parallel task decomposition, directory analyzers, and advanced compression strategies from the roadmap remain TODO.

## Next Steps
1. Wire the `.miniphi/` indexes into an actual Layer 3 orchestrator: retrieval-augmented prompting, task trees, and resumable progress tracking.
2. Add structured config + profiles (JSON/YAML) so teams can predefine tasks, context budgets, GPU/offload prefs, CLI presets, and retention policies for the memory store.
3. Integrate richer summarization backends (node embeddings, semantic chunking) and expose file/directory analyzers described in `docs/miniphi-cli-implementation.md`.
4. Hardening: add smoke tests (mock LM Studio), richer error diagnostics (server unreachable, model missing), telemetry hooks for compression/token metrics, and `.miniphi` health checks/pruning tools.
5. Package as an npm bin (e.g., `miniphi`) and document LM Studio + Python prerequisites plus the new persistence workspace expectations for smoother adoption.
