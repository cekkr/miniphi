# miniPhi

> Local AI agent for programming across whole repositories. miniPhi runs as a CLI and talks to **local LLMs served by LM Studio**, so your code and logs stay on your machine.

![miniPhi](https://github.com/cekkr/miniphi/blob/main/md-assets/miniphi-logo.jpg?raw=true)

miniPhi is a workspace-aware assistant: it scans the current folder (your repo), compresses long command output or log files into smaller, high-signal chunks, then asks a locally loaded model to plan, analyze, or draft edits. Every run leaves an audit trail under `.miniphi/` so you can revisit what happened later.

Because a local model's context window is small (LM Studio typically loads models at 8k–16k tokens), miniPhi does not keep one growing conversation. It keeps a **layered context**: your task and the session rules are always loaded, while file contents, search results and research are ranked by importance and sub-task and shrunk to summaries — or listed by id — when they don't fit. The model can then reshape its own context, asking for exactly the piece it needs. See [Layered context](#layered-context-how-miniphi-fits-big-repos-in-a-small-window).

## What you can use it for

- **Repo onboarding:** “what’s in this project?”, “what scripts exist?”, “where is feature X implemented?”
- **Log triage:** summarize failing test runs, crashes, CI output, benchmark traces, and long CLI transcripts.
- **Change planning:** produce step-by-step plans grounded in the actual workspace layout.
- **Drafting edits:** propose patches, refactors, docs updates, or helper scripts based on the repo snapshot.
- **Nitpicking loops:** pit two local models against each other to improve long-form drafts.
- **Web research (optional):** let the agent search for current libraries and capture page text via headless browsing.

> miniPhi is intentionally **local-first**. It’s not a hosted chatbot: you run LM Studio and you own the artifacts it writes.

## Requirements

- **Node.js 20+**
- **Python 3.9+** (used by the bundled log summarizer)
- **LM Studio** with the local server enabled (default endpoint: `http://127.0.0.1:1234`)
- A model loaded in LM Studio  
  Defaults/presets typically include `mistralai/devstral-small-2-2512` or `mistralai/devstral-small-2507` (you can switch via `--model` or config). Use `--model auto` to let MiniPhi query LM Studio and pick the best installed model for the task (`miniphi models` shows the ranking).

MiniPhi defaults to REST transport (`lmStudio.transport: "rest"`). Switch to WebSocket by overriding the setting in `config.json`.

## Install (from source)

```bash
git clone https://github.com/cekkr/miniphi.git
cd miniphi
npm install
```

Optional:
- If you want the `miniphi` command on your PATH while developing, use `npm link`.
- Cheetah is included at `thirds/cheetah` as the development target for an alternative graph-query
  engine for LM Studio prompt and subprompt context handling. Clone with submodules enabled:
  ```bash
  git clone https://github.com/cekkr/miniphi.git --recurse-submodules
  ```
  Existing clones can initialize it with:
  ```bash
  git submodule update --init --recursive thirds/cheetah
  ```

## Get started

1. **Start LM Studio**
   - Download a model.
   - Enable the local server (usually `http://127.0.0.1:1234`).
   - MiniPhi scans the current native
     [LM Studio REST API](https://lmstudio.ai/docs/developer/rest) model inventory. If the server
     requires authentication, set `LMSTUDIO_API_TOKEN` (tokens are redacted from MiniPhi's
     request instrumentation).

2. **Run miniPhi inside your project**
   ```bash
   cd /path/to/my-project
   miniphi
   ```
   Running `miniphi` with no arguments opens the **interactive agent UI** (the primary interface). You:
   - **pick the files** to put in scope (fuzzy filter, Space to toggle, Enter to confirm — or Esc to skip),
   - **describe the task** in a prompt box,
   - **choose the model** after the task is known: `Auto` ranks the live LM Studio inventory for
     that task, or select an exact installed model; loaded state, context, and capabilities are
     shown before the run,
   - **watch progress in real time** as the agent reads/searches the repo, optionally researches library choices, and plans,
   - **approve each change**: proposed file writes/edits show a diff and wait for you (`y` once · `a` for the session · `n` reject), and edits are applied through a guarded writer with rollback.

   You can also seed the task directly — it still opens the UI:
   ```bash
   miniphi "Add input validation to the CLI parser and a unit test for it"
   ```

   Prefer the classic non-interactive pipeline (or running in CI/scripts)? Add `--headless` (it's also implied automatically when stdout is not a TTY), or use any explicit subcommand below.

### Interactive UI vs. direct commands

The UI is the front door for everyday use, but **every direct subcommand and flag stays available** for scripting and automation. Use `miniphi ui [--task "…"]` to launch the UI explicitly, `--headless`/`--no-ui` to force the non-interactive flow, and the subcommands below for targeted, scriptable runs.

### Layered context: how miniPhi fits big repos in a small window

Local models have small context windows, so miniPhi budgets every prompt instead of appending to a
transcript. The context is a graph of layered pieces:

| Layer | What it holds | Under pressure |
| --- | --- | --- |
| Mission | your task and the workspace root | always sent |
| Contract | session rules, budgets, corrections ("you already did that") | always sent |
| Plan | decisions, applied edits, finished sub-task outcomes | shrinks last |
| Sub-task | the goal of the sub-task being worked on | shrinks last |
| Evidence | file contents, search hits, research results | summarized, then listed by id |
| Scratch | passing notes | dropped first |

The budget is derived from the model's **loaded** context length, so it adapts to whatever LM Studio
has in memory (override with `--context-budget <tokens>`). Anything that doesn't fit is not lost: it
becomes a short digest, or a one-line entry in a "Context index" carrying its id — and the model can
ask for it back, pin what matters, discard what it's done with, or open and close sub-tasks that
collapse their evidence into a single conclusion when finished. If it reports that the loaded context
isn't precise enough, miniPhi reforms the graph around the stated gap and re-asks once.

Everything is auditable: the graph and its bounded complete-sentence references are saved to
`.miniphi/agent-sessions/<id>/context-graph.json`, and the session result records how much was
loaded, digested, or reshaped.

#### Optional Cheetah graph-query engine

The interactive agent can use the Cheetah submodule as an alternative graph-query engine for each
LM Studio prompt and focused sub-task prompt. MiniPhi keeps the full context and deterministic token
budget in its local `ContextGraph`; every node also stores bounded, self-contained reference
sentences. Cheetah receives graph metadata, relations, and those sentences — never the full file or
prompt block — then `GRAPH_RECALL references=1` returns associated sentences rather than only labels
or word-like ids. The same LM Studio model selected for the session chooses and orders a small set of
returned sentence ids with strict `response_format=json_schema`; invalid replies are retried once and
then use a deterministic ranking fallback. The exact candidates, raw replies/reasoning, tool-call fields,
schema result, and final selection are written to
`.miniphi/agent-sessions/<id>/context-references.json`.
When local context is superseded (for example, after a guarded edit or a newer validation result),
MiniPhi drops the stale local node and removes its mirrored Cheetah node and edges before the next
recall. The exact guarded post-edit source becomes the authoritative file context.

Build and start Cheetah on loopback:

```bash
git submodule update --init --recursive thirds/cheetah
cd thirds/cheetah
go build -o cheetah-server ./src
CHEETAH_HEADLESS=1 CHEETAH_LISTEN_ADDR=127.0.0.1:4455 ./cheetah-server
```

Then opt in through `config.json`:

```json
{
  "context": {
    "engine": "cheetah",
    "cheetah": {
      "host": "127.0.0.1",
      "port": 4455,
      "database": null,
      "projectId": null,
      "timeoutMs": 2500,
      "required": false,
      "referenceLimit": 48
    }
  }
}
```

By default MiniPhi hashes the canonical workspace path into both an opaque project reference and a
project-specific database name (`miniphi_context_p_<hash>`). Every mirrored node id also includes
that project reference and a hashed session reference, so two projects remain isolated even if an
operator deliberately configures one shared database or reuses a session name. Set `projectId` to a
stable repository identifier if the same graph should survive moving the workspace; set `database`
only when you intentionally need a fixed database. The workspace path and full prompt/file blocks
are not stored in Cheetah; only the bounded complete reference sentences visible in the local audit
are mirrored.

With `required: false` (the default), a timeout or unavailable Cheetah server falls back to the
in-memory selector and records the failure in
`.miniphi/agent-sessions/<id>/context-engine.json`. Set `required: true` only when a missing graph
service should stop the model turn. Environment overrides are `MINIPHI_CONTEXT_ENGINE=cheetah`,
`MINIPHI_CHEETAH_HOST`, `MINIPHI_CHEETAH_PORT`, `MINIPHI_CHEETAH_DATABASE`,
`MINIPHI_CHEETAH_PROJECT_ID`,
`MINIPHI_CHEETAH_TIMEOUT_MS`, and `MINIPHI_CHEETAH_REQUIRED`.

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

Normalize historical stop-reason fields and prompt-exchange tool metadata keys in existing `.miniphi` artifacts:

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

Run a live general-purpose benchmark with schema-validated LM Studio assessment:

```bash
miniphi benchmark general --task "Assess general agent readiness" --cmd "node -v" --live-lm --live-lm-timeout 12
```

Use `--live-lm-plan-timeout` if you need a shorter/longer decomposition timeout during live benchmark runs. In live benchmark mode, navigator/decomposer/assessment now retry once with compact requests when full requests time out or overflow context, and benchmark summaries include adaptive per-stage timeout budgets/resolved timeout telemetry. If both navigator and decomposer time out, MiniPhi still sends one ultra-compact `assessment-only` LM request instead of skipping assessment entirely.

Score the installed LM Studio chat models with the compact deterministic suite:

```bash
miniphi benchmark models --easy
miniphi benchmark models --show
```

The suite checks strict JSON, reasoning, coding, context retrieval, constrained writing,
source choice, tool planning, and latency. Results are cached under
`.miniphi/benchmarks/models/` using the benchmark definition, model artifact/load configuration,
LM Studio endpoint/runtime details, and available hardware identity. A matching second run makes
no inference calls. Once fresh scores exist, headless task flows without an explicit configured
model implicitly use Auto; explicit `--model auto`, `models --task`, and the interactive model
picker use the relevant category score as their primary ranking evidence too. An explicit model
override still wins. Bare `miniphi` also exposes an **Easy benchmark** button and the cached score
table on its home screen.

Choose how much reasoning MiniPhi spends with one profile:

```bash
miniphi "Refactor the parser" --reasoning low
miniphi workspace --task "Plan the migration" --reasoning high --headless
```

`off`, `low`, `medium`, and `high` allow 0, 1, 2, and 4 focused planning
subprompts respectively; `high` is the default. MiniPhi also requests the
closest reasoning effort advertised by the selected LM Studio model. If the
model does not expose adjustable reasoning—or the compatible strict-JSON route
rejects the setting—MiniPhi keeps the decomposition profile, retries once
without the model parameter, and records that fallback. The terminal UI asks
for the profile after model selection and previews its budgets. Explicit
`--max-plan-expansions` and `--no-plan-expansion` overrides still win.

Run the opt-in from-scratch project test (PowerShell example). It performs bounded web research, creates an animated basketball page in an empty workspace, validates it in Chromium, and preserves the project and screenshot under the selected output folder:

```powershell
$env:MINIPHI_AGENT_PROJECT_INTEGRATION = "1"
$env:LMSTUDIO_REST_URL = "http://127.0.0.1:1234"
$env:MINIPHI_LIVE_MODEL = "gpt-oss-20b"
$env:MINIPHI_BASKETBALL_OUTPUT = "$PWD\.miniphi\live-tests"
node --test unit-tests-js/agent-project-creation.live.test.js
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
Prompt exchanges also retain canonical tool metadata keys (`tool_calls`, `tool_definitions`) even when null/empty so eval tooling can score runs consistently.
Stop reasons (with a code/detail) are stored in execution archives and prompt journals; when a session budget expires before Phi responds, the analyzer emits deterministic fallback JSON instead of hanging.

The deeper “JSON-only contracts”, schema rules, and contributor guardrails live in **AGENTS.md**.

For prompt-scoring diagnostics, add `--debug-lm` to enable the semantic evaluator and print the scored objectives/prompts.

## Where outputs go

miniPhi stores reproducible artifacts in two places:

- **Project-local:** `.miniphi/` (executions with `task-execution.json` request/response registers, prompt exchanges, agent-session transcripts/validation/rollbacks, helper scripts, reports, recompose edit logs/rollbacks)
- **Project-local (extra):** `.miniphi/web/` for browser snapshots and `.miniphi/nitpick/` for writer/critic sessions
- **User-level:** `~/.miniphi/` (shared caches, preferences, prompt telemetry DB)

If you want to keep your repo clean, add `.miniphi/` to your `.gitignore`.

## Commands (overview)

These are the commands most people start with:

- `miniphi` / `miniphi ui`  
  Open the **interactive agent UI**. Its home screen starts a task or runs the Easy model benchmark and displays cached scores; task flow then picks files, prompts, shows benchmark-informed model choices/live progress (including bounded `web_research` actions), and approves guarded edits (diff + rollback). Bare `miniphi` and a free-form task both open the UI on a TTY; add `--headless` to opt out. Prompts are assembled from the [layered context](#layered-context-how-miniphi-fits-big-repos-in-a-small-window); size it explicitly with `--context-budget <tokens>` if you want to override the auto-detected window.
- `miniphi "<task>"`  
  On a TTY this opens the interactive UI seeded with the task. With `--headless` (or a non-TTY), it runs the classic workspace scan + planning prompt + log-analysis JSON summary. Add `--cmd` or `--file` to route the same free-form task into `run` or `analyze-file`.
- `miniphi run --cmd "<command>" --task "<objective>"`  
  Execute a command and analyze the output.
- `miniphi analyze-file --file <path> --task "<objective>"`  
  Analyze a log or text file.
- `miniphi lmstudio-health`  
  Fast REST probe with stop reasons stored under `.miniphi/health/`.
- `miniphi models [--task "<objective>"] [--json]`  
  List models from native `/api/v1/models`, normalized with quantization, capabilities, loaded
  instances/context, and task ranking. Pass `--model auto` to let MiniPhi choose automatically.
  Lifecycle changes are explicit: `--load <model-id> [--context-length <tokens>]` loads one model,
  while `--unload <instance-id>` unloads only that exact instance.
- `miniphi benchmark models --easy`
  Run the cache-aware per-model score suite serially. Use `--models <id,id>` to limit it,
  `--refresh` to rerun matching entries, `--show` to inspect the table without inference, and
  `--json` for machine-readable trials/scores. Fresh category scores automatically guide
  task-aware model selection; after the first benchmark, headless tasks with no explicit model
  automatically opt into that evidence.
- `miniphi web-browse --url "<https://example.com>"`  
  Capture page text via a headless browser and store the snapshot under `.miniphi/web/`.
- `miniphi nitpick --task "<long-form writing task>"`  
  Run a writer/critic loop (optionally blind with web sources), enforce minimum words by actual count on final drafts, and optionally retry final expansion with `--auto-expand-rounds`.
- `miniphi helpers` / `miniphi command-library`  
  Inspect saved helper scripts and recommended commands.
- `miniphi cache-prune`  
  Trim older `.miniphi/` artifacts using retention defaults or `--retain-*` overrides.
- `miniphi migrate-stop-reasons`  
  One-shot normalization pass for historical stop reason fields plus prompt-exchange tool metadata key backfill in existing `.miniphi` JSON artifacts (`--dry-run`, `--strict`, `--parse-error-report`, and `--json` supported).
- `npm run ci:migrate-stop-reasons`  
  CI-oriented strict dry-run check for malformed JSON/legacy stop-reason artifacts.
- `miniphi recompose` / `miniphi benchmark ...`  
  Development and benchmarking harness (see `WHY_SAMPLES.md`). Recompose defaults to auto (uses LM Studio when reachable); use `--recompose-mode live|offline` to override. `benchmark models` produces model-selection evidence; `benchmark general --live-lm` enables live LM Studio planning + assessment calls with strict JSON validation, compact retry fallbacks for navigator/decomposer/assessment timeouts/context overflow, and adaptive per-stage timeout budgets persisted in summary metadata.

For the full list of flags and subcommands, run `miniphi --help` (or `node src/index.js --help`).

## Documentation map

- **AGENTS.md**: contributor + agent guardrails, JSON-first rules, deeper reference.
- **ROADMAP.md**: milestones, exit criteria, and the current status snapshot.
- `docs/`: implementation notes and LM Studio integration details.
- `samples/`: recomposition and benchmark fixtures used to validate the runtime.
- `dev_samples/task-tests.md` + `dev_samples/test_tasks/`: benchmark compendium source and cloned JSON suite used by unit tests (`node scripts/sync-test-task-catalog.js` to refresh artifacts).

## License

miniPhi is released under the ISC License. See `LICENSE`.
