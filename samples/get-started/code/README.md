# samples/get-started/code

This mini project powers the “get-started” onboarding prompts. Everything is vanilla Node.js so it runs on any platform MiniPhi supports.

## Scripts

- `node src/index.js --info` – Print the detected operating system, Node.js version, and available tools.
- `node src/index.js --readme --output ./GENERATED_README.md` – Produce a README draft that mixes environment info with TODO sections that MiniPhi can later refine.
- `node src/index.js --feature --flag interactive` – Exercise the sample feature (see `src/features/sample-feature.js`).
- `node src/index.js --smoke` – Execute every step: environment discovery, README generation, and feature verification. Equivalent to `npm test`.
- `npm test` – Alias for `node src/tests/smoke.js`.

## Files of interest

- `src/system-info.js` – Detects host OS information and probes for required CLI tools (git, npm, node, python).
- `src/project-readme.js` – Generates README content with templated sections plus context about the detected environment.
- `src/features/sample-feature.js` – Contains a small feature toggle implementation. Prompts will ask MiniPhi to adjust the behavior (e.g., tweak the formatter, add metrics).
- `src/index.js` – CLI entrypoint that wires the helpers together and exposes the verification flags.
- `src/tests/smoke.js` – Asserts the helpers produce deterministic outputs so new prompts have regression coverage.

The code intentionally contains TODO comments where MiniPhi is expected to edit behaviors. Keep these hints up to date whenever the prompt suite evolves so contributors know which parts of the sample are “in play”.
