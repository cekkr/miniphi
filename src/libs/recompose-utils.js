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

export function normalizeWhitespace(text) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export function sanitizeNarrative(text) {
  if (!text) {
    return "";
  }
  let sanitized = text.replace(/```[\s\S]*?```/g, (block) => {
    const lines = block.split(/\r?\n/).length - 2;
    return `> [omitted ${Math.max(lines, 1)} lines of code]\n`;
  });
  sanitized = sanitized.replace(/`([^`]+)`/g, "$1");
  return sanitized.replace(/\r\n/g, "\n").trim();
}

export function structureNarrative(text, label, fallbackFactory = null) {
  const trimmed = text?.trim();
  if (!trimmed) {
    return fallbackFactory ? fallbackFactory() : `## Overview\n${label} narrative unavailable.`;
  }
  if (/##\s+/.test(trimmed)) {
    return trimmed;
  }
  const paragraphs = trimmed.split(/\n{2,}/).filter(Boolean);
  const headings = ["Overview", "Flow", "Signals", "Edge Cases"];
  return paragraphs
    .map((para, index) => `## ${headings[index] ?? `Detail ${index + 1}`}\n${para}`)
    .join("\n\n");
}

export function extractImports(lines) {
  const matches = [];
  const regex = /import\s+[^;]+from\s+["'](.+?)["']/g;
  for (const line of lines) {
    let match;
    while ((match = regex.exec(line))) {
      matches.push(match[1]);
    }
  }
  return Array.from(new Set(matches));
}

export function extractExports(lines) {
  const exports = new Set();
  const patterns = [
    /export\s+function\s+([a-zA-Z0-9_]+)/g,
    /export\s+const\s+([a-zA-Z0-9_]+)/g,
    /export\s+class\s+([a-zA-Z0-9_]+)/g,
    /module\.exports\s*=\s*{([^}]+)}/g,
  ];
  lines.forEach((line) => {
    patterns.forEach((regex) => {
      let match;
      while ((match = regex.exec(line))) {
        if (match[1]) {
          match[1]
            .split(",")
            .map((token) => token.trim())
            .filter(Boolean)
            .forEach((token) => exports.add(token));
        }
      }
    });
  });
  return Array.from(exports);
}

export function extractClasses(lines) {
  const regex = /class\s+([a-zA-Z0-9_]+)/g;
  const classes = new Set();
  lines.forEach((line) => {
    let match;
    while ((match = regex.exec(line))) {
      classes.add(match[1]);
    }
  });
  return Array.from(classes);
}

export function summarizeList(items, limit = 5) {
  if (!items.length) {
    return "none";
  }
  const unique = Array.from(new Set(items));
  if (unique.length <= limit) {
    return unique.join(", ");
  }
  const prefix = unique.slice(0, limit).join(", ");
  return `${prefix}, and ${unique.length - limit} more`;
}

export function detectExportStyle(source) {
  if (!source) {
    return null;
  }
  if (/module\.exports|exports\./.test(source)) {
    return "commonjs";
  }
  if (/export\s+(const|function|class|default)/.test(source)) {
    return "esm";
  }
  return null;
}

export function hasDefaultExport(source) {
  if (!source) {
    return false;
  }
  return /export\s+default\s+/m.test(source);
}

export function codeContainsIdentifier(source, identifier) {
  if (!source || !identifier) {
    return false;
  }
  const pattern = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return pattern.test(source);
}

export function normalizeSnippetLabel(label) {
  if (!label) {
    return "";
  }
  return label.toString().trim().replace(/^['"]|['"]$/g, "");
}

export function truncateBlock(text, limit = 1400) {
  const normalized = (text ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

export function truncateLine(text, max = 160) {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

export function summarizeDiff(baseline, candidate) {
  if (!baseline && !candidate) {
    return null;
  }
  const a = (baseline ?? "").split(/\r?\n/);
  const b = (candidate ?? "").split(/\r?\n/);
  const limit = Math.min(Math.max(a.length, b.length), 400);
  const output = [];
  for (let i = 0; i < limit && output.length < 80; i += 1) {
    const left = a[i] ?? "";
    const right = b[i] ?? "";
    if (left === right) {
      continue;
    }
    output.push(`- [${i + 1}] ${truncateLine(left)}`);
    output.push(`+ [${i + 1}] ${truncateLine(right)}`);
  }
  return output.length ? output.join("\n") : null;
}
