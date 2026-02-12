const CATEGORY_PROMPTS = {
  "function-calling-tool-use":
    "Benchmark MiniPhi for function-calling style tasks. Prioritize strict JSON actions, schema-safe arguments, and deterministic tool-call planning.",
  "general-assistant-reasoning":
    "Benchmark MiniPhi for assistant reasoning tasks. Prioritize grounded multi-step reasoning, factual discipline, and explicit uncertainty handling.",
  "coding-software-engineering":
    "Benchmark MiniPhi for software engineering tasks. Prioritize repo-grounded planning, safe edits, clear validation steps, and diff-aware summaries.",
  "computer-interaction-gui-web":
    "Benchmark MiniPhi for GUI and web-interaction style tasks. Prioritize reproducible navigation plans, policy-safe actions, and context-budget discipline.",
};

function normalizeSourcePath(sourcePath) {
  return String(sourcePath ?? "").replace(/\\/g, "/");
}

function slugify(text) {
  const normalized = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "item";
}

function parseLinks(line) {
  const links = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match = pattern.exec(line);
  while (match) {
    const label = String(match[1] ?? "").trim();
    const url = String(match[2] ?? "").trim();
    if (label && url) {
      links.push({ label, url });
    }
    match = pattern.exec(line);
  }
  return links;
}

function finalizeBenchmark(state) {
  if (!state.currentBenchmark || !state.currentCategory) {
    state.currentBenchmark = null;
    return;
  }
  const summary = state.currentBenchmark.summaryLines.join(" ").replace(/\s+/g, " ").trim();
  const baseId = slugify(state.currentBenchmark.name);
  let id = baseId;
  let duplicateCounter = 2;
  while (state.benchmarkIds.has(id)) {
    id = `${baseId}-${duplicateCounter}`;
    duplicateCounter += 1;
  }
  state.benchmarkIds.add(id);
  const benchmark = {
    id,
    name: state.currentBenchmark.name,
    category_id: state.currentCategory.id,
    category_title: state.currentCategory.title,
    summary,
    links: state.currentBenchmark.links,
  };
  state.benchmarks.push(benchmark);
  state.currentCategory.benchmark_ids.push(id);
  state.currentBenchmark = null;
}

export function parseBenchmarkCompendium(markdownText) {
  const state = {
    categories: [],
    categoryById: new Map(),
    currentCategory: null,
    currentBenchmark: null,
    benchmarks: [],
    benchmarkIds: new Set(),
  };
  const lines = String(markdownText ?? "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("## ")) {
      finalizeBenchmark(state);
      const title = line.slice(3).trim();
      const id = slugify(title);
      let category = state.categoryById.get(id) ?? null;
      if (!category) {
        category = { id, title, benchmark_ids: [] };
        state.categoryById.set(id, category);
        state.categories.push(category);
      }
      state.currentCategory = category;
      continue;
    }
    if (line.startsWith("### ")) {
      finalizeBenchmark(state);
      if (!state.currentCategory) {
        continue;
      }
      state.currentBenchmark = {
        name: line.slice(4).trim(),
        summaryLines: [],
        links: [],
      };
      continue;
    }
    if (!state.currentBenchmark) {
      continue;
    }
    if (line.startsWith("Links:")) {
      state.currentBenchmark.links = parseLinks(line);
      continue;
    }
    if (line === "---") {
      continue;
    }
    state.currentBenchmark.summaryLines.push(line);
  }
  finalizeBenchmark(state);
  return {
    categories: state.categories,
    benchmarks: state.benchmarks,
  };
}

export function buildBenchmarkCatalog(markdownText, options = {}) {
  const parsed = parseBenchmarkCompendium(markdownText);
  const sourceFile = normalizeSourcePath(options.sourcePath ?? "dev_samples/task-tests.md");
  return {
    schema_version: "1.0.0",
    source_file: sourceFile,
    total_categories: parsed.categories.length,
    total_benchmarks: parsed.benchmarks.length,
    categories: parsed.categories.map((category) => ({
      id: category.id,
      title: category.title,
      benchmark_count: category.benchmark_ids.length,
      benchmark_ids: [...category.benchmark_ids],
    })),
    benchmarks: parsed.benchmarks,
  };
}

function buildCategoryPrompt(categoryId, categoryTitle, benchmarkNames) {
  const basePrompt =
    CATEGORY_PROMPTS[categoryId] ??
    `Benchmark MiniPhi against ${categoryTitle} style tasks with reproducible JSON-first outputs.`;
  if (!Array.isArray(benchmarkNames) || !benchmarkNames.length) {
    return basePrompt;
  }
  return `${basePrompt} Use ${benchmarkNames.join(", ")} as reference signals for coverage.`;
}

export function buildGeneralPurposeSuite(catalog, options = {}) {
  const sourceFile = normalizeSourcePath(options.sourcePath ?? catalog?.source_file ?? "dev_samples/task-tests.md");
  const benchmarkById = new Map(
    Array.isArray(catalog?.benchmarks)
      ? catalog.benchmarks.map((benchmark) => [benchmark.id, benchmark])
      : [],
  );
  const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
  const tasks = categories.map((category, index) => {
    const refs = Array.isArray(category.benchmark_ids) ? category.benchmark_ids.slice(0, 3) : [];
    const benchmarkNames = refs
      .map((ref) => benchmarkById.get(ref)?.name)
      .filter((name) => typeof name === "string" && name.trim().length > 0);
    return {
      id: `general-suite-${index + 1}-${category.id}`,
      category_id: category.id,
      category_title: category.title,
      benchmark_refs: refs,
      task: buildCategoryPrompt(category.id, category.title, benchmarkNames),
      command: "node -v",
    };
  });
  return {
    schema_version: "1.0.0",
    source_file: sourceFile,
    purpose: "Category-balanced benchmark general regression suite derived from task-tests.md.",
    tasks,
  };
}
