These repositories are for testing purposes:

# bash
Bash is a classic GNU/Linux shell, and its source code is not used for miniphi code, but for its testing:
the first hardcore test to do is to analyze the code with a maximum of depth of 1 subfolders and create per-run folders such as `samples/benchmark/bash/<dd-mm-yy_mm-hh>/` with EXPLAIN-x.md where x is the number of test that wrote this result.
The EXPLAIN code should be a detailed explaination of how works the code flow beginning from main and delving into function and their summarization.
The resulting markdown file should be very large: this is a perfect test about how divide in multiple pieces prompts and merging results, and take advantages of information saved in .miniphi directory through several test (and knowing when ignore/remove useless information).

# recompose/hello-flow
This miniature Node.js project powers the `recompose` benchmarking flow. The `code/` directory contains the canonical source, `descriptions/` stores generated markdown representations, and `recompose-report.json` captures the per-step timings/counts produced by `node src/index.js recompose --sample samples/recompose/hello-flow --direction roundtrip`. Extend this folder with bigger projects to stress-test the markdown↔code round-trip accuracy.

# get-started
This onboarding scenario lives under `samples/get-started`. The code/ folder hosts a simple Node.js project that discovers the host environment, generates README content, and exposes a tiny feature toggle plus smoke tests. The prompts/ folder contains five curated prompt suites (environment, README, targeted edit, feature addition, verification) so MiniPhi contributors can exercise project-centric workflows that operate directly on the current working directory. Use this sample when validating the `workspace` command, command-authorization policies, or any “edit the repo in place” improvements.
