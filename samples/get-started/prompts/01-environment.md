# 01 – Environment discovery

**Objective:** Teach MiniPhi to inspect the host OS, determine which essential tools are available, and summarize the findings as structured JSON.

## Prompt structure

- **Essential prompt:** Explain that MiniPhi is running inside `samples/get-started/code` and that `@"code/src/system-info.js"` already collects OS metadata. Instruct the model to execute `node src/index.js --info` (after asking for authorization if required) and capture both stdout and parsed JSON.
- **General prompt:** Ask for a concise explanation of how the helper works, highlighting `buildEnvironmentReport`, `discoverTools`, and any missing utilities.
- **Specific prompt:** Request a JSON response that matches the schema below so downstream prompts can re-use the detection output.

```json
{
  "schema": "environment-report@v1",
  "fields": {
    "platform": "string // e.g., linux, darwin, win32",
    "release": "string // OS release or version",
    "arch": "string // cpu architecture (x64, arm64, ...)",
    "node_version": "string // semver from process.version",
    "tools": [
      {
        "name": "string // tool name requested in the prompt (node|npm|git|python3)",
        "status": "enum // available|missing",
        "version": "string|null // version string when available"
      }
    ],
    "notes": [
      "string // optional commentary (missing dependencies, follow-ups)"
    ]
  }
}
```

Document every field in the prompt block so Phi-4 knows which values are required and which are optional (`notes` can be empty). When the CLI lists missing tools, include concrete remediation steps (install command or file path) in `notes`.
