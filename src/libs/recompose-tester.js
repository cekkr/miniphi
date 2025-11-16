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

const MAX_OVERVIEW_FILES = 24;
const MAX_SNIPPET_CHARS = 1500;
const WORKSPACE_OVERVIEW_FILE = "workspace-overview.md";
const LOG_SNIPPET_LIMIT = 800;

export default class RecomposeTester {
  constructor(options = {}) {
    this.ignoredDirs = new Set(options.ignoredDirs ?? ["node_modules", ".git"]);
    this.phi4 = options.phi4 ?? null;
    this.sessionRoot = options.sessionRoot ?? path.join(process.cwd(), ".miniphi", "recompose");
    this.promptLabel = options.promptLabel ?? "recompose";
    this.verboseLogging = Boolean(options.verboseLogging);
    this.workspaceContext = null;
    this.sessionDir = null;
    this.sessionLabel = null;
    this.promptLogPath = null;
  }

  async run(options = {}) {
    const direction = (options.direction ?? "roundtrip").toLowerCase();
    if (!["code-to-markdown", "markdown-to-code", "roundtrip"].includes(direction)) {
      throw new Error(`Unsupported recompose direction "${direction}".`);
    }

    this.#requirePhi();
    if (typeof this.phi4?.clearHistory === "function") {
      this.phi4.clearHistory();
    }
    await this.#startSession(options.sessionLabel ?? this.promptLabel);

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
      return path.resolve(
        sampleDir,
        fallbackName === "code-dir"
          ? "code"
          : fallbackName === "descriptions-dir"
            ? "descriptions"
            : "reconstructed",
      );
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
      sessionDir: this.#relativeToCwd(this.sessionDir),
      promptLog: this.#relativeToCwd(this.promptLogPath),
      workspaceContext: this.workspaceContext,
      sessionLabel: this.sessionLabel,
      generatedAt: new Date().toISOString(),
    };
  }

  async codeToMarkdown({ sourceDir, targetDir }) {
    const start = Date.now();
    const files = await this.#listFiles(sourceDir);
    const workspaceSummary = await this.#ensureWorkspaceSummaryFromCode(sourceDir, files);
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
      const narrativeMarkdown = await this.#narrateSourceFile({
        relativePath,
        language,
        content,
        workspaceSummary,
      });
      const target = path.join(targetDir, `${relativePath}.md`);
      await this.#ensureDir(path.dirname(target));
      await fs.promises.writeFile(target, narrativeMarkdown, "utf8");
      converted += 1;
    }
    return {
      phase: "code-to-markdown",
      durationMs: Date.now() - start,
      discovered: files.length,
      converted,
      skipped,
      descriptionsDir: this.#relativeToCwd(targetDir),
    };
  }

  async markdownToCode({ sourceDir, targetDir }) {
    const start = Date.now();
    const files = (await this.#listFiles(sourceDir)).filter((file) => file.toLowerCase().endsWith(".md"));
    const workspaceSummary = await this.#ensureWorkspaceSummaryFromDescriptions(sourceDir, files);
    let converted = 0;
    const warnings = [];

    for (const relativePath of files) {
      const absolute = path.join(sourceDir, relativePath);
      const raw = await fs.promises.readFile(absolute, "utf8");
      const { metadata, body } = this.#parseMarkdown(raw);
      const narrative = body.trim();
      if (!narrative) {
        warnings.push({ path: relativePath, reason: "missing narrative content" });
        continue;
      }
      const targetPathRelative =
        metadata.source ?? relativePath.replace(/\.md$/i, "").replace(/\\/g, "/");
      const language = metadata.language ?? this.#languageFromExtension(path.extname(targetPathRelative));
      try {
        const plan = await this.#planCodeFromNarrative({
          relativePath: targetPathRelative,
          narrative,
          workspaceSummary,
        });
        const code = await this.#generateSourceFromPlan({
          relativePath: targetPathRelative,
          plan,
          narrative,
          language,
        });
        const targetPath = path.join(targetDir, targetPathRelative);
        await this.#ensureDir(path.dirname(targetPath));
        await fs.promises.writeFile(targetPath, `${code.replace(/\s+$/, "")}\n`, "utf8");
        converted += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push({ path: relativePath, reason });
      }
    }

    return {
      phase: "markdown-to-code",
      durationMs: Date.now() - start,
      processed: files.length,
      converted,
      skipped: files.length - converted,
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

  async #narrateSourceFile({ relativePath, language, content, workspaceSummary }) {
    const normalizedContent = content.replace(/\r\n/g, "\n");
    const sourceHash = createHash("sha256").update(normalizedContent, "utf8").digest("hex");
    const prompt = [
      "You are documenting a source file for the MiniPhi recomposition benchmark.",
      "Convert the code into a multi-section narrative that describes intent, data flow, and error handling.",
      "Use at least three markdown headings (##) and no fenced code blocks. Inline code should be rewritten as plain language.",
      "Explain behavior as a story the reader must mentally reassemble into code.",
      `Workspace overview:\n${workspaceSummary}\n`,
      `Describe the file (${relativePath}) written in ${language}.`,
      "Raw source follows:",
      `"""`,
      normalizedContent.slice(0, MAX_SNIPPET_CHARS * 4),
      `"""`,
    ].join("\n\n");

    const response = await this.#promptPhi(prompt, {
      label: "recompose:file-narrative",
      metadata: { file: relativePath },
    });
    const structured = this.#structureNarrative(this.#sanitizeNarrative(response), relativePath, () =>
      this.#fallbackFileNarrative({
        relativePath,
        language,
        content: normalizedContent,
      }),
    );
    const document = [
      "---",
      `source: ${relativePath}`,
      `language: ${language}`,
      `generatedAt: ${new Date().toISOString()}`,
      `sha256: ${sourceHash}`,
      "---",
      "",
      structured,
      "",
    ].join("\n");
    await this.#writeSessionAsset(
      path.join("files", `${this.#safeSessionName(relativePath)}.md`),
      `# Narrative for ${relativePath}\n\n${structured}\n`,
    );
    return document;
  }

  async #planCodeFromNarrative({ relativePath, narrative, workspaceSummary }) {
    const prompt = [
      "You previously helped convert code into prose for a secure recomposition test.",
      "Given the narrative description, outline the concrete implementation strategy.",
      "Describe the modules, helper functions, and edge cases that must exist.",
      "Return markdown with headings for Inputs, Transformations, Outputs, and Failure Modes. Do not write code.",
      `Workspace overview:\n${workspaceSummary}`,
      `Narrative for ${relativePath}:\n${narrative}`,
    ].join("\n\n");
    const plan = this.#structureNarrative(
      await this.#promptPhi(prompt, {
        label: "recompose:file-plan",
        metadata: { file: relativePath },
      }),
      relativePath,
      () => this.#fallbackPlanFromNarrative(relativePath, narrative),
    );
    await this.#writeSessionAsset(
      path.join("plans", `${this.#safeSessionName(relativePath)}.md`),
      `# Plan for ${relativePath}\n\n${plan}\n`,
    );
    return plan;
  }

  async #generateSourceFromPlan({ relativePath, plan, narrative, language }) {
    const prompt = [
      "You now synthesize the final source file described earlier.",
      "Use the supplied plan and narrative to rebuild the exact behavior.",
      "Respond with a single fenced code block containing only the source.",
      `Plan:`,
      plan,
      `Narrative:`,
      narrative,
      `Emit the ${language || "text"} source code for ${relativePath}.`,
    ].join("\n\n");
    const response = await this.#promptPhi(prompt, {
      label: "recompose:codegen",
      metadata: { file: relativePath, language },
    });
    const code = this.#extractCodeFromResponse(response);
    if (!code) {
      throw new Error("Phi-4 response did not include a code block.");
    }
    await this.#writeSessionAsset(
      path.join("code", `${this.#safeSessionName(relativePath)}.txt`),
      code,
    );
    return code;
  }

  async #ensureWorkspaceSummaryFromCode(sourceDir, files) {
    if (this.workspaceContext?.kind === "code" && this.workspaceContext.sourceDir === sourceDir) {
      return this.workspaceContext.summary;
    }
    const glimpses = await this.#collectGlimpses(sourceDir, files);
    const prompt = [
      "Survey the workspace and narrate the protagonist's goals.",
      "Produce sections for Architecture Rhythm, Supporting Cast, and Risk Notes.",
      "Avoid listing file names explicitly; rely on behaviors and interactions.",
      `Glimpses:\n${glimpses}`,
    ].join("\n\n");
    const summary = this.#structureNarrative(
      this.#sanitizeNarrative(await this.#promptPhi(prompt, { label: "recompose:workspace-overview" })),
      "workspace",
      () => this.#fallbackWorkspaceSummaryFromCode(files.length, glimpses),
    );
    this.workspaceContext = { kind: "code", summary, sourceDir };
    await this.#writeSessionAsset(WORKSPACE_OVERVIEW_FILE, `# Workspace Overview\n\n${summary}\n`);
    return summary;
  }

  async #ensureWorkspaceSummaryFromDescriptions(sourceDir, files) {
    if (this.workspaceContext?.summary) {
      return this.workspaceContext.summary;
    }
    const excerpts = await Promise.all(
      files.slice(0, MAX_OVERVIEW_FILES).map(async (relativePath) => {
        const absolute = path.join(sourceDir, relativePath);
        const raw = await fs.promises.readFile(absolute, "utf8");
        const { body } = this.#parseMarkdown(raw);
        return `### ${relativePath}\n${body.split(/\n+/).slice(0, 6).join("\n")}`;
      }),
    );
    const prompt = [
      "The workspace contains prose-only descriptions of code files.",
      "Summarize the project from these excerpts so Phi-4 can rebuild it.",
      `Excerpts:\n${excerpts.join("\n\n")}`,
    ].join("\n\n");
    const summary = this.#structureNarrative(
      this.#sanitizeNarrative(await this.#promptPhi(prompt, { label: "recompose:workspace-from-descriptions" })),
      "workspace",
      () => this.#fallbackWorkspaceSummaryFromDescriptions(excerpts),
    );
    this.workspaceContext = { kind: "descriptions", summary, sourceDir };
    await this.#writeSessionAsset(WORKSPACE_OVERVIEW_FILE, `# Workspace Overview\n\n${summary}\n`);
    return summary;
  }

  async #collectGlimpses(baseDir, files) {
    const glimpses = [];
    for (const relative of files) {
      if (glimpses.length >= MAX_OVERVIEW_FILES) {
        break;
      }
      const absolute = path.join(baseDir, relative);
      if (await this.#isBinary(absolute)) {
        continue;
      }
      const snippet = await this.#readSnippet(absolute);
      glimpses.push(`### ${relative}\n${snippet}`);
    }
    return glimpses.join("\n\n");
  }

  async #readSnippet(filePath) {
    const content = await fs.promises.readFile(filePath, "utf8");
    return content.replace(/\r\n/g, "\n").slice(0, MAX_SNIPPET_CHARS);
  }

  async #promptPhi(prompt, traceOptions = undefined) {
    const started = Date.now();
    let response = "";
    let error = null;
    try {
      response = await this.phi4.chatStream(prompt, undefined, undefined, undefined, {
        scope: "sub",
        label: traceOptions?.label ?? this.promptLabel,
        metadata: {
          sessionLabel: this.sessionLabel,
          workspaceSummary: this.workspaceContext?.summary ?? null,
          workspaceType: "recompose",
          ...(traceOptions?.metadata ?? {}),
        },
      });
      return response;
    } catch (err) {
      error = err;
      if (this.verboseLogging) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[MiniPhi][Recompose][Prompt] ${traceOptions?.label ?? "prompt"} failed: ${message}`);
      }
      return "";
    } finally {
      if (this.verboseLogging) {
        const durationMs = Date.now() - started;
        console.log(
          `[MiniPhi][Recompose][Prompt] ${traceOptions?.label ?? "prompt"} completed in ${durationMs} ms`,
        );
      }
      await this.#logPromptEvent({
        label: traceOptions?.label ?? this.promptLabel,
        prompt,
        response,
        error,
        metadata: traceOptions?.metadata ?? null,
        durationMs: Date.now() - started,
      });
    }
  }

  #sanitizeNarrative(text) {
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

  #structureNarrative(text, label, fallbackFactory = null) {
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

  #extractCodeFromResponse(response) {
    if (!response) {
      return null;
    }
    const match = response.match(/```[a-z0-9+-]*\s*\r?\n([\s\S]*?)```/i);
    if (match) {
      return match[1];
    }
    return null;
  }

  async #startSession(label) {
    const slug = this.#slugify(label ?? this.promptLabel ?? "recompose");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const root = this.sessionRoot ?? path.join(process.cwd(), ".miniphi", "recompose");
    this.sessionDir = path.join(root, `${timestamp}-${slug}`);
    this.sessionLabel = slug;
    this.workspaceContext = null;
    await fs.promises.mkdir(path.join(this.sessionDir, "files"), { recursive: true });
    await fs.promises.mkdir(path.join(this.sessionDir, "plans"), { recursive: true });
    await fs.promises.mkdir(path.join(this.sessionDir, "code"), { recursive: true });
    this.promptLogPath = path.join(this.sessionDir, "prompts.log");
    const header = [
      `# MiniPhi Recompose Prompt Log`,
      `Session: ${this.sessionLabel}`,
      `Created: ${new Date().toISOString()}`,
      "",
    ].join("\n");
    await fs.promises.writeFile(this.promptLogPath, `${header}`, "utf8");
  }

  async #writeSessionAsset(relativePath, content) {
    if (!this.sessionDir) {
      return null;
    }
    const target = path.join(this.sessionDir, relativePath);
    await this.#ensureDir(path.dirname(target));
    await fs.promises.writeFile(target, content, "utf8");
    return target;
  }

  #safeSessionName(relativePath) {
    return relativePath.replace(/[\\/]+/g, "__");
  }

  async #logPromptEvent({ label, prompt, response, error, metadata, durationMs }) {
    if (!this.promptLogPath) {
      return;
    }
    const lines = [
      `[${new Date().toISOString()}][${label ?? "prompt"}] ${error ? "ERROR" : "OK"} (${durationMs ?? 0} ms)`,
      metadata ? `meta: ${JSON.stringify(metadata)}` : null,
      "Prompt:",
      this.#truncateForLog(prompt),
      "Response:",
      error ? String(error instanceof Error ? error.message : error) : this.#truncateForLog(response),
      "",
    ].filter(Boolean);
    await fs.promises.appendFile(this.promptLogPath, `${lines.join("\n")}\n`, "utf8");
  }

  #truncateForLog(text) {
    if (!text) {
      return "(empty)";
    }
    const normalized = String(text).trim();
    if (normalized.length <= LOG_SNIPPET_LIMIT) {
      return normalized;
    }
    return `${normalized.slice(0, LOG_SNIPPET_LIMIT)}…`;
  }

  #fallbackFileNarrative({ relativePath, language, content }) {
    if (language === "markdown") {
      return this.#fallbackMarkdownNarrative(relativePath, content);
    }
    const lines = content.split(/\r?\n/);
    const imports = this.#extractImports(lines);
    const exports = this.#extractExports(lines);
    const classNames = this.#extractClasses(lines);
    const responsibilities = [];
    if (imports.length) {
      responsibilities.push(
        `Pulls in ${imports.length} helper${imports.length === 1 ? "" : "s"} (${this.#summarizeList(imports)}).`,
      );
    }
    if (exports.length) {
      responsibilities.push(
        `Exposes ${exports.length} exported symbol${exports.length === 1 ? "" : "s"} (${this.#summarizeList(exports)}).`,
      );
    }
    if (classNames.length) {
      responsibilities.push(`Defines class constructs such as ${this.#summarizeList(classNames)}.`);
    }
    const approxLength = lines.length;
    const structure = [
      "## Purpose",
      `The file ${relativePath} operates as a ${language} module with roughly ${approxLength} line${approxLength === 1 ? "" : "s"}.`,
      responsibilities.length ? responsibilities.join(" ") : "It focuses on orchestration and light data shaping.",
      "## Key Elements",
      imports.length ? `- Dependencies: ${this.#summarizeList(imports, 6)}` : "- Dependencies: internal-only helpers.",
      exports.length ? `- Public interface: ${this.#summarizeList(exports, 6)}` : "- Public interface: internal utilities only.",
      classNames.length ? `- Classes: ${this.#summarizeList(classNames, 4)}` : "- Classes: none, relies on functions.",
      "## Flow & Edge Cases",
      "Execution revolves around sanitizing input, coordinating helper utilities, and emitting structured results/logs. Edge cases are handled defensively (nullish names, insufficient samples, or missing state) prior to returning values.",
    ];
    return structure.join("\n\n");
  }

  #fallbackMarkdownNarrative(relativePath, content) {
    const headings = content
      .split(/\r?\n/)
      .filter((line) => /^#+\s+/.test(line))
      .map((line) => line.replace(/^#+\s+/, "").trim());
    const summaryHeadings = headings.slice(0, 4);
    const sections = [
      "## Overview",
      `The document ${relativePath} guides the reader through ${summaryHeadings.length ? summaryHeadings.join(", ") : "a short workflow"}.`,
      "## Highlights",
      summaryHeadings.length
        ? summaryHeadings.map((title) => `- ${title}`).join("\n")
        : "- Describes the hello-flow benchmark goals.\n- Explains how to run recompose commands.\n- Emphasizes narrative-only descriptions.",
      "## Outcome",
      "Readers learn why the benchmark exists, which directories participate (`code/`, `descriptions/`, `reconstructed/`), and how to trigger automated runs without exposing raw code.",
    ];
    return sections.join("\n\n");
  }

  #fallbackPlanFromNarrative(relativePath, narrative) {
    const trimmed = narrative.trim();
    const excerpt = trimmed ? trimmed.replace(/\s+/g, " ").slice(0, 400) : null;
    return [
      "## Inputs",
      `- Honor the parameters referenced in the ${relativePath} description (names, value arrays, metadata objects).`,
      "## Transformations",
      `- Follow the behaviors hinted in the narrative${excerpt ? ` (e.g., "${excerpt}")` : ""}.`,
      "## Outputs",
      "- Emit data structures and log lines described by the story (greetings, pipeline summaries, trend metadata, etc.).",
      "## Failure Modes",
      "- Validate inputs, surface descriptive warnings, and fall back to neutral defaults whenever the description mentions missing data.",
    ].join("\n\n");
  }

  #fallbackWorkspaceSummaryFromCode(fileCount, glimpses) {
    const fileNames = glimpses
      .split(/\n+/)
      .filter((line) => line.startsWith("### "))
      .map((line) => line.replace(/^###\s+/, "").trim())
      .slice(0, 6);
    return [
      "## Architecture Rhythm",
      `The workspace contains approximately ${fileCount} source files organized into flows, shared helpers, and entry points. Each module collaborates via explicit imports and emphasizes deterministic behavior for recomposition.`,
      "## Supporting Cast",
      `Narratives rely on greeters, math utilities, validation steps, and in-memory persistence to keep analytics repeatable. Representative files: ${fileNames.join(", ") || "greeter.js, math.js, flows/pipeline.js"}.`,
      "## Risk Notes",
      "Focus on keeping descriptions high level: no direct code blocks, only references to behaviors and data lifecycles. Use the story-driven approach to recreate functionality instead of copying syntax.",
    ].join("\n\n");
  }

  #fallbackWorkspaceSummaryFromDescriptions(excerpts) {
    return [
      "## Architecture Rhythm",
      "Descriptions emphasize a greeting-to-analysis journey: values are validated, normalized, summarized, then logged.",
      "## Supporting Cast",
      `Narrative excerpts referenced modules such as flows/pipeline, math helpers, and persistence. Sample excerpt:\n${excerpts[0] ?? "n/a"}`,
      "## Risk Notes",
      "Maintaining prose-only files protects the benchmark from copy/paste shortcuts. When regenerating code, rely on the storyline rather than original syntax.",
    ].join("\n\n");
  }

  #extractImports(lines) {
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

  #extractExports(lines) {
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

  #extractClasses(lines) {
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

  #summarizeList(items, limit = 5) {
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

  #languageFromExtension(ext) {
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

  #parseMarkdown(raw) {
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

  #slugify(text) {
    const normalized = (text ?? "")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized || "recompose";
  }

  #requirePhi() {
    if (!this.phi4) {
      throw new Error("Phi-4 handler is required for recompose benchmarks.");
    }
  }
}
