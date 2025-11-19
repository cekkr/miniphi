# 02 – README scaffolding

**Objective:** Use the environment report to draft a repository README and note which sections still need human editing.

## Prompt structure

- **Essential prompt:** Reference `@"code/src/project-readme.js"` to explain how `generateReadmeContent` works. Mention the environment JSON produced in step 01 and instruct the model to treat it as authoritative.
- **General prompt:** Ask MiniPhi to plan the README updates for the current project root (default: current working directory). The plan should highlight the sections that need real content (workflow, secrets, TODOs).
- **Specific prompt:** Require the following JSON structure so README drafts and TODOs can be persisted without ambiguity.

```json
{
  "schema": "readme-plan@v1",
  "fields": {
    "project_name": "string // detected from package.json or README title",
    "summary": "string // <= 2 sentences describing the repo",
    "sections": [
      {
        "title": "string // README section name",
        "status": "enum // ready|needs_input|blocked",
        "content_hint": "string // placeholder text or instructions"
      }
    ],
    "actions": [
      {
        "type": "enum // analyze|edit|command",
        "description": "string // what to do next",
        "files": ["string // paths to touch, e.g., README.md"],
        "ready": "boolean // true when MiniPhi can proceed without human input"
      }
    ]
  }
}
```

Ask Phi-4 to emit both the JSON payload and a short Markdown snippet (≤ 200 words) describing how to run the README generator (`node src/index.js --readme --output ...`). Store the snippet under `.miniphi/prompt-exchanges/` for future reuse.
