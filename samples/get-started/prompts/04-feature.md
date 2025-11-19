# 04 – Add a feature and expose it

**Objective:** Extend `runFeature` + CLI wiring in `@"code/src/index.js"` so the sample can toggle a new behavior (for instance, emit telemetry summaries, write to a log file, or print contextual TODOs).

## Prompt structure

- **Essential prompt:** Describe the desired feature (e.g., “Add a `--metrics` flag that prints the number of available vs missing tools”). Mention every file that needs to change and pin them with direct references.
- **General prompt:** Ask Phi-4 to break the work into sub-prompts: update the feature module, patch the CLI parser, and expand smoke tests. Highlight the dependency order.
- **Specific prompt:** Require JSON for the action plan plus an inline Markdown changelog.

```json
{
  "schema": "feature-extension@v1",
  "fields": {
    "plan": [
      {
        "id": "string // e.g., 1, 2, 2.1",
        "title": "string",
        "requires_subprompt": "boolean",
        "files": ["string"],
        "commands": ["string // npm test, node src/index.js --smoke"],
        "danger": "enum // low|mid|high",
        "notes": "string|null"
      }
    ],
    "changelog": "string // <=150 words summarizing the edits + verification"
  }
}
```

Include comments alongside each schema field when embedding it in the Phi prompt so it is clear what values are expected and which enums are valid.
