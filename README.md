# miniPhi

> Local, LM Studio-based (and Phi-4-powered) command and log analysis that compresses everything before it thinks. And execute commands. And edits things. In short, like Codex, but locally.

![miniPhi](https://github.com/cekkr/miniphi/blob/main/md-assets/miniphi-logo.jpg?raw=true)

miniPhi squeezes CLI transcripts, benchmark dossiers, and raw text logs into small reasoning-ready chunks and hands them to LM Studio's `microsoft/phi-4-reasoning-plus` model. The CLI streams the model's `<think>` reasoning, publishes structured summaries, snapshots everything under `.miniphi/`, and keeps a receipt so the next investigation can pick up where you left off.

## Why miniPhi exists
- You can run scary commands (summarizations, implementations, data migrations, synthetic benchmarks, `npm benchmark:windows`) and let Phi-4 triage the output without pasting it into a remote service.
- Giant logs stay useful because a Python summarizer and a JS compressor shave them down before Phi starts thinking.
- miniPhi keeps a scrapbook of every prompt, response, benchmark run, and research sweep, which means you never lose context across sessions.
- Every Phi-4 prompt now declares an explicit JSON schema so responses can be replayed or diffed reliably inside large workspaces.
- Workspace capabilities (package scripts, repo scripts, `.bin` tools) and import graphs are summarized ahead of each run so Phi starts with an accurate list of available operations and dependencies.

## Get started
Install [LM Studio](https://lmstudio.ai) as developer and download model `microsoft/phi-4-reasoning-plus` (through Settings icon on the bottom-right corner of main window). Then start the APIs server through the Console icon on the vertical bar on the left.

Clone miniPhi repo:
> $ `git clone https://github.com/cekkr/miniphi.git --recurive-submodules`

(Submodules are useful only for development and benchmark purposes)

Install submodules, using `-g` flag if you want `miniphi` command available on PATH.
> $ `npm install -g`

This project is in a alpha stage of development, and technically it's able to execute terminal commands (at the current version, without asking permissions). Be careful.

> $ `cd my-project/`  
> $ `miniphi --task "Create the README.md of the current project"`

## Workspace-first prompts
- `node src/index.js workspace --task "Plan README refresh"` scans the current working directory, summarizes capabilities, and saves a recursive outline without executing arbitrary shell commands.
- Running `npx miniphi "Audit the docs structure" --verbose` (or `miniphi "…"` when installed globally) now triggers the same workflow: when the CLI does not recognize the first argument as a command it treats the free-form text as the task and assumes the CWD is the project root.
- Workspace summaries combine `WorkspaceProfiler`, `CapabilityInventory`, and `ApiNavigator` hints so Phi-4 starts with concrete file paths, package scripts, and helper suggestions before editing anything.
- Use this mode whenever you want MiniPhi to propose edits (README rewrites, code tweaks, task plans) grounded in the current repo before running `miniphi run --cmd ...`.
- Append `@"path/to/file.js"` (quotes optional) anywhere in your prompt to pin that file as a fixed reference—the CLI resolves the file relative to the current directory, hashes the contents, stores the snapshot under `.miniphi/prompt-exchanges/fixed-references/`, and injects a summary of the file into every downstream Phi-4 prompt for deterministic reasoning.

## Command authorization & shared memory
- Every run now consults a shared home-level store at `~/.miniphi/` for prompt telemetry, performance data, system profiles, and operator preferences. `miniphi-prompts.db` was relocated there so the scoring database survives across projects.
- Commands are gated by the new `CommandAuthorizationManager`; choose `--command-policy ask|session|allow|deny` (default: `ask`) and opt into `--assume-yes` when you want to auto-approve prompts in non-interactive shells. Use `--command-danger <low|mid|high>` to describe how risky your `--cmd` invocation is so navigator follow-ups inherit the right defaults.
- Navigation prompts returned by `ApiNavigator` now include per-command `danger` fields, so MiniPhi only interrupts you when a potentially destructive command is queued.
- Direct file references and command policies are persisted inside `.miniphi/prompt-exchanges/fixed-references/` (project scope) and `~/.miniphi/preferences/command-policy.json` (global scope) so reruns can replay the exact same context even if the workspace changed in between.

## Fundamentals
- **Narrative-only recomposition inputs.** Storytelling folders inside `samples/recompose/*/descriptions` benchmarks stay prose-only so recomposition prompts must reason instead of copy/pasting code; `hello-flow` enforces those rules in its README. This is an example of multi-passage concept extrapolation without code snippets, priority ordering e back conversion to code, confronting practical results.
- **Multi-prompt orchestration.** miniPhi expands every command into a workspace scan, plan, and targeted edits, then saves the prompt trees and transcripts under `.miniphi/` so interrupted runs can resume mid-branch.
- **JSON schema enforcement.** Each Phi-4 prompt references a schema from `docs/prompts/*.schema.json`, validation happens before responses enter history storage, and schema IDs stay attached for deterministic replays.

## What ships today
- **Layered LM Studio runtime.** `LMStudioManager` performs JIT model loading and `/api/v0` diagnostics, `Phi4Handler` streams reasoning while enforcing JSON schema contracts, and `EfficientLogAnalyzer` + `PythonLogSummarizer` compress live command output or saved files before Phi-4 thinks.
- **CLI entrypoints + default workflow.** `node src/index.js run --cmd "npm test" --task "Analyze failures"` is the canonical loop, while `analyze-file`, `web-research`, `history-notes`, `recompose`, and `benchmark recompose|analyze|plan scaffold` cover file replay, research snapshots, `.miniphi` audits, recomposition, and benchmark sweeps.
- **Persistent `.miniphi/` workspace.** `miniPhiMemory` snapshots each run under `executions/<id>/`, stores `prompt.json`, `analysis.json`, helper scripts, TODO queues, and mirrors every sub-prompt as JSON inside `.miniphi/prompt-exchanges/` and `.miniphi/helpers/`.
- **Schema registry + enforcement.** `PromptSchemaRegistry` injects schema blocks from `docs/prompts/*.schema.json` into every Phi-4 call (main prompts, scoring prompts, decomposers) and rejects invalid responses before they touch history storage.
- **Workspace context analyzers.** `WorkspaceProfiler`, `FileConnectionAnalyzer`, and `CapabilityInventory` scan the repository, render ASCII connection graphs, capture package/repo scripts plus `.bin` tools, and feed those hints into every prompt so Phi knows which capabilities already exist.
- **ApiNavigator helper loops.** Navigation prompts can request single-use Node.js or Python helpers, execute them immediately, and archive the code plus stdout/stderr artifacts under `.miniphi/helpers/` for later runs.
- **Prompt decomposition + planning.** `PromptDecomposer` emits JSON trees and human-readable outlines under `.miniphi/prompt-exchanges/decompositions/`, letting operators resume multi-step tasks mid-branch.
- **Resource guard rails + health logs.** `ResourceMonitor` samples CPU, RAM, and VRAM in real time, streams warnings to the console, and records rollups under `.miniphi/health/resource-usage.json` alongside `.miniphi/history/benchmarks.json`.
- **Research/history/benchmark archives.** Research snapshots, history notes, and benchmark artifacts land in `.miniphi/research/`, `.miniphi/history-notes/`, and `.miniphi/benchmarks/`, keeping every Phi-4 conversation reproducible.
- **Recomposition + benchmark harness.** `RecomposeTester` and `RecomposeBenchmarkRunner` power `samples/recompose/hello-flow`, repair mismatches with diff-driven prompts, and export Phi transcripts next to each JSON report.
- **Prompt telemetry + scoring.** `PromptPerformanceTracker` records workspace focus, commands, schema IDs, capability summaries, and prompt lineage inside `miniphi-prompts.db` so future runs can reuse proven setups.
- **Config profiles and overrides.** Optional `config.json` (or `--config`/`MINIPHI_CONFIG`) pins LM Studio endpoints, prompt defaults, GPU modes, context budgets, resource thresholds, and chunk sizes without retyping flags.
- **Samples.** `samples/recompose/hello-flow` remains the canonical recomposition benchmark, while `samples/get-started` introduces a workspace-onboarding scenario with curated prompts for environment detection, README drafting, feature tweaks, and verification commands.

miniPhi currently targets macOS, Windows, and Linux and expects LM Studio to be reachable at `http://127.0.0.1:1234`. The defaults assume the `microsoft/phi-4-reasoning-plus` model is already downloaded in LM Studio.

## Architecture snapshot
1. **LMStudioManager** (src/libs/lmstudio-api.js) performs JIT model loading and surfaces the `/api/v0` REST primitives (list models, chat/completion probes, embeddings, runtime stats).
2. **Phi4Handler** (src/libs/lms-phi4.js) wraps LM Studio calls, enforces reasoning streams, wires `--session-timeout`, and declares the JSON schema that each downstream Phi-4 call must respect.
3. **EfficientLogAnalyzer + PythonLogSummarizer** compress streamed stdout/stderr or files by chunk, annotate the segments, and feed the high-signal slices to Phi-4 while embedding the proper JSON schema from `docs/prompts/`.
4. **miniPhiMemory + PromptRecorder** archive prompts, compressed context, responses, TODOs, scoring metadata, recursive prompt plans, and capability outlines under `.miniphi/` so future runs can rehydrate any exchange.
5. **WorkspaceProfiler + FileConnectionAnalyzer + CapabilityInventory** scan the repository tree ahead of a run so each prompt is prefixed with facts about the code/docs split, import/dependency graph, and available scripts/binaries.
6. **PromptPerformanceTracker** scores every prompt/response pair inside `miniphi-prompts.db` (SQLite), captures prompt lineage/schema IDs/commands/capabilities, and exposes the structured telemetry to scoring prompts and future runs.

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
- miniPhi executes the command in your working directory, compresses the live output, streams Phi-4 reasoning, and drops `executions/<id>/` metadata under `.miniphi/`.
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
- `recompose` operates on `samples/recompose` projects. Flags: `--sample`, `--direction code-to-markdown|markdown-to-code|roundtrip`, `--code-dir`, `--descriptions-dir`, `--output-dir`, `--clean`, `--report`, and `--resume-descriptions`. Used for development and testing purposes.
- `benchmark recompose` automates timestamped runs (default sample `samples/recompose/hello-flow`). Mix in `--directions`, `--repeat`, `--run-prefix`, `--timestamp`, `--clean`, `--resume-descriptions`, or `--sample`.
- `benchmark analyze` reads `RUN-###.json` files, emits `SUMMARY.json|md|html`, and supports `--path` or positional directories plus repeated `--compare` flags to diff baselines vs candidates.
- `benchmark plan scaffold` inspects a sample (default `hello-flow`) and prints a commented YAML template; use `--sample`, `--benchmark-root`, and `--output` to persist it.

Every command accepts `--config <path>` (falls back to searching upward for `config.json`) and `--verbose` for progress logs. `--debug-lm` prints every objective + prompt as the prompt scoring database runs.

## Frequently used flags
- `--task` describes what Phi-4 should do with the log or command output. If omitted, it defaults to `"Provide a precise technical analysis"` from `config.example.json`.
- `--prompt-id <id>` or `--config defaults.promptId` let you resume a chat session; transcripts are written to `.miniphi/prompt-sessions/<id>.json`.
- `--python-script <path>` overrides the bundled `log_summarizer.py` (miniPhi will auto-detect `python3`, `python`, or `py`).
- `--session-timeout <ms>` hard-stops the orchestration; Phi-4 receives the remaining budget with each prompt so runaway loops cannot hang the CLI.
- `--no-summary` skips the JSON footer if another system is reading stdout.
- `MINIPHI_CONFIG=/path/config.json` is honored if you prefer environment variables over flags.

## Hidden `.miniphi` workspace
miniPhi always writes to the nearest `.miniphi/` directory (creating one if it does not exist):
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
- `docs/studies/APIs/REST API v0 _ LM Studio Docs.html` is the offline reference consumed by `LMStudioRestClient`.
- `docs/os-defaults/windows.md` and `docs/prompts/windows-benchmark-default.md` document the Windows helper workflow.
- `docs/studies/todo/author.md` tracks authoring tasks that still need human review.
- `samples/recompose/hello-flow` plus `samples/benchmark/` contain the recomposition harness and reference plans described in `WHY_SAMPLES.md`.

## Project status
- Ready: layered LM Studio stack (`LMStudioManager`, `Phi4Handler`, `EfficientLogAnalyzer`) is production ready with reasoning streaming, JSON schema guards, and prompt scoring.
- Ready: `.miniphi` memory, prompt transcripts, and research or history snapshots are stable across commands.
- Warning: there are no automated tests yet, so manual verification is still required whenever compression heuristics or Phi prompts change.
- In progress: packaging (`npm bin` publish), richer summarization backends, better telemetry, and retention policies for `.miniphi` artifacts are still underway.
- Next up: upcoming work focuses on runtime improvements (prompt orchestration, analyzers, LM Studio clients) rather than tweaking benchmark scripts; the `benchmark analyze` and `plan scaffold` tools already cover reporting needs.

## License
miniPhi is released under the ISC License. See `LICENSE` for the legal text.
