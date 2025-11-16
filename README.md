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
- **Structured prompt transcripts.** `src/libs/prompt-recorder.js` records each LM Studio exchange (MiniPhi’s main prompt plus every sub-prompt) as JSON under `.miniphi/prompt-exchanges/`, so you can audit or replay prompts one by one.
- **Prompt performance scoring.** `src/libs/prompt-performance-tracker.js` keeps a global `miniphi-prompts.db` SQLite database in the project root, auto-scores each prompt/response pair (including Phi-4-powered semantic evaluations), and snapshots the best-performing prompt compositions per workspace/objective so you can iterate on what works. Pass `--debug-lm` to log every objective + prompt as they’re graded.
- **Resource guard rails.** `src/libs/resource-monitor.js` samples RAM/CPU/VRAM usage, surfaces warnings during runs, and archives usage stats under `.miniphi/health/`.
- **Config-driven defaults.** Drop a `config.json` (copy `config.example.json`) or pass `--config`/`MINIPHI_CONFIG` to predefine the LM Studio endpoint, prompt defaults, and resource thresholds instead of repeating flags every time.
- **Prompt safety net.** Pass `--session-timeout <ms>` when running MiniPhi to cap the entire run (the remaining budget is forwarded to each Phi-4 prompt so runaway loops can’t hang the process).
- **Workspace-aware prompting.** `WorkspaceProfiler` (`src/libs/workspace-profiler.js`) inspects the current working directory (codebases, doc hubs, book-style markdown folders) and feeds that context into every Phi-4 prompt so MiniPhi knows whether to focus on code, documentation, or multi-chapter manuscripts (including outlining new chapters when asked).
- **Two entrypoints.** `node src/index.js run ...` to execute a command for you, `node src/index.js analyze-file ...` to summarize an existing log.
- **Web research snapshots.** `node src/index.js web-research "query"` fetches structured DuckDuckGo results, prints them inline, and stores the report (plus optional raw payloads) under `.miniphi/research/` for later retrieval.
- **.miniphi history notes.** `node src/index.js history-notes --label "post-upgrade"` scans `.miniphi`, records last-modified timestamps, and (when available) last git authors/commits so you can diff workspace evolution across runs.
- **Code↔markdown recomposition tests.** `node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean` converts source code into markdown files, rebuilds code from the generated docs, compares the result, and emits a per-step benchmark report.
- **Benchmark automation + analysis.** `node src/index.js benchmark recompose --directions roundtrip,code-to-markdown` drops timestamped `RUN-###.{json,log}` artifacts under `samples/benchmark/recompose/<dd-mm-yy_mm-hh>/`, accepts JSON/YAML plans via `--plan` for per-run clean/label/direction overrides, and `node src/index.js benchmark analyze <dir>` now emits `SUMMARY.{json,md,html}` so rollups can be embedded directly into docs or PRs.

### Prompt Taxonomy & Recordings
MiniPhi now distinguishes between the **main prompt** (the single prompt generated per CLI invocation) and the **sub prompts** (each LM Studio API call issued while satisfying that run). Every exchange is written to `.miniphi/prompt-exchanges/<id>.json` with a `scope` field (`"main"` or `"sub"`), the request payload, streamed reasoning, and the final response. The companion `.miniphi/prompt-exchanges/index.json` file lists the latest exchanges and their `mainPromptId`, making it easy to:
- Inspect exactly what the model received (system prompt + history) versus what it answered.
- Diff or replay a single sub prompt by launching a fresh Node process pointed at the saved JSON.
- Track iterative improvements by grouping multiple runs under the same `--prompt-id` or by referencing the auto-generated `mainPromptId`.

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

### LM Studio REST sanity check
Before running MiniPhi, you can validate that LM Studio is serving Phi-4 locally by issuing a quick curl request:

```bash
curl http://127.0.0.1:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "microsoft/phi-4-reasoning-plus",
    "messages": [
      { "role": "system", "content": "Always answer in rhymes. Today is Thursday" },
      { "role": "user", "content": "What day is it today?" }
    ],
    "temperature": 0.7,
    "max_tokens": -1,
    "stream": false
  }'
```

You should see a JSON response from LM Studio; if not, ensure the desktop app has the REST server enabled on `http://127.0.0.1:1234`.

## Installation
```bash
git clone https://github.com/cekkr/miniphi.git
cd miniphi
npm install
```
Keep `log_summarizer.py` in the project root (or provide its path with `--python-script`).

For a global install run `npm install -g .` from the project root (or `npm install -g miniphi` once it is published). That exposes the `miniphi` command so you can skip the `node src/index.js` prefix, and `npx miniphi ...` works as well for one-off invocations.

## Optional configuration file

MiniPhi searches for `miniphi.config.json` or `config.json` starting from your current directory and climbing toward the filesystem root. Override the discovery process with `--config <path>` or by setting `MINIPHI_CONFIG`/`MINIPHI_CONFIG_PATH` if you want to keep a config outside of the project tree.

Copy `config.example.json` to `config.json` and tune the keys you care about:

| Section | Purpose |
| --- | --- |
| `lmStudio.clientOptions` | Forward options (e.g., `baseUrl`, bearer tokens) to `@lmstudio/sdk` so MiniPhi knows where to reach your LM Studio server. |
| `lmStudio.prompt` | Override the Phi-4 system prompt or set `timeoutMs` for each generated prompt. |
| `defaults` | Predefine `task`, `contextLength`, `gpu`, `timeout`, `summaryLevels`, `chunkSize`, `sessionTimeout`, or a persisted `promptId`. Missing values fall back to the CLI defaults listed below. |
| `resourceMonitor` | Set default `maxMemoryPercent`, `maxCpuPercent`, `maxVramPercent`, and `sampleIntervalMs` thresholds for the resource guard rails. |
| `pythonScript` | Point to a custom `log_summarizer.py` location instead of relying on the project root copy. |

Every field is optional; MiniPhi merges the config with CLI flags with CLI flags taking precedence.

## Running the CLI
If you installed MiniPhi globally (`npm install -g .` or `npm install -g miniphi`) or you prefer `npx`, replace `node src/index.js` with `miniphi` in the examples below (`miniphi run ...`, `miniphi analyze-file ...`).

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
| `--prompt-id <id>` | Attach/continue a prompt session so you can resume the same Phi-4 conversation across commands. |
| `--session-timeout <ms>` | Hard limit for the entire MiniPhi run; remaining time is enforced per Phi-4 prompt. |
| `--debug-lm` | Print each objective + prompt instrumented by the prompt scoring system (and verify writes to `miniphi-prompts.db`). |
| `--verbose` | Print capture progress and reasoning blocks to the console. |

### Capture quick web research
```bash
node src/index.js web-research "phi-4 reasoning roadmap" --max-results 5
```
- Uses DuckDuckGo’s Instant Answer API to grab quick snippets + URLs, prints them to the console, and stores the JSON snapshot under `.miniphi/research/`.
- Pass `--query-file queries.txt` for newline-delimited batch queries, `--note` to annotate the snapshot, and `--no-save` if you just want the console output.

### Snapshot .miniphi history
```bash
node src/index.js history-notes --label "post-benchmark" --no-git
```
- Walks the `.miniphi` directory, records file sizes + last-modified timestamps, and (when available) attaches the latest git commit/author touching each file.
- Outputs both JSON and Markdown summaries inside `.miniphi/history-notes/`, making it easy to diff MiniPhi’s internal state between runs.

### Benchmark code ↔ markdown recomposition
```bash
node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean
```
- Step 1 converts the files under `code/` into markdown sheets (with front matter + fenced code blocks) inside the sample’s `descriptions/` folder.
- Step 2 rebuilds code from each markdown file into `reconstructed/`, then Step 3 compares the reconstructed files against the originals.
- Every run writes a `recompose-report.json` summary (counts, timings, mismatch stats) so you can diff code→markdown→code fidelity over time.

### Prompt sessions & process-level timeouts
- **Prompt sessions.** Supply `--prompt-id my-bash-audit` to persist Phi-4 chat history under `.miniphi/prompt-sessions/my-bash-audit.json`. Subsequent `run`/`analyze-file` invocations with the same ID pick up right where the previous reasoning left off, enabling step-by-step analysis across different Node.js scripts or terminals.
- **Session timeout.** Use `--session-timeout 1200000` (20 minutes in ms) when you want MiniPhi to abort the entire run if it takes too long. The remaining budget is calculated before every Phi-4 call, so long shell commands or recursive prompt batches can’t hang forever, yet you keep full control by leaving the flag unset.

### Prompt performance scoring
- Every Phi-4 prompt (main + sub) is mirrored into a project-level SQLite database (`miniphi-prompts.db`) managed by `PromptPerformanceTracker`. Each row stores the objective, workspace fingerprint, score, follow-up likelihood, and serialized evaluation metadata so you can mine high-performing prompt structures across repos.
- A dedicated Phi-4 scoring prompt (`prompt-scoring` scope) grades how well the assistant response satisfied the stated objective, whether multi-step follow-ups are required, and which prompt patterns/tags describe the interaction. When Phi-4 is unavailable, MiniPhi falls back to heuristics but still records summaries.
- `best_prompt_snapshots` consolidates each workspace/objective combination into a JSON blob (rolling averages, best prompt text, follow-up rate, and any recommended series strategy) so other tooling can query the DB without replaying every exchange.
- Pass `--debug-lm` to dump the current objective + prompt text to stdout as soon as it is queued for scoring, making it easy to correlate console logs with DB rows.

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

## Writing-Focused Workspaces
- MiniPhi now inspects the working directory before prompting Phi-4. When it finds a documentation-centric or book-style folder (multiple markdown chapters, `preface.md`, etc.) it injects a summary of that structure into the prompt so the model has a global view of the manuscript.
- Ask MiniPhi to “improve Chapter 3” or “draft a new appendix” inside such a workspace and the agent will reference the detected chapters, suggest cross-chapter edits, and generate new sections without assuming it is editing source code.
- Mixed repositories (code + docs) still get profiled, so the agent knows when to operate on code and when the task is strictly editorial.

## Hidden `.miniphi` Workspace
- MiniPhi now maintains a hidden `.miniphi/` directory at the nearest project root (or reuses an existing one if you invoke the CLI from a subfolder). Every execution creates an `executions/<id>/` archive with `execution.json`, `prompt.json`, `analysis.json`, `compression.json`, and chunked `segments/segment-###.json` files so you can rehydrate any prompt without rerunning the command.
- Global memory lives in JSON ledgers: `prompts.json` (prompt history + hashes), `knowledge.json` (condensed insights), and `todo.json` (auto-extracted next steps). Each file is mirrored by a recursive index under `indices/` for faster lookups.
- `health/resource-usage.json` keeps the last 50 resource-monitor snapshots (averages plus the final samples) so it is easy to correlate Phi work with system strain.
- `index.json` at the root links the entire structure so other tooling can crawl memory without guessing file names.
- `prompt-sessions/<id>.json` stores the serialized Phi-4 chat history for every `--prompt-id`, making it easy to resume or inspect a multi-stage reasoning thread.
- Use `--verbose` to see where the run was archived (path is relative to your current shell). The data is plain JSON, so you can feed it into future orchestration layers or external dashboards.

## Benchmark Harness & Samples
- `node benchmark/run-tests.js` runs repeatable sample/benchmark suites (defined in `benchmark/tests.config.json`) with hardened logging: every line is timestamped and flushed into `benchmark/logs/<test-name>/<ISO>.log`, and each test inherits the 15-minute safety timeout described in `WHY_SAMPLES.md`.
- `benchmark/scripts/bash-flow-explain.js` now uses `web-tree-sitter` (plus a macro-aware fallback) to traverse `samples/bash` up to depth 1, expand the `shell.c::main → reader_loop → execute_command_internal` flow in execution order, and emit `samples/benchmark/bash/<dd-mm-yy_mm-hh>/EXPLAIN-###.md` call-walk reports for reuse by the orchestrator.
- `benchmark/scripts/bash-recursive-prompts.js` loads Phi-4 via LM Studio, builds a depth-1 directory tree, recursively feeds file snippets to the model, records per-stage stats (prompt/response size + duration), and writes AI-style dossiers under `samples/benchmark/bash/<dd-mm-yy_mm-hh>/RECURSIVE-###.md` (mirrored into `.miniphi/benchmarks/bash/`).
- The latest manual pass, `samples/benchmark/bash/14-11-25_38-05/EXPLAIN-003.md`, drills into `shell.c → eval.c → execute_cmd.c`, documents how `main` hands off to `reader_loop`/`execute_simple_command`, and ends with a benchmark-specific “Next Steps” list that is now mirrored in `AI_REFERENCE.md`.
- `npm run benchmark:windows` wraps `benchmark/run-tests.js` and then feeds the freshest `EXPLAIN-###.md` into `node src/index.js analyze-file` using the stored Windows prompt preset (`docs/prompts/windows-benchmark-default.md`), so you get a “realtime implementation + next steps” summary without retyping the task each run.
- Pass specific test names (e.g. `node benchmark/run-tests.js samples-bash-explain`) or use `--list` to discover suites; add future tests to `benchmark/tests.config.json` to get logging + resource tracking for free.

## Documentation Map
- `AI_REFERENCE.md` - short status update plus near-term roadmap.
- `docs/NodeJS LM Studio API Integration.md` - detailed research on using the LM Studio SDK vs REST APIs.
- `docs/APIs/REST API v0 _ LM Studio Docs.html` - offline copy of LM Studio's native REST API reference used by `LMStudioRestClient`.
- `docs/miniphi-cli-implementation.md` - CLI behavior, compression algorithms, and example pipelines.
- `src/libs/miniphi-memory.js` - `.miniphi` directory manager (execution archives, indexes, persistent TODOs).
- `log_summarizer.py` - Python reference implementation for recursive hierarchical summaries.
- `docs/os-defaults/windows.md` - canonical LM Studio + CLI defaults for the Windows helper workflow (ports, models, helper commands).
- `docs/prompts/windows-benchmark-default.md` - reusable prompt preset consumed by `npm run benchmark:windows`.

## Current Status & Next Steps
Per `AI_REFERENCE.md`:
- OK Layered LM Studio stack (`LMStudioManager`, `Phi4Handler`, `EfficientLogAnalyzer`) is functional with streaming Phi-4 responses.
- OK Hidden `.miniphi/` memory + indexes capture every execution, prompt, and auto-derived TODO across local runs.
- WARNING No automated tests; rely on manual verification when changing compression heuristics or Phi prompts.
- UNDER CONSTRUCTION Next milestones: hook the persisted memory into multi-task orchestration, add structured config profiles, richer summarization backends, CLI packaging (`npm bin`), and better error diagnostics/telemetry (plus retention policies for the `.miniphi` store).

## License
MiniPhi is released under the ISC License (`LICENSE`).
