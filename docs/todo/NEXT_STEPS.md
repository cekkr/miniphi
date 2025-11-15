# Next Steps

- [ ] Restore a proper Node.js toolchain (npm + @lmstudio/sdk, better-sqlite3, tree-sitter deps) so that LM Studio features and scoring pipelines run without the new fallback warnings.
- [ ] Document and/or automate Node binary discovery so the CLI can default to the LM Studio embedded runtime when the system node is missing, preventing manual path overrides during benchmarks.
- [ ] Consider lazily importing LM Studio handlers only for commands that need them to avoid loading the optional dependency at process start; this would shave a few hundred milliseconds off recompose-only benchmarks.
