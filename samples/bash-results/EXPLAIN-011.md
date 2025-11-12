# Bash Sample Execution Flow

- Generated at: 2025-11-12T02:25:48.409Z
- Source root: `samples\bash`
- Depth inspected: 1
- Files scanned: 62
- Functions indexed: 2105
- Method: tree-sitter AST traversal to preserve ordered call flows and inline expansions (depth ≤ 2).

## Shell startup flow
- File: `shell.c`
- Line: 369
- Signature: `int main(int argc, char **argv) #else /* !NO_MAIN_ENV_ARG */ int main(int argc, char **argv, char **env)`
- Body length: 253 line(s)
- Ordered walkthrough of `shell.c::main`. Each step lists the original call site, the callee location (when known), and expands one level deeper to show how execution fans out.

### Ordered call trace
1. `defined()` @ shell.c:379 → definition outside current scan
   ↳ defined (RESTRICTED_SHELL) int saverst; #endif volatile int locally_skip_
2. `defined()` @ shell.c:384 → definition outside current scan
   ↳ defined (__OPENNT) || defined (__MVS__) char **env; env = environ; #end
3. `defined()` @ shell.c:384 → definition outside current scan
   ↳ defined (__MVS__) char **env; env = environ; #endif /* __OPENNT || __MV
4. `USE_VAR()` @ shell.c:390 → definition outside current scan
   ↳ USE_VAR(argc);
5. `USE_VAR()` @ shell.c:391 → definition outside current scan
   ↳ USE_VAR(argv);
6. `USE_VAR()` @ shell.c:392 → definition outside current scan
   ↳ USE_VAR(env);
7. `USE_VAR()` @ shell.c:393 → definition outside current scan
   ↳ USE_VAR(code);
8. `USE_VAR()` @ shell.c:394 → definition outside current scan
   ↳ USE_VAR(old_errexit_flag);
9. `defined()` @ shell.c:395 → definition outside current scan
   ↳ defined (RESTRICTED_SHELL) USE_VAR(saverst); #endif /* Catch early SIGI
10. `USE_VAR()` @ shell.c:396 → definition outside current scan
   ↳ USE_VAR(saverst);
11. `setjmp_nosigs()` @ shell.c:400 → definition outside current scan
   ↳ setjmp_nosigs (top_level); if (code) exit (2); xtrace_init (); #
12. `exit()` @ shell.c:402 → definition outside current scan
   ↳ exit (2); xtrace_init (); #if defined (USING_BASH_MALLOC) && defined (DE
13. `xtrace_init()` @ shell.c:404 → defined in `print_cmd.c:414`
   ↳ xtrace_init (); #if defined (USING_BASH_MALLOC) && defined (DEBUG) && !define
   ↪ expands into `xtrace_init()` (print_cmd.c:414)
  - `xtrace_set()` @ print_cmd.c:417 → defined in `print_cmd.c:394`
     ↳ xtrace_set (-1, stderr)
     ↪ expands into `xtrace_set()` (print_cmd.c:394)
    - `sh_validfd()` @ print_cmd.c:397 → defined in `general.c:606`
       ↳ sh_validfd (fd)
    - `internal_error()` @ print_cmd.c:399 → defined in `braces.c:890`
       ↳ internal_error (_("xtrace_set: %d: invalid file descriptor"), fd)
    - `_()` @ print_cmd.c:399 → definition outside current scan
       ↳ _("xtrace_set: %d: invalid file descriptor")
    - `internal_error()` @ print_cmd.c:404 → defined in `braces.c:890`
       ↳ internal_error (_("xtrace_set: NULL file pointer"))
    - `_()` @ print_cmd.c:404 → definition outside current scan
       ↳ _("xtrace_set: NULL file pointer")
    - `fileno()` @ print_cmd.c:407 → definition outside current scan
       ↳ fileno (fp)
    - `internal_warning()` @ print_cmd.c:408 → defined in `error.c:221`
       ↳ internal_warning (_("xtrace fd (%d) != fileno xtrace fp (%d)"), fd, fileno (fp))
    - `_()` @ print_cmd.c:408 → definition outside current scan
       ↳ _("xtrace fd (%d) != fileno xtrace fp (%d)")
    - `fileno()` @ print_cmd.c:408 → definition outside current scan
       ↳ fileno (fp)
14. `defined()` @ shell.c:406 → definition outside current scan
   ↳ defined (USING_BASH_MALLOC) && defined (DEBUG) && !defined (DISABLE_MALLOC_WRAPP
15. `defined()` @ shell.c:406 → definition outside current scan
   ↳ defined (DEBUG) && !defined (DISABLE_MALLOC_WRAPPERS) malloc_set_register (1)
16. `defined()` @ shell.c:406 → definition outside current scan
   ↳ defined (DISABLE_MALLOC_WRAPPERS) malloc_set_register (1); /* XXX - change to
17. `malloc_set_register()` @ shell.c:407 → definition outside current scan
   ↳ malloc_set_register (1); /* XXX - change to 1 for malloc debugging */ #endif
18. `check_dev_tty()` @ shell.c:410 → defined in `general.c:629`
   ↳ check_dev_tty (); #ifdef __CYGWIN__ _cygwin32_check_tmp (); #endif /* __C
   ↪ expands into `check_dev_tty()` (general.c:629)
  - `open()` @ general.c:635 → definition outside current scan
     ↳ open ("/dev/tty", O_RDWR|O_NONBLOCK)
  - `ttyname()` @ general.c:639 → definition outside current scan
     ↳ ttyname (fileno (stdin))
  - `fileno()` @ general.c:639 → definition outside current scan
     ↳ fileno (stdin)
  - `open()` @ general.c:642 → definition outside current scan
     ↳ open (tty, O_RDWR|O_NONBLOCK)
  - `close()` @ general.c:645 → definition outside current scan
     ↳ close (tty_fd)
19. `_cygwin32_check_tmp()` @ shell.c:413 → defined in `shell.c:353`
   ↳ _cygwin32_check_tmp (); #endif /* __CYGWIN__ */ /* Wait forever if we are
   ↪ expands into `_cygwin32_check_tmp()` (shell.c:353)
  - `stat()` @ shell.c:358 → definition outside current scan
     ↳ stat ("/tmp", &sb)
  - `internal_warning()` @ shell.c:359 → defined in `error.c:221`
     ↳ internal_warning (_("could not find /tmp, please create!"))
     ↪ expands into `internal_warning()` (error.c:221)
    - `error_prolog()` @ error.c:226 → defined in `error.c:73`
       ↳ error_prolog (1)
    - `fprintf()` @ error.c:227 → definition outside current scan
       ↳ fprintf (stderr, _("warning: "))
    - `_()` @ error.c:227 → definition outside current scan
       ↳ _("warning: ")
    - `va_start()` @ error.c:229 → definition outside current scan
       ↳ va_start (args, format)
    - `vfprintf()` @ error.c:231 → definition outside current scan
       ↳ vfprintf (stderr, format, args)
    - `fprintf()` @ error.c:232 → definition outside current scan
       ↳ fprintf (stderr, "\n")
    - `va_end()` @ error.c:234 → definition outside current scan
       ↳ va_end (args)
  - `_()` @ shell.c:359 → definition outside current scan
     ↳ _("could not find /tmp, please create!")
  - `S_ISDIR()` @ shell.c:362 → definition outside current scan
     ↳ S_ISDIR (sb.st_mode)
  - `internal_warning()` @ shell.c:363 → defined in `error.c:221`
     ↳ internal_warning (_("/tmp must be a valid directory name"))
     ↪ expands into `internal_warning()` (error.c:221)
    - `error_prolog()` @ error.c:226 → defined in `error.c:73`
       ↳ error_prolog (1)
    - `fprintf()` @ error.c:227 → definition outside current scan
       ↳ fprintf (stderr, _("warning: "))
    - `_()` @ error.c:227 → definition outside current scan
       ↳ _("warning: ")
    - `va_start()` @ error.c:229 → definition outside current scan
       ↳ va_start (args, format)
    - `vfprintf()` @ error.c:231 → definition outside current scan
       ↳ vfprintf (stderr, format, args)
    - `fprintf()` @ error.c:232 → definition outside current scan
       ↳ fprintf (stderr, "\n")
    - `va_end()` @ error.c:234 → definition outside current scan
       ↳ va_end (args)
  - `_()` @ shell.c:363 → definition outside current scan
     ↳ _("/tmp must be a valid directory name")
20. `sleep()` @ shell.c:417 → definition outside current scan
   ↳ sleep (3); set_default_locale (); running_setuid = uidget (); if
21. `set_default_locale()` @ shell.c:419 → defined in `locale.c:84`
   ↳ set_default_locale (); running_setuid = uidget (); if (getenv ("POSIXL
   ↪ expands into `set_default_locale()` (locale.c:84)
  - `setlocale()` @ locale.c:88 → definition outside current scan
     ↳ setlocale (LC_ALL, "")
  - `savestring()` @ locale.c:90 → definition outside current scan
     ↳ savestring (default_locale)
  - `savestring()` @ locale.c:92 → definition outside current scan
     ↳ savestring ("C")
  - `bindtextdomain()` @ locale.c:94 → definition outside current scan
     ↳ bindtextdomain (PACKAGE, LOCALEDIR)
  - `textdomain()` @ locale.c:95 → definition outside current scan
     ↳ textdomain (PACKAGE)
  - `locale_isutf8()` @ locale.c:98 → defined in `locale.c:616`
     ↳ locale_isutf8 (default_locale)
     ↪ expands into `locale_isutf8()` (locale.c:616)
    - `nl_langinfo()` @ locale.c:626 → definition outside current scan
       ↳ nl_langinfo (CODESET)
    - `STREQ()` @ locale.c:627 → definition outside current scan
       ↳ STREQ (cp, "UTF-8")
    - `STREQ()` @ locale.c:627 → definition outside current scan
       ↳ STREQ (cp, "utf8")
    - `locale_charset()` @ locale.c:630 → definition outside current scan
       ↳ locale_charset ()
    - `STREQ()` @ locale.c:631 → definition outside current scan
       ↳ STREQ (cp, "UTF-8")
    - `STREQ()` @ locale.c:631 → definition outside current scan
       ↳ STREQ (cp, "utf8")
    - `STREQN()` @ locale.c:641 → definition outside current scan
       ↳ STREQN (encoding, "UTF-8", 5)
    - `STREQN()` @ locale.c:642 → definition outside current scan
       ↳ STREQN (encoding, "utf8", 4)
  - `mblen()` @ locale.c:100 → definition outside current scan
     ↳ mblen ((char *)NULL, 0)
22. `uidget()` @ shell.c:421 → defined in `shell.c:1304`
   ↳ uidget (); if (getenv ("POSIXLY_CORRECT") || getenv ("POSIX_PEDANTIC"))
   ↪ expands into `uidget()` (shell.c:1304)
  - `getresuid()` @ shell.c:1312 → definition outside current scan
     ↳ getresuid (&current_user.uid, &current_user.euid, &current_user.saveuid)
  - `getuid()` @ shell.c:1314 → definition outside current scan
     ↳ getuid ()
  - `geteuid()` @ shell.c:1315 → definition outside current scan
     ↳ geteuid ()
  - `getresgid()` @ shell.c:1319 → definition outside current scan
     ↳ getresgid (&current_user.gid, &current_user.egid, &current_user.savegid)
  - `getgid()` @ shell.c:1321 → definition outside current scan
     ↳ getgid ()
  - `getegid()` @ shell.c:1322 → definition outside current scan
     ↳ getegid ()
  - `FREE()` @ shell.c:1327 → definition outside current scan
     ↳ FREE (current_user.user_name)
  - `FREE()` @ shell.c:1328 → definition outside current scan
     ↳ FREE (current_user.shell)
  - `FREE()` @ shell.c:1329 → definition outside current scan
     ↳ FREE (current_user.home_dir)
23. `getenv()` @ shell.c:423 → definition outside current scan
   ↳ getenv ("POSIXLY_CORRECT") || getenv ("POSIX_PEDANTIC")) posixly_correct =
24. `getenv()` @ shell.c:423 → definition outside current scan
   ↳ getenv ("POSIX_PEDANTIC")) posixly_correct = 1; #if defined (USE_GNU_MAL
25. `defined()` @ shell.c:426 → definition outside current scan
   ↳ defined (USE_GNU_MALLOC_LIBRARY) mcheck (programming_error, (void (*) ())0);
26. `mcheck()` @ shell.c:427 → definition outside current scan
   ↳ mcheck (programming_error, (void (*) ())0); #endif /* USE_GNU_MALLOC_LIBRARY */
27. `void()` @ shell.c:427 → defined in `subst.c:6314`
   ↳ void (*) ())0); #endif /* USE_GNU_MALLOC_LIBRARY */ if (setjmp_sigs (subsh
   ↪ expands into `void()` (subst.c:6314)
  - `fprintf()` @ subst.c:6318 → definition outside current scan
     ↳ fprintf (stderr, "pid %ld: dev_fd_list:", (long)getpid ())
  - `getpid()` @ subst.c:6318 → definition outside current scan
     ↳ getpid ()
  - `fflush()` @ subst.c:6319 → definition outside current scan
     ↳ fflush (stderr)
  - `fprintf()` @ subst.c:6324 → definition outside current scan
     ↳ fprintf (stderr, " %d", i)
  - `fprintf()` @ subst.c:6326 → definition outside current scan
     ↳ fprintf (stderr, "\n")
28. `setjmp_sigs()` @ shell.c:430 → definition outside current scan
   ↳ setjmp_sigs (subshell_top_level)) { argc = subshell_argc; arg
29. `shell_reinitialize()` @ shell.c:461 → defined in `shell.c:1992`
   ↳ shell_reinitialize (); if (setjmp_nosigs (top_level)) exit (2); }
   ↪ expands into `shell_reinitialize()` (shell.c:1992)
  - `reset_shell_flags()` @ shell.c:2023 → defined in `flags.c:337`
     ↳ reset_shell_flags ()
     ↪ expands into `reset_shell_flags()` (flags.c:337)
  - `reset_shell_options()` @ shell.c:2024 → definition outside current scan
     ↳ reset_shell_options ()
  - `reset_shopt_options()` @ shell.c:2025 → definition outside current scan
     ↳ reset_shopt_options ()
  - `bash_history_reinit()` @ shell.c:2031 → defined in `bashhist.c:284`
     ↳ bash_history_reinit (enable_history_list = 0)
     ↪ expands into `bash_history_reinit()` (bashhist.c:284)
  - `delete_all_contexts()` @ shell.c:2044 → defined in `variables.c:5384`
     ↳ delete_all_contexts (shell_variables)
     ↪ expands into `delete_all_contexts()` (variables.c:5384)
    - `delete_local_contexts()` @ variables.c:5387 → defined in `variables.c:5370`
       ↳ delete_local_contexts (vcxt)
    - `delete_all_variables()` @ variables.c:5388 → defined in `variables.c:4052`
       ↳ delete_all_variables (global_variables->table)
  - `delete_all_variables()` @ shell.c:2045 → defined in `variables.c:4052`
     ↳ delete_all_variables (shell_functions)
     ↪ expands into `delete_all_variables()` (variables.c:4052)
    - `hash_flush()` @ variables.c:4055 → defined in `hashlib.c:355`
       ↳ hash_flush (hashed_vars, free_variable_hash_data)
  - `reinit_special_variables()` @ shell.c:2047 → defined in `variables.c:5898`
     ↳ reinit_special_variables ()
     ↪ expands into `reinit_special_variables()` (variables.c:5898)
    - `sv_comp_wordbreaks()` @ variables.c:5902 → defined in `variables.c:5982`
       ↳ sv_comp_wordbreaks ("COMP_WORDBREAKS")
    - `sv_globignore()` @ variables.c:5904 → defined in `variables.c:5967`
       ↳ sv_globignore ("GLOBIGNORE")
    - `sv_opterr()` @ variables.c:5905 → defined in `variables.c:6247`
       ↳ sv_opterr ("OPTERR")
  - `bashline_reinitialize()` @ shell.c:2050 → defined in `bashline.c:649`
     ↳ bashline_reinitialize ()
     ↪ expands into `bashline_reinitialize()` (bashline.c:649)
30. `setjmp_nosigs()` @ shell.c:462 → definition outside current scan
   ↳ setjmp_nosigs (top_level)) exit (2); } shell_environment = env; s
31. `exit()` @ shell.c:463 → definition outside current scan
   ↳ exit (2); } shell_environment = env; set_shell_name (argv[0]);
32. `set_shell_name()` @ shell.c:467 → defined in `shell.c:1778`
   ↳ set_shell_name (argv[0]); gettimeofday (&shellstart, 0); shell_start_tim
   ↪ expands into `set_shell_name()` (shell.c:1778)
  - `base_pathname()` @ shell.c:1783 → defined in `general.c:888`
     ↳ base_pathname (argv0)
     ↪ expands into `base_pathname()` (general.c:888)
    - `absolute_pathname()` @ general.c:894 → defined in `general.c:821`
       ↳ absolute_pathname (string)
    - `strrchr()` @ general.c:901 → definition outside current scan
       ↳ strrchr (string, '/')
  - `FREE()` @ shell.c:1798 → definition outside current scan
     ↳ FREE (dollar_vars[0])
  - `savestring()` @ shell.c:1799 → definition outside current scan
     ↳ savestring (shell_name)
33. `gettimeofday()` @ shell.c:469 → definition outside current scan
   ↳ gettimeofday (&shellstart, 0); shell_start_time = shellstart.tv_sec; /*
34. `parse_long_options()` @ shell.c:475 → defined in `shell.c:838`
   ↳ parse_long_options (argv, arg_index, argc); if (want_initial_help) {
   ↪ expands into `parse_long_options()` (shell.c:838)
  - `STREQ()` @ shell.c:859 → definition outside current scan
     ↳ STREQ (arg_string + 1, long_args[i].name)
  - `report_error()` @ shell.c:865 → defined in `error.c:169`
     ↳ report_error (_("%s: option requires an argument"), long_args[i].name)
     ↪ expands into `report_error()` (error.c:169)
    - `error_prolog()` @ error.c:174 → defined in `error.c:73`
       ↳ error_prolog (1)
    - `va_start()` @ error.c:176 → definition outside current scan
       ↳ va_start (args, format)
    - `vfprintf()` @ error.c:178 → definition outside current scan
       ↳ vfprintf (stderr, format, args)
    - `fprintf()` @ error.c:179 → definition outside current scan
       ↳ fprintf (stderr, "\n")
    - `va_end()` @ error.c:181 → definition outside current scan
       ↳ va_end (args)
    - `exit_shell()` @ error.c:186 → defined in `shell.c:984`
       ↳ exit_shell (last_command_exit_value)
  - `_()` @ shell.c:865 → definition outside current scan
     ↳ _("%s: option requires an argument")
  - `exit()` @ shell.c:866 → definition outside current scan
     ↳ exit (EX_BADUSAGE)
  - `report_error()` @ shell.c:878 → defined in `error.c:169`
     ↳ report_error (_("%s: invalid option"), argv[arg_index])
     ↪ expands into `report_error()` (error.c:169)
    - `error_prolog()` @ error.c:174 → defined in `error.c:73`
       ↳ error_prolog (1)
    - `va_start()` @ error.c:176 → definition outside current scan
       ↳ va_start (args, format)
    - `vfprintf()` @ error.c:178 → definition outside current scan
       ↳ vfprintf (stderr, format, args)
    - `fprintf()` @ error.c:179 → definition outside current scan
       ↳ fprintf (stderr, "\n")
    - `va_end()` @ error.c:181 → definition outside current scan
       ↳ va_end (args)
    - `exit_shell()` @ error.c:186 → defined in `shell.c:984`
       ↳ exit_shell (last_command_exit_value)
  - `_()` @ shell.c:878 → definition outside current scan
     ↳ _("%s: invalid option")
  - `show_shell_usage()` @ shell.c:879 → defined in `shell.c:2056`
     ↳ show_shell_usage (stderr, 0)
     ↪ expands into `show_shell_usage()` (shell.c:2056)
    - `fprintf()` @ shell.c:2063 → definition outside current scan
       ↳ fprintf (fp, _("GNU bash, version %s-(%s)\n"), shell_version_string (), MACHTYPE)
    - `_()` @ shell.c:2063 → definition outside current scan
       ↳ _("GNU bash, version %s-(%s)\n")
    - `shell_version_string()` @ shell.c:2063 → defined in `version.c:64`
       ↳ shell_version_string ()
    - `fprintf()` @ shell.c:2064 → definition outside current scan
       ↳ fprintf (fp, _("Usage:\t%s [GNU long option] [option] ...\n\t%s [GNU long option] [option] script-file ...\n"), shell_name, shell_name)
    - `_()` @ shell.c:2064 → definition outside current scan
       ↳ _("Usage:\t%s [GNU long option] [option] ...\n\t%s [GNU long option] [option] script-file ...\n")
    - `fputs()` @ shell.c:2066 → definition outside current scan
       ↳ fputs (_("GNU long options:\n"), fp)
    - `_()` @ shell.c:2066 → definition outside current scan
       ↳ _("GNU long options:\n")
    - `fprintf()` @ shell.c:2068 → definition outside current scan
       ↳ fprintf (fp, "\t--%s\n", long_args[i].name)
    - `fputs()` @ shell.c:2070 → definition outside current scan
       ↳ fputs (_("Shell options:\n"), fp)
    - `_()` @ shell.c:2070 → definition outside current scan
       ↳ _("Shell options:\n")
    - `fputs()` @ shell.c:2071 → definition outside current scan
       ↳ fputs (_("\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n"), fp)
    - `_()` @ shell.c:2071 → definition outside current scan
       ↳ _("\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n")
    - `STREQ()` @ shell.c:2074 → definition outside current scan
       ↳ STREQ (shell_builtins[i].name, "set")
    - `savestring()` @ shell.c:2076 → definition outside current scan
       ↳ savestring (shell_builtins[i].short_doc)
    - `strchr()` @ shell.c:2082 → definition outside current scan
       ↳ strchr (set_opts, '[')
    - `strchr()` @ shell.c:2087 → definition outside current scan
       ↳ strchr (s, ']')
    - `fprintf()` @ shell.c:2090 → definition outside current scan
       ↳ fprintf (fp, _("\t-%s or -o option\n"), s)
    - `_()` @ shell.c:2090 → definition outside current scan
       ↳ _("\t-%s or -o option\n")
    - `free()` @ shell.c:2091 → definition outside current scan
       ↳ free (set_opts)
    - `fprintf()` @ shell.c:2096 → definition outside current scan
       ↳ fprintf (fp, _("Type `%s -c \"help set\"' for more information about shell options.\n"), shell_name)
    - `_()` @ shell.c:2096 → definition outside current scan
       ↳ _("Type `%s -c \"help set\"' for more information about shell options.\n")
    - `fprintf()` @ shell.c:2097 → definition outside current scan
       ↳ fprintf (fp, _("Type `%s -c help' for more information about shell builtin commands.\n"), shell_name)
    - `_()` @ shell.c:2097 → definition outside current scan
       ↳ _("Type `%s -c help' for more information about shell builtin commands.\n")
    - `fprintf()` @ shell.c:2098 → definition outside current scan
       ↳ fprintf (fp, _("Use the `bashbug' command to report bugs.\n"))
    - `_()` @ shell.c:2098 → definition outside current scan
       ↳ _("Use the `bashbug' command to report bugs.\n")
    - `fprintf()` @ shell.c:2099 → definition outside current scan
       ↳ fprintf (fp, "\n")
    - `fprintf()` @ shell.c:2100 → definition outside current scan
       ↳ fprintf (fp, _("bash home page: <http://www.gnu.org/software/bash>\n"))
    - `_()` @ shell.c:2100 → definition outside current scan
       ↳ _("bash home page: <http://www.gnu.org/software/bash>\n")
    - `fprintf()` @ shell.c:2101 → definition outside current scan
       ↳ fprintf (fp, _("General help using GNU software: <http://www.gnu.org/gethelp/>\n"))
    - `_()` @ shell.c:2101 → definition outside current scan
       ↳ _("General help using GNU software: <http://www.gnu.org/gethelp/>\n")
  - `exit()` @ shell.c:880 → definition outside current scan
     ↳ exit (EX_BADUSAGE)
35. `show_shell_usage()` @ shell.c:479 → defined in `shell.c:2056`
   ↳ show_shell_usage (stdout, 1); exit (EXECUTION_SUCCESS); } if (d
   ↪ expands into `show_shell_usage()` (shell.c:2056)
  - `fprintf()` @ shell.c:2063 → definition outside current scan
     ↳ fprintf (fp, _("GNU bash, version %s-(%s)\n"), shell_version_string (), MACHTYPE)
  - `_()` @ shell.c:2063 → definition outside current scan
     ↳ _("GNU bash, version %s-(%s)\n")
  - `shell_version_string()` @ shell.c:2063 → defined in `version.c:64`
     ↳ shell_version_string ()
     ↪ expands into `shell_version_string()` (version.c:64)
    - `snprintf()` @ version.c:73 → definition outside current scan
       ↳ snprintf (tt, sizeof (tt), "%s.%d(%d)-%s", dist_version, patch_level, build_version, release_status)
    - `sprintf()` @ version.c:75 → definition outside current scan
       ↳ sprintf (tt, "%s.%d(%d)-%s", dist_version, patch_level, build_version, release_status)
    - `snprintf()` @ version.c:79 → definition outside current scan
       ↳ snprintf (tt, sizeof (tt), "%s.%d(%d)", dist_version, patch_level, build_version)
    - `sprintf()` @ version.c:81 → definition outside current scan
       ↳ sprintf (tt, "%s.%d(%d)", dist_version, patch_level, build_version)
  - `fprintf()` @ shell.c:2064 → definition outside current scan
     ↳ fprintf (fp, _("Usage:\t%s [GNU long option] [option] ...\n\t%s [GNU long option] [option] script-file ...\n"), shell_name, shell_name)
  - `_()` @ shell.c:2064 → definition outside current scan
     ↳ _("Usage:\t%s [GNU long option] [option] ...\n\t%s [GNU long option] [option] script-file ...\n")
  - `fputs()` @ shell.c:2066 → definition outside current scan
     ↳ fputs (_("GNU long options:\n"), fp)
  - `_()` @ shell.c:2066 → definition outside current scan
     ↳ _("GNU long options:\n")
  - `fprintf()` @ shell.c:2068 → definition outside current scan
     ↳ fprintf (fp, "\t--%s\n", long_args[i].name)
  - `fputs()` @ shell.c:2070 → definition outside current scan
     ↳ fputs (_("Shell options:\n"), fp)
  - `_()` @ shell.c:2070 → definition outside current scan
     ↳ _("Shell options:\n")
  - `fputs()` @ shell.c:2071 → definition outside current scan
     ↳ fputs (_("\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n"), fp)
  - `_()` @ shell.c:2071 → definition outside current scan
     ↳ _("\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n")
  - `STREQ()` @ shell.c:2074 → definition outside current scan
     ↳ STREQ (shell_builtins[i].name, "set")
  - `savestring()` @ shell.c:2076 → definition outside current scan
     ↳ savestring (shell_builtins[i].short_doc)
  - `strchr()` @ shell.c:2082 → definition outside current scan
     ↳ strchr (set_opts, '[')
  - `strchr()` @ shell.c:2087 → definition outside current scan
     ↳ strchr (s, ']')
  - `fprintf()` @ shell.c:2090 → definition outside current scan
     ↳ fprintf (fp, _("\t-%s or -o option\n"), s)
  - `_()` @ shell.c:2090 → definition outside current scan
     ↳ _("\t-%s or -o option\n")
  - `free()` @ shell.c:2091 → definition outside current scan
     ↳ free (set_opts)
  - `fprintf()` @ shell.c:2096 → definition outside current scan
     ↳ fprintf (fp, _("Type `%s -c \"help set\"' for more information about shell options.\n"), shell_name)
  - `_()` @ shell.c:2096 → definition outside current scan
     ↳ _("Type `%s -c \"help set\"' for more information about shell options.\n")
  - `fprintf()` @ shell.c:2097 → definition outside current scan
     ↳ fprintf (fp, _("Type `%s -c help' for more information about shell builtin commands.\n"), shell_name)
  - `_()` @ shell.c:2097 → definition outside current scan
     ↳ _("Type `%s -c help' for more information about shell builtin commands.\n")
  - `fprintf()` @ shell.c:2098 → definition outside current scan
     ↳ fprintf (fp, _("Use the `bashbug' command to report bugs.\n"))
  - `_()` @ shell.c:2098 → definition outside current scan
     ↳ _("Use the `bashbug' command to report bugs.\n")
  - `fprintf()` @ shell.c:2099 → definition outside current scan
     ↳ fprintf (fp, "\n")
  - `fprintf()` @ shell.c:2100 → definition outside current scan
     ↳ fprintf (fp, _("bash home page: <http://www.gnu.org/software/bash>\n"))
  - `_()` @ shell.c:2100 → definition outside current scan
     ↳ _("bash home page: <http://www.gnu.org/software/bash>\n")
  - `fprintf()` @ shell.c:2101 → definition outside current scan
     ↳ fprintf (fp, _("General help using GNU software: <http://www.gnu.org/gethelp/>\n"))
  - `_()` @ shell.c:2101 → definition outside current scan
     ↳ _("General help using GNU software: <http://www.gnu.org/gethelp/>\n")
36. `exit()` @ shell.c:480 → definition outside current scan
   ↳ exit (EXECUTION_SUCCESS); } if (do_version) { show_shell_v
37. `show_shell_version()` @ shell.c:485 → defined in `version.c:87`
   ↳ show_shell_version (1); exit (EXECUTION_SUCCESS); } echo_input_
   ↪ expands into `show_shell_version()` (version.c:87)
  - `printf()` @ version.c:90 → definition outside current scan
     ↳ printf (_("GNU bash, version %s (%s)\n"), shell_version_string (), MACHTYPE)
  - `_()` @ version.c:90 → definition outside current scan
     ↳ _("GNU bash, version %s (%s)\n")
  - `shell_version_string()` @ version.c:90 → defined in `version.c:64`
     ↳ shell_version_string ()
     ↪ expands into `shell_version_string()` (version.c:64)
    - `snprintf()` @ version.c:73 → definition outside current scan
       ↳ snprintf (tt, sizeof (tt), "%s.%d(%d)-%s", dist_version, patch_level, build_version, release_status)
    - `sprintf()` @ version.c:75 → definition outside current scan
       ↳ sprintf (tt, "%s.%d(%d)-%s", dist_version, patch_level, build_version, release_status)
    - `snprintf()` @ version.c:79 → definition outside current scan
       ↳ snprintf (tt, sizeof (tt), "%s.%d(%d)", dist_version, patch_level, build_version)
    - `sprintf()` @ version.c:81 → definition outside current scan
       ↳ sprintf (tt, "%s.%d(%d)", dist_version, patch_level, build_version)
  - `printf()` @ version.c:93 → definition outside current scan
     ↳ printf ("%s\n", _(bash_copyright))
  - `_()` @ version.c:93 → definition outside current scan
     ↳ _(bash_copyright)
  - `printf()` @ version.c:94 → definition outside current scan
     ↳ printf ("%s\n", _(bash_license))
  - `_()` @ version.c:94 → definition outside current scan
     ↳ _(bash_license)
  - `printf()` @ version.c:95 → definition outside current scan
     ↳ printf ("%s\n", _("This is free software; you are free to change and redistribute it."))
  - `_()` @ version.c:95 → definition outside current scan
     ↳ _("This is free software; you are free to change and redistribute it.")
  - `printf()` @ version.c:96 → definition outside current scan
     ↳ printf ("%s\n", _("There is NO WARRANTY, to the extent permitted by law."))
  - `_()` @ version.c:96 → definition outside current scan
     ↳ _("There is NO WARRANTY, to the extent permitted by law.")
38. `exit()` @ shell.c:486 → definition outside current scan
   ↳ exit (EXECUTION_SUCCESS); } echo_input_at_read = verbose_flag; /* --ve
39. `parse_shell_options()` @ shell.c:493 → defined in `shell.c:891`
   ↳ parse_shell_options (argv, arg_index, argc); /* If user supplied the "--log
   ↪ expands into `parse_shell_options()` (shell.c:891)
  - `set_option_defaults()` @ shell.c:935 → defined in `shell.c:1813`
     ↳ set_option_defaults ()
     ↪ expands into `set_option_defaults()` (shell.c:1813)
  - `list_minus_o_opts()` @ shell.c:936 → definition outside current scan
     ↳ list_minus_o_opts (-1, (on_or_off == '-') ? 0 : 1)
  - `reset_option_defaults()` @ shell.c:937 → defined in `shell.c:1821`
     ↳ reset_option_defaults ()
     ↪ expands into `reset_option_defaults()` (shell.c:1821)
  - `set_minus_o_option()` @ shell.c:940 → definition outside current scan
     ↳ set_minus_o_option (on_or_off, o_option)
  - `exit()` @ shell.c:941 → definition outside current scan
     ↳ exit (EX_BADUSAGE)
  - `shopt_listopt()` @ shell.c:953 → definition outside current scan
     ↳ shopt_listopt (o_option, (on_or_off == '-') ? 0 : 1)
  - `add_shopt_to_alist()` @ shell.c:956 → defined in `shell.c:2105`
     ↳ add_shopt_to_alist (o_option, on_or_off)
     ↪ expands into `add_shopt_to_alist()` (shell.c:2105)
    - `xrealloc()` @ shell.c:2111 → defined in `braces.c:884`
       ↳ xrealloc (shopt_alist, shopt_len * sizeof (shopt_alist[0]))
  - `change_flag()` @ shell.c:967 → defined in `flags.c:225`
     ↳ change_flag (arg_character, on_or_off)
     ↪ expands into `change_flag()` (flags.c:225)
    - `find_flag()` @ flags.c:236 → defined in `flags.c:210`
       ↳ find_flag (flag)
    - `bash_initialize_history()` @ flags.c:251 → defined in `bashhist.c:272`
       ↳ bash_initialize_history ()
    - `set_job_control()` @ flags.c:257 → defined in `jobs.c:5317`
       ↳ set_job_control (on_or_off == FLAG_ON)
    - `disable_priv_mode()` @ flags.c:273 → defined in `shell.c:1338`
       ↳ disable_priv_mode ()
    - `maybe_make_restricted()` @ flags.c:279 → defined in `shell.c:1277`
       ↳ maybe_make_restricted (shell_name)
  - `report_error()` @ shell.c:969 → defined in `error.c:169`
     ↳ report_error (_("%c%c: invalid option"), on_or_off, arg_character)
     ↪ expands into `report_error()` (error.c:169)
    - `error_prolog()` @ error.c:174 → defined in `error.c:73`
       ↳ error_prolog (1)
    - `va_start()` @ error.c:176 → definition outside current scan
       ↳ va_start (args, format)
    - `vfprintf()` @ error.c:178 → definition outside current scan
       ↳ vfprintf (stderr, format, args)
    - `fprintf()` @ error.c:179 → definition outside current scan
       ↳ fprintf (stderr, "\n")
    - `va_end()` @ error.c:181 → definition outside current scan
       ↳ va_end (args)
    - `exit_shell()` @ error.c:186 → defined in `shell.c:984`
       ↳ exit_shell (last_command_exit_value)
  - `_()` @ shell.c:969 → definition outside current scan
     ↳ _("%c%c: invalid option")
  - `show_shell_usage()` @ shell.c:970 → defined in `shell.c:2056`
     ↳ show_shell_usage (stderr, 0)
     ↪ expands into `show_shell_usage()` (shell.c:2056)
    - `fprintf()` @ shell.c:2063 → definition outside current scan
       ↳ fprintf (fp, _("GNU bash, version %s-(%s)\n"), shell_version_string (), MACHTYPE)
    - `_()` @ shell.c:2063 → definition outside current scan
       ↳ _("GNU bash, version %s-(%s)\n")
    - `shell_version_string()` @ shell.c:2063 → defined in `version.c:64`
       ↳ shell_version_string ()
    - `fprintf()` @ shell.c:2064 → definition outside current scan
       ↳ fprintf (fp, _("Usage:\t%s [GNU long option] [option] ...\n\t%s [GNU long option] [option] script-file ...\n"), shell_name, shell_name)
    - `_()` @ shell.c:2064 → definition outside current scan
       ↳ _("Usage:\t%s [GNU long option] [option] ...\n\t%s [GNU long option] [option] script-file ...\n")
    - `fputs()` @ shell.c:2066 → definition outside current scan
       ↳ fputs (_("GNU long options:\n"), fp)
    - `_()` @ shell.c:2066 → definition outside current scan
       ↳ _("GNU long options:\n")
    - `fprintf()` @ shell.c:2068 → definition outside current scan
       ↳ fprintf (fp, "\t--%s\n", long_args[i].name)
    - `fputs()` @ shell.c:2070 → definition outside current scan
       ↳ fputs (_("Shell options:\n"), fp)
    - `_()` @ shell.c:2070 → definition outside current scan
       ↳ _("Shell options:\n")
    - `fputs()` @ shell.c:2071 → definition outside current scan
       ↳ fputs (_("\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n"), fp)
    - `_()` @ shell.c:2071 → definition outside current scan
       ↳ _("\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n")
    - `STREQ()` @ shell.c:2074 → definition outside current scan
       ↳ STREQ (shell_builtins[i].name, "set")
    - `savestring()` @ shell.c:2076 → definition outside current scan
       ↳ savestring (shell_builtins[i].short_doc)
    - `strchr()` @ shell.c:2082 → definition outside current scan
       ↳ strchr (set_opts, '[')
    - `strchr()` @ shell.c:2087 → definition outside current scan
       ↳ strchr (s, ']')
    - `fprintf()` @ shell.c:2090 → definition outside current scan
       ↳ fprintf (fp, _("\t-%s or -o option\n"), s)
    - `_()` @ shell.c:2090 → definition outside current scan
       ↳ _("\t-%s or -o option\n")
    - `free()` @ shell.c:2091 → definition outside current scan
       ↳ free (set_opts)
    - `fprintf()` @ shell.c:2096 → definition outside current scan
       ↳ fprintf (fp, _("Type `%s -c \"help set\"' for more information about shell options.\n"), shell_name)
    - `_()` @ shell.c:2096 → definition outside current scan
       ↳ _("Type `%s -c \"help set\"' for more information about shell options.\n")
    - `fprintf()` @ shell.c:2097 → definition outside current scan
       ↳ fprintf (fp, _("Type `%s -c help' for more information about shell builtin commands.\n"), shell_name)
    - `_()` @ shell.c:2097 → definition outside current scan
       ↳ _("Type `%s -c help' for more information about shell builtin commands.\n")
    - `fprintf()` @ shell.c:2098 → definition outside current scan
       ↳ fprintf (fp, _("Use the `bashbug' command to report bugs.\n"))
    - `_()` @ shell.c:2098 → definition outside current scan
       ↳ _("Use the `bashbug' command to report bugs.\n")
    - `fprintf()` @ shell.c:2099 → definition outside current scan
       ↳ fprintf (fp, "\n")
    - `fprintf()` @ shell.c:2100 → definition outside current scan
       ↳ fprintf (fp, _("bash home page: <http://www.gnu.org/software/bash>\n"))
    - `_()` @ shell.c:2100 → definition outside current scan
       ↳ _("bash home page: <http://www.gnu.org/software/bash>\n")
    - `fprintf()` @ shell.c:2101 → definition outside current scan
       ↳ fprintf (fp, _("General help using GNU software: <http://www.gnu.org/gethelp/>\n"))
    - `_()` @ shell.c:2101 → definition outside current scan
       ↳ _("General help using GNU software: <http://www.gnu.org/gethelp/>\n")
  - `exit()` @ shell.c:971 → definition outside current scan
     ↳ exit (EX_BADUSAGE)
40. `set_login_shell()` @ shell.c:503 → definition outside current scan
   ↳ set_login_shell ("login_shell", login_shell != 0); #if defined (TRANSLATABLE_

---
## Core execution pivots

## Reader loop (`eval.c::reader_loop`)
- File: `eval.c`
- Line: 60
- Signature: `int reader_loop(void)`
- Body length: 150 line(s)
- Call trace captured with depth-limited expansion to show downstream dispatch order.

### Ordered call trace
1. `USE_VAR()` @ eval.c:66 → definition outside current scan
   ↳ USE_VAR(current_command)
2. `reset_readahead_token()` @ eval.c:73 → defined in `y.tab.c:5900`
   ↳ reset_readahead_token ()
   ↪ expands into `reset_readahead_token()` (y.tab.c:5900)
3. `setjmp_nosigs()` @ eval.c:79 → definition outside current scan
   ↳ setjmp_nosigs (top_level)
4. `unlink_fifo_list()` @ eval.c:82 → defined in `subst.c:5972`
   ↳ unlink_fifo_list ()
   ↪ expands into `unlink_fifo_list()` (subst.c:5972)
  - `kill()` @ subst.c:5982 → definition outside current scan
     ↳ kill(fifo_list[i].proc, 0)
  - `unlink()` @ subst.c:5984 → definition outside current scan
     ↳ unlink (fifo_list[i].file)
  - `free()` @ subst.c:5985 → definition outside current scan
     ↳ free (fifo_list[i].file)
5. `signal_is_ignored()` @ eval.c:87 → defined in `trap.c:1613`
   ↳ signal_is_ignored (SIGINT)
   ↪ expands into `signal_is_ignored()` (trap.c:1613)
6. `signal_is_trapped()` @ eval.c:87 → defined in `array.c:1036`
   ↳ signal_is_trapped (SIGINT)
   ↪ expands into `signal_is_trapped()` (array.c:1036)
7. `set_signal_handler()` @ eval.c:88 → defined in `sig.c:826`
   ↳ set_signal_handler (SIGINT, sigint_sighandler)
   ↪ expands into `set_signal_handler()` (sig.c:826)
  - `sigemptyset()` @ sig.c:852 → definition outside current scan
     ↳ sigemptyset (&act.sa_mask)
  - `sigemptyset()` @ sig.c:853 → definition outside current scan
     ↳ sigemptyset (&oact.sa_mask)
  - `sigaction()` @ sig.c:854 → definition outside current scan
     ↳ sigaction (sig, &act, &oact)
8. `reset_local_contexts()` @ eval.c:103 → defined in `variables.c:5394`
   ↳ reset_local_contexts ()
   ↪ expands into `reset_local_contexts()` (variables.c:5394)
  - `delete_local_contexts()` @ variables.c:5397 → defined in `variables.c:5370`
     ↳ delete_local_contexts (shell_variables)
9. `set_exit_status()` @ eval.c:116 → defined in `shell.c:1068`
   ↳ set_exit_status (EXECUTION_FAILURE)
   ↪ expands into `set_exit_status()` (shell.c:1068)
  - `set_pipestatus_from_exit()` @ shell.c:1071 → defined in `variables.c:6412`
     ↳ set_pipestatus_from_exit (last_command_exit_value = s)
10. `dispose_command()` @ eval.c:126 → defined in `dispose_cmd.c:35`
   ↳ dispose_command (current_command)
   ↪ expands into `dispose_command()` (dispose_cmd.c:35)
  - `dispose_redirects()` @ dispose_cmd.c:42 → defined in `dispose_cmd.c:306`
     ↳ dispose_redirects (command->redirects)
  - `dispose_word()` @ dispose_cmd.c:58 → defined in `dispose_cmd.c:247`
     ↳ dispose_word (c->name)
  - `dispose_words()` @ dispose_cmd.c:59 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->map_list)
  - `dispose_command()` @ dispose_cmd.c:60 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:61 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:71 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->init)
  - `dispose_words()` @ dispose_cmd.c:72 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->test)
  - `dispose_words()` @ dispose_cmd.c:73 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->step)
  - `dispose_command()` @ dispose_cmd.c:74 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:75 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:82 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Group->command)
  - `free()` @ dispose_cmd.c:83 → definition outside current scan
     ↳ free (command->value.Group)
  - `dispose_command()` @ dispose_cmd.c:89 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Subshell->command)
  - `free()` @ dispose_cmd.c:90 → definition outside current scan
     ↳ free (command->value.Subshell)
  - `free()` @ dispose_cmd.c:96 → definition outside current scan
     ↳ free (command->value.Coproc->name)
  - `dispose_command()` @ dispose_cmd.c:97 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Coproc->command)
  - `free()` @ dispose_cmd.c:98 → definition outside current scan
     ↳ free (command->value.Coproc)
  - `dispose_word()` @ dispose_cmd.c:108 → defined in `dispose_cmd.c:247`
     ↳ dispose_word (c->word)
  - `dispose_words()` @ dispose_cmd.c:112 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (p->patterns)
  - `dispose_command()` @ dispose_cmd.c:113 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (p->action)
  - `free()` @ dispose_cmd.c:116 → definition outside current scan
     ↳ free (t)
  - `free()` @ dispose_cmd.c:118 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:128 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->test)
  - `dispose_command()` @ dispose_cmd.c:129 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:130 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:139 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->test)
  - `dispose_command()` @ dispose_cmd.c:140 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->true_case)
  - `dispose_command()` @ dispose_cmd.c:141 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->false_case)
  - `free()` @ dispose_cmd.c:142 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:151 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->words)
  - `dispose_redirects()` @ dispose_cmd.c:152 → defined in `dispose_cmd.c:306`
     ↳ dispose_redirects (c->redirects)
  - `free()` @ dispose_cmd.c:153 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:162 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->first)
  - `dispose_command()` @ dispose_cmd.c:163 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->second)
  - `free()` @ dispose_cmd.c:164 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:174 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->exp)
  - `free()` @ dispose_cmd.c:175 → definition outside current scan
     ↳ free (c)
  - `dispose_cond_node()` @ dispose_cmd.c:186 → defined in `dispose_cmd.c:215`
     ↳ dispose_cond_node (c)
  - `dispose_function_def()` @ dispose_cmd.c:196 → defined in `dispose_cmd.c:239`
     ↳ dispose_function_def (c)
  - `command_error()` @ dispose_cmd.c:201 → defined in `error.c:420`
     ↳ command_error ("dispose_command", CMDERR_BADTYPE, command->type, 0)
11. `restore_sigmask()` @ eval.c:130 → defined in `sig.c:495`
   ↳ restore_sigmask ()
   ↪ expands into `restore_sigmask()` (sig.c:495)
  - `sigprocmask()` @ sig.c:499 → definition outside current scan
     ↳ sigprocmask (SIG_SETMASK, &top_level_mask, (sigset_t *)NULL)
12. `command_error()` @ eval.c:134 → defined in `error.c:420`
   ↳ command_error ("reader_loop", CMDERR_BADJUMP, code, 0)
   ↪ expands into `command_error()` (error.c:420)
  - `programming_error()` @ error.c:426 → defined in `error.c:131`
     ↳ programming_error ("%s: %s: %d", func, _(cmd_error_table[code]), e)
  - `_()` @ error.c:426 → definition outside current scan
     ↳ _(cmd_error_table[code])
13. `dispose_used_env_vars()` @ eval.c:140 → defined in `variables.c:4646`
   ↳ dispose_used_env_vars ()
   ↪ expands into `dispose_used_env_vars()` (variables.c:4646)
  - `dispose_temporary_env()` @ variables.c:4651 → defined in `variables.c:4619`
     ↳ dispose_temporary_env (propagate_temp_var)
  - `maybe_make_export_env()` @ variables.c:4652 → defined in `variables.c:5064`
     ↳ maybe_make_export_env ()
14. `alloca()` @ eval.c:144 → definition outside current scan
   ↳ alloca (0)
15. `read_command()` @ eval.c:147 → defined in `eval.c:381`
   ↳ read_command ()
   ↪ expands into `read_command()` (eval.c:381)
  - `set_current_prompt_level()` @ eval.c:388 → defined in `y.tab.c:8550`
     ↳ set_current_prompt_level (1)
  - `find_variable()` @ eval.c:398 → defined in `expr.c:1651`
     ↳ find_variable ("TMOUT")
  - `var_isset()` @ eval.c:400 → defined in `variables.c:1911`
     ↳ var_isset (tmout_var)
  - `atoi()` @ eval.c:402 → definition outside current scan
     ↳ atoi (value_cell (tmout_var))
  - `value_cell()` @ eval.c:402 → definition outside current scan
     ↳ value_cell (tmout_var)
  - `set_signal_handler()` @ eval.c:405 → defined in `sig.c:826`
     ↳ set_signal_handler (SIGALRM, alrm_catcher)
  - `alarm()` @ eval.c:406 → definition outside current scan
     ↳ alarm (tmout_len)
  - `parse_command()` @ eval.c:414 → defined in `eval.c:337`
     ↳ parse_command ()
  - `alarm()` @ eval.c:418 → definition outside current scan
     ↳ alarm(0)
  - `set_signal_handler()` @ eval.c:419 → defined in `sig.c:826`
     ↳ set_signal_handler (SIGALRM, old_alrm)
16. `set_exit_status()` @ eval.c:151 → defined in `shell.c:1068`
   ↳ set_exit_status (last_command_exit_value)
   ↪ expands into `set_exit_status()` (shell.c:1068)
  - `set_pipestatus_from_exit()` @ shell.c:1071 → defined in `variables.c:6412`
     ↳ set_pipestatus_from_exit (last_command_exit_value = s)
17. `dispose_command()` @ eval.c:152 → defined in `dispose_cmd.c:35`
   ↳ dispose_command (global_command)
   ↪ expands into `dispose_command()` (dispose_cmd.c:35)
  - `dispose_redirects()` @ dispose_cmd.c:42 → defined in `dispose_cmd.c:306`
     ↳ dispose_redirects (command->redirects)
  - `dispose_word()` @ dispose_cmd.c:58 → defined in `dispose_cmd.c:247`
     ↳ dispose_word (c->name)
  - `dispose_words()` @ dispose_cmd.c:59 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->map_list)
  - `dispose_command()` @ dispose_cmd.c:60 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:61 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:71 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->init)
  - `dispose_words()` @ dispose_cmd.c:72 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->test)
  - `dispose_words()` @ dispose_cmd.c:73 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->step)
  - `dispose_command()` @ dispose_cmd.c:74 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:75 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:82 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Group->command)
  - `free()` @ dispose_cmd.c:83 → definition outside current scan
     ↳ free (command->value.Group)
  - `dispose_command()` @ dispose_cmd.c:89 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Subshell->command)
  - `free()` @ dispose_cmd.c:90 → definition outside current scan
     ↳ free (command->value.Subshell)
  - `free()` @ dispose_cmd.c:96 → definition outside current scan
     ↳ free (command->value.Coproc->name)
  - `dispose_command()` @ dispose_cmd.c:97 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Coproc->command)
  - `free()` @ dispose_cmd.c:98 → definition outside current scan
     ↳ free (command->value.Coproc)
  - `dispose_word()` @ dispose_cmd.c:108 → defined in `dispose_cmd.c:247`
     ↳ dispose_word (c->word)
  - `dispose_words()` @ dispose_cmd.c:112 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (p->patterns)
  - `dispose_command()` @ dispose_cmd.c:113 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (p->action)
  - `free()` @ dispose_cmd.c:116 → definition outside current scan
     ↳ free (t)
  - `free()` @ dispose_cmd.c:118 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:128 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->test)
  - `dispose_command()` @ dispose_cmd.c:129 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:130 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:139 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->test)
  - `dispose_command()` @ dispose_cmd.c:140 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->true_case)
  - `dispose_command()` @ dispose_cmd.c:141 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->false_case)
  - `free()` @ dispose_cmd.c:142 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:151 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->words)
  - `dispose_redirects()` @ dispose_cmd.c:152 → defined in `dispose_cmd.c:306`
     ↳ dispose_redirects (c->redirects)
  - `free()` @ dispose_cmd.c:153 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:162 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->first)
  - `dispose_command()` @ dispose_cmd.c:163 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->second)
  - `free()` @ dispose_cmd.c:164 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:174 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->exp)
  - `free()` @ dispose_cmd.c:175 → definition outside current scan
     ↳ free (c)
  - `dispose_cond_node()` @ dispose_cmd.c:186 → defined in `dispose_cmd.c:215`
     ↳ dispose_cond_node (c)
  - `dispose_function_def()` @ dispose_cmd.c:196 → defined in `dispose_cmd.c:239`
     ↳ dispose_function_def (c)
  - `command_error()` @ dispose_cmd.c:201 → defined in `error.c:420`
     ↳ command_error ("dispose_command", CMDERR_BADTYPE, command->type, 0)
18. `decode_prompt_string()` @ eval.c:168 → defined in `y.tab.c:8623`
   ↳ decode_prompt_string (ps0_prompt, 1)
   ↪ expands into `decode_prompt_string()` (y.tab.c:8623)
  - `xmalloc()` @ y.tab.c:8642 → defined in `braces.c:878`
     ↳ xmalloc (result_size = PROMPT_GROWTH)
  - `savestring()` @ y.tab.c:8657 → definition outside current scan
     ↳ savestring ("!")
  - `savestring()` @ y.tab.c:8663 → definition outside current scan
     ↳ savestring ("1")
  - `itos()` @ y.tab.c:8665 → defined in `expr.c:1688`
     ↳ itos (prompt_history_number (decoding_prompt))
  - `prompt_history_number()` @ y.tab.c:8665 → defined in `y.tab.c:8568`
     ↳ prompt_history_number (decoding_prompt)
  - `strncpy()` @ y.tab.c:8685 → definition outside current scan
     ↳ strncpy (octal_string, string, 3)
  - `read_octal()` @ y.tab.c:8688 → defined in `builtins/common.c:561`
     ↳ read_octal (octal_string)
  - `xmalloc()` @ y.tab.c:8689 → defined in `braces.c:878`
     ↳ xmalloc (3)
  - `ISOCTAL()` @ y.tab.c:8708 → definition outside current scan
     ↳ ISOCTAL (*string)
  - `getnow()` @ y.tab.c:8720 → definition outside current scan
     ↳ getnow ()
  - `sv_tz()` @ y.tab.c:8722 → defined in `variables.c:6182`
     ↳ sv_tz ("TZ")
  - `localtime()` @ y.tab.c:8724 → definition outside current scan
     ↳ localtime (&the_time)
  - `strcpy()` @ y.tab.c:8727 → definition outside current scan
     ↳ strcpy (timebuf, "??")
  - `strftime()` @ y.tab.c:8731 → definition outside current scan
     ↳ strftime (timebuf, sizeof (timebuf), "%a %b %d", tm)
  - `strftime()` @ y.tab.c:8733 → definition outside current scan
     ↳ strftime (timebuf, sizeof (timebuf), "%H:%M:%S", tm)
  - `strftime()` @ y.tab.c:8735 → definition outside current scan
     ↳ strftime (timebuf, sizeof (timebuf), "%I:%M:%S", tm)
  - `strftime()` @ y.tab.c:8737 → definition outside current scan
     ↳ strftime (timebuf, sizeof (timebuf), "%I:%M %p", tm)
  - `strftime()` @ y.tab.c:8739 → definition outside current scan
     ↳ strftime (timebuf, sizeof (timebuf), "%H:%M", tm)
  - `savestring()` @ y.tab.c:8746 → definition outside current scan
     ↳ savestring (timebuf)
  - `getnow()` @ y.tab.c:8753 → definition outside current scan
     ↳ getnow ()
  - `localtime()` @ y.tab.c:8754 → definition outside current scan
     ↳ localtime (&the_time)
  - `xmalloc()` @ y.tab.c:8764 → defined in `braces.c:878`
     ↳ xmalloc (tflen + 3)
  - `memcpy()` @ y.tab.c:8765 → definition outside current scan
     ↳ memcpy (timefmt, t, tflen)
  - `strftime()` @ y.tab.c:8775 → definition outside current scan
     ↳ strftime (timebuf, sizeof (timebuf), timefmt, tm)
  - `free()` @ y.tab.c:8776 → definition outside current scan
     ↳ free (timefmt)
  - `strcpy()` @ y.tab.c:8780 → definition outside current scan
     ↳ strcpy (timebuf, "??")
  - `sh_backslash_quote_for_double_quotes()` @ y.tab.c:8793 → definition outside current scan
     ↳ sh_backslash_quote_for_double_quotes (timebuf, 0)
  - `savestring()` @ y.tab.c:8795 → definition outside current scan
     ↳ savestring (timebuf)
  - `xmalloc()` @ y.tab.c:8799 → defined in `braces.c:878`
     ↳ xmalloc (3)
  - `base_pathname()` @ y.tab.c:8806 → defined in `general.c:888`
     ↳ base_pathname (shell_name)
  - `sh_strvis()` @ y.tab.c:8810 → definition outside current scan
     ↳ sh_strvis (temp)
  - `sh_backslash_quote_for_double_quotes()` @ y.tab.c:8811 → definition outside current scan
     ↳ sh_backslash_quote_for_double_quotes (t, 0)
  - `free()` @ y.tab.c:8812 → definition outside current scan
     ↳ free (t)
  - `sh_strvis()` @ y.tab.c:8815 → definition outside current scan
     ↳ sh_strvis (temp)
  - `xmalloc()` @ y.tab.c:8820 → defined in `braces.c:878`
     ↳ xmalloc (16)
  - `strcpy()` @ y.tab.c:8822 → definition outside current scan
     ↳ strcpy (temp, dist_version)
  - `sprintf()` @ y.tab.c:8824 → definition outside current scan
     ↳ sprintf (temp, "%s.%d", dist_version, patch_level)
  - `get_string_value()` @ y.tab.c:8834 → defined in `expr.c:1654`
     ↳ get_string_value ("PWD")
  - `getcwd()` @ y.tab.c:8838 → definition outside current scan
     ↳ getcwd (t_string, sizeof(t_string))
  - `strlen()` @ y.tab.c:8844 → definition outside current scan
     ↳ strlen (t_string)
19. `fprintf()` @ eval.c:171 → definition outside current scan
   ↳ fprintf (stderr, "%s", ps0_string)
20. `fflush()` @ eval.c:172 → definition outside current scan
   ↳ fflush (stderr)
21. `free()` @ eval.c:174 → definition outside current scan
   ↳ free (ps0_string)
22. `execute_command()` @ eval.c:183 → defined in `execute_cmd.c:444`
   ↳ execute_command (current_command)
   ↪ expands into `execute_command()` (execute_cmd.c:444)
  - `new_fd_bitmap()` @ execute_cmd.c:451 → defined in `execute_cmd.c:344`
     ↳ new_fd_bitmap (FD_BITMAP_DEFAULT_SIZE)
  - `begin_unwind_frame()` @ execute_cmd.c:452 → defined in `unwind_prot.c:103`
     ↳ begin_unwind_frame ("execute-command")
  - `add_unwind_protect()` @ execute_cmd.c:453 → defined in `unwind_prot.c:126`
     ↳ add_unwind_protect (uw_dispose_fd_bitmap, (char *)bitmap)
  - `execute_command_internal()` @ execute_cmd.c:456 → defined in `execute_cmd.c:623`
     ↳ execute_command_internal (command, 0, NO_PIPE, NO_PIPE, bitmap)
  - `dispose_fd_bitmap()` @ execute_cmd.c:458 → defined in `execute_cmd.c:363`
     ↳ dispose_fd_bitmap (bitmap)
  - `discard_unwind_frame()` @ execute_cmd.c:459 → defined in `unwind_prot.c:110`
     ↳ discard_unwind_frame ("execute-command")
  - `unlink_fifo_list()` @ execute_cmd.c:465 → defined in `subst.c:5972`
     ↳ unlink_fifo_list ()
23. `dispose_command()` @ eval.c:190 → defined in `dispose_cmd.c:35`
   ↳ dispose_command (current_command)
   ↪ expands into `dispose_command()` (dispose_cmd.c:35)
  - `dispose_redirects()` @ dispose_cmd.c:42 → defined in `dispose_cmd.c:306`
     ↳ dispose_redirects (command->redirects)
  - `dispose_word()` @ dispose_cmd.c:58 → defined in `dispose_cmd.c:247`
     ↳ dispose_word (c->name)
  - `dispose_words()` @ dispose_cmd.c:59 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->map_list)
  - `dispose_command()` @ dispose_cmd.c:60 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:61 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:71 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->init)
  - `dispose_words()` @ dispose_cmd.c:72 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->test)
  - `dispose_words()` @ dispose_cmd.c:73 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->step)
  - `dispose_command()` @ dispose_cmd.c:74 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:75 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:82 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Group->command)
  - `free()` @ dispose_cmd.c:83 → definition outside current scan
     ↳ free (command->value.Group)
  - `dispose_command()` @ dispose_cmd.c:89 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Subshell->command)
  - `free()` @ dispose_cmd.c:90 → definition outside current scan
     ↳ free (command->value.Subshell)
  - `free()` @ dispose_cmd.c:96 → definition outside current scan
     ↳ free (command->value.Coproc->name)
  - `dispose_command()` @ dispose_cmd.c:97 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (command->value.Coproc->command)
  - `free()` @ dispose_cmd.c:98 → definition outside current scan
     ↳ free (command->value.Coproc)
  - `dispose_word()` @ dispose_cmd.c:108 → defined in `dispose_cmd.c:247`
     ↳ dispose_word (c->word)
  - `dispose_words()` @ dispose_cmd.c:112 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (p->patterns)
  - `dispose_command()` @ dispose_cmd.c:113 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (p->action)
  - `free()` @ dispose_cmd.c:116 → definition outside current scan
     ↳ free (t)
  - `free()` @ dispose_cmd.c:118 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:128 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->test)
  - `dispose_command()` @ dispose_cmd.c:129 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->action)
  - `free()` @ dispose_cmd.c:130 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:139 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->test)
  - `dispose_command()` @ dispose_cmd.c:140 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->true_case)
  - `dispose_command()` @ dispose_cmd.c:141 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->false_case)
  - `free()` @ dispose_cmd.c:142 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:151 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->words)
  - `dispose_redirects()` @ dispose_cmd.c:152 → defined in `dispose_cmd.c:306`
     ↳ dispose_redirects (c->redirects)
  - `free()` @ dispose_cmd.c:153 → definition outside current scan
     ↳ free (c)
  - `dispose_command()` @ dispose_cmd.c:162 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->first)
  - `dispose_command()` @ dispose_cmd.c:163 → defined in `dispose_cmd.c:35`
     ↳ dispose_command (c->second)
  - `free()` @ dispose_cmd.c:164 → definition outside current scan
     ↳ free (c)
  - `dispose_words()` @ dispose_cmd.c:174 → defined in `dispose_cmd.c:263`
     ↳ dispose_words (c->exp)
  - `free()` @ dispose_cmd.c:175 → definition outside current scan
     ↳ free (c)
  - `dispose_cond_node()` @ dispose_cmd.c:186 → defined in `dispose_cmd.c:215`
     ↳ dispose_cond_node (c)
  - `dispose_function_def()` @ dispose_cmd.c:196 → defined in `dispose_cmd.c:239`
     ↳ dispose_function_def (c)
  - `command_error()` @ dispose_cmd.c:201 → defined in `error.c:420`
     ↳ command_error ("dispose_command", CMDERR_BADTYPE, command->type, 0)
24. `handle_ignoreeof()` @ eval.c:196 → defined in `y.tab.c:9308`
   ↳ handle_ignoreeof (1)
   ↪ expands into `handle_ignoreeof()` (y.tab.c:9308)
  - `fprintf()` @ y.tab.c:9313 → definition outside current scan
     ↳ fprintf (stderr, _("Use \"%s\" to leave the shell.\n"), login_shell ? "logout" : "exit")
  - `_()` @ y.tab.c:9313 → definition outside current scan
     ↳ _("Use \"%s\" to leave the shell.\n")
  - `prompt_again()` @ y.tab.c:9321 → defined in `y.tab.c:8501`
     ↳ prompt_again (0)

## Executor core (`execute_cmd.c::execute_command_internal`)
- File: `execute_cmd.c`
- Line: 623
- Signature: `int execute_command_internal(COMMAND *command, int asynchronous, int pipe_in, int pipe_out, struct fd_bitmap *fds_to_close)`
- Body length: 610 line(s)
- Call trace captured with depth-limited expansion to show downstream dispatch order.

### Ordered call trace
1. `run_pending_traps()` @ execute_cmd.c:643 → defined in `trap.c:327`
   ↳ run_pending_traps ()
   ↪ expands into `run_pending_traps()` (trap.c:327)
  - `internal_debug()` @ trap.c:349 → defined in `error.c:254`
     ↳ internal_debug ("run_pending_traps: recursive invocation while running trap for signal %d", running_trap-1)
  - `internal_error()` @ trap.c:358 → defined in `braces.c:890`
     ↳ internal_error (_("trap handler: maximum trap handler level exceeded (%d)"), evalnest_max)
  - `_()` @ trap.c:358 → definition outside current scan
     ↳ _("trap handler: maximum trap handler level exceeded (%d)")
  - `jump_to_top_level()` @ trap.c:360 → defined in `sig.c:489`
     ↳ jump_to_top_level (DISCARD)
  - `save_pipestatus_array()` @ trap.c:369 → defined in `variables.c:6379`
     ↳ save_pipestatus_array ()
  - `save_bash_trapsig()` @ trap.c:373 → defined in `trap.c:296`
     ↳ save_bash_trapsig ()
  - `set_bash_trapsig()` @ trap.c:385 → defined in `trap.c:306`
     ↳ set_bash_trapsig (sig)
  - `run_interrupt_trap()` @ trap.c:397 → defined in `trap.c:1347`
     ↳ run_interrupt_trap (0)
  - `run_sigchld_trap()` @ trap.c:411 → defined in `jobs.c:4492`
     ↳ run_sigchld_trap (x)
  - `internal_warning()` @ trap.c:455 → defined in `error.c:221`
     ↳ internal_warning (_("run_pending_traps: bad value in trap_list[%d]: %p"), sig, trap_list[sig])
  - `_()` @ trap.c:455 → definition outside current scan
     ↳ _("run_pending_traps: bad value in trap_list[%d]: %p")
  - `internal_warning()` @ trap.c:459 → defined in `error.c:221`
     ↳ internal_warning (_("run_pending_traps: signal handler is SIG_DFL, resending %d (%s) to myself"), sig, signal_name (sig))
  - `_()` @ trap.c:459 → definition outside current scan
     ↳ _("run_pending_traps: signal handler is SIG_DFL, resending %d (%s) to myself")
  - `signal_name()` @ trap.c:459 → defined in `trap.c:218`
     ↳ signal_name (sig)
  - `kill()` @ trap.c:460 → definition outside current scan
     ↳ kill (getpid (), sig)
  - `getpid()` @ trap.c:460 → definition outside current scan
     ↳ getpid ()
  - `savestring()` @ trap.c:467 → definition outside current scan
     ↳ savestring (old_trap)
  - `save_parser_state()` @ trap.c:469 → defined in `y.tab.c:9579`
     ↳ save_parser_state (&pstate)
  - `save_pipeline()` @ trap.c:476 → defined in `jobs.c:486`
     ↳ save_pipeline (1)
  - `COPY_PROCENV()` @ trap.c:486 → definition outside current scan
     ↳ COPY_PROCENV (return_catch, save_return_catch)
  - `setjmp_nosigs()` @ trap.c:487 → definition outside current scan
     ↳ setjmp_nosigs (return_catch)
  - `parse_and_execute()` @ trap.c:496 → defined in `builtins/evalstring.c:314`
     ↳ parse_and_execute (trap_command, "trap", pflags)
  - `parse_and_execute_cleanup()` @ trap.c:500 → defined in `builtins/evalstring.c:211`
     ↳ parse_and_execute_cleanup (sig + 1)
  - `restore_pipeline()` @ trap.c:506 → defined in `jobs.c:503`
     ↳ restore_pipeline (1)
  - `restore_parser_state()` @ trap.c:510 → defined in `y.tab.c:9643`
     ↳ restore_parser_state (&pstate)
  - `COPY_PROCENV()` @ trap.c:517 → definition outside current scan
     ↳ COPY_PROCENV (save_return_catch, return_catch)
  - `restore_bash_trapsig()` @ trap.c:522 → defined in `trap.c:312`
     ↳ restore_bash_trapsig (old_trapsig)
  - `sh_longjmp()` @ trap.c:524 → definition outside current scan
     ↳ sh_longjmp (return_catch, 1)
2. `execute_in_subshell()` @ execute_cmd.c:664 → defined in `execute_cmd.c:1575`
   ↳ execute_in_subshell (command, asynchronous, pipe_in, pipe_out, fds_to_close)
   ↪ expands into `execute_in_subshell()` (execute_cmd.c:1575)
  - `USE_VAR()` @ execute_cmd.c:1582 → definition outside current scan
     ↳ USE_VAR(user_subshell)
  - `USE_VAR()` @ execute_cmd.c:1583 → definition outside current scan
     ↳ USE_VAR(user_coproc)
  - `USE_VAR()` @ execute_cmd.c:1584 → definition outside current scan
     ↳ USE_VAR(invert)
  - `USE_VAR()` @ execute_cmd.c:1585 → definition outside current scan
     ↳ USE_VAR(tcom)
  - `USE_VAR()` @ execute_cmd.c:1586 → definition outside current scan
     ↳ USE_VAR(asynchronous)
  - `stdin_redirects()` @ execute_cmd.c:1591 → defined in `redir.c:1434`
     ↳ stdin_redirects (command->redirects)
  - `reset_terminating_signals()` @ execute_cmd.c:1664 → defined in `sig.c:344`
     ↳ reset_terminating_signals ()
  - `clear_pending_traps()` @ execute_cmd.c:1669 → defined in `trap.c:660`
     ↳ clear_pending_traps ()
  - `reset_signal_handlers()` @ execute_cmd.c:1670 → defined in `trap.c:1478`
     ↳ reset_signal_handlers ()
  - `run_trap_cleanup()` @ execute_cmd.c:1682 → defined in `trap.c:1096`
     ↳ run_trap_cleanup (running_trap - 1)
  - `setup_async_signals()` @ execute_cmd.c:1692 → defined in `execute_cmd.c:5708`
     ↳ setup_async_signals ()
  - `set_sigint_handler()` @ execute_cmd.c:1698 → defined in `trap.c:802`
     ↳ set_sigint_handler ()
  - `set_sigchld_handler()` @ execute_cmd.c:1701 → defined in `jobs.c:5430`
     ↳ set_sigchld_handler ()
  - `without_job_control()` @ execute_cmd.c:1706 → defined in `jobs.c:5355`
     ↳ without_job_control ()
  - `close_fd_bitmap()` @ execute_cmd.c:1709 → defined in `execute_cmd.c:376`
     ↳ close_fd_bitmap (fds_to_close)
  - `do_piping()` @ execute_cmd.c:1711 → defined in `execute_cmd.c:6374`
     ↳ do_piping (pipe_in, pipe_out)
  - `coproc_closeall()` @ execute_cmd.c:1714 → defined in `execute_cmd.c:2214`
     ↳ coproc_closeall ()
  - `procsub_clear()` @ execute_cmd.c:1719 → defined in `jobs.c:1159`
     ↳ procsub_clear ()
  - `clear_fifo_list()` @ execute_cmd.c:1721 → defined in `subst.c:5915`
     ↳ clear_fifo_list ()
  - `stdin_redirects()` @ execute_cmd.c:1733 → defined in `redir.c:1434`
     ↳ stdin_redirects (command->redirects)
  - `restore_default_signal()` @ execute_cmd.c:1735 → defined in `trap.c:937`
     ↳ restore_default_signal (EXIT_TRAP)
  - `shell_control_structure()` @ execute_cmd.c:1738 → defined in `execute_cmd.c:473`
     ↳ shell_control_structure (command->type)
  - `async_redirect_stdin()` @ execute_cmd.c:1745 → defined in `execute_cmd.c:594`
     ↳ async_redirect_stdin ()
  - `optimize_subshell_command()` @ execute_cmd.c:1756 → defined in `builtins/evalstring.c:161`
     ↳ optimize_subshell_command (command->value.Subshell->command)
  - `do_redirections()` @ execute_cmd.c:1761 → defined in `redir.c:236`
     ↳ do_redirections (command->redirects, RX_ACTIVE)
  - `exit()` @ execute_cmd.c:1762 → definition outside current scan
     ↳ exit (invert ? EXECUTION_SUCCESS : EXECUTION_FAILURE)
  - `dispose_redirects()` @ execute_cmd.c:1764 → defined in `dispose_cmd.c:306`
     ↳ dispose_redirects (command->redirects)
  - `procsub_clear()` @ execute_cmd.c:1769 → defined in `jobs.c:1159`
     ↳ procsub_clear ()
  - `setjmp_nosigs()` @ execute_cmd.c:1811 → definition outside current scan
     ↳ setjmp_nosigs (top_level)
  - `setjmp_nosigs()` @ execute_cmd.c:1817 → definition outside current scan
     ↳ setjmp_nosigs (return_catch)
  - `execute_command_internal()` @ execute_cmd.c:1828 → defined in `execute_cmd.c:623`
     ↳ execute_command_internal ((COMMAND *)tcom, asynchronous, NO_PIPE, NO_PIPE, fds_to_close)
  - `signal_is_trapped()` @ execute_cmd.c:1841 → defined in `array.c:1036`
     ↳ signal_is_trapped (0)
  - `run_exit_trap()` @ execute_cmd.c:1844 → defined in `trap.c:1025`
     ↳ run_exit_trap ()
3. `execute_coproc()` @ execute_cmd.c:668 → defined in `execute_cmd.c:2476`
   ↳ execute_coproc (command, pipe_in, pipe_out, fds_to_close)
   ↪ expands into `execute_coproc()` (execute_cmd.c:2476)
  - `internal_warning()` @ execute_cmd.c:2493 → defined in `error.c:221`
     ↳ internal_warning (_("execute_coproc: coproc [%d:%s] still exists"), sh_coproc.c_pid, sh_coproc.c_name)
  - `_()` @ execute_cmd.c:2493 → definition outside current scan
     ↳ _("execute_coproc: coproc [%d:%s] still exists")
  - `coproc_init()` @ execute_cmd.c:2497 → defined in `execute_cmd.c:2127`
     ↳ coproc_init (&sh_coproc)
  - `expand_string_unsplit_to_string()` @ execute_cmd.c:2503 → defined in `subst.c:3872`
     ↳ expand_string_unsplit_to_string (command->value.Coproc->name, 0)
  - `valid_identifier()` @ execute_cmd.c:2505 → defined in `general.c:287`
     ↳ valid_identifier (name)
  - `err_invalidid()` @ execute_cmd.c:2507 → defined in `error.c:458`
     ↳ err_invalidid (name)
  - `free()` @ execute_cmd.c:2508 → definition outside current scan
     ↳ free (name)
  - `free()` @ execute_cmd.c:2513 → definition outside current scan
     ↳ free (command->value.Coproc->name)
  - `make_command_string()` @ execute_cmd.c:2518 → defined in `print_cmd.c:151`
     ↳ make_command_string (command)
  - `sh_openpipe()` @ execute_cmd.c:2520 → defined in `general.c:749`
     ↳ sh_openpipe ((int *)&rpipe)
  - `sh_openpipe()` @ execute_cmd.c:2521 → defined in `general.c:749`
     ↳ sh_openpipe ((int *)&wpipe)
  - `BLOCK_SIGNAL()` @ execute_cmd.c:2523 → definition outside current scan
     ↳ BLOCK_SIGNAL (SIGCHLD, set, oset)
  - `make_child()` @ execute_cmd.c:2525 → defined in `jobs.c:2264`
     ↳ make_child (p = savestring (tcmd), FORK_ASYNC)
  - `savestring()` @ execute_cmd.c:2525 → definition outside current scan
     ↳ savestring (tcmd)
  - `close()` @ execute_cmd.c:2529 → definition outside current scan
     ↳ close (rpipe[0])
  - `close()` @ execute_cmd.c:2530 → definition outside current scan
     ↳ close (wpipe[1])
  - `close()` @ execute_cmd.c:2536 → definition outside current scan
     ↳ close (oldrfd)
  - `close()` @ execute_cmd.c:2538 → definition outside current scan
     ↳ close (oldwfd)
  - `FREE()` @ execute_cmd.c:2542 → definition outside current scan
     ↳ FREE (p)
  - `UNBLOCK_SIGNAL()` @ execute_cmd.c:2545 → definition outside current scan
     ↳ UNBLOCK_SIGNAL (oset)
  - `execute_in_subshell()` @ execute_cmd.c:2546 → defined in `execute_cmd.c:1575`
     ↳ execute_in_subshell (command, 1, wpipe[0], rpipe[1], fds_to_close)
  - `fflush()` @ execute_cmd.c:2548 → definition outside current scan
     ↳ fflush (stdout)
  - `fflush()` @ execute_cmd.c:2549 → definition outside current scan
     ↳ fflush (stderr)
  - `exit()` @ execute_cmd.c:2551 → definition outside current scan
     ↳ exit (estat)
  - `close()` @ execute_cmd.c:2554 → definition outside current scan
     ↳ close (rpipe[1])
  - `close()` @ execute_cmd.c:2555 → definition outside current scan
     ↳ close (wpipe[0])
  - `coproc_alloc()` @ execute_cmd.c:2557 → defined in `execute_cmd.c:2137`
     ↳ coproc_alloc (command->value.Coproc->name, coproc_pid)
  - `SET_CLOSE_ON_EXEC()` @ execute_cmd.c:2563 → definition outside current scan
     ↳ SET_CLOSE_ON_EXEC (cp->c_rfd)
  - `SET_CLOSE_ON_EXEC()` @ execute_cmd.c:2564 → definition outside current scan
     ↳ SET_CLOSE_ON_EXEC (cp->c_wfd)
  - `coproc_setvars()` @ execute_cmd.c:2566 → defined in `execute_cmd.c:2364`
     ↳ coproc_setvars (cp)
  - `UNBLOCK_SIGNAL()` @ execute_cmd.c:2568 → definition outside current scan
     ↳ UNBLOCK_SIGNAL (oset)
  - `itrace()` @ execute_cmd.c:2571 → defined in `error.c:358`
     ↳ itrace ("execute_coproc (%s): [%d] %s", command->value.Coproc->name, coproc_pid, the_printed_command)
  - `close_pipes()` @ execute_cmd.c:2574 → defined in `execute_cmd.c:6357`
     ↳ close_pipes (pipe_in, pipe_out)
  - `unlink_fifo_list()` @ execute_cmd.c:2577 → defined in `subst.c:5972`
     ↳ unlink_fifo_list ()
  - `stop_pipeline()` @ execute_cmd.c:2579 → defined in `jobs.c:558`
     ↳ stop_pipeline (1, (COMMAND *)NULL)
  - `DESCRIBE_PID()` @ execute_cmd.c:2580 → definition outside current scan
     ↳ DESCRIBE_PID (coproc_pid)
  - `run_pending_traps()` @ execute_cmd.c:2581 → defined in `trap.c:327`
     ↳ run_pending_traps ()
4. `time_command()` @ execute_cmd.c:677 → defined in `execute_cmd.c:1429`
   ↳ time_command (command, asynchronous, pipe_in, pipe_out, fds_to_close)
   ↪ expands into `time_command()` (execute_cmd.c:1429)
  - `gettimeofday()` @ execute_cmd.c:1456 → definition outside current scan
     ↳ gettimeofday (&before, &dtz)
  - `gettimeofday()` @ execute_cmd.c:1458 → definition outside current scan
     ↳ gettimeofday (&before, NULL)
  - `getrusage()` @ execute_cmd.c:1460 → definition outside current scan
     ↳ getrusage (RUSAGE_SELF, &selfb)
  - `getrusage()` @ execute_cmd.c:1461 → definition outside current scan
     ↳ getrusage (RUSAGE_CHILDREN, &kidsb)
  - `times()` @ execute_cmd.c:1464 → definition outside current scan
     ↳ times (&before)
  - `COPY_PROCENV()` @ execute_cmd.c:1486 → definition outside current scan
     ↳ COPY_PROCENV (top_level, save_top_level)
  - `setjmp_nosigs()` @ execute_cmd.c:1488 → definition outside current scan
     ↳ setjmp_nosigs (top_level)
  - `execute_command_internal()` @ execute_cmd.c:1490 → defined in `execute_cmd.c:623`
     ↳ execute_command_internal (command, asynchronous, pipe_in, pipe_out, fds_to_close)
  - `COPY_PROCENV()` @ execute_cmd.c:1491 → definition outside current scan
     ↳ COPY_PROCENV (save_top_level, top_level)
  - `sh_longjmp()` @ execute_cmd.c:1500 → definition outside current scan
     ↳ sh_longjmp (top_level, code)
  - `gettimeofday()` @ execute_cmd.c:1508 → definition outside current scan
     ↳ gettimeofday (&after, &dtz)
  - `gettimeofday()` @ execute_cmd.c:1510 → definition outside current scan
     ↳ gettimeofday (&after, NULL)
  - `getrusage()` @ execute_cmd.c:1512 → definition outside current scan
     ↳ getrusage (RUSAGE_SELF, &selfa)
  - `getrusage()` @ execute_cmd.c:1513 → definition outside current scan
     ↳ getrusage (RUSAGE_CHILDREN, &kidsa)
  - `difftimeval()` @ execute_cmd.c:1515 → definition outside current scan
     ↳ difftimeval (&real, &before, &after)
  - `timeval_to_secs()` @ execute_cmd.c:1516 → definition outside current scan
     ↳ timeval_to_secs (&real, &rs, &rsf, 1000000)
  - `addtimeval()` @ execute_cmd.c:1518 → definition outside current scan
     ↳ addtimeval (&user, difftimeval(&after, &selfb.ru_utime, &selfa.ru_utime), difftimeval(&before, &kidsb.ru_utime, &kidsa.ru_utime))
  - `difftimeval()` @ execute_cmd.c:1518 → definition outside current scan
     ↳ difftimeval(&after, &selfb.ru_utime, &selfa.ru_utime)
  - `difftimeval()` @ execute_cmd.c:1519 → definition outside current scan
     ↳ difftimeval(&before, &kidsb.ru_utime, &kidsa.ru_utime)
  - `timeval_to_secs()` @ execute_cmd.c:1520 → definition outside current scan
     ↳ timeval_to_secs (&user, &us, &usf, 1000000)
  - `addtimeval()` @ execute_cmd.c:1522 → definition outside current scan
     ↳ addtimeval (&sys, difftimeval(&after, &selfb.ru_stime, &selfa.ru_stime), difftimeval(&before, &kidsb.ru_stime, &kidsa.ru_stime))
  - `difftimeval()` @ execute_cmd.c:1522 → definition outside current scan
     ↳ difftimeval(&after, &selfb.ru_stime, &selfa.ru_stime)
  - `difftimeval()` @ execute_cmd.c:1523 → definition outside current scan
     ↳ difftimeval(&before, &kidsb.ru_stime, &kidsa.ru_stime)
  - `timeval_to_secs()` @ execute_cmd.c:1524 → definition outside current scan
     ↳ timeval_to_secs (&sys, &ss, &ssf, 1000000)
  - `timeval_to_cpu()` @ execute_cmd.c:1526 → definition outside current scan
     ↳ timeval_to_cpu (&real, &user, &sys)
  - `times()` @ execute_cmd.c:1529 → definition outside current scan
     ↳ times (&after)
  - `clock_t_to_secs()` @ execute_cmd.c:1532 → definition outside current scan
     ↳ clock_t_to_secs (real, &rs, &rsf)
  - `clock_t_to_secs()` @ execute_cmd.c:1537 → definition outside current scan
     ↳ clock_t_to_secs (user, &us, &usf)
  - `clock_t_to_secs()` @ execute_cmd.c:1541 → definition outside current scan
     ↳ clock_t_to_secs (sys, &ss, &ssf)
  - `get_string_value()` @ execute_cmd.c:1554 → defined in `expr.c:1654`
     ↳ get_string_value ("TIMEFORMAT")
  - `print_formatted_time()` @ execute_cmd.c:1563 → defined in `execute_cmd.c:1345`
     ↳ print_formatted_time (stderr, time_format, rs, rsf, us, usf, ss, ssf, cpu)
  - `sh_longjmp()` @ execute_cmd.c:1566 → definition outside current scan
     ↳ sh_longjmp (top_level, code)
5. `shell_control_structure()` @ execute_cmd.c:685 → defined in `execute_cmd.c:473`
   ↳ shell_control_structure (command->type)
   ↪ expands into `shell_control_structure()` (execute_cmd.c:473)
6. `SET_LINE_NUMBER()` @ execute_cmd.c:696 → definition outside current scan
   ↳ SET_LINE_NUMBER (command->value.Subshell->line)
7. `make_command_string()` @ execute_cmd.c:699 → defined in `print_cmd.c:151`
   ↳ make_command_string (command)
   ↪ expands into `make_command_string()` (print_cmd.c:151)
  - `make_command_string_internal()` @ print_cmd.c:156 → defined in `print_cmd.c:175`
     ↳ make_command_string_internal (command)
8. `make_child()` @ execute_cmd.c:701 → defined in `jobs.c:2264`
   ↳ make_child (p = savestring (tcmd), fork_flags)
   ↪ expands into `make_child()` (jobs.c:2264)
  - `sigemptyset()` @ jobs.c:2274 → definition outside current scan
     ↳ sigemptyset (&oset_copy)
  - `sigprocmask()` @ jobs.c:2275 → definition outside current scan
     ↳ sigprocmask (SIG_BLOCK, (sigset_t *)NULL, &oset_copy)
  - `sigaddset()` @ jobs.c:2276 → definition outside current scan
     ↳ sigaddset (&oset_copy, SIGTERM)
  - `sigemptyset()` @ jobs.c:2280 → definition outside current scan
     ↳ sigemptyset (&set)
  - `sigaddset()` @ jobs.c:2281 → definition outside current scan
     ↳ sigaddset (&set, SIGCHLD)
  - `sigaddset()` @ jobs.c:2282 → definition outside current scan
     ↳ sigaddset (&set, SIGINT)
  - `sigaddset()` @ jobs.c:2283 → definition outside current scan
     ↳ sigaddset (&set, SIGTERM)
  - `sigemptyset()` @ jobs.c:2285 → definition outside current scan
     ↳ sigemptyset (&oset)
  - `sigprocmask()` @ jobs.c:2286 → definition outside current scan
     ↳ sigprocmask (SIG_BLOCK, &set, &oset)
  - `set_signal_handler()` @ jobs.c:2290 → defined in `sig.c:826`
     ↳ set_signal_handler (SIGTERM, SIG_DFL)
  - `making_children()` @ jobs.c:2292 → defined in `jobs.c:427`
     ↳ making_children ()
  - `sync_buffered_stream()` @ jobs.c:2302 → defined in `input.c:551`
     ↳ sync_buffered_stream (default_buffered_input)
  - `fork()` @ jobs.c:2305 → definition outside current scan
     ↳ fork ()
  - `sigprocmask()` @ jobs.c:2309 → definition outside current scan
     ↳ sigprocmask (SIG_SETMASK, &oset_copy, (sigset_t *)NULL)
  - `waitchld()` @ jobs.c:2311 → defined in `jobs.c:4056`
     ↳ waitchld (-1, 0)
  - `sys_error()` @ jobs.c:2314 → defined in `error.c:274`
     ↳ sys_error ("fork: retry")
  - `sleep()` @ jobs.c:2316 → definition outside current scan
     ↳ sleep (forksleep)
  - `sigprocmask()` @ jobs.c:2322 → definition outside current scan
     ↳ sigprocmask (SIG_SETMASK, &set, (sigset_t *)NULL)
  - `set_signal_handler()` @ jobs.c:2327 → defined in `sig.c:826`
     ↳ set_signal_handler (SIGTERM, oterm)
  - `sys_error()` @ jobs.c:2331 → defined in `error.c:274`
     ↳ sys_error ("fork")
  - `terminate_current_pipeline()` @ jobs.c:2334 → defined in `jobs.c:1739`
     ↳ terminate_current_pipeline ()
  - `kill_current_pipeline()` @ jobs.c:2338 → defined in `jobs.c:1801`
     ↳ kill_current_pipeline ()
  - `set_exit_status()` @ jobs.c:2340 → defined in `shell.c:1068`
     ↳ set_exit_status (EX_NOEXEC)
  - `throw_to_top_level()` @ jobs.c:2341 → defined in `sig.c:405`
     ↳ throw_to_top_level ()
  - `getpid()` @ jobs.c:2355 → definition outside current scan
     ↳ getpid ()
  - `unset_bash_input()` @ jobs.c:2360 → defined in `shell.c:1761`
     ↳ unset_bash_input (0)
  - `restore_sigmask()` @ jobs.c:2365 → defined in `sig.c:495`
     ↳ restore_sigmask ()
  - `ignore_tty_job_signals()` @ jobs.c:2378 → defined in `jobs.c:2505`
     ↳ ignore_tty_job_signals ()
  - `default_tty_job_signals()` @ jobs.c:2380 → defined in `jobs.c:2517`
     ↳ default_tty_job_signals ()
  - `setpgid()` @ jobs.c:2390 → definition outside current scan
     ↳ setpgid (mypid, pipeline_pgrp)
  - `sys_error()` @ jobs.c:2391 → defined in `error.c:274`
     ↳ sys_error (_("child setpgid (%ld to %ld)"), (long)mypid, (long)pipeline_pgrp)
  - `_()` @ jobs.c:2391 → definition outside current scan
     ↳ _("child setpgid (%ld to %ld)")
  - `give_terminal_to()` @ jobs.c:2400 → defined in `jobs.c:4997`
     ↳ give_terminal_to (pipeline_pgrp, 0)
  - `pipe_read()` @ jobs.c:2404 → defined in `jobs.c:5439`
     ↳ pipe_read (pgrp_pipe)
  - `default_tty_job_signals()` @ jobs.c:2419 → defined in `jobs.c:2517`
     ↳ default_tty_job_signals ()
  - `sh_closepipe()` @ jobs.c:2425 → defined in `general.c:763`
     ↳ sh_closepipe (pgrp_pipe)
  - `setpgid()` @ jobs.c:2455 → definition outside current scan
     ↳ setpgid (pid, pipeline_pgrp)
  - `add_process()` @ jobs.c:2465 → defined in `jobs.c:1607`
     ↳ add_process (command, pid)
  - `delete_old_job()` @ jobs.c:2483 → defined in `jobs.c:1366`
     ↳ delete_old_job (pid)
  - `bgp_delete()` @ jobs.c:2487 → defined in `jobs.c:895`
     ↳ bgp_delete (pid)
9. `savestring()` @ execute_cmd.c:701 → definition outside current scan
   ↳ savestring (tcmd)
10. `signal_is_trapped()` @ execute_cmd.c:703 → defined in `array.c:1036`
   ↳ signal_is_trapped (ERROR_TRAP)
   ↪ expands into `signal_is_trapped()` (array.c:1036)
11. `signal_in_progress()` @ execute_cmd.c:704 → defined in `trap.c:1651`
   ↳ signal_in_progress (DEBUG_TRAP)
   ↪ expands into `signal_in_progress()` (trap.c:1651)
12. `FREE()` @ execute_cmd.c:706 → definition outside current scan
   ↳ FREE (the_printed_command_except_trap)
13. `savestring()` @ execute_cmd.c:707 → definition outside current scan
   ↳ savestring (the_printed_command)
14. `FREE()` @ execute_cmd.c:713 → definition outside current scan
   ↳ FREE (p)
15. `execute_in_subshell()` @ execute_cmd.c:725 → defined in `execute_cmd.c:1575`
   ↳ execute_in_subshell (command, asynchronous, pipe_in, pipe_out, fds_to_close)
   ↪ expands into `execute_in_subshell()` (execute_cmd.c:1575)
  - `USE_VAR()` @ execute_cmd.c:1582 → definition outside current scan
     ↳ USE_VAR(user_subshell)
  - `USE_VAR()` @ execute_cmd.c:1583 → definition outside current scan
     ↳ USE_VAR(user_coproc)
  - `USE_VAR()` @ execute_cmd.c:1584 → definition outside current scan
     ↳ USE_VAR(invert)
  - `USE_VAR()` @ execute_cmd.c:1585 → definition outside current scan
     ↳ USE_VAR(tcom)
  - `USE_VAR()` @ execute_cmd.c:1586 → definition outside current scan
     ↳ USE_VAR(asynchronous)
  - `stdin_redirects()` @ execute_cmd.c:1591 → defined in `redir.c:1434`
     ↳ stdin_redirects (command->redirects)
  - `reset_terminating_signals()` @ execute_cmd.c:1664 → defined in `sig.c:344`
     ↳ reset_terminating_signals ()
  - `clear_pending_traps()` @ execute_cmd.c:1669 → defined in `trap.c:660`
     ↳ clear_pending_traps ()
  - `reset_signal_handlers()` @ execute_cmd.c:1670 → defined in `trap.c:1478`
     ↳ reset_signal_handlers ()
  - `run_trap_cleanup()` @ execute_cmd.c:1682 → defined in `trap.c:1096`
     ↳ run_trap_cleanup (running_trap - 1)
  - `setup_async_signals()` @ execute_cmd.c:1692 → defined in `execute_cmd.c:5708`
     ↳ setup_async_signals ()
  - `set_sigint_handler()` @ execute_cmd.c:1698 → defined in `trap.c:802`
     ↳ set_sigint_handler ()
  - `set_sigchld_handler()` @ execute_cmd.c:1701 → defined in `jobs.c:5430`
     ↳ set_sigchld_handler ()
  - `without_job_control()` @ execute_cmd.c:1706 → defined in `jobs.c:5355`
     ↳ without_job_control ()
  - `close_fd_bitmap()` @ execute_cmd.c:1709 → defined in `execute_cmd.c:376`
     ↳ close_fd_bitmap (fds_to_close)
  - `do_piping()` @ execute_cmd.c:1711 → defined in `execute_cmd.c:6374`
     ↳ do_piping (pipe_in, pipe_out)
  - `coproc_closeall()` @ execute_cmd.c:1714 → defined in `execute_cmd.c:2214`
     ↳ coproc_closeall ()
  - `procsub_clear()` @ execute_cmd.c:1719 → defined in `jobs.c:1159`
     ↳ procsub_clear ()
  - `clear_fifo_list()` @ execute_cmd.c:1721 → defined in `subst.c:5915`
     ↳ clear_fifo_list ()
  - `stdin_redirects()` @ execute_cmd.c:1733 → defined in `redir.c:1434`
     ↳ stdin_redirects (command->redirects)
  - `restore_default_signal()` @ execute_cmd.c:1735 → defined in `trap.c:937`
     ↳ restore_default_signal (EXIT_TRAP)
  - `shell_control_structure()` @ execute_cmd.c:1738 → defined in `execute_cmd.c:473`
     ↳ shell_control_structure (command->type)
  - `async_redirect_stdin()` @ execute_cmd.c:1745 → defined in `execute_cmd.c:594`
     ↳ async_redirect_stdin ()
  - `optimize_subshell_command()` @ execute_cmd.c:1756 → defined in `builtins/evalstring.c:161`
     ↳ optimize_subshell_command (command->value.Subshell->command)
  - `do_redirections()` @ execute_cmd.c:1761 → defined in `redir.c:236`
     ↳ do_redirections (command->redirects, RX_ACTIVE)
  - `exit()` @ execute_cmd.c:1762 → definition outside current scan
     ↳ exit (invert ? EXECUTION_SUCCESS : EXECUTION_FAILURE)
  - `dispose_redirects()` @ execute_cmd.c:1764 → defined in `dispose_cmd.c:306`
     ↳ dispose_redirects (command->redirects)
  - `procsub_clear()` @ execute_cmd.c:1769 → defined in `jobs.c:1159`
     ↳ procsub_clear ()
  - `setjmp_nosigs()` @ execute_cmd.c:1811 → definition outside current scan
     ↳ setjmp_nosigs (top_level)
  - `setjmp_nosigs()` @ execute_cmd.c:1817 → definition outside current scan
     ↳ setjmp_nosigs (return_catch)
  - `execute_command_internal()` @ execute_cmd.c:1828 → defined in `execute_cmd.c:623`
     ↳ execute_command_internal ((COMMAND *)tcom, asynchronous, NO_PIPE, NO_PIPE, fds_to_close)
  - `signal_is_trapped()` @ execute_cmd.c:1841 → defined in `array.c:1036`
     ↳ signal_is_trapped (0)
  - `run_exit_trap()` @ execute_cmd.c:1844 → defined in `trap.c:1025`
     ↳ run_exit_trap ()
16. `subshell_exit()` @ execute_cmd.c:727 → defined in `shell.c:1053`
   ↳ subshell_exit (last_command_exit_value)
   ↪ expands into `subshell_exit()` (shell.c:1053)
  - `fflush()` @ shell.c:1056 → definition outside current scan
     ↳ fflush (stdout)
  - `fflush()` @ shell.c:1057 → definition outside current scan
     ↳ fflush (stderr)
  - `signal_is_trapped()` @ shell.c:1062 → defined in `array.c:1036`
     ↳ signal_is_trapped (0)
  - `run_exit_trap()` @ shell.c:1063 → defined in `trap.c:1025`
     ↳ run_exit_trap ()
  - `sh_exit()` @ shell.c:1065 → defined in `shell.c:1038`
     ↳ sh_exit (s)
17. `sh_exit()` @ execute_cmd.c:729 → defined in `shell.c:1038`
   ↳ sh_exit (last_command_exit_value)
   ↪ expands into `sh_exit()` (shell.c:1038)
  - `trace_malloc_stats()` @ shell.c:1043 → definition outside current scan
     ↳ trace_malloc_stats (get_name_for_error (), NULL)
  - `get_name_for_error()` @ shell.c:1043 → defined in `error.c:89`
     ↳ get_name_for_error ()
  - `exit()` @ shell.c:1047 → definition outside current scan
     ↳ exit (s)
18. `close_pipes()` @ execute_cmd.c:734 → defined in `execute_cmd.c:6357`
   ↳ close_pipes (pipe_in, pipe_out)
   ↪ expands into `close_pipes()` (execute_cmd.c:6357)
  - `close()` @ execute_cmd.c:6361 → definition outside current scan
     ↳ close (in)
  - `close()` @ execute_cmd.c:6363 → definition outside current scan
     ↳ close (out)
19. `unlink_fifo_list()` @ execute_cmd.c:738 → defined in `subst.c:5972`
   ↳ unlink_fifo_list ()
   ↪ expands into `unlink_fifo_list()` (subst.c:5972)
  - `kill()` @ subst.c:5982 → definition outside current scan
     ↳ kill(fifo_list[i].proc, 0)
  - `unlink()` @ subst.c:5984 → definition outside current scan
     ↳ unlink (fifo_list[i].file)
  - `free()` @ subst.c:5985 → definition outside current scan
     ↳ free (fifo_list[i].file)
20. `stop_pipeline()` @ execute_cmd.c:752 → defined in `jobs.c:558`
   ↳ stop_pipeline (asynchronous, (COMMAND *)NULL)
   ↪ expands into `stop_pipeline()` (jobs.c:558)
  - `BLOCK_CHILD()` @ jobs.c:565 → definition outside current scan
     ↳ BLOCK_CHILD (set, oset)
  - `sh_closepipe()` @ jobs.c:569 → defined in `general.c:763`
     ↳ sh_closepipe (pgrp_pipe)
  - `cleanup_dead_jobs()` @ jobs.c:572 → defined in `jobs.c:1302`
     ↳ cleanup_dead_jobs ()
  - `xmalloc()` @ jobs.c:577 → defined in `braces.c:878`
     ↳ xmalloc (js.j_jobslots * sizeof (JOB *))
  - `compact_jobs_list()` @ jobs.c:620 → defined in `jobs.c:1467`
     ↳ compact_jobs_list (0)
  - `xrealloc()` @ jobs.c:626 → defined in `braces.c:884`
     ↳ xrealloc (jobs, (js.j_jobslots * sizeof (JOB *)))
  - `xmalloc()` @ jobs.c:638 → defined in `braces.c:878`
     ↳ xmalloc (sizeof (JOB))
  - `REVERSE_LIST()` @ jobs.c:643 → definition outside current scan
     ↳ REVERSE_LIST (the_pipeline, PROCESS *)
  - `PRUNNING()` @ jobs.c:670 → definition outside current scan
     ↳ PRUNNING (p)
  - `PSTOPPED()` @ jobs.c:671 → definition outside current scan
     ↳ PSTOPPED (p)
  - `job_working_directory()` @ jobs.c:677 → defined in `jobs.c:411`
     ↳ job_working_directory ()
  - `setjstatus()` @ jobs.c:685 → defined in `jobs.c:4463`
     ↳ setjstatus (i)
  - `reset_current()` @ jobs.c:710 → defined in `jobs.c:3767`
     ↳ reset_current ()
  - `maybe_give_terminal_to()` @ jobs.c:733 → defined in `jobs.c:5037`
     ↳ maybe_give_terminal_to (shell_pgrp, newjob->pgrp, 0)
  - `stop_making_children()` @ jobs.c:738 → defined in `jobs.c:437`
     ↳ stop_making_children ()
  - `UNBLOCK_CHILD()` @ jobs.c:739 → definition outside current scan
     ↳ UNBLOCK_CHILD (oset)
21. `signal_is_trapped()` @ execute_cmd.c:756 → defined in `array.c:1036`
   ↳ signal_is_trapped (ERROR_TRAP)
   ↪ expands into `signal_is_trapped()` (array.c:1036)
22. `signal_is_ignored()` @ execute_cmd.c:756 → defined in `trap.c:1613`
   ↳ signal_is_ignored (ERROR_TRAP)
   ↪ expands into `signal_is_ignored()` (trap.c:1613)
23. `wait_for()` @ execute_cmd.c:760 → defined in `jobs.c:3063`
   ↳ wait_for (paren_pid, 0)
   ↪ expands into `wait_for()` (jobs.c:3063)
  - `BLOCK_CHILD()` @ jobs.c:3075 → definition outside current scan
     ↳ BLOCK_CHILD (set, oset)
  - `set_signal_handler()` @ jobs.c:3093 → defined in `sig.c:826`
     ↳ set_signal_handler (SIGINT, wait_sigint_handler)
  - `internal_debug()` @ jobs.c:3096 → defined in `error.c:254`
     ↳ internal_debug ("wait_for: recursively setting old_sigint_handler to wait_sigint_handler: running_trap = %d", running_trap)
  - `set_signal_handler()` @ jobs.c:3101 → defined in `sig.c:826`
     ↳ set_signal_handler (SIGINT, old_sigint_handler)
  - `FIND_CHILD()` @ jobs.c:3121 → definition outside current scan
     ↳ FIND_CHILD (pid, child)
  - `find_job()` @ jobs.c:3128 → defined in `jobs.c:1877`
     ↳ find_job (pid, 0, NULL)
  - `PRUNNING()` @ jobs.c:3134 → definition outside current scan
     ↳ PRUNNING(child)
  - `RUNNING()` @ jobs.c:3134 → definition outside current scan
     ↳ RUNNING (job)
  - `waitchld()` @ jobs.c:3145 → defined in `jobs.c:4056`
     ↳ waitchld (pid, 1)
  - `itrace()` @ jobs.c:3148 → defined in `error.c:358`
     ↳ itrace("wait_for: blocking wait for %d returns %d child = %p", (int)pid, r, child)
  - `restore_sigint_handler()` @ jobs.c:3155 → defined in `jobs.c:2892`
     ↳ restore_sigint_handler ()
  - `WSTATUS()` @ jobs.c:3168 → definition outside current scan
     ↳ WSTATUS (child->status)
  - `restore_sigint_handler()` @ jobs.c:3201 → defined in `jobs.c:2892`
     ↳ restore_sigint_handler ()
  - `PRUNNING()` @ jobs.c:3205 → definition outside current scan
     ↳ PRUNNING (child)
  - `RUNNING()` @ jobs.c:3205 → definition outside current scan
     ↳ RUNNING (job)
  - `restore_sigint_handler()` @ jobs.c:3208 → defined in `jobs.c:2892`
     ↳ restore_sigint_handler ()
  - `job_exit_status()` @ jobs.c:3214 → defined in `jobs.c:3019`
     ↳ job_exit_status (job)
  - `process_exit_status()` @ jobs.c:3215 → defined in `jobs.c:2957`
     ↳ process_exit_status (child->status)
  - `job_exit_signal()` @ jobs.c:3216 → defined in `jobs.c:3025`
     ↳ job_exit_signal (job)
  - `process_exit_signal()` @ jobs.c:3217 → defined in `jobs.c:2951`
     ↳ process_exit_signal (child->status)
  - `JOBSTATE()` @ jobs.c:3220 → definition outside current scan
     ↳ JOBSTATE (job)
  - `WIFSTOPPED()` @ jobs.c:3220 → definition outside current scan
     ↳ WIFSTOPPED (child->status)
  - `WSTOPSIG()` @ jobs.c:3221 → definition outside current scan
     ↳ WSTOPSIG (child->status)
  - `IS_JOBCONTROL()` @ jobs.c:3223 → definition outside current scan
     ↳ IS_JOBCONTROL (job)
  - `itrace()` @ jobs.c:3240 → defined in `error.c:358`
     ↳ itrace("wait_for: job == NO_JOB, giving the terminal to shell_pgrp (%ld)", (long)shell_pgrp)
  - `IS_ASYNC()` @ jobs.c:3251 → definition outside current scan
     ↳ IS_ASYNC (job)
  - `IS_FOREGROUND()` @ jobs.c:3251 → definition outside current scan
     ↳ IS_FOREGROUND (job)
  - `give_terminal_to()` @ jobs.c:3253 → defined in `jobs.c:4997`
     ↳ give_terminal_to (shell_pgrp, 0)
  - `job_signal_status()` @ jobs.c:3275 → defined in `jobs.c:2968`
     ↳ job_signal_status (job)
  - `WIFSIGNALED()` @ jobs.c:3277 → definition outside current scan
     ↳ WIFSIGNALED (s)
  - `WIFSTOPPED()` @ jobs.c:3277 → definition outside current scan
     ↳ WIFSTOPPED (s)
  - `set_tty_state()` @ jobs.c:3280 → defined in `jobs.c:2654`
     ↳ set_tty_state ()
  - `IS_FOREGROUND()` @ jobs.c:3284 → definition outside current scan
     ↳ IS_FOREGROUND (job)
  - `get_new_window_size()` @ jobs.c:3285 → definition outside current scan
     ↳ get_new_window_size (0, (int *)0, (int *)0)
  - `RL_ISSTATE()` @ jobs.c:3294 → definition outside current scan
     ↳ RL_ISSTATE(RL_STATE_COMPLETING|RL_STATE_DISPATCHING|RL_STATE_TERMPREPPED)
  - `get_new_window_size()` @ jobs.c:3297 → definition outside current scan
     ↳ get_new_window_size (0, (int *)0, (int *)0)
  - `get_tty_state()` @ jobs.c:3301 → defined in `jobs.c:2617`
     ↳ get_tty_state ()
  - `IS_JOBCONTROL()` @ jobs.c:3307 → definition outside current scan
     ↳ IS_JOBCONTROL (job)
  - `IS_FOREGROUND()` @ jobs.c:3307 → definition outside current scan
     ↳ IS_FOREGROUND (job)
  - `WIFSIGNALED()` @ jobs.c:3308 → definition outside current scan
     ↳ WIFSIGNALED (s)
24. `run_error_trap()` @ execute_cmd.c:773 → defined in `trap.c:1319`
   ↳ run_error_trap ()
   ↪ expands into `run_error_trap()` (trap.c:1319)
  - `_run_trap_internal()` @ trap.c:1323 → defined in `trap.c:1107`
     ↳ _run_trap_internal (ERROR_TRAP, "error trap")
25. `signal_in_progress()` @ execute_cmd.c:782 → defined in `trap.c:1651`
   ↳ signal_in_progress (DEBUG_TRAP)
   ↪ expands into `signal_in_progress()` (trap.c:1651)
26. `FREE()` @ execute_cmd.c:784 → definition outside current scan
   ↳ FREE (the_printed_command_except_trap)
27. `savestring()` @ execute_cmd.c:785 → definition outside current scan
   ↳ savestring (the_printed_command)
28. `run_pending_traps()` @ execute_cmd.c:787 → defined in `trap.c:327`
   ↳ run_pending_traps ()
   ↪ expands into `run_pending_traps()` (trap.c:327)
  - `internal_debug()` @ trap.c:349 → defined in `error.c:254`
     ↳ internal_debug ("run_pending_traps: recursive invocation while running trap for signal %d", running_trap-1)
  - `internal_error()` @ trap.c:358 → defined in `braces.c:890`
     ↳ internal_error (_("trap handler: maximum trap handler level exceeded (%d)"), evalnest_max)
  - `_()` @ trap.c:358 → definition outside current scan
     ↳ _("trap handler: maximum trap handler level exceeded (%d)")
  - `jump_to_top_level()` @ trap.c:360 → defined in `sig.c:489`
     ↳ jump_to_top_level (DISCARD)
  - `save_pipestatus_array()` @ trap.c:369 → defined in `variables.c:6379`
     ↳ save_pipestatus_array ()
  - `save_bash_trapsig()` @ trap.c:373 → defined in `trap.c:296`
     ↳ save_bash_trapsig ()
  - `set_bash_trapsig()` @ trap.c:385 → defined in `trap.c:306`
     ↳ set_bash_trapsig (sig)
  - `run_interrupt_trap()` @ trap.c:397 → defined in `trap.c:1347`
     ↳ run_interrupt_trap (0)
  - `run_sigchld_trap()` @ trap.c:411 → defined in `jobs.c:4492`
     ↳ run_sigchld_trap (x)
  - `internal_warning()` @ trap.c:455 → defined in `error.c:221`
     ↳ internal_warning (_("run_pending_traps: bad value in trap_list[%d]: %p"), sig, trap_list[sig])
  - `_()` @ trap.c:455 → definition outside current scan
     ↳ _("run_pending_traps: bad value in trap_list[%d]: %p")
  - `internal_warning()` @ trap.c:459 → defined in `error.c:221`
     ↳ internal_warning (_("run_pending_traps: signal handler is SIG_DFL, resending %d (%s) to myself"), sig, signal_name (sig))
  - `_()` @ trap.c:459 → definition outside current scan
     ↳ _("run_pending_traps: signal handler is SIG_DFL, resending %d (%s) to myself")
  - `signal_name()` @ trap.c:459 → defined in `trap.c:218`
     ↳ signal_name (sig)
  - `kill()` @ trap.c:460 → definition outside current scan
     ↳ kill (getpid (), sig)
  - `getpid()` @ trap.c:460 → definition outside current scan
     ↳ getpid ()
  - `savestring()` @ trap.c:467 → definition outside current scan
     ↳ savestring (old_trap)
  - `save_parser_state()` @ trap.c:469 → defined in `y.tab.c:9579`
     ↳ save_parser_state (&pstate)
  - `save_pipeline()` @ trap.c:476 → defined in `jobs.c:486`
     ↳ save_pipeline (1)
  - `COPY_PROCENV()` @ trap.c:486 → definition outside current scan
     ↳ COPY_PROCENV (return_catch, save_return_catch)
  - `setjmp_nosigs()` @ trap.c:487 → definition outside current scan
     ↳ setjmp_nosigs (return_catch)
  - `parse_and_execute()` @ trap.c:496 → defined in `builtins/evalstring.c:314`
     ↳ parse_and_execute (trap_command, "trap", pflags)
  - `parse_and_execute_cleanup()` @ trap.c:500 → defined in `builtins/evalstring.c:211`
     ↳ parse_and_execute_cleanup (sig + 1)
  - `restore_pipeline()` @ trap.c:506 → defined in `jobs.c:503`
     ↳ restore_pipeline (1)
  - `restore_parser_state()` @ trap.c:510 → defined in `y.tab.c:9643`
     ↳ restore_parser_state (&pstate)
  - `COPY_PROCENV()` @ trap.c:517 → definition outside current scan
     ↳ COPY_PROCENV (save_return_catch, return_catch)
  - `restore_bash_trapsig()` @ trap.c:522 → defined in `trap.c:312`
     ↳ restore_bash_trapsig (old_trapsig)
  - `sh_longjmp()` @ trap.c:524 → definition outside current scan
     ↳ sh_longjmp (return_catch, 1)
29. `jump_to_top_level()` @ execute_cmd.c:788 → defined in `sig.c:489`
   ↳ jump_to_top_level (ERREXIT)
   ↪ expands into `jump_to_top_level()` (sig.c:489)
  - `sh_longjmp()` @ sig.c:492 → definition outside current scan
     ↳ sh_longjmp (top_level, value)
30. `DESCRIBE_PID()` @ execute_cmd.c:795 → definition outside current scan
   ↳ DESCRIBE_PID (paren_pid)
31. `run_pending_traps()` @ execute_cmd.c:797 → defined in `trap.c:327`
   ↳ run_pending_traps ()
   ↪ expands into `run_pending_traps()` (trap.c:327)
  - `internal_debug()` @ trap.c:349 → defined in `error.c:254`
     ↳ internal_debug ("run_pending_traps: recursive invocation while running trap for signal %d", running_trap-1)
  - `internal_error()` @ trap.c:358 → defined in `braces.c:890`
     ↳ internal_error (_("trap handler: maximum trap handler level exceeded (%d)"), evalnest_max)
  - `_()` @ trap.c:358 → definition outside current scan
     ↳ _("trap handler: maximum trap handler level exceeded (%d)")
  - `jump_to_top_level()` @ trap.c:360 → defined in `sig.c:489`
     ↳ jump_to_top_level (DISCARD)
  - `save_pipestatus_array()` @ trap.c:369 → defined in `variables.c:6379`
     ↳ save_pipestatus_array ()
  - `save_bash_trapsig()` @ trap.c:373 → defined in `trap.c:296`
     ↳ save_bash_trapsig ()
  - `set_bash_trapsig()` @ trap.c:385 → defined in `trap.c:306`
     ↳ set_bash_trapsig (sig)
  - `run_interrupt_trap()` @ trap.c:397 → defined in `trap.c:1347`
     ↳ run_interrupt_trap (0)
  - `run_sigchld_trap()` @ trap.c:411 → defined in `jobs.c:4492`
     ↳ run_sigchld_trap (x)
  - `internal_warning()` @ trap.c:455 → defined in `error.c:221`
     ↳ internal_warning (_("run_pending_traps: bad value in trap_list[%d]: %p"), sig, trap_list[sig])
  - `_()` @ trap.c:455 → definition outside current scan
     ↳ _("run_pending_traps: bad value in trap_list[%d]: %p")
  - `internal_warning()` @ trap.c:459 → defined in `error.c:221`
     ↳ internal_warning (_("run_pending_traps: signal handler is SIG_DFL, resending %d (%s) to myself"), sig, signal_name (sig))
  - `_()` @ trap.c:459 → definition outside current scan
     ↳ _("run_pending_traps: signal handler is SIG_DFL, resending %d (%s) to myself")
  - `signal_name()` @ trap.c:459 → defined in `trap.c:218`
     ↳ signal_name (sig)
  - `kill()` @ trap.c:460 → definition outside current scan
     ↳ kill (getpid (), sig)
  - `getpid()` @ trap.c:460 → definition outside current scan
     ↳ getpid ()
  - `savestring()` @ trap.c:467 → definition outside current scan
     ↳ savestring (old_trap)
  - `save_parser_state()` @ trap.c:469 → defined in `y.tab.c:9579`
     ↳ save_parser_state (&pstate)
  - `save_pipeline()` @ trap.c:476 → defined in `jobs.c:486`
     ↳ save_pipeline (1)
  - `COPY_PROCENV()` @ trap.c:486 → definition outside current scan
     ↳ COPY_PROCENV (return_catch, save_return_catch)
  - `setjmp_nosigs()` @ trap.c:487 → definition outside current scan
     ↳ setjmp_nosigs (return_catch)
  - `parse_and_execute()` @ trap.c:496 → defined in `builtins/evalstring.c:314`
     ↳ parse_and_execute (trap_command, "trap", pflags)
  - `parse_and_execute_cleanup()` @ trap.c:500 → defined in `builtins/evalstring.c:211`
     ↳ parse_and_execute_cleanup (sig + 1)
  - `restore_pipeline()` @ trap.c:506 → defined in `jobs.c:503`
     ↳ restore_pipeline (1)
  - `restore_parser_state()` @ trap.c:510 → defined in `y.tab.c:9643`
     ↳ restore_parser_state (&pstate)
  - `COPY_PROCENV()` @ trap.c:517 → definition outside current scan
     ↳ COPY_PROCENV (save_return_catch, return_catch)
  - `restore_bash_trapsig()` @ trap.c:522 → defined in `trap.c:312`
     ↳ restore_bash_trapsig (old_trapsig)
  - `sh_longjmp()` @ trap.c:524 → definition outside current scan
     ↳ sh_longjmp (return_catch, 1)
32. `execute_command_internal()` @ execute_cmd.c:813 → defined in `execute_cmd.c:623` (recursive call prevented)
   ↳ execute_command_internal (command, 1, pipe_in, pipe_out, fds_to_close)
33. `time_command()` @ execute_cmd.c:817 → defined in `execute_cmd.c:1429`
   ↳ time_command (command, asynchronous, pipe_in, pipe_out, fds_to_close)
   ↪ expands into `time_command()` (execute_cmd.c:1429)
  - `gettimeofday()` @ execute_cmd.c:1456 → definition outside current scan
     ↳ gettimeofday (&before, &dtz)
  - `gettimeofday()` @ execute_cmd.c:1458 → definition outside current scan
     ↳ gettimeofday (&before, NULL)
  - `getrusage()` @ execute_cmd.c:1460 → definition outside current scan
     ↳ getrusage (RUSAGE_SELF, &selfb)
  - `getrusage()` @ execute_cmd.c:1461 → definition outside current scan
     ↳ getrusage (RUSAGE_CHILDREN, &kidsb)
  - `times()` @ execute_cmd.c:1464 → definition outside current scan
     ↳ times (&before)
  - `COPY_PROCENV()` @ execute_cmd.c:1486 → definition outside current scan
     ↳ COPY_PROCENV (top_level, save_top_level)
  - `setjmp_nosigs()` @ execute_cmd.c:1488 → definition outside current scan
     ↳ setjmp_nosigs (top_level)
  - `execute_command_internal()` @ execute_cmd.c:1490 → defined in `execute_cmd.c:623`
     ↳ execute_command_internal (command, asynchronous, pipe_in, pipe_out, fds_to_close)
  - `COPY_PROCENV()` @ execute_cmd.c:1491 → definition outside current scan
     ↳ COPY_PROCENV (save_top_level, top_level)
  - `sh_longjmp()` @ execute_cmd.c:1500 → definition outside current scan
     ↳ sh_longjmp (top_level, code)
  - `gettimeofday()` @ execute_cmd.c:1508 → definition outside current scan
     ↳ gettimeofday (&after, &dtz)
  - `gettimeofday()` @ execute_cmd.c:1510 → definition outside current scan
     ↳ gettimeofday (&after, NULL)
  - `getrusage()` @ execute_cmd.c:1512 → definition outside current scan
     ↳ getrusage (RUSAGE_SELF, &selfa)
  - `getrusage()` @ execute_cmd.c:1513 → definition outside current scan
     ↳ getrusage (RUSAGE_CHILDREN, &kidsa)
  - `difftimeval()` @ execute_cmd.c:1515 → definition outside current scan
     ↳ difftimeval (&real, &before, &after)
  - `timeval_to_secs()` @ execute_cmd.c:1516 → definition outside current scan
     ↳ timeval_to_secs (&real, &rs, &rsf, 1000000)
  - `addtimeval()` @ execute_cmd.c:1518 → definition outside current scan
     ↳ addtimeval (&user, difftimeval(&after, &selfb.ru_utime, &selfa.ru_utime), difftimeval(&before, &kidsb.ru_utime, &kidsa.ru_utime))
  - `difftimeval()` @ execute_cmd.c:1518 → definition outside current scan
     ↳ difftimeval(&after, &selfb.ru_utime, &selfa.ru_utime)
  - `difftimeval()` @ execute_cmd.c:1519 → definition outside current scan
     ↳ difftimeval(&before, &kidsb.ru_utime, &kidsa.ru_utime)
  - `timeval_to_secs()` @ execute_cmd.c:1520 → definition outside current scan
     ↳ timeval_to_secs (&user, &us, &usf, 1000000)
  - `addtimeval()` @ execute_cmd.c:1522 → definition outside current scan
     ↳ addtimeval (&sys, difftimeval(&after, &selfb.ru_stime, &selfa.ru_stime), difftimeval(&before, &kidsb.ru_stime, &kidsa.ru_stime))
  - `difftimeval()` @ execute_cmd.c:1522 → definition outside current scan
     ↳ difftimeval(&after, &selfb.ru_stime, &selfa.ru_stime)
  - `difftimeval()` @ execute_cmd.c:1523 → definition outside current scan
     ↳ difftimeval(&before, &kidsb.ru_stime, &kidsa.ru_stime)
  - `timeval_to_secs()` @ execute_cmd.c:1524 → definition outside current scan
     ↳ timeval_to_secs (&sys, &ss, &ssf, 1000000)
  - `timeval_to_cpu()` @ execute_cmd.c:1526 → definition outside current scan
     ↳ timeval_to_cpu (&real, &user, &sys)
  - `times()` @ execute_cmd.c:1529 → definition outside current scan
     ↳ times (&after)
  - `clock_t_to_secs()` @ execute_cmd.c:1532 → definition outside current scan
     ↳ clock_t_to_secs (real, &rs, &rsf)
  - `clock_t_to_secs()` @ execute_cmd.c:1537 → definition outside current scan
     ↳ clock_t_to_secs (user, &us, &usf)
  - `clock_t_to_secs()` @ execute_cmd.c:1541 → definition outside current scan
     ↳ clock_t_to_secs (sys, &ss, &ssf)
  - `get_string_value()` @ execute_cmd.c:1554 → defined in `expr.c:1654`
     ↳ get_string_value ("TIMEFORMAT")
  - `print_formatted_time()` @ execute_cmd.c:1563 → defined in `execute_cmd.c:1345`
     ↳ print_formatted_time (stderr, time_format, rs, rsf, us, usf, ss, ssf, cpu)
  - `sh_longjmp()` @ execute_cmd.c:1566 → definition outside current scan
     ↳ sh_longjmp (top_level, code)
34. `shell_control_structure()` @ execute_cmd.c:827 → defined in `execute_cmd.c:473`
   ↳ shell_control_structure (command->type)
   ↪ expands into `shell_control_structure()` (execute_cmd.c:473)
35. `stdin_redirects()` @ execute_cmd.c:828 → defined in `redir.c:1434`
   ↳ stdin_redirects (command->redirects)
   ↪ expands into `stdin_redirects()` (redir.c:1434)
  - `stdin_redirection()` @ redir.c:1442 → defined in `redir.c:1400`
     ↳ stdin_redirection (rp->instruction, rp->redirector.dest)
36. `delete_procsubs()` @ execute_cmd.c:832 → defined in `subst.c:6093`
   ↳ delete_procsubs ()
   ↪ expands into `delete_procsubs()` (subst.c:6093)
  - `reap_some_procsubs()` @ subst.c:6096 → defined in `subst.c:6083`
     ↳ reap_some_procsubs (nfifo)
37. `num_fifos()` @ execute_cmd.c:838 → defined in `subst.c:6105`
   ↳ num_fifos ()
   ↪ expands into `num_fifos()` (subst.c:6105)
38. `copy_fifo_list()` @ execute_cmd.c:839 → defined in `subst.c:5930`
   ↳ copy_fifo_list ((int *)&osize)
   ↪ expands into `copy_fifo_list()` (subst.c:5930)
39. `begin_unwind_frame()` @ execute_cmd.c:840 → defined in `unwind_prot.c:103`
   ↳ begin_unwind_frame ("internal_fifos")
   ↪ expands into `begin_unwind_frame()` (unwind_prot.c:103)
  - `add_unwind_protect()` @ unwind_prot.c:106 → defined in `unwind_prot.c:126`
     ↳ add_unwind_protect (NULL, tag)
40. `add_unwind_protect()` @ execute_cmd.c:842 → defined in `unwind_prot.c:126`
   ↳ add_unwind_protect (xfree, ofifo_list)
   ↪ expands into `add_unwind_protect()` (unwind_prot.c:126)
  - `add_unwind_protect_internal()` @ unwind_prot.c:129 → defined in `unwind_prot.c:183`
     ↳ add_unwind_protect_internal (cleanup, arg)

---
## Additional entry programs
- `array.c:1139` → array_create, array_insert, array_insert, array_insert, array_insert
- `array2.c:1197` → array_create, array_insert, array_insert, array_insert, array_insert
- `builtins/gen-helpfiles.c:103` → strcmp, strcmp, strcmp, fprintf, exit
- `builtins/getopt.c:283` → sh_getopt, printf, printf, printf, printf
- `builtins/mkbuiltins.c:227` → strcmp, strcmp, strcmp, strcmp, strcmp
- `builtins/psize.c:57` → signal, write
- `hashlib.c:478` → hash_create, hash_create, fgets, savestring, hash_insert
- `mksyntax.c:293` → strrchr, getopt, usage, fopen, fprintf
- `support/bashversion.c:61` → strrchr, getopt, usage, exit, usage
- `support/man2html.c:3998` → getopt, usage, exit, usage, exit
- `support/mksignames.c:72` → fopen, fprintf, exit, fprintf, exit
- `support/printenv.c:33` → puts, exit, strlen, strncmp, puts
- `support/recho.c:32` → printf, strprint, printf, exit
- `support/siglen.c:7` → strcmp, strsignal, strlen, printf, printf
- `support/xcase.c:41` → getopt, setbuf, fprintf, exit, fopen
- `support/zecho.c:24` → printf, putchar, putchar, exit

---
## Methodology & next steps
- AST-guided traversal keeps statements ordered, so startup, reader, and executor flows retain the real control-path.
- Depth is currently limited to two hops to avoid combinatorial explosion; bump FLOW_DEPTH for deeper recursion once compression strategies mature.
- Attach `.miniphi/benchmarks` mirrors to reuse this breakdown inside orchestrated reasoning tasks without rescanning 5K+ line files.
- Future enhancement: annotate each call with surrounding comments to add semantic context (e.g., why traps or job control toggles occur).

---
Report crafted by benchmark/scripts/bash-flow-explain.js.