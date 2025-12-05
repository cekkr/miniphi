# Bash Sample Execution Flow

- Generated at: 2025-12-05T18:10:35.703Z
- Source root: `samples/bash`
- Depth inspected: 1
- Files scanned: 5
- Functions indexed: 17
- Method: tree-sitter AST traversal to preserve ordered call flows and inline expansions (depth ≤ 2).

## Shell startup flow
- File: `shell.c`
- Line: 14
- Signature: `int main(int argc, char **argv)`
- Body length: 9 line(s)
- Ordered walkthrough of `shell.c::main`. Each step lists the original call site, the callee location (when known), and expands one level deeper to show how execution fans out.

### Ordered call trace
1. `initialize_shell()` @ shell.c:15 → defined in `shell.c:24`
   ↳ initialize_shell()
   ↪ expands into `initialize_shell()` (shell.c:24)
  - `printf()` @ shell.c:25 → definition outside current scan
     ↳ printf("[shell] initializing runtime\\n")
  - `execute_command_internal()` @ shell.c:26 → defined in `execute_cmd.c:14`
     ↳ execute_command_internal("probe-environment")
     ↪ expands into `execute_command_internal()` (execute_cmd.c:14)
    - `memset()` @ execute_cmd.c:16 → definition outside current scan
       ↳ memset(&plan, 0, sizeof(plan))
    - `strncpy()` @ execute_cmd.c:17 → definition outside current scan
       ↳ strncpy(plan.command, command, sizeof(plan.command) - 1)
    - `prepare_environment()` @ execute_cmd.c:18 → defined in `execute_cmd.c:23`
       ↳ prepare_environment(&plan)
    - `run_steps()` @ execute_cmd.c:19 → defined in `execute_cmd.c:29`
       ↳ run_steps(&plan)
    - `persist_telemetry()` @ execute_cmd.c:20 → defined in `execute_cmd.c:37`
       ↳ persist_telemetry(&plan)
2. `load_profile()` @ shell.c:16 → defined in `shell.c:34`
   ↳ load_profile("/etc/miniphi.rc")
   ↪ expands into `load_profile()` (shell.c:34)
  - `printf()` @ shell.c:35 → definition outside current scan
     ↳ printf("[shell] sourcing profile %s\\n", path)
  - `execute_command_internal()` @ shell.c:36 → defined in `execute_cmd.c:14`
     ↳ execute_command_internal("source-profile")
     ↪ expands into `execute_command_internal()` (execute_cmd.c:14)
    - `memset()` @ execute_cmd.c:16 → definition outside current scan
       ↳ memset(&plan, 0, sizeof(plan))
    - `strncpy()` @ execute_cmd.c:17 → definition outside current scan
       ↳ strncpy(plan.command, command, sizeof(plan.command) - 1)
    - `prepare_environment()` @ execute_cmd.c:18 → defined in `execute_cmd.c:23`
       ↳ prepare_environment(&plan)
    - `run_steps()` @ execute_cmd.c:19 → defined in `execute_cmd.c:29`
       ↳ run_steps(&plan)
    - `persist_telemetry()` @ execute_cmd.c:20 → defined in `execute_cmd.c:37`
       ↳ persist_telemetry(&plan)
3. `reader_loop()` @ shell.c:17 → defined in `eval.c:10`
   ↳ reader_loop()
   ↪ expands into `reader_loop()` (eval.c:10)
  - `read_command()` @ eval.c:12 → defined in `eval.c:23`
     ↳ read_command(buffer, sizeof(buffer))
     ↪ expands into `read_command()` (eval.c:23)
    - `strncpy()` @ eval.c:29 → definition outside current scan
       ↳ strncpy(buffer, commands[index], size - 1)
  - `validate_command()` @ eval.c:13 → defined in `eval.c:35`
     ↳ validate_command(buffer)
     ↪ expands into `validate_command()` (eval.c:35)
    - `strlen()` @ eval.c:36 → definition outside current scan
       ↳ strlen(command)
  - `normalize_command()` @ eval.c:17 → defined in `eval.c:39`
     ↳ normalize_command(buffer, normalized, sizeof(normalized))
     ↪ expands into `normalize_command()` (eval.c:39)
    - `strlen()` @ eval.c:40 → definition outside current scan
       ↳ strlen(command)
  - `execute_command_internal()` @ eval.c:18 → defined in `execute_cmd.c:14`
     ↳ execute_command_internal(normalized)
     ↪ expands into `execute_command_internal()` (execute_cmd.c:14)
    - `memset()` @ execute_cmd.c:16 → definition outside current scan
       ↳ memset(&plan, 0, sizeof(plan))
    - `strncpy()` @ execute_cmd.c:17 → definition outside current scan
       ↳ strncpy(plan.command, command, sizeof(plan.command) - 1)
    - `prepare_environment()` @ execute_cmd.c:18 → defined in `execute_cmd.c:23`
       ↳ prepare_environment(&plan)
    - `run_steps()` @ execute_cmd.c:19 → defined in `execute_cmd.c:29`
       ↳ run_steps(&plan)
    - `persist_telemetry()` @ execute_cmd.c:20 → defined in `execute_cmd.c:37`
       ↳ persist_telemetry(&plan)
4. `execute_command_internal()` @ shell.c:18 → defined in `execute_cmd.c:14`
   ↳ execute_command_internal("startup")
   ↪ expands into `execute_command_internal()` (execute_cmd.c:14)
  - `memset()` @ execute_cmd.c:16 → definition outside current scan
     ↳ memset(&plan, 0, sizeof(plan))
  - `strncpy()` @ execute_cmd.c:17 → definition outside current scan
     ↳ strncpy(plan.command, command, sizeof(plan.command) - 1)
  - `prepare_environment()` @ execute_cmd.c:18 → defined in `execute_cmd.c:23`
     ↳ prepare_environment(&plan)
     ↪ expands into `prepare_environment()` (execute_cmd.c:23)
    - `printf()` @ execute_cmd.c:24 → definition outside current scan
       ↳ printf("[executor] preparing environment for %s\\n", plan->command)
    - `record_metric()` @ execute_cmd.c:25 → defined in `execute_cmd.c:42`
       ↳ record_metric("prepare", plan->command)
  - `run_steps()` @ execute_cmd.c:19 → defined in `execute_cmd.c:29`
     ↳ run_steps(&plan)
     ↪ expands into `run_steps()` (execute_cmd.c:29)
    - `printf()` @ execute_cmd.c:30 → definition outside current scan
       ↳ printf("[executor] running primary step for %s\\n", plan->command)
    - `strcmp()` @ execute_cmd.c:32 → definition outside current scan
       ↳ strcmp(plan->command, "sync-jobs")
    - `record_metric()` @ execute_cmd.c:33 → defined in `execute_cmd.c:42`
       ↳ record_metric("jobs", "synchronized")
  - `persist_telemetry()` @ execute_cmd.c:20 → defined in `execute_cmd.c:37`
     ↳ persist_telemetry(&plan)
     ↪ expands into `persist_telemetry()` (execute_cmd.c:37)
    - `printf()` @ execute_cmd.c:38 → definition outside current scan
       ↳ printf("[executor] telemetry for %s (%d steps)\\n", plan->command, plan->steps)
    - `record_metric()` @ execute_cmd.c:39 → defined in `execute_cmd.c:42`
       ↳ record_metric("command", plan->command)
5. `dispatch_jobs()` @ shell.c:19 → defined in `shell.c:39`
   ↳ dispatch_jobs()
   ↪ expands into `dispatch_jobs()` (shell.c:39)
  - `printf()` @ shell.c:40 → definition outside current scan
     ↳ printf("[shell] dispatching async jobs\\n")
  - `sync_jobs()` @ shell.c:41 → defined in `jobs.c:3`
     ↳ sync_jobs()
     ↪ expands into `sync_jobs()` (jobs.c:3)
    - `printf()` @ jobs.c:4 → definition outside current scan
       ↳ printf("[jobs] syncing job table\\n")
  - `prune_jobs()` @ shell.c:42 → defined in `jobs.c:7`
     ↳ prune_jobs()
     ↪ expands into `prune_jobs()` (jobs.c:7)
    - `printf()` @ jobs.c:8 → definition outside current scan
       ↳ printf("[jobs] pruning completed jobs\\n")
6. `shutdown_shell()` @ shell.c:20 → defined in `shell.c:29`
   ↳ shutdown_shell()
   ↪ expands into `shutdown_shell()` (shell.c:29)
  - `printf()` @ shell.c:30 → definition outside current scan
     ↳ printf("[shell] shutting down runtime\\n")
  - `flush_telemetry()` @ shell.c:31 → defined in `telemetry.c:3`
     ↳ flush_telemetry()
     ↪ expands into `flush_telemetry()` (telemetry.c:3)
    - `printf()` @ telemetry.c:4 → definition outside current scan
       ↳ printf("[telemetry] flushing buffered metrics\\n")

---
## Core execution pivots

## Reader loop (`eval.c::reader_loop`)
- File: `eval.c`
- Line: 10
- Signature: `int reader_loop(void)`
- Body length: 12 line(s)
- Call trace captured with depth-limited expansion to show downstream dispatch order.

### Ordered call trace
1. `read_command()` @ eval.c:12 → defined in `eval.c:23`
   ↳ read_command(buffer, sizeof(buffer))
   ↪ expands into `read_command()` (eval.c:23)
  - `strncpy()` @ eval.c:29 → definition outside current scan
     ↳ strncpy(buffer, commands[index], size - 1)
2. `validate_command()` @ eval.c:13 → defined in `eval.c:35`
   ↳ validate_command(buffer)
   ↪ expands into `validate_command()` (eval.c:35)
  - `strlen()` @ eval.c:36 → definition outside current scan
     ↳ strlen(command)
3. `normalize_command()` @ eval.c:17 → defined in `eval.c:39`
   ↳ normalize_command(buffer, normalized, sizeof(normalized))
   ↪ expands into `normalize_command()` (eval.c:39)
  - `strlen()` @ eval.c:40 → definition outside current scan
     ↳ strlen(command)
4. `execute_command_internal()` @ eval.c:18 → defined in `execute_cmd.c:14`
   ↳ execute_command_internal(normalized)
   ↪ expands into `execute_command_internal()` (execute_cmd.c:14)
  - `memset()` @ execute_cmd.c:16 → definition outside current scan
     ↳ memset(&plan, 0, sizeof(plan))
  - `strncpy()` @ execute_cmd.c:17 → definition outside current scan
     ↳ strncpy(plan.command, command, sizeof(plan.command) - 1)
  - `prepare_environment()` @ execute_cmd.c:18 → defined in `execute_cmd.c:23`
     ↳ prepare_environment(&plan)
  - `run_steps()` @ execute_cmd.c:19 → defined in `execute_cmd.c:29`
     ↳ run_steps(&plan)
  - `persist_telemetry()` @ execute_cmd.c:20 → defined in `execute_cmd.c:37`
     ↳ persist_telemetry(&plan)

## Executor core (`execute_cmd.c::execute_command_internal`)
- File: `execute_cmd.c`
- Line: 14
- Signature: `void execute_command_internal(const char *command)`
- Body length: 8 line(s)
- Call trace captured with depth-limited expansion to show downstream dispatch order.

### Ordered call trace
1. `memset()` @ execute_cmd.c:16 → definition outside current scan
   ↳ memset(&plan, 0, sizeof(plan))
2. `strncpy()` @ execute_cmd.c:17 → definition outside current scan
   ↳ strncpy(plan.command, command, sizeof(plan.command) - 1)
3. `prepare_environment()` @ execute_cmd.c:18 → defined in `execute_cmd.c:23`
   ↳ prepare_environment(&plan)
   ↪ expands into `prepare_environment()` (execute_cmd.c:23)
  - `printf()` @ execute_cmd.c:24 → definition outside current scan
     ↳ printf("[executor] preparing environment for %s\\n", plan->command)
  - `record_metric()` @ execute_cmd.c:25 → defined in `execute_cmd.c:42`
     ↳ record_metric("prepare", plan->command)
4. `run_steps()` @ execute_cmd.c:19 → defined in `execute_cmd.c:29`
   ↳ run_steps(&plan)
   ↪ expands into `run_steps()` (execute_cmd.c:29)
  - `printf()` @ execute_cmd.c:30 → definition outside current scan
     ↳ printf("[executor] running primary step for %s\\n", plan->command)
  - `strcmp()` @ execute_cmd.c:32 → definition outside current scan
     ↳ strcmp(plan->command, "sync-jobs")
  - `record_metric()` @ execute_cmd.c:33 → defined in `execute_cmd.c:42`
     ↳ record_metric("jobs", "synchronized")
5. `persist_telemetry()` @ execute_cmd.c:20 → defined in `execute_cmd.c:37`
   ↳ persist_telemetry(&plan)
   ↪ expands into `persist_telemetry()` (execute_cmd.c:37)
  - `printf()` @ execute_cmd.c:38 → definition outside current scan
     ↳ printf("[executor] telemetry for %s (%d steps)\\n", plan->command, plan->steps)
  - `record_metric()` @ execute_cmd.c:39 → defined in `execute_cmd.c:42`
     ↳ record_metric("command", plan->command)

---
## Methodology & next steps
- AST-guided traversal keeps statements ordered, so startup, reader, and executor flows retain the real control-path.
- Depth is currently limited to two hops to avoid combinatorial explosion; bump FLOW_DEPTH for deeper recursion once compression strategies mature.
- Attach `.miniphi/benchmarks` mirrors to reuse this breakdown inside orchestrated reasoning tasks without rescanning 5K+ line files.
- Future enhancement: annotate each call with surrounding comments to add semantic context (e.g., why traps or job control toggles occur).

---
Report crafted by benchmark/scripts/bash-flow-explain.js.