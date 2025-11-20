# Mini Bash Sample

This trimmed C workspace exists solely for MiniPhi's benchmark harness. It mimics the structure of the full GNU Bash sources without shipping the entire project. The sample keeps a handful of orchestrated files (`shell.c`, `eval.c`, `execute_cmd.c`, `jobs.c`, `telemetry.c`) so the benchmark scripts can traverse function graphs, expand call flows, and exercise the recursive prompt harness.

- `shell.c` bootstraps the runtime, calls into the reader loop, and dispatches telemetry/jobs.
- `eval.c` implements a simplified `reader_loop` plus validation helpers so there is a realistic call tree.
- `execute_cmd.c` plans and executes commands, persisting telemetry as it goes.
- `jobs.c` and `telemetry.c` provide extra call sites so the analysis tools can follow nested functions.

The small footprint keeps the repository light while still validating the AST walkers, flow report generation, and recursive Phi-4 prompts.
