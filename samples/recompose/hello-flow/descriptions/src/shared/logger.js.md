---
source: src/shared/logger.js
language: javascript
generatedAt: 2025-12-21T15:29:57.614Z
sha256: abbc66716535b8070800ce65e0fa15cf5f2441640cde857a6c4b0a2b9c327c05
---

## Purpose

The file src/shared/logger.js operates as a javascript module with roughly 23 lines.

Exposes 1 exported symbol (createLogger).

## Key Elements

- Dependencies: internal-only helpers.

- Public interface: createLogger

- Classes: none, relies on functions.

## Flow & Edge Cases

Execution revolves around sanitizing input, coordinating helper utilities, and emitting structured results/logs. Edge cases are handled defensively (nullish names, insufficient samples, or missing state) prior to returning values.
