# Next Steps

- [ ] Extend `samples/recompose/hello-flow` (or add a new sibling sample) with more files/layers to better stress-test markdown↔code fidelity and expose throughput bottlenecks.
- [ ] Allow `node src/index.js benchmark recompose` to accept JSON/YAML plans so each run can opt into custom clean modes, run labels, or direction-specific parameters without extra flags.
- [ ] Teach `benchmark analyze` to emit Markdown/HTML rollups (in addition to SUMMARY.json) so reports can be embedded directly into docs or PRs.
