import fs from "fs";
import path from "path";

const DEFAULT_IGNORED_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".miniphi"]);
const DEFAULT_SKIP_FILES = new Set([".gitkeep"]);

function normalizeSet(values) {
  if (!values) {
    return new Set();
  }
  const output = new Set();
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      output.add(value.trim().toLowerCase());
    }
  }
  return output;
}

function shouldSkipDirectory(name, ignored) {
  if (!name) {
    return false;
  }
  const normalized = name.toLowerCase();
  return ignored.has(normalized) || normalized.startsWith(".");
}

export async function listWorkspaceFiles(baseDir, options = undefined) {
  if (!baseDir) {
    return [];
  }
  const ignored = normalizeSet(options?.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
  const skipFiles = normalizeSet(options?.skipFiles ?? DEFAULT_SKIP_FILES);
  const files = [];
  const stack = [""];
  while (stack.length) {
    const current = stack.pop();
    const absolute = path.join(baseDir, current);
    let dirents;
    try {
      dirents = await fs.promises.readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const relPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (shouldSkipDirectory(dirent.name, ignored)) {
          continue;
        }
        stack.push(relPath);
      } else if (dirent.isFile()) {
        if (skipFiles.has(dirent.name.toLowerCase())) {
          continue;
        }
        files.push(relPath.replace(/\\/g, "/"));
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export async function collectManifestSummary(baseDir, options = undefined) {
  if (!baseDir) {
    return { files: [], manifest: [] };
  }
  const files = await listWorkspaceFiles(baseDir, options);
  const limit = Math.max(1, options?.limit ?? 12);
  const manifest = [];
  for (const relative of files.slice(0, limit)) {
    const absolute = path.join(baseDir, relative);
    try {
      const stats = await fs.promises.stat(absolute);
      manifest.push({ path: relative, bytes: stats.size });
    } catch {
      manifest.push({ path: relative, bytes: 0 });
    }
  }
  return { files, manifest };
}

export async function readReadmeSnippet({ candidates = [], maxLength = 240 } = {}) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      const stats = await fs.promises.stat(candidate);
      if (!stats.isFile()) {
        continue;
      }
      const snippet = (await fs.promises.readFile(candidate, "utf8")).replace(/\s+/g, " ").trim();
      if (snippet) {
        return snippet.slice(0, maxLength);
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function formatMetadataSummary(metadata) {
  if (!metadata) {
    return "";
  }
  const lines = [];
  if (metadata.sampleName) {
    lines.push(`Workspace sample: ${metadata.sampleName}`);
  }
  if (metadata.plan?.name) {
    lines.push(`Plan: ${metadata.plan.name}`);
  }
  if (Array.isArray(metadata.manifest) && metadata.manifest.length) {
    const entries = metadata.manifest
      .slice(0, 6)
      .map((entry) => `- ${entry.path} (${entry.bytes} bytes)`)
      .join("\n");
    lines.push(`Manifest preview:\n${entries}`);
  }
  if (metadata.readmeSnippet) {
    lines.push(`README snippet: ${metadata.readmeSnippet}`);
  }
  return lines.join("\n");
}

export function buildWorkspaceHintBlock(files, baseDir, readmeSnippet = null, options = undefined) {
  const limit = Math.max(1, options?.limit ?? 10);
  const manifestLines = (files ?? [])
    .slice(0, limit)
    .map((file) => `- ${file}`)
    .join("\n");
  const blocks = [];
  const label = baseDir ? ` (${baseDir})` : "";
  if (manifestLines) {
    blocks.push(`File manifest${label}:\n${manifestLines}`);
  }
  if (readmeSnippet) {
    blocks.push(`README excerpt:\n${readmeSnippet}`);
  }
  return blocks.join("\n\n");
}

export { DEFAULT_IGNORED_DIRS };
