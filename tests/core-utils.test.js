import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDangerLevel,
  mergeFixedReferences,
  buildPlanOperations,
  buildPlanSegments,
  formatPlanSegmentsBlock,
  formatPlanRecommendationsBlock,
  buildNavigationOperations,
  normalizePlanDirections,
  buildResourceConfig,
  resolveLmStudioHttpBaseUrl,
  isLocalLmStudioBaseUrl,
  extractContextRequestsFromAnalysis,
  extractJsonBlock,
  extractTruncationPlanFromAnalysis,
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

test("buildPlanSegments captures depth, recommendations, and descriptions", () => {
  const plan = {
    steps: [
      {
        id: "1",
        title: "Root",
        description: "Root description",
        requires_subprompt: true,
        recommendation: "use analyzer",
        children: [
          { id: "1.1", title: "Leaf", description: "Leaf desc", requires_subprompt: false },
        ],
      },
    ],
  };
  const segments = buildPlanSegments(plan, { limit: 4 });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].depth, 0);
  assert.equal(segments[0].recommendation, "use analyzer");
  assert.equal(segments[1].depth, 1);
  assert.equal(segments[1].title, "Leaf");
});

test("formatPlanSegmentsBlock renders indented bullets with flags", () => {
  const block = formatPlanSegmentsBlock([
    { id: "1", title: "Root", depth: 0, requiresSubprompt: true },
    { id: "1.1", title: "Child", depth: 1, description: "Do stuff", recommendation: "npm test" },
  ]);
  assert.match(block, /- 1\. Root \(sub-prompt\)/);
  assert.match(block, /  - 1\.1\. Child \(npm test\)/);
  assert.match(block, /Do stuff/);
});

test("formatPlanRecommendationsBlock lists helpers with truncation notice", () => {
  const block = formatPlanRecommendationsBlock(
    ["npm test", "node scripts/audit", "python helper.py"],
    { limit: 2 },
  );
  assert.match(block, /Recommended helpers:/);
  assert.match(block, /- npm test/);
  assert.match(block, /\(\+1 more recommended tools\/scripts\)/);
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

test("extractJsonBlock tolerates fences, think blocks, and trailing prose", () => {
  const raw = `<think>draft</think>
  Sure, here's the plan:
  \`\`\`json
  {"plan_id":"123","steps":[{"id":"1","title":"Do thing"}]}
  \`\`\`
  Thanks!`;
  const parsed = extractJsonBlock(raw);
  assert.equal(parsed.plan_id, "123");
  assert.equal(parsed.steps[0].id, "1");
});

test("extractJsonBlock returns null when no JSON is present", () => {
  assert.equal(extractJsonBlock("Just a note without objects."), null);
});

test("extractTruncationPlanFromAnalysis returns null when prose is provided", () => {
  assert.equal(
    extractTruncationPlanFromAnalysis("Still thinking about how to chunk those logs..."),
    null,
  );
});

test("extractTruncationPlanFromAnalysis normalizes chunk metadata", () => {
  const analysis = JSON.stringify({
    task: "Audit logs",
    truncation_strategy: {
      should_split: true,
      chunking_plan: [
        {
          id: "chunk-a",
          goal: "Inspect parser regressions",
          priority: 2,
          lines: [100, 250],
          helper_commands: ["python scripts/split.py --chunk A"],
        },
      ],
      carryover_fields: ["chunk", "line_hint", "symptom"],
      history_schema: "chunk,line_window,summary,helpers",
    },
    next_steps: ["Rerun analyzer on chunk A"],
  });
  const result = extractTruncationPlanFromAnalysis(analysis);
  assert.ok(result);
  assert.equal(result.plan.shouldSplit, true);
  assert.equal(result.plan.chunkingPlan.length, 1);
  assert.equal(result.plan.chunkingPlan[0].startLine, 100);
  assert.equal(result.plan.chunkingPlan[0].endLine, 250);
  assert.equal(result.plan.chunkingPlan[0].helperCommands[0], "python scripts/split.py --chunk A");
  assert.deepEqual(result.nextSteps, ["Rerun analyzer on chunk A"]);
});
