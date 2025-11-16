---
source: src/shared/logger.js
language: javascript
generatedAt: 2025-11-16T04:45:19.645Z
sha256: abbc66716535b8070800ce65e0fa15cf5f2441640cde857a6c4b0a2b9c327c05
---

# File: src/shared/logger.js

```javascript
export function createLogger(scope = "flow") {
  const history = [];

  const write = (level, message, metadata = {}) => {
    const entry = {
      scope,
      level,
      message,
      metadata,
      timestamp: new Date().toISOString(),
    };
    history.push(entry);
    return entry;
  };

  return {
    info: (message, metadata) => write("info", message, metadata),
    warn: (message, metadata) => write("warn", message, metadata),
    error: (message, metadata) => write("error", message, metadata),
    flush: () => [...history],
  };
}

```
