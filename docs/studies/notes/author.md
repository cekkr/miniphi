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

Start LM Studio with mistralai/devstral-small-2-2512 (or swap in ibm/granite-4-h-tiny or microsoft/phi-4-reasoning-plus if you need different defaults), then run node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --clean to produce new .miniphi/recompose/... sessions and confirm the prompt chain.
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
- Miniphi currently not enough "current project-centric". It should be evident to work with current working directory as base project where to work, and it has to support the basic command "miniphy Make this prompt without argument name in CWD --optional-args". Miniphi was created to create from scratch but also edit big projects, and not only "convert to markdown and back to code" as done in benchmarks.
- Add "command authorization before execution". User's can always allow them, ask for permission for every session etc. Then, take advantages of "APIs generated commands" to add to JSON response structure also the predicted dangerousness (low|mid|high), so user can be asked for permission only for sensible commands. Check the correct implementation of JSON structures definition and prompting: is important to comment fields to explain correctly what they should contains, and in case of enumerators the list of available options.
- Check the ability of APIs model to change by himself the JSON structure of commands and response. Anyway this requires its ability to implement their input and output adapters.
- Add support to direct file reference: with @"file/path.cpp" (quotes optional), the prompts analyze and takes as fixed reference the given files.
- I forgot it. 

## Prompt analysis
It should be improved the recursive approach. For example, given a prompt, are needed API's prompts... to analyze prompt. These series of prompts (what are the objectives? make a list ...) are aiming to obtain the checklist of what to do, and divided every point in sub-prompts (and recursively sub-sub-prompts etc when needed) to analyze and editing everything coherently staying in the current maximum context window (default: 4096).
A class that uses nvidia/amdgpu tools to obtain in real time VRAM usage may help to expand/shrink dynamically context window in base of current resource(?)

## Additional
- Create a general .miniphi folder in user's home path to save every general information useful to any project (learned prompts, OS current configuration, best performances etc.) to avoid to add them in miniphi source code.

# Benchmarking and step by step improvements

Tests

node src/index.js recompose --sample samples/recompose/hello-flow --direction code-to-markdown --prompt-journal recompose-hello --prompt-journal-status active --verbose (runs offline by default and completes in milliseconds).
npm run benchmark (both samples-bash-explain and samples-bash-recursive-prompts now pass; the second test exercises the offline deterministic path unless MINIPHI_BENCHMARK_MODE=live is set).
Next Steps

When you need full Phi coverage, re-run recompose with --recompose-mode live and export MINIPHI_BENCHMARK_MODE=live before npm run benchmark.
Populate .miniphi/recompose-cache with a known-good live run so future offline passes can reuse richer narratives.
Consider extending the offline summaries (both recompose + benchmark) with quick hashes so you can detect drift between offline heuristics and live expectations.

## Part 2

Changes

src/libs/lmstudio-api.js (lines 160-181) now treats cached models as compatible when the existing context window is already larger than the request, so the scoring Phi instance no longer ejects the main handle by asking for a smaller context.
src/libs/lms-phi4.js (lines 100-214) reworks chatStream into a two-attempt loop that retries once after “model not loaded / unloaded / instance reference” errors, reuses the request metadata, and attaches explicit error listeners to both the LM Studio iterator and the parser stream so “Model unloaded” events are caught instead of crashing the process. The method now reports a final failure only after the retry budget is exhausted and records schema failures exactly once.
src/index.js (lines 1887-1904) raises the live recompose prompt timeout to at least five minutes so Phi-4 can finish the long “file-plan” prompts without being forcibly aborted at the global 2‑minute setting.
Benchmark Runs

npm run sample:besh-journal now completes the LM Studio load sequence only once. The run still fails because Phi-4 refuses to emit JSON (see current-benchmarks/20251120T095105Z/npm-sample-besh-journal/output.log (lines 1-20)), but the previous “Cannot find model of instance reference” crash is gone, confirming the lifecycle fix.
node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --recompose-mode live --prompt-journal adhoc-roundtrip … now reaches Phi-4 and records a successful workspace-overview prompt (samples/recompose/hello-flow/recompose-report.prompts.log (lines 1-25)). The subsequent “file-plan” prompts still stall—first because they hit the old 2‑minute cutoff (lines 26‑34) and then because Phi responds with the generic “Hi there…” text instead of the requested plan (.miniphi/recompose/2025-11-20T08-34-50-220Z-recompose/prompts.log (lines 1-15)). Because those prompts never return structured plans, the reconstructed sources remain offline stubs.
RECOMPOSE_MODE=live ./run-log-benchmarks.sh (full directions) produced current-benchmarks/20251120T085026Z. That run captured a failing sample:besh-journal (same schema issue) and a successful recompose-code-to-markdown, but it timed out during recompose-markdown-to-code so no npm benchmark phase ran (current-benchmarks/20251120T085026Z/run.log (lines 1-24)).
RECOMPOSE_MODE=live RECOMPOSE_DIRECTIONS=roundtrip ./run-log-benchmarks.sh generated current-benchmarks/20251120T095105Z before the process was killed while recompose-roundtrip waited on Phi (run log lines 1-16). In both benchmark attempts the Phi prompts remained the limiting factor; resource monitor still reports ~99% RAM usage and the schema validator rejects multiple responses.
Next Steps

Patch the Phi prompt templates (main analyzer + recompose prompts) so they include an explicit “JSON only” reminder and fall back to deterministic summaries before hitting the time limit; otherwise every run will continue to die on schema errors or 5‑minute hangs.
Consider disabling prompt scoring (or hardening its schema) when LM Studio is already overloaded—the scoring Phi is currently spamming warnings for $.series_strategy and contributes nothing to the failing workflows.
Once Phi responds deterministically again, rerun RECOMPOSE_MODE=live ./run-log-benchmarks.sh so current-benchmarks includes one clean, end-to-end artifact set.
Commands executed (all in repo root):

npm run sample:besh-journal → exits 1 with schema validation error.
node src/index.js recompose … --direction roundtrip → exits 0 but produces offline stubs because downstream prompts still fail.
RECOMPOSE_MODE=live ./run-log-benchmarks.sh and RECOMPOSE_MODE=live RECOMPOSE_DIRECTIONS=roundtrip ./run-log-benchmarks.sh → both terminated after ~1 hr because Phi-4 stalled mid-recompose; partial logs saved under current-benchmarks/20251120T085026Z and 20251120T095105Z.

## So ...
So for preparing benchamrks: npm run sample:besh-journal --verbose --stream-output

Human test execution: npm run sample:besh-journal --no-stream

Run:
npm test
npm run sample:besh-journal -- --prompt-journal-status active --verbose

Update LM Studio/SDK to matching versions to clear the “channelSend for unknown channel” warning; if it persists, force REST via MINIPHI_FORCE_REST=1 while testing.

## High priority benchmark Codex prompt

Execute the benchmark step-by-step to improve initial prompt templates, testing and improve "prompts learning" (and best structure learning) by the model itself and their saving and scoring for future sessions/projects, testing the use of the APIs model to improve tasks execution performances through terminal commands and ad hoc script generated by APIs model itself, and again they're saving for future re-usage in similare contexts but also in different projects, when enough generic. This makes evident how "basic prompts and structures" templates are essential for an "exponential" auto-learning by miniphi itself to complete complex task through chirurgic commands and series of prompts within context-length limits.

Run the test commands BY YOURSELF, to evaluate and implement edits in real time and more over because were mostly created for AI test use. Read the run outputs in real time to avoid infinity-loops or lack-of-exit issue.

Make tests about "context length overflow" splitting: given the max tokens in context allowed by LM Studio API, learn how to split the current task in sub task, taking advantage of model itself to learn how to split the task in two or multiple tasks and re-merging the result in the most efficient way.

# Next test:
Next steps (optional, to exercise the new recompose JSON chain end‑to‑end):

node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip --recompose-mode live --verbose
benchmark-plan.yaml --clean --verbose
