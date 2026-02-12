# Benchmark Task Clones

This folder stores a structured clone of `dev_samples/task-tests.md` so MiniPhi can validate benchmark coverage with deterministic unit tests.

Files:
- `benchmark-catalog.json`: normalized benchmark metadata (categories, names, summaries, links).
- `general-purpose-suite.json`: category-balanced task prompts used by CLI benchmark regression tests.
- `catalog-utils.js`: parser/builders used by tests and the sync script.

To regenerate the JSON artifacts after editing `dev_samples/task-tests.md`:

```bash
node scripts/sync-test-task-catalog.js
```
