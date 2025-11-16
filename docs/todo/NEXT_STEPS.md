# Next Steps

- [x] Extend `samples/recompose/hello-flow` (or add a new sibling sample) with more files/layers to better stress-test markdown�+"code fidelity and expose throughput bottlenecks.
- [x] Allow `node src/index.js benchmark recompose` to accept JSON/YAML plans so each run can opt into custom clean modes, run labels, or direction-specific parameters without extra flags.
- [x] Teach `benchmark analyze` to emit Markdown/HTML rollups (in addition to SUMMARY.json) so reports can be embedded directly into docs or PRs.
- [x] While executing recompose runs (standalone or benchmark), log in a file apart all prompts to LMStudio APIs and their response (CLI writes `<report>.prompts.log`, benchmarks emit `RUN-###.prompts.log`)
- [ ] Expose a `benchmark plan scaffold --sample <dir>` helper that emits detected defaults plus comments, so teams can tweak fields without memorizing the schema.
- [ ] Let `benchmark analyze` compare two directories (baseline vs candidate) and highlight delta trends per phase/warning bucket to streamline regression reports.
- [ ] Add a markdown-to-code fallback/resend path whenever Phi-4 skips fenced output so runs like `clean-roundtrip` do not silently drop files such as `src/index.js`.
- [ ] Teach the recompose harness to auto-summarize/diff mismatched files (README, validate.js, greeter.js, math.js, logger.js, memory-store.js) and feed that context back into repair prompts instead of stopping at hash deltas.
- [ ] Profile and parallelize the code-to-markdown step (currently ~20 minutes for 9 files in hello-flow-plan) to keep roundtrip benchmarks under a 5-minute target.
- [ ] Harden the recompose prompt template/validators in `src/libs/recompose-tester.js` so responses preserve ES module syntax (`export` vs `module.exports`) and existing function names, re-prompting automatically when structure changes like the greeter/math regressions in `samples/recompose/hello-flow/reconstructed`.
- [ ] Add a `--resume-descriptions` / markdown-only mode inside `RecomposeBenchmarkRunner` so CLI repairs can skip the expensive code-to-markdown sweep when descriptions already exist (e.g., iterate only on markdown-to-code for hello-flow-plan).
- [ ] Pipe actual sample metadata (README snippet, plan name, file manifest) into the `workspaceContext` that Phi-4 sees during recompose runs; the current generic placeholder in `.miniphi/recompose/.../clean-roundtrip.json` caused the assistant to hallucinate narrative docs instead of mirroring the code.
