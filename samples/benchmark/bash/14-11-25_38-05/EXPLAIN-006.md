# Bash Sample Execution Flow

- Generated at: 2025-11-11T19:29:22.929Z
- Source root: `samples\bash`
- Depth inspected: 1
- Files scanned: 62
- Main entries analyzed: 22

This report focuses on the first-level call graph anchored at `main` to satisfy the WHY_SAMPLES benchmark requirements.

## Entry Point: array.c (line 1140)
Signature: `main(int c, char **v)`

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

## Entry Point: array2.c (line 1198)
Signature: `main(int c, char **v)`

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

## Entry Point: braces.c (line 897)
Signature: `main (int c, char **v)`

### Direct Calls
- `strlen()` called 2 time(s) -> definition not found within depth
- `brace_expand()` called 1 time(s) -> brace_expand (char *text) (in braces.c:104)
- `fgets()` called 1 time(s) -> definition not found within depth
- `fprintf()` called 1 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `printf()` called 1 time(s) -> definition not found within depth
- `strncmp()` called 1 time(s) -> strncmp (assign + equal_offset + 2, ") (in variables.c:4987)
- `strvec_dispose()` called 1 time(s) -> definition not found within depth

## Entry Point: builtins\gen-helpfiles.c (line 104)
Signature: `main (int argc, char **argv)`

### Direct Calls
- `strcmp()` called 3 time(s) -> definition not found within depth
- `exit()` called 2 time(s) -> definition not found within depth
- `fprintf()` called 1 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `write_helpfiles()` called 1 time(s) -> write_helpfiles (struct builtin *builtins) (in builtins\gen-helpfiles.c:145)

## Entry Point: builtins\getopt.c (line 284)
Signature: `main (int argc, char **argv)`

### Direct Calls
- `printf()` called 9 time(s) -> definition not found within depth
- `exit()` called 1 time(s) -> definition not found within depth
- `sh_getopt()` called 1 time(s) -> sh_getopt (int argc, char *const *argv, const char *optstring) (in builtins\getopt.c:114)

## Entry Point: builtins\mkbuiltins.c (line 228)
Signature: `main (int argc, char **argv)`

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

## Entry Point: builtins\psize.c (line 58)
Signature: `main (int argc, char **argv)`

### Direct Calls
- `signal()` called 1 time(s) -> definition not found within depth
- `write()` called 1 time(s) -> definition not found within depth

## Entry Point: execute_cmd.c (line 5528)
Signature: `main(). */
      result = setjmp_nosigs (top_level);

      /* Give the return builtin a place to jump to when executed in a subshell
         or pipeline */
      funcvalue = 0;
      if (return_catch_flag && builtin == return_builtin)
        funcvalue = setjmp_nosigs (return_catch);

      if (result == EXITPROG || result == EXITBLTIN)
	subshell_exit (last_command_exit_value);
#if 0	/* TAG:bash-5.4 https://savannah.gnu.org/support/?109840 6/5/2025 */
      else if (result == ERREXIT)
	subshell_exit (last_command_exit_value ? last_command_exit_value : EXECUTION_FAILURE);
#endif
      else if (result)
	subshell_exit (EXECUTION_FAILURE);
      else if (funcvalue)
	subshell_exit (return_catch_value);
      else`

### Direct Calls
- `execute_builtin()` called 1 time(s) -> execute_builtin (sh_builtin_func_t *builtin, WORD_LIST *words, int flags, int subshell) (in execute_cmd.c:4984)
- `execute_disk_command()` called 1 time(s) -> execute_disk_command (WORD_LIST *words, REDIRECT *redirects, char *command_line,
		      int pipe_in, int pipe_out, int async,
		      struct fd_bitmap *fds_t (in execute_cmd.c:5771)
- `fflush()` called 1 time(s) -> definition not found within depth
- `savestring()` called 1 time(s) -> definition not found within depth
- `subshell_exit()` called 1 time(s) -> subshell_exit (int s) (in shell.c:1054)

## Entry Point: expr.c (line 1658)
Signature: `main (int argc, char **argv)`

### Direct Calls
- `exit()` called 2 time(s) -> definition not found within depth
- `_()` called 1 time(s) -> definition not found within depth
- `evalexp()` called 1 time(s) -> evalexp (const char *expr, int flags, int *validp) (in expr.c:417)
- `fprintf()` called 1 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `printf()` called 1 time(s) -> definition not found within depth
- `setjmp()` called 1 time(s) -> definition not found within depth

## Entry Point: hashlib.c (line 479)
Signature: `main (int c, char **v)`

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

## Entry Point: locale.c (line 83)
Signature: `main(). */
void
set_default_locale (void)`

### Direct Calls
- `defined()` called 2 time(s) -> defined (HANDLE_MULTIBYTE) (in bashline.c:4132)
- `savestring()` called 2 time(s) -> definition not found within depth
- `bindtextdomain()` called 1 time(s) -> definition not found within depth
- `locale_isutf8()` called 1 time(s) -> locale_isutf8 (char *lspec) (in locale.c:617)
- `mblen()` called 1 time(s) -> definition not found within depth
- `setlocale()` called 1 time(s) -> definition not found within depth
- `textdomain()` called 1 time(s) -> definition not found within depth

## Entry Point: mksyntax.c (line 294)
Signature: `main(int argc, char **argv)`

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

## Entry Point: shell.c (line 105)
Signature: `main() */
#endif

extern int gnu_error_format;

/* Non-zero means that this shell has already been run; i.e. you should
   call shell_reinitialize () if you need to start afresh. */
int shell_initialized = 0;
int bash_argv_initialized = 0;

COMMAND *global_command = (COMMAND *)NULL;

/* Information about the current user. */
struct user_info current_user =`

_No direct calls detected within the parsed body._

## Entry Point: subst.c (line 6594)
Signature: `main (). */
  result = setjmp_nosigs (top_level);

  /* If we're running a process substitution inside a shell function,
     trap `return' so we don't return from the function in the subshell
     and go off to never-never land. */
  if (result == 0 && return_catch_flag)
    function_value = setjmp_nosigs (return_catch);
  else
    function_value = 0;

  if (result == ERREXIT)
    rc = last_command_exit_value;
  else if (result == EXITPROG || result == EXITBLTIN)
    rc = last_command_exit_value;
  else if (result)
    rc = EXECUTION_FAILURE;
  else if (function_value)
    rc = return_catch_value;
  else`

### Direct Calls
- `parse_and_execute()` called 1 time(s) -> parse_and_execute (char *string, const char *from_file, int flags) (in builtins\evalstring.c:315)

## Entry Point: support\bashversion.c (line 62)
Signature: `main (int argc, char **argv)`

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

## Entry Point: support\man2html.c (line 3999)
Signature: `main(int argc, char **argv)`

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

## Entry Point: support\mksignames.c (line 73)
Signature: `main (int argc, char **argv)`

### Direct Calls
- `exit()` called 3 time(s) -> definition not found within depth
- `fprintf()` called 2 time(s) -> fprintf (stream, "int %s () (in builtins\mkbuiltins.c:1326)
- `defined()` called 1 time(s) -> defined (HANDLE_MULTIBYTE) (in bashline.c:4132)
- `fopen()` called 1 time(s) -> definition not found within depth
- `initialize_signames()` called 1 time(s) -> initialize_signames (void) (in support\signames.c:70)
- `write_signames()` called 1 time(s) -> write_signames (FILE *stream) (in support\mksignames.c:48)

## Entry Point: support\printenv.c (line 34)
Signature: `main (int argc, char **argv)`

### Direct Calls
- `exit()` called 3 time(s) -> definition not found within depth
- `puts()` called 2 time(s) -> definition not found within depth
- `strlen()` called 1 time(s) -> definition not found within depth
- `strncmp()` called 1 time(s) -> strncmp (assign + equal_offset + 2, ") (in variables.c:4987)

## Entry Point: support\recho.c (line 33)
Signature: `main(int argc, char **argv)`

### Direct Calls
- `printf()` called 2 time(s) -> definition not found within depth
- `exit()` called 1 time(s) -> definition not found within depth
- `strprint()` called 1 time(s) -> strprint(char *str) (in support\recho.c:46)

## Entry Point: support\siglen.c (line 8)
Signature: `main(int argc, char **argv)`

### Direct Calls
- `printf()` called 2 time(s) -> definition not found within depth
- `exit()` called 1 time(s) -> definition not found within depth
- `strcmp()` called 1 time(s) -> definition not found within depth
- `strlen()` called 1 time(s) -> definition not found within depth
- `strsignal()` called 1 time(s) -> definition not found within depth

## Entry Point: support\xcase.c (line 42)
Signature: `main(int ac, char **av)`

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

## Entry Point: support\zecho.c (line 25)
Signature: `main(int argc, char **argv)`

### Direct Calls
- `putchar()` called 2 time(s) -> definition not found within depth
- `exit()` called 1 time(s) -> definition not found within depth
- `printf()` called 1 time(s) -> definition not found within depth

---
## Global Observations

**Top call targets across depth-1 scan**
- `printf()`: 55 hits _(definition outside depth)_
- `exit()`: 31 hits _(definition outside depth)_
- `print_array()`: 24 hits
- `array_insert()`: 22 hits
- `fprintf()`: 17 hits
- `strcmp()`: 14 hits _(definition outside depth)_
- `array_dispose()`: 12 hits
- `free()`: 12 hits _(definition outside depth)_
- `array_dispose_element()`: 8 hits
- `array_from_string()`: 8 hits

**Follow-up candidates (missing definitions within depth limit)**
- `printf()`: 55 reference(s) without a local definition
- `exit()`: 31 reference(s) without a local definition
- `strcmp()`: 14 reference(s) without a local definition
- `free()`: 12 reference(s) without a local definition
- `fopen()`: 8 reference(s) without a local definition

---
## Focus Functions (depth ≤ 1)

### shell.c::main (entry pipeline)
- File: `shell.c` (line 105)
- Signature: `main() */
#endif

extern int gnu_error_format;

/* Non-zero means that this shell has already been run; i.e. you should
   call shell_reinitialize () if you need to start afresh. */
int shell_initialized = 0;
int bash_argv_initialized = 0;

COMMAND *global_command = (COMMAND *)NULL;

/* Information about the current user. */
struct user_info current_user =`
- Body length: 5 line(s)
- Highlights:
  - No heuristically-detected highlights within focus window.

_No additional direct calls detected within focus body._

### eval.c::reader_loop (command dispatcher)
- File: `eval.c` (line 61)
- Signature: `reader_loop (void)`
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
- File: `execute_cmd.c` (line 456)
- Signature: `execute_command_internal (command, 0, NO_PIPE, NO_PIPE, bitmap);

  dispose_fd_bitmap (bitmap);
  discard_unwind_frame ("execute-command");

#if defined (PROCESS_SUBSTITUTION)
  /* don't unlink fifos if we're in a shell function; wait until the function
     returns. */
  if (variable_context == 0 && retain_fifos == 0)
    unlink_fifo_list ();
#endif /* PROCESS_SUBSTITUTION */

  QUIT;
  return (result);
}

/* Return 1 if TYPE is a shell control structure type. */
static int
shell_control_structure (enum command_type type)`
- Body length: 28 line(s)
- Highlights:
  - No heuristically-detected highlights within focus window.

**Direct call activity (top 15)**
- `defined()` × 4 → defined (HANDLE_MULTIBYTE) (bashline.c:4132)

---
Report crafted by benchmark/scripts/bash-flow-explain.js.