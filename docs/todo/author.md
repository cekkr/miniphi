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