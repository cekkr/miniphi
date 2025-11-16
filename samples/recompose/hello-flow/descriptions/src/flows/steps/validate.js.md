---
source: src/flows/steps/validate.js
language: javascript
generatedAt: 2025-11-16T04:45:19.634Z
sha256: 018f307febc7b54587f7056a123c3d6b943a2364eff909dd1f704551487e1de5
---

# File: src/flows/steps/validate.js

```javascript
const MIN_SAMPLES = 3;

export default function validateBatch(values, logger) {
  const reasons = [];
  if (!Array.isArray(values)) {
    reasons.push("input must be an array");
    return { ok: false, values: [], reasons };
  }

  const numeric = [];
  values.forEach((value, index) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      reasons.push(`value at index ${index} is not numeric`);
      return;
    }
    numeric.push(parsed);
  });

  if (numeric.length < MIN_SAMPLES) {
    reasons.push(`requires at least ${MIN_SAMPLES} numeric samples`);
  }

  if (numeric.length) {
    const sorted = [...numeric].sort((a, b) => a - b);
    if (sorted[0] === sorted[sorted.length - 1]) {
      reasons.push("all samples share the same value");
    }
  }

  if (reasons.length) {
    logger.warn("Validation failed", { reasons });
    return { ok: false, values: [], reasons };
  }

  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  logger.info("Validation passed", { samples: numeric.length, min, max });
  return { ok: true, values: numeric, reasons: [] };
}

```
