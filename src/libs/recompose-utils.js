import path from "path";

export function relativeToCwd(target, cwd = process.cwd()) {
  if (!target) {
    return null;
  }
  const relative = path.relative(cwd, target);
  if (relative && !relative.startsWith("..")) {
    return relative.replace(/\\/g, "/");
  }
  return target;
}

export function slugify(text) {
  const normalized = (text ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "recompose";
}

export function safeSessionName(relativePath) {
  return relativePath.replace(/[\\/]+/g, "__");
}

export function sanitizeExportName(name, fallbackLabel = "recompose") {
  const fallback = `${slugify(fallbackLabel)}.prompts.log`;
  if (!name) {
    return fallback;
  }
  const normalized = name
    .replace(/[\\/]+/g, "-")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .trim();
  if (!normalized) {
    return fallback;
  }
  if (!normalized.toLowerCase().endsWith(".log")) {
    return `${normalized}.log`;
  }
  return normalized;
}

export function normalizeExportName(name) {
  if (!name) {
    return "offlineStub";
  }
  const sanitized = name.replace(/[^\w]/g, "_");
  return sanitized || "offlineStub";
}

export function languageFromExtension(ext) {
  switch (ext.toLowerCase()) {
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".java":
      return "java";
    case ".cs":
      return "csharp";
    case ".cpp":
    case ".cc":
    case ".cxx":
      return "cpp";
    case ".c":
      return "c";
    case ".h":
    case ".hpp":
      return "c";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".sh":
      return "bash";
    case ".ps1":
      return "powershell";
    case ".md":
      return "markdown";
    case ".json":
      return "json";
    case ".html":
      return "html";
    case ".css":
    case ".scss":
    case ".less":
      return "css";
    default:
      return "text";
  }
}

export function parseMarkdown(raw) {
  if (!raw) {
    return { metadata: {}, body: "" };
  }
  let body = raw;
  const metadata = {};
  const frontMatterMatch = raw.match(/^---\s*[\r\n]+([\s\S]*?)\r?\n---\s*/);
  if (frontMatterMatch) {
    frontMatterMatch[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
          return;
        }
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        metadata[key] = value;
      });
    body = raw.slice(frontMatterMatch[0].length);
  }
  return { metadata, body: body.trim() };
}
