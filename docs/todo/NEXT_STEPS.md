# Next Steps

- [x] Extend `samples/recompose/hello-flow` (or add a new sibling sample) with more files/layers to better stress-test markdown�+"code fidelity and expose throughput bottlenecks.
- [x] Allow `node src/index.js benchmark recompose` to accept JSON/YAML plans so each run can opt into custom clean modes, run labels, or direction-specific parameters without extra flags.
- [x] Teach `benchmark analyze` to emit Markdown/HTML rollups (in addition to SUMMARY.json) so reports can be embedded directly into docs or PRs.
- [ ] Expose a `benchmark plan scaffold --sample <dir>` helper that emits detected defaults plus comments, so teams can tweak fields without memorizing the schema.
- [ ] Let `benchmark analyze` compare two directories (baseline vs candidate) and highlight delta trends per phase/warning bucket to streamline regression reports.
- [ ] Add a markdown-to-code fallback/resend path whenever Phi-4 skips fenced output so runs like `clean-roundtrip` do not silently drop files such as `src/index.js`.
- [ ] Teach the recompose harness to auto-summarize/diff mismatched files (README, validate.js, greeter.js, math.js, logger.js, memory-store.js) and feed that context back into repair prompts instead of stopping at hash deltas.
- [ ] Profile and parallelize the code-to-markdown step (currently ~20 minutes for 9 files in hello-flow-plan) to keep roundtrip benchmarks under a 5-minute target.
