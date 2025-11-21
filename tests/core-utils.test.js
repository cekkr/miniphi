import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDangerLevel,
  mergeFixedReferences,
  buildPlanOperations,
  buildNavigationOperations,
  normalizePlanDirections,
  buildResourceConfig,
  resolveLmStudioHttpBaseUrl,
  isLocalLmStudioBaseUrl,
  extractContextRequestsFromAnalysis,
} from "../src/libs/core-utils.js";

test("normalizeDangerLevel clamps unknown values to mid", () => {
  assert.equal(normalizeDangerLevel("LOW"), "low");
  assert.equal(normalizeDangerLevel("High"), "high");
  assert.equal(normalizeDangerLevel("unexpected"), "mid");
  assert.equal(normalizeDangerLevel(null), "mid");
});

test("mergeFixedReferences preserves existing context", () => {
  const context = { summary: "info" };
  const merged = mergeFixedReferences(context, [{ path: "file.txt" }]);
  assert.equal(merged.summary, "info");
  assert.deepEqual(merged.fixedReferences, [{ path: "file.txt" }]);
  assert.equal(mergeFixedReferences(context, []).fixedReferences, undefined);
});

test("buildPlanOperations flattens nested steps respecting limit", () => {
  const plan = {
    steps: [
      {
        id: "1",
        title: "Root",
        description: "root",
        requires_subprompt: true,
        recommendation: "look",
        children: [
          { id: "1.1", title: "Child", description: "child", requires_subprompt: false },
        ],
      },
      { id: "2", title: "Next", description: "next", requires_subprompt: false },
    ],
  };
  const operations = buildPlanOperations(plan, 2);
  assert.equal(operations.length, 2);
  assert.equal(operations[0].status, "requires-subprompt");
  assert.equal(operations[1].summary, "Child");
});

test("buildNavigationOperations prefers explicit actions then focus commands", () => {
  const hints = {
    actions: [
      { command: "ls", danger: "LOW", reason: "list" },
      { command: "rm -rf /", danger: "HIGH", reason: "dangerous" },
      { danger: "mid" }, // ignored
    ],
    focusCommands: ["git status", "npm test"],
  };
  const operations = buildNavigationOperations(hints, 3);
  assert.equal(operations.length, 3);
  assert.equal(operations[0].danger, "low");
  assert.equal(operations[1].danger, "high");
  assert.equal(operations[2].command, "git status");
});

test("normalizePlanDirections normalizes arrays and comma strings", () => {
  assert.deepEqual(normalizePlanDirections(["RoundTrip", " code "]), ["roundtrip", "code"]);
  assert.deepEqual(normalizePlanDirections("roundtrip, code-to-markdown"), [
    "roundtrip",
    "code-to-markdown",
  ]);
  assert.deepEqual(normalizePlanDirections(""), []);
});

test("buildResourceConfig clamps thresholds and sample interval", () => {
  const config = buildResourceConfig({
    "max-memory-percent": 150,
    "max-cpu-percent": 50,
    "max-vram-percent": "10",
    "resource-sample-interval": 100,
  });
  assert.equal(config.thresholds.memory, 100);
  assert.equal(config.thresholds.cpu, 50);
  assert.equal(config.thresholds.vram, 10);
  assert.equal(config.sampleInterval, undefined);
  const valid = buildResourceConfig({ "resource-sample-interval": 500 });
  assert.equal(valid.sampleInterval, 500);
});

test("resolveLmStudioHttpBaseUrl prioritizes config then env fallbacks", () => {
  const env = { LMSTUDIO_REST_URL: "http://10.0.0.5:9999" };
  const config = {
    lmStudio: {
      rest: { baseUrl: "http://localhost:1234" },
      clientOptions: { baseUrl: "http://127.0.0.1:3333" },
    },
  };
  assert.equal(resolveLmStudioHttpBaseUrl(config, env), "http://localhost:1234");
  const viaEnv = resolveLmStudioHttpBaseUrl({}, env);
  assert.equal(viaEnv, "http://10.0.0.5:9999");
  assert.equal(resolveLmStudioHttpBaseUrl({}, {}), null);
});

test("isLocalLmStudioBaseUrl detects loopback hosts", () => {
  assert.equal(isLocalLmStudioBaseUrl("http://127.0.0.1:1234"), true);
  assert.equal(isLocalLmStudioBaseUrl("http://localhost"), true);
  assert.equal(isLocalLmStudioBaseUrl("http://192.168.1.5:1234"), false);
  assert.equal(isLocalLmStudioBaseUrl("not a url"), true);
});

test("extractContextRequestsFromAnalysis returns normalized hints", () => {
  const analysis = JSON.stringify({
    context_requests: [
      {
        id: "chunk-1",
        description: "Provide chunk 2",
        details: "Lines 120-200 focus on parser errors",
        priority: "high",
        context: "parser.c",
      },
      {
        request: "Need README excerpt",
        scope: "README.md",
        priority: "mid",
      },
      {
        details: "Missing description only",
      },
    ],
  });
  const requests = extractContextRequestsFromAnalysis(analysis);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].id, "chunk-1");
  assert.equal(requests[0].detail, "Lines 120-200 focus on parser errors");
  assert.equal(requests[0].priority, "high");
  assert.equal(requests[1].description, "Need README excerpt");
  assert.equal(requests[1].context, "README.md");
});
