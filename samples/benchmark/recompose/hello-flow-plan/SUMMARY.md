# Benchmark Summary

- Directory: C:\Sources\GitHub\miniphi\samples\benchmark\recompose\hello-flow-plan
- Analyzed At: 2025-11-16T09:23:30.178Z
- Total Runs: 3
- Sample Directories: samples/recompose/hello-flow

## roundtrip
Runs: 1, warnings 3 (1 runs), mismatches 9 (1 runs)

| Phase | Avg (ms) | Min (ms) | Max (ms) | Samples |
| --- | ---: | ---: | ---: | ---: |
| code-to-markdown | 842081.00 | 842081.00 | 842081.00 | 1 |
| markdown-to-code | 2794827.00 | 2794827.00 | 2794827.00 | 1 |
| comparison | 6.00 | 6.00 | 6.00 | 1 |

## code-to-markdown
Runs: 2, warnings 0 (0 runs), mismatches 0 (0 runs)

| Phase | Avg (ms) | Min (ms) | Max (ms) | Samples |
| --- | ---: | ---: | ---: | ---: |
| code-to-markdown | 1296880.00 | 1201745.00 | 1392015.00 | 2 |

## Warning Runs
- C:\Sources\GitHub\miniphi\samples\benchmark\recompose\hello-flow-plan\clean-roundtrip.json (3 warnings) — sample: Phi-4 response did not include a code block.; Phi-4 response did not include a code block.; Phi-4 response did not include a code block.

## Mismatch Runs
- C:\Sources\GitHub\miniphi\samples\benchmark\recompose\hello-flow-plan\clean-roundtrip.json: mismatches 6, missing 3, extras 0
