# Bash Sample Execution Flow (Benchmark Pass 003)

- Generated: 2025-11-11T19:16:31Z (UTC)  
- Scope: `samples/bash` root plus first-level subdirectories only (depth ≤ 1) as required by `WHY_SAMPLES.md`.  
- Method: manual static analysis tied to the benchmark harness; no source edits inside the Bash tree.  
- Context: Windows host with LM Studio endpoint at `http://127.0.0.1:1234`, default Phi-4 reasoning-plus context 4096 tokens.

> Goal: capture a *detailed* walk from `main` through the orchestration layers that Bash uses to parse, execute, and retire commands, while preserving notes that can be fed into `.miniphi/` for future prompt chunking.

---

## 1. Scope & Directory Snapshot (Depth 1)

Scanning stopped at the first nested level. The most relevant top-level components encountered were:

| Path | Purpose (high level) |
| --- | --- |
| `samples/bash/shell.c` | Primary entry point (`main`), lifecycle management, CLI parsing, trap wiring, startup file sequencing, reader loop invocation. |
| `samples/bash/eval.c` | Implements `reader_loop`, `read_command`, prompt expansion, here-doc collection, and pretty-print mode. |
| `samples/bash/execute_cmd.c` | Core executor: walks `COMMAND` trees, handles redirections/pipelines/subshell forks, dispatches builtins, functions, and external binaries. |
| `samples/bash/parser.*` (`parse.y`, generated `y.tab.c/h`) | Grammar + `yyparse`, builds the `COMMAND` AST consumed by the executor. |
| `samples/bash/builtins/` | Specialized builtins (`eval`, `set`, `trap`, etc.) plus helpers shared through `builtins/common.h`. |
| `samples/bash/jobs.c`, `trap.c`, `redir.c`, `variables.c`, `findcmd.c`, `hashcmd.c`, `mailcheck.c`, `input.c` | Job control, trap plumbing, redirection machinery, environment table management, command lookup, async mail notification, and input buffering. |
| `samples/bash/lib`, `samples/bash/include` | Support libs (readline, glob, tilde) and headers; inspected only at directory level per depth cap. |

All findings below reference only these files/directories (depth 0–1) to satisfy the benchmark constraint.

---

## 2. Entry Pipeline (`samples/bash/shell.c`)

### 2.1 Early Guard Rails

`main` (lines ~371–840) starts with duplicated signatures to accommodate platforms with/without `char **env`. It immediately:

1. Installs a `setjmp_nosigs` guard into `top_level` so early signals (notably `SIGINT`) can unwind without corrupting startup state.
2. Enables extended tracing (`xtrace_init`) and verifies the controlling TTY (`check_dev_tty`).
3. On Cygwin, `_cygwin32_check_tmp` ensures `/tmp` exists.
4. Sets locale defaults (`set_default_locale`) and caches `running_setuid` for later privilege shedding.

### 2.2 Argument & Mode Parsing

`parse_long_options` sweeps GNU-style flags (`--login`, `--version`, `--help`, etc.) before `parse_shell_options` processes POSIX single-letter switches. Flags that require post-processing (`-c`, `-l`, `-s`, `-O`, `-o`) set globals (`want_pending_command`, `make_login_shell`, `read_from_stdin`) consumed later in initialization.

Interactive detection (`init_interactive` vs `init_noninteractive`) follows POSIX.2 rules: no `-c`, optional `-s`, stdin/stderr must be tty, unless `-i` forces interactivity. Resulting flags feed prompt logic, history activation, and mail timers.

### 2.3 Login / POSIX Behavior

`login_shell` flips sign if `--login` is explicit. If `POSIXLY_CORRECT` is present, `bind_variable("POSIXLY_CORRECT","y")` and `sv_strict_posix` enable POSIX strict mode: interactive comments, alias semantics, and environment imports align with spec expectations.

### 2.4 shell_initialize (lines ~1913–1990)

`shell_initialize` is the central bootstrapper:

- Line-buffer stdout/stderr once (`sh_setlinebuf`).
- Sort builtin tables via `initialize_shell_builtins` for binary search lookups inside `find_shell_builtin`.
- Install trap and signal handlers (`initialize_traps`, `initialize_signals`).
- Populate `current_host_name` and `current_user` lazily (interactive shells eagerly hit `get_current_user_info`).
- Initialize tilde expansion (`tilde_initialize`), shell/global variables (`initialize_shell_variables`), job-control state (`initialize_job_control`), the shell input stack (`initialize_bash_input`), and option registries (`initialize_shell_options`, `initialize_bashopts`). Privileged or restricted shells skip importing functions/options from the environment.

Because `main` may re-enter (`shell_reinitialize`) when the binary is reused recursively, the initializer must be idempotent and aware of `shell_initialized`.

### 2.5 Compatibility & Startup Files

After `compat_init`, `setjmp_sigs(top_level)` wraps `run_startup_files`. `locally_skip_execution` and `running_setuid` gate startup file execution (setuid shells avoid sourcing user files). When sourcing scripts, `$0` swaps to the script path for improved diagnostics. Post-startup, `act_like_sh` toggles strict POSIX again if the binary is invoked as `sh`.

### 2.6 Input Binding & Execution Modes

`cmd_init` and `uwp_init` allocate command caches and unwind-protect frames before any user code runs. Then `main` bifurcates:

- `command_execution_string` (from `-c`) -> `with_input_from_string(...); goto read_and_execute;`
- Script argument -> `open_shell_script`.
- No arguments but non-interactive -> treat stdin as buffered script.

`set_bash_input` finalizes the input stream and, when `debugging_mode` is set, `start_debugger` begins tracing.

Interactive shells then activate mail timers, history (`bash_initialize_history`, `load_history`), and terminal state watchers (`get_tty_state`). Finally, `reader_loop()` takes over; upon returning, `exit_shell(last_command_exit_value)` performs cleanup (trap[0], history persistence, job termination, `sh_exit`).

---

## 3. Reader Loop (`samples/bash/eval.c`)

`reader_loop` is a structured event loop that keeps consuming commands until EOF or a fatal jump occurs:

1. Increments `indirection_level` (used to detect recursion depth and to propagate `set -e` behavior).
2. Enters a `while (EOF_Reached == 0)` loop guarded by `setjmp_nosigs(top_level)`. Jump codes handled:
   - `ERREXIT`, `FORCE_EOF`, `EXITPROG`, `EXITBLTIN` → break loop, propagate exit.
   - `DISCARD` → free partially parsed commands, reset errno, re-arm traps.
   - Defaults route through `command_error("reader_loop", ...)`.
3. On each iteration, `run_pending_traps()` may re-arm signal handlers. `read_command()` kicks off parsing:
   - If interactive, consult `$TMOUT` to install `SIGALRM` timeouts (`alrm_catcher`).
   - Calls `parse_command()` (`yyparse` + `gather_here_documents`) to populate `global_command`.
4. After a successful parse:
   - Interactive shells expand `$PS0` before executing to mimic `ksh` debugging prompts.
   - `current_command_number++`, `stdin_redir = 0`, `execute_command(current_command)`.
   - `dispose_command` cleans AST nodes regardless of success/failure.
5. Special handling:
   - `ignoreeof` support intercepts Ctrl-D in interactive mode; `handle_ignoreeof` can clear `EOF_Reached`.
   - Non-interactive parse errors force EOF to terminate scripts.
6. If `just_one_command` is set (`-c` or `-s`), `EOF_Reached` flips after first execution to exit promptly.

This loop is the only place where AST objects created in `parse_command` are executed, ensuring a single-threaded evaluation pipeline that the rest of the shell assumes.

---

## 4. Parsing Stack (`samples/bash/parse.y`, `y.tab.c`)

While the benchmark forbids deep directory traversal, the exposed parser files at depth 1 show:

- `yyparse()` (generated from `parse.y`) consumes tokens via `bash-yyparse` macros, building `COMMAND` nodes defined in `command.h`.
- `parse_command()` (lines ~360–420 in `eval.c`) manages bookkeeping flags (`parsing_command`, `need_here_doc`) around `yyparse`.
- Here-documents accumulate through `gather_here_documents` post-parse.
- Error recovery uses `jump_to_top_level(FORCE_EOF)` for fatal lexical states (see `parse.y:4596`).

Understanding this layer is critical because every executor path assumes well-formed `COMMAND` trees; malformed nodes typically bubble up as `CMDERR_BADTYPE` in `execute_command_internal`.

---

## 5. Execution Layer (`samples/bash/execute_cmd.c`)

### 5.1 `execute_command`

This thin wrapper allocates an `fd_bitmap` (tracks descriptors that must be closed after forking) and calls `execute_command_internal` with synchronous settings. After execution it disposes bitmaps, prunes process-substitution FIFOs when permissible, and returns the resulting status.

### 5.2 `execute_command_internal`

Key responsibilities:

1. **Pre-flight checks**: bail if the shell is currently `breaking`/`continuing`, or if `read_but_dont_execute` is set (e.g., `bash -n`). Null commands short-circuit to success.
2. **Command flags**: handle `CMD_INVERT_RETURN`, `CMD_IGNORE_RETURN`, and `set -e` interplay.
3. **Subshell & Pipeline Logic**:
   - Control structures or explicit subshell requests (`cm_subshell`, `CMD_WANT_SUBSHELL`, `CMD_FORCE_SUBSHELL`) may force a fork (`make_child`).
   - Asynchronous/time-measured commands optionally go through `time_command`, which wraps execution in another `setjmp` to gather resource usage.
4. **Redirection Handling**: `do_redirections(..., RX_ACTIVE|RX_UNDOABLE)` applies redirects, populating `redirection_undo_list` and `exec_redirection_undo_list`. Failures trigger `run_error_trap`, propagate exit statuses, and respect `set -e`.
5. **Command Dispatch**:
   - `cm_simple` routes to `execute_simple_command`.
   - Compound forms call specialized helpers (`execute_pipeline`, `execute_connection`, `execute_for_command`, `execute_while_or_until`, `execute_case_command`, `execute_function`, `execute_intern_function`, etc.).
   - Job-control aware routines ensure process groups and terminal pgids remain consistent.
6. **Trap Awareness**: before and after execution, the function checks `signal_is_trapped(ERROR_TRAP)` and may adjust `line_number` for accurate debugging/trap reporting.
7. **Cleanup**: redirection undo frames unwind via `uw_cleanup_redirects`, FIFO snapshots restore when returning from functions or when `retain_fifos` is active, and `currently_executing_command` resets to avoid stale pointers inside traps.

### 5.3 Simple Commands (`execute_simple_command`)

This is the “meaty” path (lines ~4468–4920):

1. **Preparation**:
   - Formats the command via `print_simple_command`, caches it in `the_printed_command` for debugging/job listings.
   - Executes the `DEBUG` trap before evaluation, respecting `debugging_mode`.
   - Determines whether to fork early based on pipeline/background context to isolate variable assignments.
2. **Fork Strategy**:
   - Uses `make_child` to spawn asynchronous/pipelined children, inheriting `the_printed_command_except_trap` for job listings.
   - Sets `subshell_environment` bits (`SUBSHELL_FORK`, `SUBSHELL_PIPE`, `SUBSHELL_ASYNC`) so downstream code knows which cleanups to run.
   - Applies `do_piping` to hook `pipe_in`/`pipe_out`.
3. **Word Expansion & Lookup**:
   - Expands the command words, tracks quotes, and obtains the command name for builtin/function lookup.
   - Honor temporary variable assignments (`temporary_env`), merging them if POSIX mandates persistence (special builtins).
4. **Builtins vs Functions vs External**:
   - `find_shell_builtin` and `find_function` provide candidates. Special builtins (`break`, `return`, `exec`, etc.) set `builtin_is_special`, affecting error semantics under `set -e`.
   - Builtins execute via `execute_builtin_or_function` (in-process). If already forked, `execute_subshell_builtin_or_function` runs them in the child with signal handlers reset.
   - If no builtin/function matches, control falls to `execute_from_filesystem`, composed of `hashcmd`/`findcmd` lookups, `maybe_make_export_env`, `hashing` heuristics, and finally `execute_disk_command` (`fork` + `execve`).
5. **Job Control Integration**:
   - Updates `last_asynchronous_pid`, `last_command_subst_pid`, and `pipestatus`.
   - When backgrounded, `setup_async_signals` disables SIGINT/SIGQUIT delivery to the job leader and ensures stdin redirection from `/dev/null` if the job did not specify one.
6. **Auto-`cd` convenience**:
   - If `autocd` and the first word is a directory, rewrites the command to `cd -- <dir>` by prepending tokens and re-dispatching as a builtin.

### 5.4 Compound & Flow Control Commands

Even within the depth cap we can follow the dispatch sites:

- `execute_pipeline` handles `cm_connection` nodes of type `pipe`, building FD pairs and recursively invoking `execute_command_internal`.
- `execute_connection` orchestrates `&&`, `||`, and `;` constructs, preserving short-circuit semantics.
- Loop nodes (`cm_for`, `cm_arith_for`, `cm_while`, `cm_until`, `cm_select`) live in the same file; each repeatedly calls `execute_command` on their test and body components, wiring `break`/`continue` through `breaking`/`continuing` globals.
- `execute_function` and `execute_intern_function` manage function-local scopes, environment saving/restoring, and recursion depth.
- `execute_case_command` matches words against patterns using `strmatch`/`glob` helpers from `lib`.

### 5.5 Redirection & Process Substitution (Depth 1 Glimpse)

`redir.c` (same directory) defines `do_redirections`, `stdin_redirects`, and undo helpers used above. `process_substitution` support interacts with FIFOs tracked by `copy_fifo_list`, `clear_fifo_list`, and `unlink_fifo_list`. Because we limited depth, only file references (not nested `lib/` implementations) were noted.

---

## 6. Supporting Subsystems (Depth ≤ 1 Notes)

- **`variables.c` / `variables.h`**: Manage `SHELL_VAR` structures, initialization via `/etc/profile`, `~/.bashrc`, assignment persistence for special builtins, and `temporary_env` merging.
- **`jobs.c` / `jobs.h`**: Provide process-group tracking, `%` job spec resolution, `describe_pid`, `hangup_all_jobs`, and cleanup invoked from both `main` (login exit path) and executors.
- **`trap.c` / `trap.h`**: Maintain trap tables, error and DEBUG traps referenced repeatedly in `execute_command_internal`.
- **`findcmd.c` / `hashcmd.c`**: Support `hash -r`, `hash -l`, hashed path lookup, and direct stat-based discovery invoked by `execute_disk_command`.
- **`mailcheck.c`**: `reset_mail_timer`, `init_mail_dates`, and threshold-based mail notifications called from `main` during interactive setup.
- **`input.c`**: Abstraction over file descriptors/streams for `bash_input`, including `with_input_from_string` used when `-c` is specified.
- **`builtins/`**: Contains loadables (`evalstring.c`, `hash.c`, etc.) referenced indirectly through function pointers registered during `initialize_shell_builtins`.

These modules complete the “one level deep” graph necessary to trace execution without descending into `lib/readline` or `support/` internals.

---

## 7. Observations & Benchmark Insights

1. **Control-Flow Depth**: Even with depth 1, the main-to-executor path spans `shell.c → eval.c → execute_cmd.c`, with numerous global flags bridging the files. Capturing these dependencies early is crucial for any automation or `.miniphi` summarizer chunking (each file is hundreds of KB).
2. **Trap + Error Interop**: The interplay between `set -e`, `CMD_INVERT_RETURN`, and `ERROR_TRAP` is delicate. The benchmark script currently only counts direct call names; it misses nuanced behaviors such as the deliberate suppression of `set -e` when `!` is applied (`CMD_IGNORE_RETURN`).
3. **Job Control Boundaries**: Depth-1 inspection reveals all public hooks (`initialize_job_control`, `end_job_control`, `describe_pid`). Without this context, EXPLAIN files risk mis-attributing background execution to parser code.
4. **Resource Timing Hooks**: `COMMAND_TIMING` blocks gate `time_command`, bridging asynchronous execs with `time` output; documenting these ensures later benchmarks can correlate pipeline timings with `.miniphi/health` snapshots.

---

## 8. Next Steps (For AI_REFERENCE + Implementation Roadmap)

1. **Augment Benchmark Script**: Enhance `benchmark/scripts/bash-flow-explain.js` to include `reader_loop` and `execute_command_internal` summaries instead of only listing call counts. This will better align automated output with the manual findings above.
2. **Chunked Memory Capture**: Store this EXPLAIN breakdown inside `.miniphi/benchmarks/bash` (new namespace) so subsequent tests can reuse the `main → reader_loop → execute_simple_command` narrative without re-reading 5000+ lines.
3. **Cross-check Builtins**: Within depth 1, catalog the most critical builtins (e.g., `eval`, `trap`, `set`, `exec`) and record how `execute_simple_command` flags them as “special” to support automated reasoning about `set -e` semantics.
4. **Integrate LM Studio Health Checks**: Before running future benchmarks, call the `/api/v0` status endpoint (via `LMStudioRestClient`) to snapshot model availability and context size. Storing this alongside EXPLAIN files will help correlate reasoning quality with model state.
5. **Document Parser Recovery Limits**: Produce a follow-up EXPLAIN focused on `parse.y` error recovery (still depth 1) so that future improvements know how `jump_to_top_level(FORCE_EOF)` affects benchmarking when intentionally malformed scripts are supplied.

These next steps are carried into `AI_REFERENCE.md` to keep the roadmap consistent with this benchmark cycle.

---

*Report authored during the “samples/bash” benchmark cycle requested in `WHY_SAMPLES.md`. Stored under `samples/bash-results/EXPLAIN-003.md` for future aggregation.* 
