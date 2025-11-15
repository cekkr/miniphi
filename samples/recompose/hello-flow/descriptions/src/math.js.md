---
source: src/math.js
language: javascript
generatedAt: 2025-11-15T23:21:56.027Z
sha256: f8bb2afdb1eea366696cb7d83e7b23f7f3a6f493af51cbbfe3cc4c36e25149ab
---

# File: src/math.js

```javascript
export function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const numbers = values.map((value) => Number(value) || 0);
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return Number((total / numbers.length).toFixed(2));
}

export function describeTrend(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return "insufficient-data";
  }
  const diff = values[values.length - 1] - values[0];
  if (diff === 0) {
    return "flat";
  }
  return diff > 0 ? "upward" : "downward";
}

```
