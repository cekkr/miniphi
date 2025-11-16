---
source: src/math.js
language: javascript
generatedAt: 2025-11-16T05:16:39.580Z
sha256: f8bb2afdb1eea366696cb7d83e7b23f7f3a6f493af51cbbfe3cc4c36e25149ab
---

## Mission
The analytics narrative needs two dependable storytellers for numbers: one that can summarize a list of samples with a polite average, and another that can glance at the first and last entry to describe momentum. This module keeps those responsibilities isolated so the orchestrator can focus on wording rather than arithmetic.

## Averaging Ritual
The averaging helper accepts any iterable of values, quietly casts each entry to a number (defaulting to zero when coercion fails), and returns the mean rounded to two decimal places. Empty input yields `0`, which keeps downstream string templates from producing “NaN” or “undefined.” The rounding step ensures summaries remain short enough for conversational output while still hinting at precision.

## Trend Decoder
The second helper inspects how the final sample compares to the first. If there are fewer than two numeric points, it answers with “insufficient-data.” Identical start and end values produce “flat,” anything higher becomes “upward,” and everything else is labeled “downward.” These exact tokens are later embedded into closing sentences so operators instantly understand whether their metrics improved, declined, or never moved.
