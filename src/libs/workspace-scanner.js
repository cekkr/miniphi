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
const CACHE_KIND_SYNC = "sync";
const CACHE_KIND_ASYNC = "async";

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

function createWorkspaceScanCache() {
  return {
    sync: new Map(),
    async: new Map(),
  };
}

function resolveCacheStore(scanCache, kind) {
  if (!scanCache) {
    return null;
  }
  if (scanCache instanceof Map) {
    return scanCache;
  }
  if (typeof scanCache !== "object") {
    return null;
  }
  const key = kind === CACHE_KIND_ASYNC ? "async" : "sync";
  if (!(scanCache[key] instanceof Map)) {
    scanCache[key] = new Map();
  }
  return scanCache[key];
}

function hasCompatibleScanResult(scanResult, root) {
  return Boolean(
    scanResult?.root &&
      path.resolve(scanResult.root) === root &&
      Array.isArray(scanResult.entries),
  );
}

function buildWorkspaceScanCacheKey(baseDir, options = undefined) {
  const root = baseDir ? path.resolve(baseDir) : "";
  const resolved = resolveScanOptions(options);
  const ignored = Array.from(resolved.ignoredDirs).sort();
  return JSON.stringify({
    root,
    ignored,
    maxDepth: resolved.maxDepth,
    maxEntries: resolved.maxEntries,
    includeFiles: resolved.includeFiles,
    includeDirectories: resolved.includeDirectories,
  });
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
      dirents.sort((a, b) => a.name.localeCompare(b.name));
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

export function resolveWorkspaceScanSync(baseDir, options = undefined) {
  const root = baseDir ? path.resolve(baseDir) : null;
  if (!root) {
    return scanWorkspaceSync(baseDir, options);
  }
  if (hasCompatibleScanResult(options?.scanResult, root)) {
    return options.scanResult;
  }
  const cacheKey = buildWorkspaceScanCacheKey(root, options);
  const syncCache = resolveCacheStore(options?.scanCache, CACHE_KIND_SYNC);
  if (syncCache?.has(cacheKey)) {
    return syncCache.get(cacheKey);
  }
  const result = scanWorkspaceSync(root, options);
  if (syncCache) {
    syncCache.set(cacheKey, result);
  }
  return result;
}

export async function resolveWorkspaceScan(baseDir, options = undefined) {
  const root = baseDir ? path.resolve(baseDir) : null;
  if (!root) {
    return scanWorkspace(baseDir, options);
  }
  if (hasCompatibleScanResult(options?.scanResult, root)) {
    return options.scanResult;
  }
  const cacheKey = buildWorkspaceScanCacheKey(root, options);
  const syncCache = resolveCacheStore(options?.scanCache, CACHE_KIND_SYNC);
  if (syncCache?.has(cacheKey)) {
    return syncCache.get(cacheKey);
  }
  const asyncCache = resolveCacheStore(options?.scanCache, CACHE_KIND_ASYNC);
  if (asyncCache?.has(cacheKey)) {
    return asyncCache.get(cacheKey);
  }
  const pending = scanWorkspace(root, options);
  if (asyncCache) {
    asyncCache.set(cacheKey, pending);
  }
  try {
    const result = await pending;
    if (syncCache) {
      syncCache.set(cacheKey, result);
    }
    return result;
  } finally {
    if (asyncCache) {
      asyncCache.delete(cacheKey);
    }
  }
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

export {
  DEFAULT_IGNORED_DIRS,
  DEFAULT_SKIP_FILES,
  createWorkspaceScanCache,
  normalizeScanSet,
};
