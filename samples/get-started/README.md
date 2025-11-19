# Get-Started Sample

This sample exercises the “teach MiniPhi how to work inside the current project” workflow. It mirrors the structure of `samples/recompose/hello-flow`, but the focus is onboarding a fresh workspace by prompting MiniPhi to:

1. Discover the host OS and the availability of essential tools (Node.js, npm, git, etc.).
2. Draft or refine a project-level `README.md` that describes the detected environment plus current capabilities.
3. Edit an existing function to tweak a behavior without breaking the provided smoke tests.
4. Add a new feature, expose it through the sample CLI, and prove it works by running the verification script.

## Folder layout

- `code/` – Small Node.js project that contains the runnable sample plus smoke tests.
- `prompts/` – Curated Phi-4 prompt starters. Each file documents the JSON schema MiniPhi should request/produce during the corresponding step so contributors can test deterministic prompting.
- `runs/` – Empty holder for saved prompt transcripts or summaries generated while exploring this sample.

## Running the sample

```bash
cd samples/get-started/code
npm install     # installs nothing, but ensures node_modules exists for editors
npm test        # runs src/tests/smoke.js
node src/index.js --info --readme --feature --output ./out/README.md
```

The CLI supports `--smoke` to execute every check in one go. `npm test` runs the same assertions so MiniPhi can validate that new behaviors still pass after edits.

## Prompt workflow

The files under `prompts/` describe a suggested order (“01-environment”, “02-readme”, “03-edit-function”, “04-feature”, “05-verify”). Each prompt lists:

- Essential, general, and specific instructions that should be fed into MiniPhi.
- The JSON response schema (with commented fields and enumerator values) required for that step.
- Hints about direct file references (e.g., `@"code/src/system-info.js"`) that keep the LM grounded in the sample code.

Use `node ../../src/index.js workspace --task "Plan README refresh for samples/get-started"` (or simply `miniphi Plan README refresh`) to generate a recursive plan rooted in this sample before dispatching edits. Persist the prompt transcripts under `runs/` whenever the flow changes so future contributors can replay the onboarding scenario.
