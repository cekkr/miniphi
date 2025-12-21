# Hello Flow Sample

This intentionally small project keeps the `recompose` benchmark deterministic while still exercising layered imports:
- `src/greeter.js` handles friendly greetings/farewells.
- `src/math.js` performs average/trend calculations.
- `src/shared/logger.js` emits telemetry at each step.
- `src/shared/persistence/memory-store.js` stores state in memory.

The pipeline (`src/flows/pipeline.js`) orchestrates normalization and validation via the logger and store, demonstrating a minimal but complete observability loop.
