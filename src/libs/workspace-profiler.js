import fs from "fs";
import path from "path";
import FileConnectionAnalyzer from "./file-connection-analyzer.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".cs",
  ".go",
  ".rb",
  ".rs",
  ".php",
  ".scala",
  ".swift",
  ".kt",
  ".kts",
  ".m",
  ".mm",
  ".pl",
  ".sh",
  ".ps1",
  ".bat",
  ".sql",
  ".lua",
]);

const DOC_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".adoc",
  ".rst",
  ".txt",
  ".tex",
  ".org",
  ".rtf",
]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
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

/**
 * Provides lightweight workspace profiling so MiniPhi can reason about different project types
 * (codebases, documentation hubs, book-like markdown directories, etc.) before it prompts Phi-4.
 */
export default class WorkspaceProfiler {
  constructor(options = undefined) {
    this.maxEntries = options?.maxEntries ?? 500;
    this.maxDepth = options?.maxDepth ?? 2;
    this.sampleLimit = options?.sampleLimit ?? 8;
    this.includeConnections = options?.includeConnections ?? true;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.connectionAnalyzer =
      options?.connectionAnalyzer ??
      new FileConnectionAnalyzer({
        logger: this.logger,
      });
  }

  /**
   * Generates a structured profile for the target directory.
   * @param {string} rootDir
   * @returns {{ root: string, stats: object, classification: object, highlights: object, summary: string }}
   */
  describe(rootDir) {
    const root = path.resolve(rootDir ?? process.cwd());
    if (!fs.existsSync(root)) {
      throw new Error(`Workspace root not found: ${root}`);
    }
    const stats = {
      files: 0,
      directories: 0,
      codeFiles: 0,
      docFiles: 0,
      otherFiles: 0,
      chapterLikeFiles: [],
    };
    const highlights = {
      directories: [],
      codeFiles: [],
      docFiles: [],
      otherFiles: [],
      chapters: [],
    };

    const queue = [{ dir: root, depth: 0 }];
    const visited = new Set();

    while (queue.length > 0 && stats.files < this.maxEntries) {
      const current = queue.shift();
      if (!current) break;
      if (visited.has(current.dir)) continue;
      visited.add(current.dir);

      let entries = [];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current.dir, entry.name);
        const relative = path.relative(root, fullPath) || entry.name;
        if (entry.isDirectory()) {
          stats.directories += 1;
          if (highlights.directories.length < this.sampleLimit) {
            highlights.directories.push(relative);
          }
          if (current.depth + 1 <= this.maxDepth && !this.#shouldSkipDirectory(entry.name)) {
            queue.push({ dir: fullPath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        stats.files += 1;
        const ext = path.extname(entry.name).toLowerCase();
        const normalized = entry.name.toLowerCase();
        if (DOC_EXTENSIONS.has(ext)) {
          stats.docFiles += 1;
          if (highlights.docFiles.length < this.sampleLimit) {
            highlights.docFiles.push(relative);
          }
          if (/chapter|preface|appendix|epilogue/.test(normalized)) {
            stats.chapterLikeFiles.push(relative);
            if (highlights.chapters.length < this.sampleLimit) {
              highlights.chapters.push(relative);
            }
          }
        } else if (CODE_EXTENSIONS.has(ext)) {
          stats.codeFiles += 1;
          if (highlights.codeFiles.length < this.sampleLimit) {
            highlights.codeFiles.push(relative);
          }
        } else {
          stats.otherFiles += 1;
          if (highlights.otherFiles.length < this.sampleLimit) {
            highlights.otherFiles.push(relative);
          }
        }

        if (stats.files >= this.maxEntries) {
          break;
        }
      }
    }

    const classification = this.#classify(stats);
    const summary = this.#formatSummary(root, stats, highlights, classification);
    let connections = null;
    if (this.includeConnections && stats.codeFiles > 0 && this.connectionAnalyzer) {
      try {
        connections = this.connectionAnalyzer.analyze(root);
      } catch (error) {
        if (this.logger) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger(`[WorkspaceProfiler] File connection analysis failed: ${message}`);
        }
      }
    }

    return {
      root,
      stats,
      highlights,
      classification,
      summary,
      connections,
      connectionSummary: connections?.summary ?? null,
      connectionGraphic: connections?.graph ?? null,
    };
  }

  #shouldSkipDirectory(name) {
    const normalized = name.toLowerCase();
    if (IGNORED_DIRECTORIES.has(normalized)) {
      return true;
    }
    return normalized.startsWith(".");
  }

  #classify(stats) {
    const totalFiles = Math.max(1, stats.files);
    const docRatio = stats.docFiles / totalFiles;
    const codeRatio = stats.codeFiles / totalFiles;
    const hasChapters = stats.chapterLikeFiles.length >= 2;

    if (docRatio >= 0.55 && stats.docFiles >= 5) {
      const label = hasChapters ? "Book-like markdown workspace" : "Documentation-focused workspace";
      const actions = hasChapters
        ? [
            "Synthesize or revise chapters cohesively",
            "Add new sections/chapters using the book outline",
            "Respect narrative flow and cross references",
          ]
        : [
            "Edit and expand existing documents",
            "Generate new content aligned with the docs folder structure",
          ];
      return {
        domain: hasChapters ? "book" : "docs",
        label,
        note: hasChapters ? "Multiple markdown files contain chapter-related naming." : "Markdown/text files dominate.",
        actions,
      };
    }

    if (codeRatio >= 0.5 && stats.codeFiles >= 5) {
      return {
        domain: "code",
        label: "Source-code heavy workspace",
        note: "Code files are the dominant artifact type.",
        actions: [
          "Perform code-level reasoning, diagnostics, or edits",
          "Respect language-specific tooling and folder conventions",
        ],
      };
    }

    return {
      domain: "mixed",
      label: "Mixed workspace (code + docs)",
      note: "No single artifact type dominates. Balance documentation and code changes.",
      actions: [
        "Decide whether to operate on docs or code depending on the prompt",
        "Coordinate updates across both representations when needed",
      ],
    };
  }

  #formatSummary(root, stats, highlights, classification) {
    const lines = [
      `- Root: ${root}`,
      `- Workspace type: ${classification.label}`,
      `- File makeup: ${stats.docFiles} docs, ${stats.codeFiles} code, ${stats.otherFiles} other (scanned ${stats.files} files, ${stats.directories} directories)`,
    ];
    if (highlights.chapters.length) {
      lines.push(`- Chapter-like docs: ${highlights.chapters.join(", ")}`);
    } else if (highlights.docFiles.length) {
      lines.push(`- Example docs: ${highlights.docFiles.join(", ")}`);
    }
    if (highlights.codeFiles.length) {
      lines.push(`- Example code: ${highlights.codeFiles.join(", ")}`);
    }
    if (highlights.directories.length) {
      lines.push(`- Key folders: ${highlights.directories.join(", ")}`);
    }
    if (classification.note) {
      lines.push(`- Clues: ${classification.note}`);
    }
    if (classification.actions?.length) {
      lines.push(`- Suggested focus: ${classification.actions.join("; ")}`);
    }
    return lines.join("\n");
  }
}
