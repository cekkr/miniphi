---
source: src/greeter.js
language: javascript
generatedAt: 2025-11-15T23:21:56.026Z
sha256: 83aed47e73533b4c518a4d0e70dbe668f600a15e7b678505ae4cdfa76d269379
---

# File: src/greeter.js

```javascript
export function greet(name) {
  const target = (name ?? "friend").trim() || "friend";
  return `Hello, ${target}!`;
}

export function farewell(name) {
  const target = (name ?? "friend").trim() || "friend";
  return `Goodbye, ${target}. Keep building!`;
}

```
