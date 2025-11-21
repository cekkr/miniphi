# miniPhi

> Local, LM Studio-based (and Phi-4-powered) project assistant for your repositories. It runs as a CLI “local AI agent” that understands your workspace, compresses logs and context, and then asks Phi-4 to plan, analyze, or draft changes on top of that snapshot.

![miniPhi](https://github.com/cekkr/miniphi/blob/main/md-assets/miniphi-logo.jpg?raw=true)

miniPhi squeezes CLI transcripts, benchmark dossiers, and raw text logs into small reasoning-ready chunks and hands them to LM Studio's `microsoft/phi-4-reasoning-plus` model. The CLI streams the model's `<think>` reasoning, publishes structured summaries, snapshots everything under `.miniphi/`, and keeps a receipt so the next investigation can pick up where you left off.

## What miniPhi is
- A **local AI agent for a project**, not a hosted chatbot: it runs on top of your own LM Studio instance and keeps all logs, prompts, and artifacts on disk under `.miniphi/` and `~/.miniphi/`.
- A **workspace-aware CLI orchestrator** that scans your repo, discovers scripts and tooling, and feeds that context into Phi-4 before asking it to plan or edit anything.
- A **log and transcript compressor** that lets Phi-4 reason over long command outputs, test runs, and benchmark traces without you pasting anything into a browser.
- A **memory layer around LM Studio** so prompt trees, decompositions, helper scripts, and research notes can be replayed, diffed, or continued in later sessions.
- A **development harness for samples and benchmarks** (such as the recomposition flows and benchmark commands documented below), which exist to validate the runtime rather than act as the primary user experience.

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

## Step-by-step prompt journals
- Pass `--prompt-journal <id>` (or omit the value to reuse the auto-generated `--prompt-id`) to enable the new prompt-step journal stored under `.miniphi/prompt-exchanges/stepwise/<id>/`. Every Phi-4/API prompt, response, and downstream operation (shell commands, analyzer runs, navigator helpers) is recorded in order so another agent can audit the session before continuing.
- Pair `--prompt-journal-status paused|completed|closed` with repeated runs to explicitly pause or finish a journal. A common pattern is `--prompt-journal session-123 --prompt-journal-status paused` to capture the latest step, review it asynchronously, then resume with `--prompt-journal session-123 --prompt-journal-status completed`.
- Journals coexist with `--prompt-id <id>` so you can persist the Phi chat history and the higher-level operation ledger together. The files are plain JSON so they are easy to diff, summarize, or feed back into MiniPhi as fixed references.
- Try `npm run sample:besh-journal` to see the feature in action: it analyzes the one-file `samples/besh/bsh.c` project, records every summarization prompt, and leaves the journal paused so another agent (or you) can review it before resuming.

## Prompt template baselines
- `node src/index.js prompt-template --baseline truncation --task "Teach me to split the jest log" --dataset-summary "Captured 50k lines of Jest output"` prints a ready-to-send Phi prompt that reuses the log-analysis schema (including `truncation_strategy`).
- `node src/index.js prompt-template --baseline log-analysis --task "Summarize the failing jest suites" --schema-id log-analysis` prints the base log/command-analysis prompt (schema block included) so you can version control the JSON contract that MiniPhi expects before dispatching Phi.
- Each invocation writes a template artifact under `.miniphi/prompt-exchanges/templates/<id>.json` so decomposers, helpers, or future runs can replay the exact scaffold. Metadata captures dataset size hints, helper-command focus, and the JSON keys that must persist between chunks.
- Use `--total-lines`, `--target-lines`, `--history-keys`, `--helper-focus`, and `--notes` to pin the truncation budget and the carryover ledger; `--output <path>` saves the rendered prompt to a file, while `--no-workspace` skips workspace profiling when you only need a generic template.
- The command never talks to LM Studio—it simply builds the deterministic baseline around the stored schema—so you can version control the generated templates and share them across repos.

## Command authorization & shared memory
- Every run now consults a shared home-level store at `~/.miniphi/` for prompt telemetry, performance data, system profiles, and operator preferences. `miniphi-prompts.db` was relocated there so the scoring database survives across projects.
- Commands are gated by the new `CommandAuthorizationManager`; choose `--command-policy ask|session|allow|deny` (default: `ask`) and opt into `--assume-yes` when you want to auto-approve prompts in non-interactive shells. Use `--command-danger <low|mid|high>` to describe how risky your `--cmd` invocation is so navigator follow-ups inherit the right defaults.
- Navigation prompts returned by `ApiNavigator` now include per-command `danger` fields, so MiniPhi only interrupts you when a potentially destructive command is queued.
- Direct file references and command policies are persisted inside `.miniphi/prompt-exchanges/fixed-references/` (project scope) and `~/.miniphi/preferences/command-policy.json` (global scope) so reruns can replay the exact same context even if the workspace changed in between.
- A lightweight `SchemaAdapterRegistry` sits between LM Studio responses and the CLI; ApiNavigator already emits a `schema_version` field and the adapter normalizes new JSON layouts at runtime so future prompt revisions can evolve without patching the client.

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
- **Endpoint normalization + prompt defaults.** `lmStudio.clientOptions.baseUrl` can point to either `http://` or `ws://` servers; miniPhi normalizes the WebSocket endpoint automatically, mirrors the same host for the REST client, and lets you omit `prompt.system` entirely to fall back to MiniPhi's built-in system prompt.
- **Samples.** `samples/recompose/hello-flow` remains the canonical recomposition benchmark, while `samples/get-started` introduces a workspace-onboarding scenario with curated prompts for environment detection, README drafting, feature tweaks, and verification commands.
- **Batch benchmark logger.** `./run-log-benchmarks.sh` executes `npm run sample:besh-journal`, all recompose directions, and `npm run benchmark`, storing stdout, git status snapshots, and copies of new artifacts under `current-benchmarks/<timestamp>/`. Set `RECOMPOSE_MODE=live` or `RECOMPOSE_DIRECTIONS=code-to-markdown,...` to customize which combinations run.

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
- When Phi-4 responds with a `truncation_strategy`, MiniPhi now saves the JSON plan under `.miniphi/executions/<id>/truncation-plan.json`, prints the execution id, and lets you resume with `--resume-truncation <id>` (optionally `--truncation-chunk <priority|label>`). The resumed run focuses the requested chunk—down to the line window when provided—so the follow-up prompt consumes the plan instead of starting from scratch.
- If Phi still needs more information before continuing, it can describe the missing snippets via `context_requests`. MiniPhi prints those requests to the console and stores the hints in `.miniphi/executions/<id>/analysis.json`, so you can gather the exact context the model asks for instead of resending everything.

## Command tour
- `run` executes a command and streams reasoning. Key flags: `--cmd`, `--task`, `--cwd`, `--timeout`, `--session-timeout`, `--prompt-id`, `--python-script`, `--summary-levels`, `--context-length`, and the resource monitor thresholds (`--max-memory-percent`, `--max-cpu-percent`, `--max-vram-percent`, `--resource-sample-interval`).
- `analyze-file` summarizes an existing file. Flags mirror `run` but swap `--cmd` for `--file`.
- `web-research` performs DuckDuckGo Instant Answer lookups. Use positional queries or `--query`, set `--max-results`, `--provider`, `--include-raw`, `--no-save`, and optional `--note`. Results live under `.miniphi/research/`.
- `history-notes` snapshots `.miniphi/` and optionally attaches git metadata. Use `--label`, `--history-root`, and `--no-git`.
- `command-library` prints every command that Phi recommended via `recommended_fixes[].commands`; filter with `--search`, `--tag`, and `--limit`, or add `--json` to consume the output programmatically.
- `recompose` operates on `samples/recompose` projects. Flags: `--sample`, `--direction code-to-markdown|markdown-to-code|roundtrip`, `--code-dir`, `--descriptions-dir`, `--output-dir`, `--clean`, `--report`, and `--resume-descriptions`. Used for development and testing purposes.
- `benchmark recompose` automates timestamped runs (default sample `samples/recompose/hello-flow`). Mix in `--directions`, `--repeat`, `--run-prefix`, `--timestamp`, `--clean`, `--resume-descriptions`, or `--sample`.
- `benchmark analyze` reads `RUN-###.json` files, emits `SUMMARY.json|md|html`, and supports `--path` or positional directories plus repeated `--compare` flags to diff baselines vs candidates.
- `benchmark plan scaffold` inspects a sample (default `hello-flow`) and prints a commented YAML template; use `--sample`, `--benchmark-root`, and `--output` to persist it.

Every command accepts `--config <path>` (falls back to searching upward for `config.json`) and `--verbose` for progress logs. `--debug-lm` prints every objective + prompt as the prompt scoring database runs.

## Frequently used flags
- `--task` describes what Phi-4 should do with the log or command output. If omitted, it defaults to `"Provide a precise technical analysis"` from `config.example.json`.
- `--prompt-id <id>` or `--config defaults.promptId` let you resume a chat session; transcripts are written to `.miniphi/prompt-sessions/<id>.json`.
- `--prompt-journal [id]` mirrors every prompt + downstream operation into `.miniphi/prompt-exchanges/stepwise/<id>/`; combine with `--prompt-journal-status paused|completed|closed` to pause/resume journals explicitly.
- `--python-script <path>` overrides the bundled `log_summarizer.py` (miniPhi will auto-detect `python3`, `python`, or `py`).
- `--resume-truncation <execution-id>` replays the truncation plan saved for a previous analyze-file run; use it as soon as the CLI tells you a plan was captured.
- `--truncation-chunk <priority|label>` selects which chunk goal from the saved plan should drive the follow-up run. When the plan contains a line range, MiniPhi restricts summarization to that slice automatically.
- `--session-timeout <s>` hard-stops the orchestration; Phi-4 receives the remaining budget with each prompt so runaway loops cannot hang the CLI.
- `--no-summary` skips the JSON footer if another system is reading stdout.
- `MINIPHI_CONFIG=/path/config.json` is honored if you prefer environment variables over flags.

## Hidden `.miniphi` workspace
miniPhi always writes to the nearest `.miniphi/` directory (creating one if it does not exist):
- `executions/<id>/` contains `execution.json`, `prompt.json`, `analysis.json`, compression chunks, and any generated log segments.
- `prompt-exchanges/` captures every Phi-4 request, including decompositions (`prompt-exchanges/decompositions/`) and sub-prompts, as JSON.
- `prompt-exchanges/stepwise/<session>/` hosts the new prompt journals so you can replay each API call + resulting operation step-by-step (useful for AI oversight or handoffs).
- `prompt-exchanges/templates/` is the catalog of baseline prompts generated by `prompt-template`; each entry records the rendered prompt, dataset hints, and helper focus so you can replay truncation strategies without re-authoring them.
- `.miniphi/helpers/command-library.json` accumulates any commands Phi recommended inside `recommended_fixes[].commands`, making it easy to replay previously suggested remediation steps or share them across runs.
- The workspace context passed to Phi now includes a short “Command library recommendations” block whenever the library has entries, so prompt plans automatically see the best-known remediation commands before generating new suggestions.
- Prompt contexts now also summarize `.miniphi/index.json` plus the latest `.miniphi/history/benchmarks.json` entries so Phi understands what prior executions and benchmark digests exist without re-reading the graphs.
- Every `.miniphi/executions/<id>/analysis.json` now includes any `context_requests` Phi emitted, giving you a persistent record of the exact snippets or descriptions the model asked for before rerunning the analyzer.
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
- `samples/besh/bsh.c` is a massive single-file shell used to stress recursive summarization; `npm run sample:besh-journal` walks through it with the prompt journal enabled.
- `samples/bash-it/` is a fixed copy of the Bash shell source tree (with its real multi-directory layout) so you can run unit-style MiniPhi tests, recomposition exercises, or benchmarking passes against a realistic, complex workspace without needing to clone GNU Bash separately.

## Project status
- Ready: layered LM Studio stack (`LMStudioManager`, `Phi4Handler`, `EfficientLogAnalyzer`) is production ready with reasoning streaming, JSON schema guards, and prompt scoring.
- Ready: `.miniphi` memory, prompt transcripts, and research or history snapshots are stable across commands.
- Ready: helper utilities (danger normalization, navigation planners, LM Studio endpoint detection) now have automated coverage via `npm test` (`node --test ./tests/**/*.test.js`).
- Warning: compression heuristics and Phi prompt templates still require manual verification because integration tests depend on live LM Studio responses.
- In progress: packaging (`npm bin` publish), richer summarization backends, better telemetry, and retention policies for `.miniphi` artifacts are still underway.
- Next up: upcoming work focuses on runtime improvements (prompt orchestration, analyzers, LM Studio clients) rather than tweaking benchmark scripts; the `benchmark analyze` and `plan scaffold` tools already cover reporting needs.

## License
miniPhi is released under the ISC License. See `LICENSE` for the legal text.
