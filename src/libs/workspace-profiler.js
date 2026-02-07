import fs from "fs";
import path from "path";
import FileConnectionAnalyzer from "./file-connection-analyzer.js";
import {
  DEFAULT_IGNORED_DIRS,
  normalizeScanSet,
  resolveWorkspaceScanSync,
} from "./workspace-scanner.js";

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

const DATA_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".json",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".xml",
  ".db",
  ".sqlite",
  ".sql",
  ".parquet",
  ".feather",
  ".arrow",
  ".xls",
  ".xlsx",
  ".sav",
  ".sas7bdat",
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
    this.ignoredDirs = normalizeScanSet(options?.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
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
  describe(rootDir, options = undefined) {
    const root = path.resolve(rootDir ?? process.cwd());
    if (!fs.existsSync(root)) {
      throw new Error(`Workspace root not found: ${root}`);
    }
    const scanResult = this._resolveScan(root, options);
    const { stats, highlights } = this._summarizeScan(scanResult);
    const classification = this._classify(stats);
    const summary = this._formatSummary(root, stats, highlights, classification);
    const directives = this._formatDirectives(classification);
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
      directives,
      connections,
      connectionSummary: connections?.summary ?? null,
      connectionGraphic: connections?.graph ?? null,
    };
  }

  _resolveScan(root, options = undefined) {
    return resolveWorkspaceScanSync(root, {
      ignoredDirs: this.ignoredDirs,
      scanResult: options?.scanResult,
      scanCache: options?.scanCache,
    });
  }

  _summarizeScan(scanResult) {
    const stats = {
      files: 0,
      directories: 0,
      codeFiles: 0,
      docFiles: 0,
      dataFiles: 0,
      otherFiles: 0,
      chapterLikeFiles: [],
    };
    const highlights = {
      directories: [],
      codeFiles: [],
      docFiles: [],
      dataFiles: [],
      otherFiles: [],
      chapters: [],
    };
    const entries = Array.isArray(scanResult?.entries) ? scanResult.entries : [];
    const maxDepth = Number.isFinite(this.maxDepth) ? this.maxDepth : Number.POSITIVE_INFINITY;
    const maxFiles = Number.isFinite(this.maxEntries)
      ? this.maxEntries
      : Number.POSITIVE_INFINITY;
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string") {
        continue;
      }
      const depth =
        Number.isFinite(entry.depth) && entry.depth >= 0
          ? entry.depth
          : this._calculateDepth(entry.path);
      if (entry.type === "dir") {
        if (depth > maxDepth + 1) {
          continue;
        }
        stats.directories += 1;
        if (highlights.directories.length < this.sampleLimit) {
          highlights.directories.push(entry.path);
        }
        continue;
      }
      if (entry.type !== "file") {
        continue;
      }
      if (depth > maxDepth) {
        continue;
      }
      stats.files += 1;
      const ext = path.extname(entry.path).toLowerCase();
      const basename = path.basename(entry.path).toLowerCase();
      if (DOC_EXTENSIONS.has(ext)) {
        stats.docFiles += 1;
        if (highlights.docFiles.length < this.sampleLimit) {
          highlights.docFiles.push(entry.path);
        }
        if (/chapter|preface|appendix|epilogue/.test(basename)) {
          stats.chapterLikeFiles.push(entry.path);
          if (highlights.chapters.length < this.sampleLimit) {
            highlights.chapters.push(entry.path);
          }
        }
      } else if (DATA_EXTENSIONS.has(ext)) {
        stats.dataFiles += 1;
        if (highlights.dataFiles.length < this.sampleLimit) {
          highlights.dataFiles.push(entry.path);
        }
      } else if (CODE_EXTENSIONS.has(ext)) {
        stats.codeFiles += 1;
        if (highlights.codeFiles.length < this.sampleLimit) {
          highlights.codeFiles.push(entry.path);
        }
      } else {
        stats.otherFiles += 1;
        if (highlights.otherFiles.length < this.sampleLimit) {
          highlights.otherFiles.push(entry.path);
        }
      }
      if (stats.files >= maxFiles) {
        break;
      }
    }
    return { stats, highlights };
  }

  _calculateDepth(relativePath) {
    if (!relativePath) {
      return 0;
    }
    const normalized = relativePath.replace(/\\/g, "/");
    return normalized.split("/").length - 1;
  }

  _classify(stats) {
    const totalFiles = Math.max(1, stats.files);
    const docRatio = stats.docFiles / totalFiles;
    const codeRatio = stats.codeFiles / totalFiles;
    const dataRatio = stats.dataFiles / totalFiles;
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

    if (dataRatio >= 0.5 && stats.dataFiles >= 4) {
      return {
        domain: "data",
        label: "Data-centric workspace",
        note: "Structured data files (CSV/JSON/parquet/etc.) dominate the repository.",
        actions: [
          "Propose chunk-friendly helpers for slicing/aggregating datasets instead of editing code blindly",
          "Respect large-file immutability; create derived data or summaries under tmp/output folders",
          "Prefer decomposer prompts tailored to dataset exploration (schemas, sampling, summarization)",
        ],
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

  _formatSummary(root, stats, highlights, classification) {
    const lines = [
      `- Root: ${root}`,
      `- Workspace type: ${classification.label}`,
      `- File makeup: ${stats.docFiles} docs, ${stats.codeFiles} code, ${stats.dataFiles} data, ${stats.otherFiles} other (scanned ${stats.files} files, ${stats.directories} directories)`,
    ];
    if (highlights.chapters.length) {
      lines.push(`- Chapter-like docs: ${highlights.chapters.join(", ")}`);
    } else if (highlights.docFiles.length) {
      lines.push(`- Example docs: ${highlights.docFiles.join(", ")}`);
    }
    if (highlights.dataFiles.length) {
      lines.push(`- Example datasets: ${highlights.dataFiles.join(", ")}`);
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

  _formatDirectives(classification) {
    const actions = Array.isArray(classification?.actions) ? classification.actions : [];
    const label = classification?.label ?? classification?.domain ?? "workspace";
    if (!actions.length) {
      return `${label}: operate conservatively; clarify goals before changing files.`;
    }
    return `${label}: ${actions.join("; ")}`;
  }
}
