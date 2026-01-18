import fs from "fs";
import path from "path";
import {
  DEFAULT_IGNORED_DIRS,
  DEFAULT_SKIP_FILES,
  filterWorkspaceFiles,
  scanWorkspace,
} from "./workspace-scanner.js";

export async function listWorkspaceFiles(baseDir, options = undefined) {
  if (!baseDir) {
    return [];
  }
  const scanResult =
    options?.scanResult ??
    (await scanWorkspace(baseDir, {
      ignoredDirs: options?.ignoredDirs ?? DEFAULT_IGNORED_DIRS,
      maxDepth: options?.maxDepth,
      maxEntries: options?.maxEntries,
    }));
  return filterWorkspaceFiles(scanResult.files, {
    skipFiles: options?.skipFiles ?? DEFAULT_SKIP_FILES,
  });
}

export async function collectManifestSummary(baseDir, options = undefined) {
  if (!baseDir) {
    return { files: [], manifest: [] };
  }
  let files = [];
  if (Array.isArray(options?.files)) {
    files = filterWorkspaceFiles(options.files, {
      skipFiles: options?.skipFiles ?? DEFAULT_SKIP_FILES,
    });
  } else if (Array.isArray(options?.scanResult?.files)) {
    files = filterWorkspaceFiles(options.scanResult.files, {
      skipFiles: options?.skipFiles ?? DEFAULT_SKIP_FILES,
    });
  } else {
    files = await listWorkspaceFiles(baseDir, options);
  }
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

export function buildPromptTemplateBlock(templates, options = undefined) {
  if (!Array.isArray(templates) || templates.length === 0) {
    return "";
  }
  const limit = Math.max(1, options?.limit ?? 4);
  const selected = templates.slice(0, limit);
  const lines = ["Prompt templates available for reuse:"];
  selected.forEach((template) => {
    const parts = [`- ${template.label ?? template.id ?? "prompt"}`];
    if (template.schemaId) {
      parts.push(`schema=${template.schemaId}`);
    }
    if (template.baseline) {
      parts.push(`baseline=${template.baseline}`);
    }
    if (template.workspaceType) {
      parts.push(`workspace=${template.workspaceType}`);
    }
    if (template.source) {
      parts.push(`source=${template.source}`);
    }
    if (template.createdAt) {
      parts.push(`saved ${template.createdAt}`);
    }
    lines.push(parts.join(" | "));
  });
  if (templates.length > selected.length) {
    lines.push(`- ... ${templates.length - selected.length} more template${templates.length - selected.length === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

export function buildPromptCompositionBlock(compositions, options = undefined) {
  if (!Array.isArray(compositions) || compositions.length === 0) {
    return "";
  }
  const limit = Math.max(1, options?.limit ?? 6);
  const selected = compositions.slice(0, limit);
  const lines = ["Recent prompt/command compositions:"];
  selected.forEach((entry) => {
    const parts = [];
    if (entry.schemaId) {
      parts.push(entry.schemaId);
    }
    if (entry.mode) {
      parts.push(entry.mode);
    }
    if (entry.command) {
      parts.push(`cmd: ${entry.command}`);
    } else if (entry.task) {
      parts.push(`task: ${entry.task}`);
    }
    if (Number.isFinite(entry.contextBudget)) {
      parts.push(`ctx<=${Math.round(entry.contextBudget)}`);
    }
    if (entry.workspaceType) {
      parts.push(`workspace: ${entry.workspaceType}`);
    }
    const statusLabel =
      entry.status === "fallback"
        ? "fallback"
        : entry.status === "invalid"
          ? "retired"
          : "ok";
    parts.push(statusLabel);
    lines.push(`- ${parts.join(" | ")}`);
  });
  if (compositions.length > selected.length) {
    lines.push(
      `- ... ${compositions.length - selected.length} more composition${compositions.length - selected.length === 1 ? "" : "s"}`,
    );
  }
  return lines.join("\n");
}

export { DEFAULT_IGNORED_DIRS };
