import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".rb",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".rs",
  ".go",
  ".sh",
  ".bat",
  ".ps1",
  ".txt",
]);

export default class RecomposeTester {
  constructor(options = {}) {
    this.ignoredDirs = new Set(options.ignoredDirs ?? ["node_modules", ".git"]);
  }

  async run(options = {}) {
    const direction = (options.direction ?? "roundtrip").toLowerCase();
    if (!["code-to-markdown", "markdown-to-code", "roundtrip"].includes(direction)) {
      throw new Error(`Unsupported recompose direction "${direction}".`);
    }
    const sampleDir = options.sampleDir ? path.resolve(options.sampleDir) : null;
    if (!sampleDir && (!options.codeDir || !options.descriptionsDir || !options.outputDir)) {
      throw new Error(
        "Recompose tests require --sample <dir> or explicit --code-dir, --descriptions-dir, and --output-dir.",
      );
    }

    const resolvePath = (value, fallbackName) => {
      if (value) {
        return path.resolve(sampleDir ?? "", value);
      }
      if (!sampleDir) {
        throw new Error(`Missing --${fallbackName} when no --sample directory is provided.`);
      }
      return path.resolve(sampleDir, fallbackName === "code-dir"
        ? "code"
        : fallbackName === "descriptions-dir"
          ? "descriptions"
          : "reconstructed");
    };

    const codeDir = resolvePath(options.codeDir, "code-dir");
    const descriptionsDir = resolvePath(options.descriptionsDir, "descriptions-dir");
    const outputDir = resolvePath(options.outputDir, "output-dir");

    if (["code-to-markdown", "roundtrip"].includes(direction)) {
      await this.#assertDirectory(codeDir, "code");
    }
    if (["markdown-to-code", "roundtrip"].includes(direction)) {
      await this.#assertDirectory(descriptionsDir, "descriptions");
    }

    if (options.clean && ["code-to-markdown", "roundtrip"].includes(direction)) {
      await this.#cleanDir(descriptionsDir);
    }
    if (options.clean && ["markdown-to-code", "roundtrip"].includes(direction)) {
      await this.#cleanDir(outputDir);
    }

    const steps = [];
    if (direction === "code-to-markdown" || direction === "roundtrip") {
      steps.push(await this.codeToMarkdown({ sourceDir: codeDir, targetDir: descriptionsDir }));
    }
    if (direction === "markdown-to-code" || direction === "roundtrip") {
      steps.push(await this.markdownToCode({ sourceDir: descriptionsDir, targetDir: outputDir }));
    }
    if (direction === "roundtrip") {
      steps.push(await this.compareDirectories({ baselineDir: codeDir, candidateDir: outputDir }));
    }

    return {
      direction,
      sampleDir: this.#relativeToCwd(sampleDir),
      codeDir: this.#relativeToCwd(codeDir),
      descriptionsDir: this.#relativeToCwd(descriptionsDir),
      outputDir: this.#relativeToCwd(outputDir),
      steps,
      generatedAt: new Date().toISOString(),
    };
  }

  async codeToMarkdown({ sourceDir, targetDir }) {
    const start = Date.now();
    const files = await this.#listFiles(sourceDir);
    let converted = 0;
    let skipped = 0;
    for (const relativePath of files) {
      const absolute = path.join(sourceDir, relativePath);
      if (await this.#isBinary(absolute)) {
        skipped += 1;
        continue;
      }
      const content = await fs.promises.readFile(absolute, "utf8");
      const language = this.#languageFromExtension(path.extname(relativePath));
      const markdown = this.#renderMarkdown({
        sourcePath: relativePath,
        language,
        content,
      });
      const target = path.join(targetDir, `${relativePath}.md`);
      await this.#ensureDir(path.dirname(target));
      await fs.promises.writeFile(target, markdown, "utf8");
      converted += 1;
    }
    return {
      phase: "code-to-markdown",
      durationMs: Date.now() - start,
      discovered: files.length,
      converted,
      skipped,
      outputDir: this.#relativeToCwd(targetDir),
    };
  }

  async markdownToCode({ sourceDir, targetDir }) {
    const start = Date.now();
    const files = await this.#listFiles(sourceDir);
    let converted = 0;
    const warnings = [];
    const markdownFiles = files.filter((file) => file.toLowerCase().endsWith(".md"));
    for (const relativePath of markdownFiles) {
      const absolute = path.join(sourceDir, relativePath);
      const raw = await fs.promises.readFile(absolute, "utf8");
      const { metadata, code } = this.#parseMarkdown(raw);
      if (!code) {
        warnings.push({ path: relativePath, reason: "missing code block" });
        continue;
      }
      const targetPathRelative =
        metadata.source ?? relativePath.replace(/\.md$/i, "").replace(/\\/g, "/");
      const targetPath = path.join(targetDir, targetPathRelative);
      await this.#ensureDir(path.dirname(targetPath));
      await fs.promises.writeFile(targetPath, `${code.replace(/\s+$/, "")}\n`, "utf8");
      converted += 1;
    }
    return {
      phase: "markdown-to-code",
      durationMs: Date.now() - start,
      processed: markdownFiles.length,
      converted,
      skipped: markdownFiles.length - converted,
      outputDir: this.#relativeToCwd(targetDir),
      warnings,
    };
  }

  async compareDirectories({ baselineDir, candidateDir }) {
    const start = Date.now();
    const baselineFiles = await this.#listFiles(baselineDir);
    const candidateFiles = await this.#listFiles(candidateDir);

    const baselineMap = new Map(baselineFiles.map((rel) => [rel, path.join(baselineDir, rel)]));
    const candidateMap = new Map(candidateFiles.map((rel) => [rel, path.join(candidateDir, rel)]));

    const matches = [];
    const mismatches = [];
    const missing = [];

    for (const [relative, baselinePath] of baselineMap) {
      const candidatePath = candidateMap.get(relative);
      if (!candidatePath) {
        missing.push(relative);
        continue;
      }
      const baselineHash = await this.#hashFile(baselinePath);
      const candidateHash = await this.#hashFile(candidatePath);
      if (baselineHash === candidateHash) {
        matches.push(relative);
      } else {
        mismatches.push({
          path: relative,
          baselineHash,
          candidateHash,
        });
      }
      candidateMap.delete(relative);
    }

    const extras = Array.from(candidateMap.keys());

    return {
      phase: "comparison",
      durationMs: Date.now() - start,
      matches: matches.length,
      mismatches,
      missing,
      extras,
    };
  }

  async #listFiles(baseDir) {
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
          if (this.ignoredDirs.has(dirent.name)) {
            continue;
          }
          stack.push(relPath);
        } else if (dirent.isFile()) {
          if (dirent.name === ".gitkeep") {
            continue;
          }
          files.push(relPath.replace(/\\/g, "/"));
        }
      }
    }
    files.sort();
    return files;
  }

  async #isBinary(filePath) {
    const handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(8192);
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 0) {
          return true;
        }
      }
      if (bytesRead === 0 && !TEXT_EXTENSIONS.has(path.extname(filePath))) {
        return true;
      }
    } finally {
      await handle.close();
    }
    return false;
  }

  #languageFromExtension(extension) {
    const normalized = extension.toLowerCase();
    switch (normalized) {
      case ".js":
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

  #renderMarkdown({ sourcePath, language, content }) {
    const normalizedContent = content.replace(/\r\n/g, "\n");
    const hash = createHash("sha256").update(normalizedContent, "utf8").digest("hex");
    return [
      "---",
      `source: ${sourcePath}`,
      `language: ${language}`,
      `generatedAt: ${new Date().toISOString()}`,
      `sha256: ${hash}`,
      "---",
      "",
      `# File: ${sourcePath}`,
      "",
      `\`\`\`${language}`,
      normalizedContent,
      "```",
      "",
    ].join("\n");
  }

  #parseMarkdown(raw) {
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
    const codeMatch = body.match(/```[a-z0-9+-]*\s*\r?\n([\s\S]*?)```/i);
    return {
      metadata,
      code: codeMatch ? codeMatch[1] : null,
    };
  }

  async #hashFile(filePath) {
    const content = await fs.promises.readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  }

  async #ensureDir(dirPath) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  async #cleanDir(targetDir) {
    await fs.promises.rm(targetDir, { recursive: true, force: true });
  }

  async #assertDirectory(dirPath, label) {
    try {
      const stats = await fs.promises.stat(dirPath);
      if (!stats.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error(`Missing ${label} directory: ${dirPath}`);
    }
  }

  #relativeToCwd(target) {
    if (!target) {
      return null;
    }
    const relative = path.relative(process.cwd(), target);
    if (relative && !relative.startsWith("..")) {
      return relative.replace(/\\/g, "/");
    }
    return target;
  }
}
