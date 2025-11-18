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

 not run (Phi-4/LM Studio needs to be running locally to exercise the new flow).

Next steps:

Start LM Studio with microsoft/phi-4-reasoning-plus, then run node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean to produce new .miniphi/recompose/... sessions and confirm the prompt chain.
Inspect .miniphi/prompt-exchanges/ and .miniphi/recompose/<timestamp>/ output from a live run to ensure the workspace overview, per-file plans, and generated code land as expected.

# Next steps 1
- (x) Evaluate the main miniphi user's prompt to LM Studio APIs to obtain a summarization of sub-prompts and sub-actions to divide its execution, process that could be needed recursively for complex prompt in complex projects (`PromptDecomposer` now issues a REST preflight plan and saves it under `.miniphi/prompt-exchanges/decompositions/`)
- (x) Add the support to "file connection" search, useful to know in a source code if a file is imported by another files or what files it's importing and analyzing them. Seen different language to handle, could be used LM Studio model itself to elaborate a fast script to its result (`FileConnectionAnalyzer` reports top importers/dependents and is threaded into every workspace summary)
- Take advantages of elaborating of available program/library on terminal (and the possibility to install them in real time, especially in python venv) to elaborate throgh LM Studio prompt an ad hoc script to obtain a certain result, like finding fast some reference in a project with many files or exact references in a big .log file. This is one of the case where "prompt best composition caching" is also useful, but in case of automatization tools
- Remember the essential importance to use JSON structured prompts pre-declaring response JSON response, to handle with chirurgic precision requests and responses patching
- In many contexts of API prompting, it's important to say what kind of operation are available on OS/Library/Scripts. Seen that they're too many to write all of them in one context, is needed the right series of prompts with rewriting only essential chat history to understand the best tools to use (or create)
- Add the support to real time stdout analyzing while still running long execution time process, needed for tools and testing, and support parallel executions for case where is needed (like testing a program that need a server running in the meanwhile), closing them when no more needed (or to recompile/re-run)
- Improve SQLite DB prompts/json structure/script tools storing and best performances statistical evaluation (also in case of context, like the project, directory, file, or current prompt and sub-prompt). Using API's prompt to check the validity of the chosen tools in this context. (This requires also a verbal description of internal commands in case of prompting needed)
- Try to generate at the end of a miniphi prompt execution, if tools are available, the commands for validating code quality/syntax error (if not know, ask to APIs)

### To prompt:
As described in [AI_REFERENCE.md](AI_REFERENCE.md) , implement next steps about: json schema enforcement, recusive prompt decomposition, file connection graphic, capability inventories, prompt telemetry richness [X]

- Add in parallel to npm libraries for code parsing, the ability to learn directly from API model how to navigate correctly the current project/path/file type, also through real time generated nodejs/python helpers scripts
- Check the ability of miniphi to... edit himself. He should have already all the fundamental implementation to do it. The ability of improve/implements next steps using itself and the API's model, is a sign of great maturity by the tool. Write your conclusion in AI_REFERENCE's next steps and implement right now what is possible/essential. LM Studio APIs are available for realtime testings right now.

# Next steps 2
- It's needed in samples a "get-started" project with a series of prompts that brings miniphi to discover the current OS the available essential tools with essential, general and specific prompts: create general README.md of the project, edit a specific function to change a little behaviour, add a specific features and implement its usage in sample project. Sample should be runnable with node to test both compilation and results respect than the excepted ones.
- Miniphi currently not enough "current project-centric". It should be evident to work with current working directory as base project where to work, and it has to support the basic command "miniphy Make this prompt without argument name in CWD --optional-args"
- Add "command authorization before execution". User's can always allow them, ask for permission for every session etc. Then, take advantages of "APIs generated commands" to add to JSON response structure also the predicted dangerousness (low|mid|high), so user can be asked for permission only for sensible commands.
- Check the ability of APIs model to change by himself the JSON structure of commands and response. Anyway this requires its ability to implement their input and output adapters.
- I forgot it. 