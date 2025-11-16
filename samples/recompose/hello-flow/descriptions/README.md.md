---
source: README.md
language: markdown
generatedAt: 2025-11-16T04:45:19.623Z
sha256: f26dda128f1dc783f9f56e325f1d40188b5555ef766d2ae8e5884b30994b2c6d
---

# File: README.md

```markdown
# Hello Flow Sample

This intentionally small project keeps the `recompose` benchmark deterministic while still exercising layered imports:

- `src/greeter.js` handles friendly greetings/farewells.
- `src/math.js` performs average/trend calculations.
- `src/flows/pipeline.js` orchestrates validation + normalization steps, persisting telemetry to `shared/persistence/memory-store.js`.
- `src/flows/steps/validate.js` and `src/flows/steps/normalize.js` demonstrate nested workflow layers.
- `src/shared/logger.js` captures structured logs for every pipeline pass.
- `src/index.js` ties the helpers together, runs two sample pipelines, and prints CLI summaries.

Use `node src/index.js recompose --sample samples/recompose/hello-flow` to convert these files into markdown and back.

```
