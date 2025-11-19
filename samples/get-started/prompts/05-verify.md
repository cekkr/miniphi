# 05 – Verification + regression log

**Objective:** After edits, run the smoke suite (`npm test`), capture CLI output, and summarize whether the new behavior matches expectations.

## Prompt structure

- **Essential prompt:** Reference `@"code/src/tests/smoke.js"` and `@"code/src/index.js"`. Instruct MiniPhi to execute `npm test` (or `node src/tests/smoke.js`) and `node src/index.js --smoke`, collecting stdout/stderr for later comparison.
- **General prompt:** Ask for a verification report: what commands ran, how long they took, and whether the observed output matches the planned changes from steps 03–04.
- **Specific prompt:** Enforce a JSON schema that records command status plus a Markdown human summary.

```json
{
  "schema": "verification-report@v1",
  "fields": {
    "commands": [
      {
        "command": "string // executed command",
        "status": "enum // success|failure|skipped",
        "duration_ms": "number // elapsed time in milliseconds",
        "danger": "enum // low|mid|high",
        "notes": "string|null // why the command mattered or why it failed"
      }
    ],
    "summary": "string // Markdown summary (<= 200 words) describing verification results",
    "follow_ups": [
      "string // next steps if something failed"
    ]
  }
}
```

Stress that the schema must be followed exactly and that the CLI will compare `danger` to the operator’s command-authorization policy before executing future commands automatically.
