# 03 – Targeted function edit

**Objective:** Modify `renderFeatureMessage` inside `@"code/src/features/sample-feature.js"` to adjust how feature telemetry is formatted (e.g., add emoji, reorder fields, or normalize tool output) while keeping `npm test` green.

## Prompt structure

- **Essential prompt:** Point Phi-4 at the exact function body and describe the expected change (for example, "prepend a ✅ when all tracked tools are available" or "ensure missing tools are listed first"). Remind it that smoke tests in `@"code/src/tests/smoke.js"` must continue to pass.
- **General prompt:** Ask for a mini plan: what needs to change, which files are involved, which verifications to run (`node src/index.js --feature --flag interactive`, `npm test`).
- **Specific prompt:** Demand JSON with the following schema so we can archive the edit plan as part of `.miniphi/prompt-exchanges`.

```json
{
  "schema": "feature-edit-plan@v1",
  "fields": {
    "objective": "string // short description of the edit",
    "risk": "enum // low|medium|high",
    "steps": [
      {
        "description": "string // actionable change",
        "files": ["string // files to edit"],
        "commands": ["string // verification commands (npm test, node src/index.js --feature)"]
      }
    ],
    "success_checks": [
      "string // bullet list of expected outputs or assertions"
    ]
  }
}
```

Emphasize that any generated commands must be authorized before execution. Include predicted dangerousness values (low|mid|high) next to each command suggestion so the CLI can decide whether to prompt the operator (ties into the authorization workstream).
