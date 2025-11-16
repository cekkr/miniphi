---
source: src/flows/steps/validate.js
language: javascript
generatedAt: 2025-11-16T05:16:39.580Z
sha256: 018f307febc7b54587f7056a123c3d6b943a2364eff909dd1f704551487e1de5
---

## Gatekeeping Role
Before any number is normalized, this step interrogates the batch to make sure it is a proper set of samples. The validator expects at least three numeric entries so trend calculations and averages are meaningful. Anything less is considered risky and therefore rejected with a polite explanation.

## Checks Performed
1. Ensure the incoming value is an array. Non-arrays produce the first rejection reason.
2. Walk through each entry, attempt to coerce it to a number, and collect indices that failed. Failed entries generate messages such as “value at index 2 is not numeric.”
3. Enforce the minimum sample count (`MIN_SAMPLES = 3`), adding a reason if the threshold isn’t met.
4. Sort surviving numbers to check if the smallest equals the largest; when every value is identical the function notes that “all samples share the same value,” because that leaves the pipeline with no meaningful spread.

## Logging And Output
If any reasons accumulated, the helper logs a warning with the full list and returns `{ ok: false, values: [], reasons }`. Otherwise it emits `{ ok: true, values, reasons: [] }`, where `values` is the array of parsed numbers ready for normalization. Successes are logged with min/max counts so later sessions can retell the validation story without referencing raw code.
