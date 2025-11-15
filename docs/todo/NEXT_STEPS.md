# Next Steps

- [ ] Add a `miniphi benchmark recompose` helper (or CLI flag) that automatically stamps `samples/benchmark/recompose/<dd-mm-yy_mm-hh>/RUN-###.{json,log}` so manual timestamping isn’t required for each roundtrip.
- [ ] Build a small analyzer that scans the timestamped JSON reports and surfaces trends (avg duration, mismatches, warning spikes) between successive runs.
- [ ] Extend `samples/recompose/hello-flow` (or add a new sibling sample) with more files/layers to better stress-test markdown↔code fidelity and expose throughput bottlenecks.
