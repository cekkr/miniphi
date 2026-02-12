import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildBenchmarkCatalog,
  buildGeneralPurposeSuite,
  parseBenchmarkCompendium,
} from "../dev_samples/test_tasks/catalog-utils.js";

const TASK_TESTS_PATH = path.resolve("dev_samples", "task-tests.md");
const CATALOG_PATH = path.resolve("dev_samples", "test_tasks", "benchmark-catalog.json");
const SUITE_PATH = path.resolve("dev_samples", "test_tasks", "general-purpose-suite.json");

function assertHttpUrl(url) {
  const parsed = new URL(url);
  assert.ok(parsed.protocol === "http:" || parsed.protocol === "https:");
}

test("task-tests markdown parses into expected benchmark structure", async () => {
  const markdown = await fs.readFile(TASK_TESTS_PATH, "utf8");
  const parsed = parseBenchmarkCompendium(markdown);

  assert.equal(parsed.categories.length, 4);
  assert.equal(parsed.benchmarks.length, 50);

  const categoryCounts = new Map(
    parsed.categories.map((category) => [category.id, category.benchmark_ids.length]),
  );
  assert.equal(categoryCounts.get("function-calling-tool-use"), 13);
  assert.equal(categoryCounts.get("general-assistant-reasoning"), 11);
  assert.equal(categoryCounts.get("coding-software-engineering"), 7);
  assert.equal(categoryCounts.get("computer-interaction-gui-web"), 19);

  for (const benchmark of parsed.benchmarks) {
    assert.ok(typeof benchmark.name === "string" && benchmark.name.trim().length > 0);
    assert.ok(typeof benchmark.summary === "string" && benchmark.summary.trim().length > 0);
    assert.ok(Array.isArray(benchmark.links) && benchmark.links.length > 0);
    for (const link of benchmark.links) {
      assert.ok(typeof link.label === "string" && link.label.trim().length > 0);
      assert.ok(typeof link.url === "string" && link.url.trim().length > 0);
      assertHttpUrl(link.url);
    }
  }
});

test("benchmark catalog clone stays synced with task-tests markdown", async () => {
  const markdown = await fs.readFile(TASK_TESTS_PATH, "utf8");
  const expectedCatalog = buildBenchmarkCatalog(markdown, {
    sourcePath: "dev_samples/task-tests.md",
  });
  const catalog = JSON.parse(await fs.readFile(CATALOG_PATH, "utf8"));

  assert.deepEqual(
    catalog,
    expectedCatalog,
    "benchmark-catalog.json is stale; run node scripts/sync-test-task-catalog.js",
  );
});

test("general-purpose benchmark suite clone stays synced and references known benchmarks", async () => {
  const markdown = await fs.readFile(TASK_TESTS_PATH, "utf8");
  const catalog = buildBenchmarkCatalog(markdown, {
    sourcePath: "dev_samples/task-tests.md",
  });
  const expectedSuite = buildGeneralPurposeSuite(catalog, {
    sourcePath: "dev_samples/task-tests.md",
  });
  const suite = JSON.parse(await fs.readFile(SUITE_PATH, "utf8"));
  assert.deepEqual(
    suite,
    expectedSuite,
    "general-purpose-suite.json is stale; run node scripts/sync-test-task-catalog.js",
  );

  const categoryIds = new Set(catalog.categories.map((category) => category.id));
  const benchmarkIds = new Set(catalog.benchmarks.map((benchmark) => benchmark.id));
  const taskCategoryIds = new Set();

  assert.equal(suite.tasks.length, categoryIds.size);
  for (const task of suite.tasks) {
    assert.ok(typeof task.id === "string" && task.id.trim().length > 0);
    assert.ok(typeof task.category_id === "string" && task.category_id.trim().length > 0);
    assert.ok(categoryIds.has(task.category_id), `Unknown category id: ${task.category_id}`);
    taskCategoryIds.add(task.category_id);
    assert.ok(typeof task.category_title === "string" && task.category_title.trim().length > 0);
    assert.ok(typeof task.task === "string" && task.task.trim().length > 30);
    assert.equal(task.command, "node -v");
    assert.ok(Array.isArray(task.benchmark_refs) && task.benchmark_refs.length > 0);
    for (const benchmarkId of task.benchmark_refs) {
      assert.ok(
        benchmarkIds.has(benchmarkId),
        `Unknown benchmark id in suite task ${task.id}: ${benchmarkId}`,
      );
    }
  }
  assert.equal(taskCategoryIds.size, categoryIds.size);
});
