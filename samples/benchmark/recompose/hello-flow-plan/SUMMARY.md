# Benchmark Summary

- Directory: C:\Sources\GitHub\miniphi\samples\benchmark\recompose\hello-flow-plan
- Analyzed At: 2025-11-16T13:28:41.276Z
- Total Runs: 4
- Sample Directories: samples/recompose/hello-flow

## unknown
Runs: 1, warnings 0 (0 runs), mismatches 0 (0 runs)

## roundtrip
Runs: 1, warnings 4 (1 runs), mismatches 9 (1 runs)

| Phase | Avg (ms) | Min (ms) | Max (ms) | Samples |
| --- | ---: | ---: | ---: | ---: |
| code-to-markdown | 1027956.00 | 1027956.00 | 1027956.00 | 1 |
| markdown-to-code | 3096608.00 | 3096608.00 | 3096608.00 | 1 |
| comparison | 6.00 | 6.00 | 6.00 | 1 |

## code-to-markdown
Runs: 2, warnings 0 (0 runs), mismatches 0 (0 runs)

| Phase | Avg (ms) | Min (ms) | Max (ms) | Samples |
| --- | ---: | ---: | ---: | ---: |
| code-to-markdown | 1183051.00 | 1014322.00 | 1351780.00 | 2 |

## Warning Runs
- C:\Sources\GitHub\miniphi\samples\benchmark\recompose\hello-flow-plan\clean-roundtrip.json (4 warnings) — sample: Phi-4 response did not include a code block.; Phi-4 response did not include a code block.; Phi-4 response did not include a code block.

## Mismatch Runs
- C:\Sources\GitHub\miniphi\samples\benchmark\recompose\hello-flow-plan\clean-roundtrip.json: mismatches 5, missing 4, extras 0
