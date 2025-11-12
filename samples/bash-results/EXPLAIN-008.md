# Bash Sample Execution Flow

- Generated at: 2025-11-11T19:34:07.425Z
- Source root: `samples\bash`
- Depth inspected: 1
- Files scanned: 62
- Main entries analyzed: 19

This report focuses on the first-level call graph anchored at `main` to satisfy the WHY_SAMPLES benchmark requirements.

## Entry Point: array.c (line 1137)
Signature: `int
main(int c, char **v)`

### Direct Calls
- `printf()` called 17 time(s) -> definition not found within depth
- `print_array()` called 12 time(s) -> print_array(ARRAY *a) (in array.c:1133)
- `array_insert()` called 11 time(s) -> array_insert(ARRAY *a, arrayind_t i, char *v) (in array.c:516)
- `array_dispose()` called 6 time(s) -> array_dispose(ARRAY *a) (in array.c:115)
- `free()` called 5 time(s) -> definition not found within depth
- `array_dispose_element()` called 4 time(s) -> array_dispose_element(ARRAY_ELEMENT *ae) (in array.c:504)
- `array_from_string()` called 4 time(s) -> array_from_string(char *s, char *sep) (in array.c:1014)
- `array_to_string()` called 4 time(s) -> array_to_string (ARRAY *a, char *sep, int quoted) (in array.c:1000)
- `array_shift()` called 3 time(s) -> array_shift(ARRAY *a, int n, int flags) (in array.c:193)
- `array_remove()` called 2 time(s) -> array_remove(ARRAY *a, arrayind_t i) (in array.c:602)
- `array_rshift()` called 2 time(s) -> array_rshift (ARRAY *a, int n, char *s) (in array.c:251)
- `element_forw()` called 2 time(s) -> element_forw(ARRAY *a, arrayind_t ind) (in array2.c:877)
- `array_copy()` called 1 time(s) -> array_copy(ARRAY *a) (in array.c:125)
- `array_create()` called 1 time(s) -> array_create(void) (in array.c:81)
- `array_num_elements()` called 1 time(s) -> definition not found within depth
- `array_to_assign()` called 1 time(s) -> array_to_assign (ARRAY *a, int quoted) (in array.c:948)

## Entry Point: array2.c (line 1195)
Signature: `int
main(int c, char **v)`

### Direct Calls
- `printf()` called 17 time(s) -> definition not found within depth
- `print_array()` called 12 time(s) -> print_array(ARRAY *a) (in array.c:1133)
- `array_insert()` called 11 time(s) -> array_insert(ARRAY *a, arrayind_t i, char *v) (in array.c:516)
- `array_dispose()` called 6 time(s) -> array_dispose(ARRAY *a) (in array.c:115)
- `free()` called 5 time(s) -> definition not found within depth
- `array_dispose_element()` called 4 time(s) -> array_dispose_element(ARRAY_ELEMENT *ae) (in array.c:504)
- `array_from_string()` called 4 time(s) -> array_from_string(char *s, char *sep) (in array.c:1014)
- `array_to_string()` called 4 time(s) -> array_to_string (ARRAY *a, char *sep, int quoted) (in array.c:1000)
- `array_shift()` called 3 time(s) -> array_shift(ARRAY *a, int n, int flags) (in array.c:193)
- `array_remove()` called 2 time(s) -> array_remove(ARRAY *a, arrayind_t i) (in array.c:602)
- `array_rshift()` called 2 time(s) -> array_rshift (ARRAY *a, int n, char *s) (in array.c:251)
- `element_forw()` called 2 time(s) -> element_forw(ARRAY *a, arrayind_t ind) (in array2.c:877)
- `array_copy()` called 1 time(s) -> array_copy(ARRAY *a) (in array.c:125)
- `array_create()` called 1 time(s) -> array_create(void) (in array.c:81)
- `array_num_elements()` called 1 time(s) -> definition not found within depth
- `array_to_assign()` called 1 time(s) -> array_to_assign (ARRAY *a, int quoted) (in array.c:948)

## Entry Point: braces.c (line 895)
Signature: `main (int c, char **v)`

### Direct Calls
- `strlen()` called 2 time(s) -> definition not found within depth
- `brace_expand()` called 1 time(s) -> brace_expand (char *text) (in braces.c:104)
- `fgets()` called 1 time(s) -> definition not found within depth
- `fprintf()` called 1 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `printf()` called 1 time(s) -> definition not found within depth
- `strncmp()` called 1 time(s) -> strncmp (assign + equal_offset + 2, ") (in variables.c:4987)
- `strvec_dispose()` called 1 time(s) -> definition not found within depth

## Entry Point: builtins\gen-helpfiles.c (line 102)
Signature: `int
main (int argc, char **argv)`

### Direct Calls
- `strcmp()` called 3 time(s) -> definition not found within depth
- `exit()` called 2 time(s) -> definition not found within depth
- `fprintf()` called 1 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `write_helpfiles()` called 1 time(s) -> write_helpfiles (struct builtin *builtins) (in builtins\gen-helpfiles.c:145)

## Entry Point: builtins\getopt.c (line 281)
Signature: `int
main (int argc, char **argv)`

### Direct Calls
- `printf()` called 9 time(s) -> definition not found within depth
- `exit()` called 1 time(s) -> definition not found within depth
- `sh_getopt()` called 1 time(s) -> sh_getopt (int argc, char *const *argv, const char *optstring) (in builtins\getopt.c:114)

## Entry Point: builtins\mkbuiltins.c (line 226)
Signature: `int
main (int argc, char **argv)`

### Direct Calls
- `strcmp()` called 10 time(s) -> definition not found within depth
- `fopen()` called 4 time(s) -> definition not found within depth
- `fprintf()` called 4 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `exit()` called 3 time(s) -> definition not found within depth
- `fclose()` called 3 time(s) -> definition not found within depth
- `file_error()` called 2 time(s) -> file_error (char *filename) (in builtins\mkbuiltins.c:977)
- `strlen()` called 2 time(s) -> definition not found within depth
- `xmalloc()` called 2 time(s) -> xmalloc(size_t n) (in braces.c:879)
- `extract_info()` called 1 time(s) -> extract_info (char *filename, FILE *structfile, FILE *externfile) (in builtins\mkbuiltins.c:514)
- `free()` called 1 time(s) -> definition not found within depth
- `getpid()` called 1 time(s) -> definition not found within depth
- `rename()` called 1 time(s) -> rename (char *from, char *to) (in builtins\mkbuiltins.c:1602)
- `sprintf()` called 1 time(s) -> definition not found within depth
- `strcat()` called 1 time(s) -> definition not found within depth
- `strcpy()` called 1 time(s) -> definition not found within depth
- `write_file_footers()` called 1 time(s) -> write_file_footers (FILE *structfile, FILE *externfile) (in builtins\mkbuiltins.c:1157)
- `write_file_headers()` called 1 time(s) -> write_file_headers (FILE *structfile, FILE *externfile) (in builtins\mkbuiltins.c:1131)
- `write_helpfiles()` called 1 time(s) -> write_helpfiles (struct builtin *builtins) (in builtins\gen-helpfiles.c:145)
- `write_longdocs()` called 1 time(s) -> write_longdocs (FILE *stream, ARRAY *builtins) (in builtins\mkbuiltins.c:1276)

## Entry Point: builtins\psize.c (line 55)
Signature: `int
main (int argc, char **argv)`

### Direct Calls
- `signal()` called 1 time(s) -> definition not found within depth
- `write()` called 1 time(s) -> definition not found within depth

## Entry Point: expr.c (line 1656)
Signature: `main (int argc, char **argv)`

### Direct Calls
- `exit()` called 2 time(s) -> definition not found within depth
- `_()` called 1 time(s) -> definition not found within depth
- `evalexp()` called 1 time(s) -> evalexp (const char *expr, int flags, int *validp) (in expr.c:417)
- `fprintf()` called 1 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `printf()` called 1 time(s) -> definition not found within depth
- `setjmp()` called 1 time(s) -> definition not found within depth

## Entry Point: hashlib.c (line 476)
Signature: `int
main (int c, char **v)`

### Direct Calls
- `hash_create()` called 2 time(s) -> hash_create (int buckets) (in hashlib.c:62)
- `hash_pstats()` called 2 time(s) -> hash_pstats (HASH_TABLE *table, char *name) (in hashlib.c:415)
- `defined()` called 1 time(s) -> defined (HANDLE_MULTIBYTE) (in bashline.c:4132)
- `exit()` called 1 time(s) -> definition not found within depth
- `fgets()` called 1 time(s) -> definition not found within depth
- `fprintf()` called 1 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `free()` called 1 time(s) -> definition not found within depth
- `hash_copy()` called 1 time(s) -> hash_copy (HASH_TABLE *table, sh_copy_func_t *cpdata) (in hashlib.c:174)
- `hash_flush()` called 1 time(s) -> hash_flush (HASH_TABLE *table, sh_free_func_t *free_data) (in hashlib.c:356)
- `hash_insert()` called 1 time(s) -> hash_insert (char *string, HASH_TABLE *table, int flags) (in hashlib.c:318)
- `savestring()` called 1 time(s) -> definition not found within depth

## Entry Point: mksyntax.c (line 291)
Signature: `int
main(int argc, char **argv)`

### Direct Calls
- `fprintf()` called 3 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `exit()` called 2 time(s) -> definition not found within depth
- `dump_lsyntax()` called 1 time(s) -> dump_lsyntax (FILE *fp) (in mksyntax.c:274)
- `fclose()` called 1 time(s) -> definition not found within depth
- `fopen()` called 1 time(s) -> definition not found within depth
- `getopt()` called 1 time(s) -> definition not found within depth
- `load_lsyntax()` called 1 time(s) -> load_lsyntax (void) (in mksyntax.c:203)
- `strerror()` called 1 time(s) -> strerror(int e) (in support\man2html.c:128)
- `strrchr()` called 1 time(s) -> definition not found within depth
- `usage()` called 1 time(s) -> usage(void) (in mksyntax.c:84)

## Entry Point: shell.c (line 369)
Signature: `int
main (int argc, char **argv)`

### Direct Calls
- `defined()` called 16 time(s) -> defined (HANDLE_MULTIBYTE) (in bashline.c:4132)
- `USE_VAR()` called 6 time(s) -> definition not found within depth
- `exit()` called 5 time(s) -> definition not found within depth
- `exit_shell()` called 5 time(s) -> exit_shell (int s) (in shell.c:985)
- `bind_args()` called 3 time(s) -> bind_args (char **argv, int arg_start, int arg_end, int start_index) (in shell.c:1488)
- `fileno()` called 3 time(s) -> definition not found within depth
- `get_string_value()` called 3 time(s) -> get_string_value () (in expr.c:1654)
- `STREQ()` called 3 time(s) -> definition not found within depth
- `_()` called 2 time(s) -> definition not found within depth
- `bind_variable()` called 2 time(s) -> bind_variable () (in expr.c:1652)
- `getenv()` called 2 time(s) -> definition not found within depth
- `isatty()` called 2 time(s) -> definition not found within depth
- `savestring()` called 2 time(s) -> definition not found within depth
- `setjmp_nosigs()` called 2 time(s) -> definition not found within depth
- `setjmp_sigs()` called 2 time(s) -> definition not found within depth
- `start_debugger()` called 2 time(s) -> start_debugger (void) (in shell.c:1547)
- `STREQN()` called 2 time(s) -> STREQN ("() (in variables.c:403)
- `strstr()` called 2 time(s) -> definition not found within depth
- `sv_strict_posix()` called 2 time(s) -> sv_strict_posix (const char *name) (in variables.c:6257)
- `unbind_variable()` called 2 time(s) -> unbind_variable (const char *name) (in variables.c:3788)
- `_cygwin32_check_tmp()` called 1 time(s) -> _cygwin32_check_tmp (void) (in shell.c:354)
- `bash_initialize_history()` called 1 time(s) -> bash_initialize_history (void) (in bashhist.c:273)
- `change_flag()` called 1 time(s) -> change_flag (int flag, int on_or_off) (in flags.c:226)
- `check_dev_tty()` called 1 time(s) -> check_dev_tty (void) (in general.c:630)
- `cmd_init()` called 1 time(s) -> cmd_init (void) (in make_cmd.c:65)

## Entry Point: support\bashversion.c (line 59)
Signature: `int
main (int argc, char **argv)`

### Direct Calls
- `printf()` called 5 time(s) -> definition not found within depth
- `exit()` called 4 time(s) -> definition not found within depth
- `usage()` called 3 time(s) -> usage(void) (in mksyntax.c:84)
- `show_shell_version()` called 2 time(s) -> show_shell_version (int extended) (in version.c:88)
- `getopt()` called 1 time(s) -> definition not found within depth
- `shell_version_string()` called 1 time(s) -> shell_version_string (void) (in version.c:65)
- `strchr()` called 1 time(s) -> definition not found within depth
- `strcpy()` called 1 time(s) -> definition not found within depth
- `strrchr()` called 1 time(s) -> definition not found within depth

## Entry Point: support\man2html.c (line 3996)
Signature: `int
main(int argc, char **argv)`

### Direct Calls
- `fputs()` called 5 time(s) -> definition not found within depth
- `out_html()` called 5 time(s) -> out_html(char *c) (in support\man2html.c:787)
- `exit()` called 4 time(s) -> definition not found within depth
- `fprintf()` called 2 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `usage()` called 2 time(s) -> usage(void) (in mksyntax.c:84)
- `change_to_font()` called 1 time(s) -> change_to_font(int nr) (in support\man2html.c:848)
- `change_to_size()` called 1 time(s) -> change_to_size(int nr) (in support\man2html.c:894)
- `fclose()` called 1 time(s) -> definition not found within depth
- `fopen()` called 1 time(s) -> definition not found within depth
- `getopt()` called 1 time(s) -> definition not found within depth
- `outputPageFooter()` called 1 time(s) -> outputPageFooter(char *l, char *c, char *r) (in support\man2html.c:2193)
- `print_sig()` called 1 time(s) -> print_sig(void) (in support\man2html.c:449)
- `read_man_page()` called 1 time(s) -> read_man_page(char *filename) (in support\man2html.c:514)
- `scan_troff()` called 1 time(s) -> scan_troff(char *c, int san, char **result) (in support\man2html.c:3767)
- `strerror()` called 1 time(s) -> strerror(int e) (in support\man2html.c:128)

## Entry Point: support\mksignames.c (line 70)
Signature: `int
main (int argc, char **argv)`

### Direct Calls
- `exit()` called 3 time(s) -> definition not found within depth
- `fprintf()` called 2 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `defined()` called 1 time(s) -> defined (HANDLE_MULTIBYTE) (in bashline.c:4132)
- `fopen()` called 1 time(s) -> definition not found within depth
- `initialize_signames()` called 1 time(s) -> initialize_signames (void) (in support\signames.c:70)
- `write_signames()` called 1 time(s) -> write_signames (FILE *stream) (in support\mksignames.c:48)

## Entry Point: support\printenv.c (line 31)
Signature: `int
main (int argc, char **argv)`

### Direct Calls
- `exit()` called 3 time(s) -> definition not found within depth
- `puts()` called 2 time(s) -> definition not found within depth
- `strlen()` called 1 time(s) -> definition not found within depth
- `strncmp()` called 1 time(s) -> strncmp (assign + equal_offset + 2, ") (in variables.c:4987)

## Entry Point: support\recho.c (line 30)
Signature: `int
main(int argc, char **argv)`

### Direct Calls
- `printf()` called 2 time(s) -> definition not found within depth
- `exit()` called 1 time(s) -> definition not found within depth
- `strprint()` called 1 time(s) -> strprint(char *str) (in support\recho.c:46)

## Entry Point: support\siglen.c (line 5)
Signature: `int
main(int argc, char **argv)`

### Direct Calls
- `printf()` called 2 time(s) -> definition not found within depth
- `exit()` called 1 time(s) -> definition not found within depth
- `strcmp()` called 1 time(s) -> definition not found within depth
- `strlen()` called 1 time(s) -> definition not found within depth
- `strsignal()` called 1 time(s) -> definition not found within depth

## Entry Point: support\xcase.c (line 39)
Signature: `int
main(int ac, char **av)`

### Direct Calls
- `exit()` called 3 time(s) -> definition not found within depth
- `fprintf()` called 2 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `fopen()` called 1 time(s) -> definition not found within depth
- `getc()` called 1 time(s) -> definition not found within depth
- `getopt()` called 1 time(s) -> definition not found within depth
- `islower()` called 1 time(s) -> definition not found within depth
- `isupper()` called 1 time(s) -> definition not found within depth
- `putchar()` called 1 time(s) -> definition not found within depth
- `setbuf()` called 1 time(s) -> definition not found within depth
- `strerror()` called 1 time(s) -> strerror(int e) (in support\man2html.c:128)
- `tolower()` called 1 time(s) -> definition not found within depth
- `toupper()` called 1 time(s) -> definition not found within depth

## Entry Point: support\zecho.c (line 22)
Signature: `int
main(int argc, char **argv)`

### Direct Calls
- `putchar()` called 2 time(s) -> definition not found within depth
- `exit()` called 1 time(s) -> definition not found within depth
- `printf()` called 1 time(s) -> definition not found within depth

---
## Global Observations

**Top call targets across depth-1 scan**
- `printf()`: 55 hits _(definition outside depth)_
- `exit()`: 36 hits _(definition outside depth)_
- `print_array()`: 24 hits
- `array_insert()`: 22 hits
- `defined()`: 18 hits
- `fprintf()`: 17 hits
- `strcmp()`: 14 hits _(definition outside depth)_
- `free()`: 13 hits _(definition outside depth)_
- `array_dispose()`: 12 hits
- `array_dispose_element()`: 8 hits

**Follow-up candidates (missing definitions within depth limit)**
- `printf()`: 55 reference(s) without a local definition
- `exit()`: 36 reference(s) without a local definition
- `strcmp()`: 14 reference(s) without a local definition
- `free()`: 13 reference(s) without a local definition
- `fopen()`: 8 reference(s) without a local definition

---
## Focus Functions (depth ≤ 1)

### shell.c::main (entry pipeline)
- File: `shell.c` (line 369)
- Signature: `int
main (int argc, char **argv)`
- Body length: 461 line(s)
- Highlights:
  - Protects execution with `setjmp`/`longjmp` for error recovery.
  - Transfers control to `reader_loop()` to consume parsed commands.
  - Handles interactive/login startup files prior to main loop.
  - Supports `-c` string execution paths via `with_input_from_string()`.

**Direct call activity (top 15)**
- `defined()` × 16 → defined (HANDLE_MULTIBYTE) (bashline.c:4132)
- `USE_VAR()` × 6 → definition not found within depth
- `exit()` × 5 → definition not found within depth
- `exit_shell()` × 5 → exit_shell (int s) (shell.c:985)
- `bind_args()` × 3 → bind_args (char **argv, int arg_start, int arg_end, int start_index) (shell.c:1488)
- `fileno()` × 3 → definition not found within depth
- `get_string_value()` × 3 → get_string_value () (expr.c:1654)
- `STREQ()` × 3 → definition not found within depth
- `_()` × 2 → definition not found within depth
- `bind_variable()` × 2 → bind_variable () (expr.c:1652)
- `getenv()` × 2 → definition not found within depth
- `isatty()` × 2 → definition not found within depth
- `savestring()` × 2 → definition not found within depth
- `setjmp_nosigs()` × 2 → definition not found within depth
- `setjmp_sigs()` × 2 → definition not found within depth

### eval.c::reader_loop (command dispatcher)
- File: `eval.c` (line 59)
- Signature: `int
reader_loop (void)`
- Body length: 150 line(s)
- Highlights:
  - Protects execution with `setjmp`/`longjmp` for error recovery.

**Direct call activity (top 15)**
- `defined()` × 4 → defined (HANDLE_MULTIBYTE) (bashline.c:4132)
- `dispose_command()` × 3 → dispose_command (COMMAND *command) (dispose_cmd.c:36)
- `alloca()` × 2 → definition not found within depth
- `set_exit_status()` × 2 → set_exit_status (int s) (shell.c:1069)
- `command()` × 1 → definition not found within depth
- `command_error()` × 1 → command_error (const char *func, int code, int e, int flags) (error.c:421)
- `decode_prompt_string()` × 1 → decode_prompt_string (char *string, int is_prompt) (y.tab.c:8624)
- `dispose_used_env_vars()` × 1 → dispose_used_env_vars (void) (variables.c:4647)
- `execute_command()` × 1 → execute_command (COMMAND *command) (execute_cmd.c:445)
- `fflush()` × 1 → definition not found within depth
- `fprintf()` × 1 → fprintf (stream, "int %s () (builtins\mkbuiltins.c:1326)
- `free()` × 1 → definition not found within depth
- `handle_ignoreeof()` × 1 → handle_ignoreeof (int reset_prompt) (y.tab.c:9309)
- `read_command()` × 1 → read_command (void) (eval.c:382)
- `reset_local_contexts()` × 1 → reset_local_contexts (void) (variables.c:5395)

### execute_cmd.c::execute_command_internal (executor core)
- File: `execute_cmd.c` (line 622)
- Signature: `int
execute_command_internal (COMMAND *command, int asynchronous, int pipe_in, int pipe_out, struct fd_bitmap *fds_to_close)`
- Body length: 610 line(s)
- Highlights:
  - Performs redirect setup via `do_redirections()` before exec paths.
  - Ensures pending traps run before continuing execution.

**Direct call activity (top 15)**
- `defined()` × 28 → defined (HANDLE_MULTIBYTE) (bashline.c:4132)
- `run_pending_traps()` × 7 → run_pending_traps (void) (trap.c:328)
- `signal_is_trapped()` × 6 → signal_is_trapped(int s) (array.c:1037)
- `add_unwind_protect()` × 5 → add_unwind_protect (sh_uwfunc_t *cleanup, void *arg) (unwind_prot.c:127)
- `discard_unwind_frame()` × 5 → discard_unwind_frame (char *tag) (unwind_prot.c:111)
- `begin_unwind_frame()` × 4 → begin_unwind_frame (char *tag) (unwind_prot.c:104)
- `jump_to_top_level()` × 4 → jump_to_top_level (int value) (sig.c:490)
- `run_error_trap()` × 4 → run_error_trap (void) (trap.c:1320)
- `signal_is_ignored()` × 4 → signal_is_ignored (int sig) (trap.c:1614)
- `execute_command_internal()` × 3 → execute_command_internal (COMMAND *command, int asynchronous, int pipe_in, int pipe_out, struct fd_bitmap *fds_to_close) (execute_cmd.c:624)
- `FREE()` × 3 → definition not found within depth
- `savestring()` × 3 → definition not found within depth
- `subshell()` × 3 → definition not found within depth
- `wait_for()` × 3 → wait_for (pid_t pid, int flags) (jobs.c:3064)
- `alloca()` × 2 → definition not found within depth

---
Report crafted by benchmark/scripts/bash-flow-explain.js.