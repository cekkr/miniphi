import fs from "fs";
import path from "path";

const DEFAULT_CONFIG_FILENAMES = ["miniphi.config.json", "config.json"];

function fileExists(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function findConfigUpwards(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    for (const name of DEFAULT_CONFIG_FILENAMES) {
      const candidate = path.join(current, name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function resolveExplicitPath(customPath) {
  if (!customPath) {
    return null;
  }
  const resolved = path.resolve(customPath);
  if (fileExists(resolved)) {
    return resolved;
  }
  throw new Error(`Configuration file not found: ${resolved}`);
}

/**
 * Loads a configuration JSON file from disk.
 * @param {string|undefined} customPath
 */
export function loadConfig(customPath) {
  let resolvedPath = resolveExplicitPath(customPath ?? process.env.MINIPHI_CONFIG ?? process.env.MINIPHI_CONFIG_PATH);
  if (!resolvedPath) {
    resolvedPath = findConfigUpwards(process.cwd());
  }

  if (!resolvedPath) {
    return { path: null, data: {} };
  }

  const contents = fs.readFileSync(resolvedPath, "utf8");
  if (!contents.trim()) {
    return { path: resolvedPath, data: {} };
  }

  try {
    return { path: resolvedPath, data: JSON.parse(contents) };
  } catch (error) {
    throw new Error(`Unable to parse ${resolvedPath}: ${error instanceof Error ? error.message : error}`);
  }
}
