import fs from "fs";
import path from "path";

const DEFAULT_CONFIG_FILENAMES = ["miniphi.config.json", "config.json"];

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const result = Array.isArray(base) ? [...base] : { ...(base ?? {}) };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

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

function applyProfile(config, profileName) {
  if (!profileName) {
    return { data: config, profileName: null, profileSource: null };
  }
  if (!config || typeof config !== "object") {
    throw new Error(`Profile "${profileName}" requested but configuration is empty.`);
  }
  const profiles = config.profiles;
  if (!profiles || typeof profiles !== "object") {
    throw new Error(`Profile "${profileName}" requested but no profiles are defined in config.`);
  }
  const profileConfig = profiles[profileName];
  if (!profileConfig || typeof profileConfig !== "object") {
    throw new Error(`Profile "${profileName}" not found in config profiles.`);
  }
  const baseConfig = { ...config };
  delete baseConfig.profiles;
  const merged = deepMerge(baseConfig, profileConfig);
  merged.profiles = profiles;
  return { data: merged, profileName, profileSource: profileConfig };
}

/**
 * Loads a configuration JSON file from disk.
 * @param {string|undefined} customPath
 */
export function loadConfig(customPath, options = undefined) {
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
    const parsed = JSON.parse(contents);
    const selectedProfile =
      options?.profile ?? process.env.MINIPHI_PROFILE ?? process.env.MINIPHI_CONFIG_PROFILE;
    const profileResult = applyProfile(parsed, selectedProfile);
    return {
      path: resolvedPath,
      data: profileResult.data,
      profileName: profileResult.profileName,
      profileSource: profileResult.profileSource,
    };
  } catch (error) {
    throw new Error(`Unable to parse ${resolvedPath}: ${error instanceof Error ? error.message : error}`);
  }
}
