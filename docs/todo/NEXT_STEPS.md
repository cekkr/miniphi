# Next Steps

- [x] Extend `samples/recompose/hello-flow` (or add a new sibling sample) with more files/layers to better stress-test markdown�+"code fidelity and expose throughput bottlenecks.
- [x] Allow `node src/index.js benchmark recompose` to accept JSON/YAML plans so each run can opt into custom clean modes, run labels, or direction-specific parameters without extra flags.
- [x] Teach `benchmark analyze` to emit Markdown/HTML rollups (in addition to SUMMARY.json) so reports can be embedded directly into docs or PRs.
- [ ] Expose a `benchmark plan scaffold --sample <dir>` helper that emits detected defaults plus comments, so teams can tweak fields without memorizing the schema.
- [ ] Let `benchmark analyze` compare two directories (baseline vs candidate) and highlight delta trends per phase/warning bucket to streamline regression reports.
