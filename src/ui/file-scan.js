import fs from "fs/promises";
import path from "path";

// Directories that are agent/VCS/build state, not editable sources. Mirrors the
// skip set used by the plan executor's search walk.
const SKIP_DIRS = new Set(["node_modules", ".git", ".miniphi", "dist", "build", "coverage"]);
const DEFAULT_MAX_FILES = 2000;

/**
 * Bounded recursive scan of a workspace, returning repo-relative POSIX file
 * paths for the interactive file picker. Skips dot-directories and known build
 * output so the list stays to actual sources.
 */
export async function scanWorkspaceFiles(cwd, { maxFiles = DEFAULT_MAX_FILES } = {}) {
  const root = path.resolve(cwd);
  const files = [];
  const walk = async (dir) => {
    if (files.length >= maxFiles) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          await walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile()) {
        const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/");
        files.push(rel);
      }
    }
  };
  await walk(root);
  files.sort();
  return files;
}
