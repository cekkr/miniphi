---
source: src/shared/logger.js
language: javascript
generatedAt: 2025-11-16T05:16:39.580Z
sha256: abbc66716535b8070800ce65e0fa15cf5f2441640cde857a6c4b0a2b9c327c05
---

## Purpose
The story needs a memory of what happened inside each pipeline pass. Instead of using `console.log`, this module offers a scoped logger factory. Every logger keeps an in-memory array of structured entries and exposes `info`, `warn`, `error`, plus a `flush()` method that returns the accumulated history.

## Structure
Calling `createLogger("InsightPipeline")` returns an object with methods that all call a shared `write(level, message, metadata)` helper. Each entry captures the scope, log level, human-readable message, any metadata object, and a timestamp in ISO format. Because entries are stored in an array, flushing is deterministic and side-effect free: it simply clones the array so the pipeline can persist it alongside normalization stats.

## Reuse
The logger never touches disk and never inspects the data structure it receives. This makes it ideal for the benchmark’s security goals: recomposition must recreate the helper exactly to satisfy snapshot comparisons, yet the description hints at the behaviors (scoped levels, iso timestamps, buffered flush) without revealing exact syntax.
