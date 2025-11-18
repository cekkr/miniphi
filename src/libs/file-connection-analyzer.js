import fs from "fs";
import path from "path";

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_BYTES = 96 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
]);
const IMPORT_EXTENSIONS = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"];
const INDEX_FILES = ["index.js", "index.ts", "index.tsx", "index.jsx"];
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".miniphi",
  "dist",
  "build",
  "out",
  ".next",
  ".idea",
  ".vscode",
]);

export default class FileConnectionAnalyzer {
  constructor(options = undefined) {
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.extensions =
      options?.extensions instanceof Set ? options.extensions : SUPPORTED_EXTENSIONS;
  }

  analyze(rootDir = process.cwd()) {
    const root = path.resolve(rootDir);
    if (!fs.existsSync(root)) {
      throw new Error(`Workspace root not found: ${root}`);
    }
    const files = this.#collectFiles(root);
    const nodes = new Map();
    const importCache = new Map();

    for (const filePath of files) {
      const relative = path.relative(root, filePath).replace(/\\/g, "/");
      const content = this.#readFileSafely(filePath);
      const imports = this.#extractImports(filePath, content, root, importCache);
      nodes.set(relative, {
        path: relative,
        imports,
        importedBy: [],
      });
    }

    let edgeCount = 0;
    for (const [file, node] of nodes.entries()) {
      node.imports.forEach((target) => {
        const targetNode = nodes.get(target);
        if (!targetNode) {
          return;
        }
        targetNode.importedBy.push(file);
        edgeCount += 1;
      });
    }

    const hotspots = this.#buildHotspots(nodes);
    const summary = this.#buildSummary(hotspots, nodes.size, edgeCount);
    const graph = this.#buildGraphSample(nodes);

    return {
      root,
      filesAnalyzed: nodes.size,
      edges: edgeCount,
      nodes: Object.fromEntries(nodes),
      hotspots,
      summary,
      graph,
    };
  }

  #collectFiles(root) {
    const queue = [root];
    const collected = [];
    const visited = new Set();

    while (queue.length > 0 && collected.length < this.maxFiles) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);

      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) {
            continue;
          }
          queue.push(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!this.extensions.has(ext)) {
          continue;
        }
        collected.push(fullPath);
        if (collected.length >= this.maxFiles) {
          break;
        }
      }
    }

    return collected;
  }

  #readFileSafely(filePath) {
    try {
      const buffer = fs.readFileSync(filePath);
      return buffer.slice(0, this.maxBytes).toString("utf8");
    } catch {
      return "";
    }
  }

  #extractImports(filePath, content, root, cache) {
    const ext = path.extname(filePath).toLowerCase();
    const imports = new Set();

    if (ext === ".py") {
      this.#extractPythonImports(filePath, content, root, imports, cache);
    } else {
      this.#extractJsImports(filePath, content, root, imports, cache);
    }

    return Array.from(imports);
  }

  #extractJsImports(filePath, content, root, imports, cache) {
    const patterns = [
      /import\s+[^"'`]+?from\s+["'`](.+?)["'`]/g,
      /import\s+["'`](.+?)["'`]/g,
      /require\(\s*["'`](.+?)["'`]\s*\)/g,
      /export\s+[^"'`]+?\s+from\s+["'`](.+?)["'`]/g,
    ];
    for (const regex of patterns) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        const spec = match[1];
        const resolved = this.#resolveModulePath(filePath, spec, root, cache);
        if (resolved) {
          imports.add(resolved);
        }
      }
    }
  }

  #extractPythonImports(filePath, content, root, imports, cache) {
    const regex = /\bfrom\s+([.\w]+)\s+import\b|\bimport\s+([.\w]+)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const spec = match[1] ?? match[2] ?? "";
      if (!spec) continue;
      const resolved = this.#resolvePythonModule(filePath, spec, root, cache);
      if (resolved) {
        imports.add(resolved);
      }
    }
  }

  #resolveModulePath(filePath, specifier, root, cache) {
    if (!specifier || (!specifier.startsWith(".") && !specifier.startsWith("/"))) {
      return null;
    }
    const baseDir = path.dirname(filePath);
    const attempts = [];
    const normalized = specifier.endsWith("/")
      ? specifier.slice(0, -1)
      : specifier.replace(/\/$/, "");
    const absoluteCandidate = path.resolve(baseDir, normalized);

    for (const ext of IMPORT_EXTENSIONS) {
      attempts.push(`${absoluteCandidate}${ext}`);
    }
    for (const indexFile of INDEX_FILES) {
      attempts.push(path.join(absoluteCandidate, indexFile));
    }

    for (const candidate of attempts) {
      const resolved = this.#validateCandidate(candidate, root, cache);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  #resolvePythonModule(filePath, specifier, root, cache) {
    const baseDir = path.dirname(filePath);
    if (specifier.startsWith(".")) {
      const relativeDepth = specifier.match(/^\.*/)[0].length;
      let targetDir = baseDir;
      for (let i = 0; i < relativeDepth - 1; i += 1) {
        targetDir = path.dirname(targetDir);
      }
      const remainder = specifier.slice(relativeDepth).replace(/\./g, "/");
      const candidate = path.join(targetDir, remainder || "");
      return this.#validateCandidate(`${candidate}.py`, root, cache);
    }
    const absolute = path.join(root, specifier.replace(/\./g, "/"));
    return this.#validateCandidate(`${absolute}.py`, root, cache);
  }

  #validateCandidate(candidatePath, root, cache) {
    const normalized = path.normalize(candidatePath);
    if (!normalized.startsWith(root)) {
      return null;
    }
    if (cache.has(normalized)) {
      return cache.get(normalized);
    }
    let exists = false;
    try {
      const stats = fs.statSync(normalized);
      exists = stats.isFile();
    } catch {
      exists = false;
    }
    const relative = exists ? path.relative(root, normalized).replace(/\\/g, "/") : null;
    cache.set(normalized, relative);
    return relative;
  }

  #buildHotspots(nodes) {
    const allNodes = Array.from(nodes.values()).map((node) => ({
      path: node.path,
      imports: node.imports.length,
      importedBy: node.importedBy.length,
    }));

    const topImporters = [...allNodes]
      .sort((a, b) => b.imports - a.imports)
      .slice(0, 5)
      .filter((node) => node.imports > 0);
    const topDependents = [...allNodes]
      .sort((a, b) => b.importedBy - a.importedBy)
      .slice(0, 5)
      .filter((node) => node.importedBy > 0);

    return { topImporters, topDependents };
  }

  #buildSummary(hotspots, nodeCount, edgeCount) {
    const lines = [
      `Scanned ${nodeCount} files (${edgeCount} verified internal connections).`,
    ];
    if (hotspots.topImporters.length) {
      const importerLines = hotspots.topImporters
        .map((node) => `- ${node.path}: imports ${node.imports} files`)
        .join("\n");
      lines.push(`Top importers:\n${importerLines}`);
    }
    if (hotspots.topDependents.length) {
      const dependentLines = hotspots.topDependents
        .map((node) => `- ${node.path}: imported by ${node.importedBy} files`)
        .join("\n");
      lines.push(`Most referenced files:\n${dependentLines}`);
    }
    return lines.join("\n\n");
  }

  #buildGraphSample(nodes) {
    const ranked = Array.from(nodes.values())
      .map((node) => ({
        path: node.path,
        imports: node.imports.slice(0, 4),
        importedBy: node.importedBy.slice(0, 4),
        importCount: node.imports.length,
        importedByCount: node.importedBy.length,
      }))
      .filter((node) => node.importCount > 0 || node.importedByCount > 0)
      .sort(
        (a, b) =>
          b.importCount +
          b.importedByCount -
          (a.importCount + a.importedByCount),
      )
      .slice(0, 4);
    if (!ranked.length) {
      return null;
    }
    const lines = ["Connections (→ imports, ← imported by):"];
    for (const node of ranked) {
      lines.push(node.path);
      if (node.imports.length) {
        const suffix = node.importCount > node.imports.length ? " ..." : "";
        lines.push(`  → ${node.imports.join(", ")}${suffix}`);
      }
      if (node.importedBy.length) {
        const suffix = node.importedByCount > node.importedBy.length ? " ..." : "";
        lines.push(`  ← ${node.importedBy.join(", ")}${suffix}`);
      }
    }
    return lines.join("\n");
  }
}
