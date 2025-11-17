# MiniPhi

> Local, Phi-4-powered command and log analysis that compresses everything before it thinks.

MiniPhi squeezes CLI transcripts, benchmark dossiers, and raw text logs into small reasoning-ready chunks and hands them to LM Studio's `microsoft/phi-4-reasoning-plus` model. The CLI streams the model's `<think>` reasoning, publishes structured summaries, snapshots everything under `.miniphi/`, and keeps a receipt so the next investigation can pick up where you left off.

## Why MiniPhi exists
- You can run scary commands (`npm test`, data migrations, synthetic benchmarks) and let Phi-4 triage the output without pasting it into a remote service.
- Giant logs stay useful because a Python summarizer and a JS compressor shave them down before Phi starts thinking.
- MiniPhi keeps a scrapbook of every prompt, response, benchmark run, and research sweep, which means you never lose context across sessions.
- Every Phi-4 prompt now declares an explicit JSON schema so responses can be replayed or diffed reliably inside large workspaces.

## What ships today
- **Layered LM Studio stack.** `LMStudioManager` handles model lifecycles, `Phi4Handler` enforces reasoning-plus formatting, and `EfficientLogAnalyzer` builds Phi-ready context from streamed command output or saved files.
- **Command + file workflows.** `node src/index.js run` executes any shell command, `analyze-file` replays logs, `web-research` hits DuckDuckGo's Instant Answer API, and `history-notes` records `.miniphi` drift.
- **Recursive compression.** `log_summarizer.py` (Python stdlib only) cooperates with the JS heuristics to chunk hundreds of thousands of lines into <1K token storyboards.
- **Coprocessor utilities.** `WorkspaceProfiler`, `PromptRecorder`, `PromptPerformanceTracker`, `PromptDecomposer`, and `MiniPhiMemory` keep workspace hints, prompt transcripts, scoring data (`miniphi-prompts.db`), JSON schema declarations, and TODO queues in sync.
- **Resource guard rails.** `ResourceMonitor` samples CPU, RAM, and VRAM; warnings are captured in `.miniphi/health/` so you can spot a runaway command.
- **Benchmarks + recomposition.** The `recompose` command and benchmark helpers (`samples/recompose/hello-flow`, `benchmark/`) capture Phi-4 conversations, emit JSON/Markdown summaries, and can be swept/analyzed via `benchmark recompose|analyze|plan scaffold`.
- **Prompt logs as artifacts.** `RecomposeTester.exportPromptLog` mirrors per-run transcripts next to their JSON reports so reviewers can inspect the exact reasoning trace without spelunking the hidden workspace.

MiniPhi currently targets macOS, Windows, and Linux and expects LM Studio to be reachable at `http://127.0.0.1:1234`. The defaults assume the `microsoft/phi-4-reasoning-plus` model is already downloaded in LM Studio.

## Architecture snapshot
1. **LMStudioManager** (src/libs/lmstudio-api.js) performs JIT model loading and surfaces the `/api/v0` REST primitives (list models, chat/completion probes, embeddings, runtime stats).
2. **Phi4Handler** (src/libs/lms-phi4.js) wraps LM Studio calls, enforces reasoning streams, wires `--session-timeout`, and declares the JSON schema that each downstream Phi-4 call must respect.
3. **EfficientLogAnalyzer + PythonLogSummarizer** compress streamed stdout/stderr or files by chunk, annotate the segments, and feed the high-signal slices to Phi-4.
4. **MiniPhiMemory + PromptRecorder** archive prompts, compressed context, responses, TODOs, scoring metadata, and recursive indexes under `.miniphi/` so future runs can rehydrate any exchange.
5. **WorkspaceProfiler + FileConnectionAnalyzer** scan the repository tree ahead of a run so each prompt is prefixed with facts about the code, docs, or book-style folders you are touching.
6. **PromptPerformanceTracker** scores every prompt/response pair inside `miniphi-prompts.db` (SQLite), clusters high-performing prompt patterns, and exposes them to future runs.

## Quickstart
### Requirements
- Node.js 20.x or newer (ESM + top-level `await` support)
- Python 3.9+ on PATH (std lib only; used by `log_summarizer.py`)
- LM Studio desktop app with the `microsoft/phi-4-reasoning-plus` model downloaded
- git (optional but enables `.miniphi` history annotations)

### Install and prepare
```bash
npm install
# (optional) copy and edit defaults
cp config.example.json config.json
```

1. Launch LM Studio and start the local server (default `http://127.0.0.1:1234`).
2. (Optional) Tailor `config.json` to set the model endpoint, prompt defaults, GPU mode, or resource monitor thresholds.

### First run
```bash
node src/index.js run --cmd "npm test" --task "Analyze why the tests fail"
```
- MiniPhi executes the command in your working directory, compresses the live output, streams Phi-4 reasoning, and drops `executions/<id>/` metadata under `.miniphi/`.
- Use `--cwd <path>` to run the command elsewhere or `--no-stream` to buffer the Phi output.

### Analyze an existing log
```bash
node src/index.js analyze-file --file ./logs/output.log --task "Summarize the recurring crash"
```
- Logs are chunked (`--chunk-size 2000` default), summarized recursively (`--summary-levels 3` default), and the resulting prompt transcript lands in `.miniphi/prompt-exchanges/`.

## Command tour
- `run` executes a command and streams reasoning. Key flags: `--cmd`, `--task`, `--cwd`, `--timeout`, `--session-timeout`, `--prompt-id`, `--python-script`, `--summary-levels`, `--context-length`, and the resource monitor thresholds (`--max-memory-percent`, `--max-cpu-percent`, `--max-vram-percent`, `--resource-sample-interval`).
- `analyze-file` summarizes an existing file. Flags mirror `run` but swap `--cmd` for `--file`.
- `web-research` performs DuckDuckGo Instant Answer lookups. Use positional queries or `--query`, set `--max-results`, `--provider`, `--include-raw`, `--no-save`, and optional `--note`. Results live under `.miniphi/research/`.
- `history-notes` snapshots `.miniphi/` and optionally attaches git metadata. Use `--label`, `--history-root`, and `--no-git`.
- `recompose` operates on `samples/recompose` projects. Flags: `--sample`, `--direction code-to-markdown|markdown-to-code|roundtrip`, `--code-dir`, `--descriptions-dir`, `--output-dir`, `--clean`, `--report`, and `--resume-descriptions`.
- `benchmark recompose` automates timestamped runs (default sample `samples/recompose/hello-flow`). Mix in `--directions`, `--repeat`, `--run-prefix`, `--timestamp`, `--clean`, `--resume-descriptions`, or `--sample`.
- `benchmark analyze` reads `RUN-###.json` files, emits `SUMMARY.json|md|html`, and supports `--path` or positional directories plus repeated `--compare` flags to diff baselines vs candidates.
- `benchmark plan scaffold` inspects a sample (default `hello-flow`) and prints a commented YAML template; use `--sample`, `--benchmark-root`, and `--output` to persist it.

Every command accepts `--config <path>` (falls back to searching upward for `config.json`) and `--verbose` for progress logs. `--debug-lm` prints every objective + prompt as the prompt scoring database runs.

## Frequently used flags
- `--task` describes what Phi-4 should do with the log or command output. If omitted, it defaults to `"Provide a precise technical analysis"` from `config.example.json`.
- `--prompt-id <id>` or `--config defaults.promptId` let you resume a chat session; transcripts are written to `.miniphi/prompt-sessions/<id>.json`.
- `--python-script <path>` overrides the bundled `log_summarizer.py` (MiniPhi will auto-detect `python3`, `python`, or `py`).
- `--session-timeout <ms>` hard-stops the orchestration; Phi-4 receives the remaining budget with each prompt so runaway loops cannot hang the CLI.
- `--no-summary` skips the JSON footer if another system is reading stdout.
- `MINIPHI_CONFIG=/path/config.json` is honored if you prefer environment variables over flags.

## Hidden `.miniphi` workspace
MiniPhi always writes to the nearest `.miniphi/` directory (creating one if it does not exist):
- `executions/<id>/` contains `execution.json`, `prompt.json`, `analysis.json`, compression chunks, and any generated log segments.
- `prompt-exchanges/` captures every Phi-4 request, including decompositions (`prompt-exchanges/decompositions/`) and sub-prompts, as JSON.
- `research/`, `history-notes/`, and `benchmarks/` collect the outputs from their corresponding commands.
- `knowledge.json`, `todo.json`, and `prompts.json` retain condensed insights, future work items, and prompt hashes; recursive indexes live in `.miniphi/indices/` for faster lookups.
- `health/resource-usage.json` stores the last 50 resource-monitor snapshots, and `.miniphi/history/benchmarks.json` mirrors benchmark rollups.

All of these artifacts are plain text so you can sync them to your own dashboards or feed them into future orchestrators.

## Documentation and samples
- `AI_REFERENCE.md` holds the current status snapshot plus the near-term roadmap.
- `docs/NodeJS LM Studio API Integration.md` explains how the LM Studio SDK and REST layers fit together.
- `docs/miniphi-cli-implementation.md` walks through compression heuristics, pipelines, and architectural decisions.
- `docs/APIs/REST API v0 _ LM Studio Docs.html` is the offline reference consumed by `LMStudioRestClient`.
- `docs/os-defaults/windows.md` and `docs/prompts/windows-benchmark-default.md` document the Windows helper workflow.
- `docs/todo/author.md` tracks authoring tasks that still need human review.
- `samples/recompose/hello-flow` plus `samples/benchmark/` contain the recomposition harness and reference plans described in `WHY_SAMPLES.md`.

## Project status
- Ready: layered LM Studio stack (`LMStudioManager`, `Phi4Handler`, `EfficientLogAnalyzer`) is production ready with reasoning streaming, JSON schema guards, and prompt scoring.
- Ready: `.miniphi` memory, prompt transcripts, and research or history snapshots are stable across commands.
- Warning: there are no automated tests yet, so manual verification is still required whenever compression heuristics or Phi prompts change.
- In progress: packaging (`npm bin` publish), richer summarization backends, better telemetry, and retention policies for `.miniphi` artifacts are still underway.
- Next up: upcoming work focuses on runtime improvements (prompt orchestration, analyzers, LM Studio clients) rather than tweaking benchmark scripts; the `benchmark analyze` and `plan scaffold` tools already cover reporting needs.

## License
MiniPhi is released under the ISC License. See `LICENSE` for the legal text.
