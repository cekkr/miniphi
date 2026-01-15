# Hello Flow Sample

This intentionally small project keeps the `recompose` benchmark deterministic while still exercising layered imports:

- `src/greeter.js` handles friendly greetings/farewells.
- `src/math.js` performs average/trend calculations.
- The pipeline (`src/flows/pipeline.js`) orchestrates normalization and validation steps with telemetry emission.

## Directories

- `code/` – Source files under test (e.g., `src/index.js`).
- `descriptions/` – Natural-language plans/narratives for recomposition.
- `reconstructed/` – Output of the recompose harness after processing.

## Benchmark Triggers

Run `node src/index.js` to execute the flow pipeline and validate:
1. Greeter utilities are imported correctly.
2. Math functions compute averages/trends accurately.
3. Telemetry is emitted at each step (normalize → validate).
4. No raw code is exposed in reconstructed outputs.
