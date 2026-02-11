# miniPhi

> Local AI agent for programming across whole repositories. miniPhi runs as a CLI and talks to **local LLMs served by LM Studio**, so your code and logs stay on your machine.

![miniPhi](https://github.com/cekkr/miniphi/blob/main/md-assets/miniphi-logo.jpg?raw=true)

miniPhi is a workspace-aware assistant: it scans the current folder (your repo), compresses long command output or log files into smaller, high-signal chunks, then asks a locally loaded model to plan, analyze, or draft edits. Every run leaves an audit trail under `.miniphi/` so you can revisit what happened later.

## What you can use it for

- **Repo onboarding:** “what’s in this project?”, “what scripts exist?”, “where is feature X implemented?”
- **Log triage:** summarize failing test runs, crashes, CI output, benchmark traces, and long CLI transcripts.
- **Change planning:** produce step-by-step plans grounded in the actual workspace layout.
- **Drafting edits:** propose patches, refactors, docs updates, or helper scripts based on the repo snapshot.
- **Nitpicking loops:** pit two local models against each other to improve long-form drafts.
- **Web snapshots (optional):** capture page text via headless browsing for blind fact-finding.

> miniPhi is intentionally **local-first**. It’s not a hosted chatbot: you run LM Studio and you own the artifacts it writes.

## Requirements

- **Node.js 20+**
- **Python 3.9+** (used by the bundled log summarizer)
- **LM Studio** with the local server enabled (default endpoint: `http://127.0.0.1:1234`)
- A model loaded in LM Studio  
  Defaults/presets typically include `mistralai/devstral-small-2-2512` or `mistralai/devstral-small-2507` (you can switch via `--model` or config).

MiniPhi defaults to REST transport (`lmStudio.transport: "rest"`). Switch to WebSocket by overriding the setting in `config.json`.

## Install (from source)

```bash
git clone https://github.com/cekkr/miniphi.git
cd miniphi
npm install
```

Optional:
- If you want the `miniphi` command on your PATH while developing, use `npm link`.
- If you need submodules for benchmarks/dev tooling, clone with:
  ```bash
  git clone https://github.com/cekkr/miniphi.git --recurse-submodules
  ```

## Get started

1. **Start LM Studio**
   - Download a model.
   - Enable the local server (usually `http://127.0.0.1:1234`).

2. **Run miniPhi inside your project**
   ```bash
   cd /path/to/my-project
   miniphi "Create a README.md for this project"
   ```

### Common workflows

Analyze a command (runs the command, compresses output, asks the model to explain what happened):

```bash
miniphi run --cmd "npm test" --task "Analyze why the tests fail and suggest fixes"
```

Analyze an existing file (log or text file already on disk):

```bash
miniphi analyze-file --file ./logs/output.log --task "Summarize the recurring crash"
```

For decomposition-driven workflows, pair `--prompt-id` with `--plan-branch <step-id>` to focus nested sub-prompts and carry that branch focus into downstream analysis context.

Run a fast LM Studio health check (REST probe with clear stop reason):

```bash
miniphi lmstudio-health --timeout 10
```

For CI-friendly checks, add `--json` to emit a machine-readable summary.

Normalize historical stop-reason fields in existing `.miniphi` artifacts:

```bash
miniphi migrate-stop-reasons
```

For CI, use strict mode and emit malformed JSON paths directly:

```bash
miniphi migrate-stop-reasons --strict --parse-error-report --json
```

Repo npm script template (automatic strict enforcement):

```bash
npm run ci:migrate-stop-reasons
```

Capture a web page into a local snapshot:

```bash
miniphi web-browse --url "https://example.com" --max-chars 4000
```

Run a writer/critic nitpicking loop (optional blind mode uses web sources):

```bash
miniphi nitpick --task "Write a 2000-word brief on X" --rounds 2 --auto-expand-rounds 2
```

If you're running from the repo (without a global install), the equivalent entrypoint is:

```bash
node src/index.js <command> [flags...]
```

### Adaptive routing (RL)

MiniPhi can learn which local model + prompt profile performs best per prompt type and route future prompts accordingly.
Enable the router with a model pool and it will persist a Q-table under `.miniphi/indices/prompt-router.json`.

```bash
miniphi run --cmd "npm test" --task "Analyze failures" --rl-router --rl-models "mistralai/devstral-small-2-2512,ibm/granite-4-h-tiny"
```

For prompt profiles and reward tuning, set the `rlRouter` section in `config.json` (see `config.example.json`).

## Safety and command execution

miniPhi can run shell commands when you use `run` (or other workflows that execute commands). Review what it’s about to do and use the command policy flags if you want stricter gating.
Use `--session-timeout` to cap total runtime; follow-up helpers are skipped once the budget is exhausted.
When `--session-timeout` is at or below the prompt timeout, MiniPhi auto-skips planner/navigator prompts to preserve analysis time.
Use `--no-navigator` to skip navigator prompts and follow-up commands when you want a single-pass run.
Navigator follow-ups skip MiniPhi CLI entrypoints to avoid recursive runs.
MiniPhi runs a fast LM Studio REST health gate before prompting; disable it with `--no-health` if you intentionally rely on WS-only setups.

Model responses are schema-validated with deterministic JSON fallbacks across analysis, planning, and navigation prompts. Non-JSON preambles are rejected under the strict parser, so the fallback payload is saved instead of salvaging mixed prose.
Prompt exchanges now persist schema-validation metadata with status fields (for example `ok`, `schema_invalid`, `invalid_json`, `preamble_detected`) so audits can distinguish parser failures from schema mismatches.
Stop reasons (with a code/detail) are stored in execution archives and prompt journals; when a session budget expires before Phi responds, the analyzer emits deterministic fallback JSON instead of hanging.

The deeper “JSON-only contracts”, schema rules, and contributor guardrails live in **AGENTS.md**.

For prompt-scoring diagnostics, add `--debug-lm` to enable the semantic evaluator and print the scored objectives/prompts.

## Where outputs go

miniPhi stores reproducible artifacts in two places:

- **Project-local:** `.miniphi/` (executions with `task-execution.json` request/response registers, prompt exchanges, helper scripts, reports, recompose edit logs/rollbacks)
- **Project-local (extra):** `.miniphi/web/` for browser snapshots and `.miniphi/nitpick/` for writer/critic sessions
- **User-level:** `~/.miniphi/` (shared caches, preferences, prompt telemetry DB)

If you want to keep your repo clean, add `.miniphi/` to your `.gitignore`.

## Commands (overview)

These are the commands most people start with:

- `miniphi "<task>"`  
  Workspace scan + planning prompt + log-analysis JSON summary. Add `--cmd` or `--file` to route the same free-form task into `run` or `analyze-file`.
- `miniphi run --cmd "<command>" --task "<objective>"`  
  Execute a command and analyze the output.
- `miniphi analyze-file --file <path> --task "<objective>"`  
  Analyze a log or text file.
- `miniphi lmstudio-health`  
  Fast REST probe with stop reasons stored under `.miniphi/health/`.
- `miniphi web-browse --url "<https://example.com>"`  
  Capture page text via a headless browser and store the snapshot under `.miniphi/web/`.
- `miniphi nitpick --task "<long-form writing task>"`  
  Run a writer/critic loop (optionally blind with web sources), enforce minimum words by actual count on final drafts, and optionally retry final expansion with `--auto-expand-rounds`.
- `miniphi helpers` / `miniphi command-library`  
  Inspect saved helper scripts and recommended commands.
- `miniphi cache-prune`  
  Trim older `.miniphi/` artifacts using retention defaults or `--retain-*` overrides.
- `miniphi migrate-stop-reasons`  
  One-shot normalization pass for historical stop reason fields in existing `.miniphi` JSON artifacts (`--dry-run`, `--strict`, `--parse-error-report`, and `--json` supported).
- `npm run ci:migrate-stop-reasons`  
  CI-oriented strict dry-run check for malformed JSON/legacy stop-reason artifacts.
- `miniphi recompose` / `miniphi benchmark ...`  
  Development and benchmarking harness (see `WHY_SAMPLES.md`). Recompose defaults to auto (uses LM Studio when reachable); use `--recompose-mode live|offline` to override.

For the full list of flags and subcommands, run `miniphi --help` (or `node src/index.js --help`).

## Documentation map

- **AGENTS.md**: contributor + agent guardrails, JSON-first rules, deeper reference.
- **AI_REFERENCE.md**: status snapshot + near-term roadmap.
- **ROADMAP.md**: milestones and exit criteria.
- `docs/`: implementation notes and LM Studio integration details.
- `samples/`: recomposition and benchmark fixtures used to validate the runtime.

## License

miniPhi is released under the ISC License. See `LICENSE`.
