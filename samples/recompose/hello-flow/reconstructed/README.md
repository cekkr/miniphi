# Hello Flow Sample

This intentionally small project keeps the `recompose` benchmark deterministic while still exercising layered imports:
- `src/greeter.js` handles friendly greetings/farewells.
- `src/math.js` performs average/trend calculations.
- Telemetry is emitted at each step via structured objects.

## Architecture

The workspace centers on a modular flow architecture with layered imports:

1. **Core Modules**:
   - `greeter.js`: Provides greeting/farewell utilities.
   - `math.js`: Handles average calculations and trend descriptions.
   - Telemetry emission at each step (normalize/validate).

2. **Shared Utilities**:
   - `logger.js`: Centralized logging.
   - `memory-store.js`: In-memory persistence.

3. **Pipeline Orchestration**:
   - `pipeline.js`: Coordinates the flow of data through steps.

## Flow

The pipeline orchestrates these components:
- Data flows from normalization to validation, with telemetry emitted at each step.
- Shared utilities ensure consistency in logging and persistence.

## Signals

### Risk Notes
- No explicit error handling or validation logic visible in excerpts.
- Telemetry emission may lack centralized control or schema enforcement.

## Directories
- `code/`: Source files for the project.
- `descriptions/`: Documentation and metadata.
- `reconstructed/`: Output of automated runs.

## Running the Benchmark

To trigger automated runs without exposing raw code:

```bash
npm run benchmark
```

This will generate output in the `reconstructed/` directory.
