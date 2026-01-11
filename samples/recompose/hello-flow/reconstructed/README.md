# Hello Flow Sample

This intentionally small project keeps the `recompose` benchmark deterministic while still exercising layered imports:

- `src/greeter.js` handles friendly greetings/farewells.
- `src/math.js` performs average/trend calculations.
- `src/flows/pipeline.js` orchestrates data flow through normalization and validation steps.
- Shared utilities include a structured logger and in-memory persistence.

## Architecture

The workspace centers on a modular flow architecture with layered imports:

1. **Core Modules**:
   - `greeter.js`: Provides greeting/farewell messages.
   - `math.js`: Handles average calculations and trend descriptions.
   - `pipeline.js`: Orchestrates the data flow, importing logger, memory store, normalize, and validate steps.

2. **Shared Utilities**:
   - Structured logger for consistent logging.
   - In-memory persistence for temporary storage.

## Flow

Data flows through normalization and validation steps:

1. **Normalization** (`src/flows/steps/normalize.js`): Ensures data consistency.
2. **Validation** (`src/flows/steps/validate.js`): Verifies data integrity.
3. **Pipeline Orchestration** (`src/flows/pipeline.js`): Coordinates the entire process.

## Risk Notes

- Missing detailed telemetry schema in `pipeline.js`.
- Potential uncertainty around error handling in flows (e.g., validation failures).
