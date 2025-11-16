---
source: src/index.js
language: javascript
generatedAt: 2025-11-16T04:45:19.639Z
sha256: 0d71eb707442c7bd5064d6ed2a18e79c600ab65216f59e1f756f0ce7f5d0acd8
---

# File: src/index.js

```javascript
import { greet, farewell } from "./greeter.js";
import { average, describeTrend } from "./math.js";
import InsightPipeline from "./flows/pipeline.js";

const pipeline = new InsightPipeline();

export function summarize(values, name) {
  const intro = greet(name);
  const session = pipeline.process(values, { owner: name, label: "summary" });
  const dataset = session.normalized.length ? session.normalized : values;
  const avg = average(dataset);
  const trend = describeTrend(dataset);
  const record = pipeline.finalize(session.id, { average: avg, trend });
  return `${intro} The average of ${session.metadata.count} samples is ${avg}, trend looks ${trend}. ${record.logLine}`;
}

export function closingRemark(name) {
  const closing = farewell(name);
  const snapshot = pipeline.lastSnapshot();
  if (!snapshot) {
    return closing;
  }
  const owner = snapshot.metadata?.owner ?? "anonymous";
  const label = snapshot.metadata?.batchLabel ?? "batch";
  const trend = snapshot.summary?.trend ?? "unknown";
  return `${closing} Latest checkpoint ${snapshot.id} keeps ${label} data for ${owner} (trend ${trend}).`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const sampleValues = [1, 3, 5, 7];
  console.log(summarize(sampleValues, "MiniPhi"));
  console.log(summarize([2, 6, 11, 13, 21], "Ops Team"));
  console.log(closingRemark("MiniPhi"));
}

```
