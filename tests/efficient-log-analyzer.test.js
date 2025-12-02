import test from "node:test";
import assert from "node:assert";
import EfficientLogAnalyzer from "../src/libs/efficient-log-analyzer.js";

const stubPhi = { getContextWindow: async () => 16000 };
const stubCli = {};
const stubSummarizer = {};

test("EfficientLogAnalyzer sanitizes Phi responses to JSON only", () => {
  const analyzer = new EfficientLogAnalyzer(stubPhi, stubCli, stubSummarizer);
  const payload =
    'Understood!\n```json\n{"task":"t","root_cause":null,"evidence":[],"recommended_fixes":[],"next_steps":[]}\n```';
  const sanitized = analyzer._sanitizeJsonResponse(payload);

  assert.strictEqual(
    sanitized,
    '{\n  "task": "t",\n  "root_cause": null,\n  "evidence": [],\n  "recommended_fixes": [],\n  "next_steps": []\n}',
  );
});

test("EfficientLogAnalyzer rejects non-object JSON responses", () => {
  const analyzer = new EfficientLogAnalyzer(stubPhi, stubCli, stubSummarizer);
  const sanitized = analyzer._sanitizeJsonResponse('[1,2,3]');
  assert.strictEqual(sanitized, null);
});
