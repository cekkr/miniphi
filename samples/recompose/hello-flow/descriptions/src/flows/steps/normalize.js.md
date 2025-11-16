---
source: src/flows/steps/normalize.js
language: javascript
generatedAt: 2025-11-16T05:16:39.580Z
sha256: 039facadc7564b1e91aaca20bfed8547d573b996e99c56ed75e8e3ec3c6ccafd
---

## Narrative
This step assumes the validator already stripped out non-numeric samples. Its mission is to translate a list of numbers into normalized values between 0 and 1 while keeping enough statistics for later storytelling. An empty list short-circuits into zeros for everything so the pipeline never divides by zero or logs misleading information.

## Process
1. Determine the minimum and maximum values across the array.
2. Compute the spread; if all values are identical, force the spread to `1` so downstream math avoids division errors.
3. Map each value to `(value - min) / spread`, rounded to four decimal places to mirror deterministic output between runs.
4. Calculate the average of the normalized list, again rounded to four decimals, and package `min`, `max`, `spread`, and `center` into a stats object.

## Logging
Once the stats are ready, the helper writes a single `info` log entry noting that normalization is complete and storing the statistics. The calling pipeline later persists those logs alongside normalized values so reconstructing the algorithm is possible only by reasoning through this prose rather than copying source.
