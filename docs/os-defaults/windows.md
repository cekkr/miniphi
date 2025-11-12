# Windows Default Settings for MiniPhi Benchmarks

These defaults capture the environment assumed by the Windows helper scripts and prompt presets. Update this file when host settings change so automated runs stay deterministic.

## Runtime Basics
| Setting | Default | Notes |
| --- | --- | --- |
| Shell | PowerShell (>= 7) or Windows Terminal | Scripts assume UTF-8 output. |
| Node.js | 18 LTS | Required for ES modules + top-level `await`. |
| Python | `py` launcher resolving to Python 3.9+ | Used by `log_summarizer.py`. |

## LM Studio / Phi-4
| Item | Value |
| --- | --- |
| REST endpoint | `http://127.0.0.1:1234` |
| Default model | `microsoft/phi-4-reasoning-plus` |
| Context length | 4096 tokens (changing this requires a model reload in LM Studio) |
| GPU preference | `auto` (MiniPhi lets LM Studio decide; override via `--gpu`). |

## MiniPhi CLI Defaults
- Command entrypoint: `node src/index.js`
- Default task text: stored in `docs/prompts/windows-benchmark-default.md`
- Resource monitor: enabled automatically with label `run:<cmd>` or `analyze:<file>`
- `.miniphi` workspace: created alongside the working directory; benchmark mirroring stores artifacts under `.miniphi/benchmarks/bash/`.

## Benchmark Workflow Helpers
- Run the Bash sample benchmark plus automated summary: `npm run benchmark:windows`
- Raw benchmark only: `npm run benchmark -- samples-bash-explain`
- Latest EXPLAIN output location: `samples/bash-results/`
- Prompt preset: `docs/prompts/windows-benchmark-default.md`
- Logs: `benchmark/logs/samples-bash/<timestamp>.log`

## File System Layout Reminders
- Ensure `samples/bash/` is populated (GNU Bash source snapshot) before running helpers.
- The helper workflow copies EXPLAIN files into `.miniphi/benchmarks/bash/` for retrieval across sessions.
- Windows paths are treated case-insensitively; all helper scripts use `path.resolve` so they work from any repo subdirectory.

## Updating Defaults
1. Edit this document when LM Studio ports, prompt presets, or helper commands change.
2. If new OS profiles are added (e.g., Linux, macOS), create sibling files under `docs/os-defaults/`.
3. Mirror prompt/template changes under `docs/prompts/` so tooling such as `scripts/run-benchmark-and-summarize.js` can reuse them.
