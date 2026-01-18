import fs from "fs";
import path from "path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".turbo",
  ".cache",
  ".miniphi",
]);

const DEFAULT_SKIP_FILES = new Set([".gitkeep"]);

function normalizeScanSet(values) {
  if (!values) {
    return new Set();
  }
  if (values instanceof Set) {
    return new Set(Array.from(values, (value) => String(value).trim().toLowerCase()).filter(Boolean));
  }
  const output = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized) {
      output.add(normalized);
    }
  }
  return output;
}

function shouldSkipDirectory(name, ignored) {
  if (!name) {
    return false;
  }
  const normalized = name.toLowerCase();
  return normalized.startsWith(".") || ignored.has(normalized);
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveScanOptions(options = undefined) {
  const ignoredDirs = normalizeScanSet(options?.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
  const maxDepth = normalizeNumber(options?.maxDepth, Number.POSITIVE_INFINITY);
  const maxEntries = normalizeNumber(options?.maxEntries, Number.POSITIVE_INFINITY);
  const includeFiles = options?.includeFiles !== false;
  const includeDirectories = options?.includeDirectories !== false;
  return {
    ignoredDirs,
    maxDepth,
    maxEntries,
    includeFiles,
    includeDirectories,
  };
}

export function scanWorkspaceSync(baseDir, options = undefined) {
  const resolvedRoot = baseDir ? path.resolve(baseDir) : null;
  const resolvedOptions = resolveScanOptions(options);
  const result = {
    root: resolvedRoot,
    files: [],
    directories: [],
    entries: [],
    stats: { files: 0, directories: 0 },
    truncated: false,
    options: {
      ignoredDirs: Array.from(resolvedOptions.ignoredDirs),
      maxDepth: resolvedOptions.maxDepth,
      maxEntries: resolvedOptions.maxEntries,
    },
  };
  if (!resolvedRoot || !fs.existsSync(resolvedRoot)) {
    return result;
  }

  const queue = [{ dir: resolvedRoot, depth: 0 }];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (visited.has(current.dir)) {
      continue;
    }
    visited.add(current.dir);

    let dirents = [];
    try {
      dirents = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      const fullPath = path.join(current.dir, dirent.name);
      const relative = path.relative(resolvedRoot, fullPath) || dirent.name;
      const normalizedPath = relative.replace(/\\/g, "/");
      if (dirent.isDirectory()) {
        const depth = current.depth + 1;
        const ignored = shouldSkipDirectory(dirent.name, resolvedOptions.ignoredDirs);
        if (resolvedOptions.includeDirectories) {
          result.stats.directories += 1;
          result.directories.push(normalizedPath);
          result.entries.push({
            type: "dir",
            path: normalizedPath,
            depth,
            ignored,
          });
        }
        if (!ignored && depth <= resolvedOptions.maxDepth) {
          queue.push({ dir: fullPath, depth });
        }
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      if (resolvedOptions.includeFiles) {
        result.stats.files += 1;
        result.files.push(normalizedPath);
        result.entries.push({
          type: "file",
          path: normalizedPath,
          depth: current.depth,
        });
        if (result.stats.files >= resolvedOptions.maxEntries) {
          result.truncated = true;
          break;
        }
      }
    }
    if (result.stats.files >= resolvedOptions.maxEntries) {
      result.truncated = true;
      break;
    }
  }

  return result;
}

export async function scanWorkspace(baseDir, options = undefined) {
  return scanWorkspaceSync(baseDir, options);
}

export function filterWorkspaceFiles(files, options = undefined) {
  if (!Array.isArray(files)) {
    return [];
  }
  const skipFiles = normalizeScanSet(options?.skipFiles ?? DEFAULT_SKIP_FILES);
  const filtered = files.filter((file) => {
    if (!file || typeof file !== "string") {
      return false;
    }
    const basename = path.basename(file).toLowerCase();
    return !skipFiles.has(basename);
  });
  filtered.sort((a, b) => a.localeCompare(b));
  return filtered;
}

export { DEFAULT_IGNORED_DIRS, DEFAULT_SKIP_FILES, normalizeScanSet };
