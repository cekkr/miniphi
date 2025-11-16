---
source: src/shared/persistence/memory-store.js
language: javascript
generatedAt: 2025-11-16T05:16:39.580Z
sha256: 28ad805f082526df3eac27b05f96792e54cee82116ac60474ee7b8a86bf54d44
---

## Narrative
The pipeline needs a trustworthy but simple persistence layer. Rather than pulling in a database, this module keeps everything in memory yet behaves like a tiny repository with predictable IDs and timestamps. It supports three operations: create a record, update an existing one, and read the last snapshot.

## Create
Calling `create(entry)` increments a counter, builds an identifier such as `run-0001`, and stores timestamps plus any additional metadata provided in `entry`. The record is pushed into an array so chronological order is preserved. The method returns the stored object so the caller can capture the generated ID.

## Update
`update(id, patch)` searches the array for a matching record and merges the patch into it. If the ID is unknown, the function returns `null`, allowing callers to detect mismatched finalizations. Successful updates return the mutated record (useful when the pipeline wants to read metadata after writing summary stats).

## Introspection
`last()` returns the most recent record or `null` when none exist, while `all()` returns a shallow copy of the array for debugging. Because everything lives in process memory, recomposition must faithfully rebuild the counter, deterministic ID padding, and merging behavior to survive the benchmark comparison step.
