# Hello Flow Sample

This intentionally small project keeps the `recompose` benchmark deterministic while still exercising layered imports:
- `src/greeter.js` handles friendly greetings/farewells.
- `src/math.js` performs average/trend calculations.
- Telemetry is emitted at each step (normalize, validate) via structured objects.
- Shared utilities (`logger.js`, `memory-store.js`) support persistence and logging.

## Directories

- **code/** - Contains the source files for the flow.
- **descriptions/** - Holds natural language descriptions of the code.
- **reconstructed/** - Outputs from automated runs.

## Automated Runs

To trigger an automated run without exposing raw code, use the following command:

```bash
node src/index.js
```

This will execute the pipeline and generate telemetry data.
