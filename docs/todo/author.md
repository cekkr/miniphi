- (x) Make the miniphi to work as agent not only strictly in source code developing context (the main one), but also dynamically in base of working directory understanding the context and working in this way. For example, it should have the bases to handle a directory where there is a book written in different markdown files per chapter, and should be able to have a general view and ability to edit and improve existing part in base of prompt or also creating a new chapter.
- (x) Evaluate if practicable and implement a "best prompt performances" scoring system and database (through SQLite, in main miniphi folder indipendently by project). The point is evaluate when a prompt needs future multiple prompts to "make it work" and, comparing the type of prompts, finding on the time the best prompt composition (and the best series of prompts composition to obtain a certain objective) for various contexts, also dipendly by the current working project path (in this case, saves "best prompts score" as json to temporarly in-memory insert in sqlite database). Seen that composing a prompt is pretty "semantical" concept, you'll often need to take advantage of the LM model itself to evaluate the context (also for classification and enumaration in databse) and obtaining the best prompt for the current series of objectives. Log these "objectives" and "prompts" in console if executed with flag --debug-lm

# Benchmark recompose

Tests

/home/riccardo/.lmstudio/.internal/utils/node src/index.js benchmark recompose --directions roundtrip,code-to-markdown,markdown-to-code --run-prefix RUN --clean
/home/riccardo/.lmstudio/.internal/utils/node src/index.js benchmark analyze samples/benchmark/recompose/16-11-25_26-00
/home/riccardo/.lmstudio/.internal/utils/node src/index.js benchmark analyze samples/benchmark/recompose/16-11-25_21-00

Next actions
Use node src/index.js benchmark recompose ... for any future hello-flow sweeps; benchmark analyze <dir> keeps the SUMMARY.json fresh for that timestamp.
Tackle the remaining NEXT_STEPS items (larger recompose sample + plan-file support + Markdown analyzer output) once you’re ready to expand coverage.
Commit the regenerated description files and the timestamped benchmark folders alongside the new helper/analyzer so future prompts inherit the context automatically.

Execute NEXT_STEPS

## Update 1

Expanded the hello-flow benchmark so it now exercises a real mini data pipeline: src/index.js wires the new InsightPipeline into the summarizer, flows/pipeline.js orchestrates validation + normalization, and supporting pieces live under flows/steps and shared (samples/recompose/hello-flow/code/src/index.js:1, samples/recompose/hello-flow/code/src/flows/pipeline.js:1, samples/recompose/hello-flow/code/src/shared/logger.js:1). The sample README and generated fixtures were refreshed to match the richer layout, so the markdown + reconstructed trees carry the new files as well (samples/recompose/hello-flow/code/README.md:3, samples/recompose/hello-flow/descriptions/src/flows/pipeline.js.md:1, samples/recompose/hello-flow/reconstructed/src/flows/pipeline.js:1).
benchmark recompose now understands JSON/YAML plans: the CLI loads and validates plan files (src/index.js:605, src/index.js:717), the runner normalizes per-run descriptors/labels/clean flags (src/libs/recompose-benchmark-runner.js:33, src/libs/recompose-benchmark-runner.js:136), and the new yaml dependency plus a checked-in benchmark-plan.yaml make it easy to share canned sweeps (package.json:40, samples/recompose/hello-flow/benchmark-plan.yaml:1).
benchmark analyze produces SUMMARY.{json,md,html} so reports drop straight into docs/PRs, and the docs explain the new behavior and plan-driven workflow (src/libs/benchmark-analyzer.js:124, README.md:24, samples/recompose/README.md:24). The helper renders per-direction tables, warning/mismatch lists, and logs the extra artifact locations.
Documentation/state-of-the-world files call out the finished work and tee up the follow-ons: AI_REFERENCE now records the layered sample + plan/rollup capabilities, and NEXT_STEPS tracks the next automation ideas (AI_REFERENCE.md:18, docs/todo/NEXT_STEPS.md:3).
Tests

node --check src/index.js
node src/index.js recompose --sample samples/recompose/hello-flow --direction code-to-markdown --clean
node src/index.js benchmark recompose --plan samples/recompose/hello-flow/benchmark-plan.yaml
node src/index.js benchmark analyze samples/benchmark/recompose/hello-flow-plan
Natural next step: tackle the new TODOs (plan scaffolder + analyze diffs) when you’re ready; the groundwork is now in place.