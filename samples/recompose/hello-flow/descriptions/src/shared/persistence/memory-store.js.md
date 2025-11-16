---
source: src/shared/persistence/memory-store.js
language: javascript
generatedAt: 2025-11-16T04:45:19.647Z
sha256: 28ad805f082526df3eac27b05f96792e54cee82116ac60474ee7b8a86bf54d44
---

# File: src/shared/persistence/memory-store.js

```javascript
export default class MemoryStore {
  constructor() {
    this.records = [];
    this.counter = 0;
  }

  create(entry = {}) {
    this.counter += 1;
    const id = entry.id ?? `run-${this.counter.toString().padStart(4, "0")}`;
    const record = {
      id,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      ...entry,
    };
    this.records.push(record);
    return record;
  }

  update(id, patch = {}) {
    const record = this.records.find((item) => item.id === id);
    if (!record) {
      return null;
    }
    Object.assign(record, patch);
    return record;
  }

  last() {
    return this.records[this.records.length - 1] ?? null;
  }

  all() {
    return [...this.records];
  }
}

```
