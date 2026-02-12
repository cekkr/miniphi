import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBenchmarkCatalog,
  buildGeneralPurposeSuite,
} from "../dev_samples/test_tasks/catalog-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(PROJECT_ROOT, "dev_samples", "task-tests.md");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "dev_samples", "test_tasks");
const CATALOG_PATH = path.join(OUTPUT_DIR, "benchmark-catalog.json");
const SUITE_PATH = path.join(OUTPUT_DIR, "general-purpose-suite.json");

async function main() {
  const markdown = await fs.readFile(SOURCE_PATH, "utf8");
  const catalog = buildBenchmarkCatalog(markdown, {
    sourcePath: "dev_samples/task-tests.md",
  });
  const suite = buildGeneralPurposeSuite(catalog, {
    sourcePath: "dev_samples/task-tests.md",
  });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await fs.writeFile(SUITE_PATH, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
  const catalogRel = path.relative(PROJECT_ROOT, CATALOG_PATH).replace(/\\/g, "/");
  const suiteRel = path.relative(PROJECT_ROOT, SUITE_PATH).replace(/\\/g, "/");
  console.log(`[MiniPhi][BenchmarkTasks] Wrote ${catalogRel}`);
  console.log(`[MiniPhi][BenchmarkTasks] Wrote ${suiteRel}`);
}

main().catch((error) => {
  console.error(
    `[MiniPhi][BenchmarkTasks] Sync failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
