# MiniPhi

> Local, Phi-4-powered command and log analysis that compresses everything before it thinks.

MiniPhi is a layered Node.js toolchain that drives LM Studio's `microsoft/Phi-4-reasoning-plus` model to run CLI commands, capture gigantic outputs, compress them aggressively (Python- and JS-assisted), and feed Phi-4 reasoning streams back to you in real time. The project grew out of the research documented in `AI_REFERENCE.md` and the design paper `docs/NodeJS LM Studio API Integration.md`, and its code lives under `src/`.

## Highlights
- **JIT model logistics.** `src/libs/lmstudio-api.js` keeps LM Studio models hot-loaded with exact context/gpu settings.
- **Native REST diagnostics.** `LMStudioRestClient` (same module) speaks LM Studio's `/api/v0` endpoints (see `docs/APIs/REST API v0 _ LM Studio Docs.html`) so we can sanity-check the local server at `http://127.0.0.1:1234`, inspect model metadata (default `microsoft/phi-4-reasoning-plus`, 4096-token baseline), and run lightweight chat/completion/embedding probes outside the SDK.
- **Reasoning-aware streaming.** `src/libs/lms-phi4.js` enforces the Phi "<think>...</think> + solution" format and can stream both reasoning and answers.
- **Lossy-but-smart compression.** JavaScript heuristics plus `log_summarizer.py` (Python stdlib only) reduce hundreds of thousands of lines to ~1K tokens.
- **Cross-platform CLI execution.** `src/libs/cli-executor.js` normalizes shells on Windows/macOS/Linux and streams stdout/stderr.
- **Persistent command memory.** Every run drops prompts, compressed context, analysis, and follow-up TODOs into a hidden `.miniphi/` workspace for later retrieval.
- **Resource guard rails.** `src/libs/resource-monitor.js` samples RAM/CPU/VRAM usage, surfaces warnings during runs, and archives usage stats under `.miniphi/health/`.
- **Two entrypoints.** `node src/index.js run ...` to execute a command for you, `node src/index.js analyze-file ...` to summarize an existing log.

## Architecture at a Glance
| Layer | File(s) | Purpose |
| --- | --- | --- |
| Layer 1 - LMStudioManager | `src/libs/lmstudio-api.js` | Load/eject LM Studio models with cached configs, enforce context/gpu budgets. |
| Layer 2 - Phi4Handler | `src/libs/lms-phi4.js`, `src/libs/phi4-stream-parser.js` | Maintain Phi system prompt, trim history to fit the window, split `<think>` and solution tokens while streaming. |
| Layer 2.5 - Compression Stack | `src/libs/efficient-log-analyzer.js`, `src/libs/python-log-summarizer.js`, `log_summarizer.py`, `src/libs/stream-analyzer.js` | Capture stdout/stderr incrementally, apply heuristics or recursive Python summaries, construct the final Phi prompt. |
| Layer 3 - CLI Orchestration (in progress) | CLI planning is outlined in `docs/miniphi-cli-implementation.md` and `AI_REFERENCE.md` | Future work: multi-task orchestration, memory consolidation, config profiles. |
| Layer 3 - Memory & Indexes | `src/libs/miniphi-memory.js`, `.miniphi/` | Hidden working directory containing executions, knowledge snapshots, TODO queues, and recursive JSON indexes. |

For the deeper architectural rationale (REST vs SDKs, LM Studio lifecycle, compression strategies) see `docs/NodeJS LM Studio API Integration.md` and `docs/miniphi-cli-implementation.md`.

## Requirements
1. **Node.js 18+** (ES modules, async iteration).
2. **LM Studio desktop app** with the server running and `microsoft/Phi-4-reasoning-plus` downloaded. MiniPhi uses the official `@lmstudio/sdk`, but also hits the native REST API snapshot under `http://127.0.0.1:1234` for diagnostics (changing context length still requires a model reload; the server defaults to 4096 tokens until you do).
3. **Python 3.9+** available as `python`, `py`, or `python3` for `log_summarizer.py`. Override via `--python-script` when needed.
4. Adequate local VRAM/system RAM-MiniPhi defaults to a 32K context window (`--context-length` to change).

## Installation
```bash
git clone https://github.com/cekkr/miniphi.git
cd miniphi
npm install
```
Keep `log_summarizer.py` in the project root (or provide its path with `--python-script`).

## Running the CLI

### Execute and analyze a command
```bash
node src/index.js run --cmd "npm test" --task "Analyze failures and propose fixes"
```
- Streams stdout/stderr, recursively compresses the transcript, then streams Phi-4's reasoning and solution.
- Use `--cwd` to change the execution directory and `--timeout <ms>` for long-running tasks.
- Disable live model output with `--no-stream` and skip the JSON footer with `--no-summary`.

### Analyze an existing log file
```bash
node src/index.js analyze-file --file ./logs/build.log --task "Summarize build issues"
```
- Processes the file chunk-by-chunk (default 2,000 lines) via `StreamAnalyzer`, summarizes each chunk with Python, and hands the merged digest to Phi-4.
- Control chunk sizing via `--chunk-size <lines>` and summarization depth via `--summary-levels <n>`.

### Frequently used options
| Flag | Description |
| --- | --- |
| `--context-length <tokens>` | Override the Phi-4 context (default 32768). |
| `--gpu <mode>` | Forward GPU config to LM Studio (`auto`, `cpu`, `cuda:0`, etc.). |
| `--summary-levels <n>` | Depth of recursive summarization (default 3). |
| `--python-script <path>` | Custom path to `log_summarizer.py`. |
| `--max-memory-percent <n>` / `--max-cpu-percent <n>` / `--max-vram-percent <n>` | Emit warnings and archive stats when the given limit is exceeded. |
| `--resource-sample-interval <ms>` | Change the sampling cadence for the resource monitor (default 5s). |
| `--verbose` | Print capture progress and reasoning blocks to the console. |

### Resource monitoring
- Every `run`/`analyze-file` session bootstraps `ResourceMonitor`, which samples system RAM, CPU, and VRAM using the best strategy available for your OS (`nvidia-smi`, PowerShell CIM, or `system_profiler`).
- Breaching a threshold surfaces `[MiniPhi][Resources]` warnings and appends the session to `.miniphi/health/resource-usage.json`, giving you per-run statistics (min/avg/max) plus the last 20 samples for trend analysis.
- Tune limits with the `--max-*-percent` flags or disable background sampling by setting a large `--resource-sample-interval`.

## Example Workflow
1. Start LM Studio, load/download Phi-4 reasoning-plus, and enable the local server.
2. From your repo, run `node src/index.js run --cmd "npm run lint" --task "Explain any lint errors"` with `--verbose`.
3. Watch MiniPhi stream lint output, see Python compression status, and observe Phi's `<think>` reasoning block (only when verbose).
4. Copy the streamed solution or inspect the JSON footer to log compression stats (`linesAnalyzed`, `compressedTokens`).
5. Repeat with `analyze-file` for build logs, test snapshots, or any text artifact.

## Hidden `.miniphi` Workspace
- MiniPhi now maintains a hidden `.miniphi/` directory at the nearest project root (or reuses an existing one if you invoke the CLI from a subfolder). Every execution creates an `executions/<id>/` archive with `execution.json`, `prompt.json`, `analysis.json`, `compression.json`, and chunked `segments/segment-###.json` files so you can rehydrate any prompt without rerunning the command.
- Global memory lives in JSON ledgers: `prompts.json` (prompt history + hashes), `knowledge.json` (condensed insights), and `todo.json` (auto-extracted next steps). Each file is mirrored by a recursive index under `indices/` for faster lookups.
- `health/resource-usage.json` keeps the last 50 resource-monitor snapshots (averages plus the final samples) so it is easy to correlate Phi work with system strain.
- `index.json` at the root links the entire structure so other tooling can crawl memory without guessing file names.
- Use `--verbose` to see where the run was archived (path is relative to your current shell). The data is plain JSON, so you can feed it into future orchestration layers or external dashboards.

## Benchmark Harness & Samples
- `node benchmark/run-tests.js` runs repeatable sample/benchmark suites (defined in `benchmark/tests.config.json`) with hardened logging: every line is timestamped and flushed into `benchmark/logs/<test-name>/<ISO>.log`, and each test inherits the 15-minute safety timeout described in `WHY_SAMPLES.md`.
- `benchmark/scripts/bash-flow-explain.js` is the first automated sample: it traverses `samples/bash` up to depth 1, builds a `main`-anchored call graph, and writes `samples/bash-results/EXPLAIN-###.md` files for later AI-assisted analysis.
- Pass specific test names (e.g. `node benchmark/run-tests.js samples-bash-explain`) or use `--list` to discover suites; add future tests to `benchmark/tests.config.json` to get logging + resource tracking for free.

## Documentation Map
- `AI_REFERENCE.md` - short status update plus near-term roadmap.
- `docs/NodeJS LM Studio API Integration.md` - detailed research on using the LM Studio SDK vs REST APIs.
- `docs/APIs/REST API v0 _ LM Studio Docs.html` - offline copy of LM Studio's native REST API reference used by `LMStudioRestClient`.
- `docs/miniphi-cli-implementation.md` - CLI behavior, compression algorithms, and example pipelines.
- `src/libs/miniphi-memory.js` - `.miniphi` directory manager (execution archives, indexes, persistent TODOs).
- `log_summarizer.py` - Python reference implementation for recursive hierarchical summaries.

## Current Status & Next Steps
Per `AI_REFERENCE.md`:
- OK Layered LM Studio stack (`LMStudioManager`, `Phi4Handler`, `EfficientLogAnalyzer`) is functional with streaming Phi-4 responses.
- OK Hidden `.miniphi/` memory + indexes capture every execution, prompt, and auto-derived TODO across local runs.
- WARNING No automated tests; rely on manual verification when changing compression heuristics or Phi prompts.
- UNDER CONSTRUCTION Next milestones: hook the persisted memory into multi-task orchestration, add structured config profiles, richer summarization backends, CLI packaging (`npm bin`), and better error diagnostics/telemetry (plus retention policies for the `.miniphi` store).

## License
MiniPhi is released under the ISC License (`LICENSE`).
