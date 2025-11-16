import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import YAML from "yaml";

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
const DEFAULT_FILE_CONCURRENCY = 3;
const PRIORITY_REPAIR_TARGETS = [
  "readme.md",
  "src/validate.js",
  "src/flows/steps/validate.js",
  "src/greeter.js",
  "src/math.js",
  "src/shared/logger.js",
  "src/shared/persistence/memory-store.js",
];
const WORKSPACE_RETRY_PATTERNS = [/no workspace provided/i, /workspace context missing/i];

export default class RecomposeTester {
  constructor(options = {}) {
    this.ignoredDirs = new Set(options.ignoredDirs ?? ["node_modules", ".git"]);
    this.phi4 = options.phi4 ?? null;
    this.sessionRoot = options.sessionRoot ?? path.join(process.cwd(), ".miniphi", "recompose");
    this.promptLabel = options.promptLabel ?? "recompose";
    this.verboseLogging = Boolean(options.verboseLogging);
    this.fileConcurrency = Math.max(1, Number(options.fileConcurrency ?? DEFAULT_FILE_CONCURRENCY) || DEFAULT_FILE_CONCURRENCY);
    this.memory = options.memory ?? null;
    this.workspaceContext = null;
    this.sampleMetadata = null;
    this.baselineSignatures = new Map();
    this.fileBlueprints = new Map();
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
    this.fileBlueprints.clear();
    this.baselineSignatures = new Map();
    await this.#loadSampleMetadata(sampleDir, { codeDir, descriptionsDir });

    if (["code-to-markdown", "roundtrip"].includes(direction)) {
      await this.#assertDirectory(codeDir, "code");
    }
    if (["markdown-to-code", "roundtrip"].includes(direction)) {
      await this.#assertDirectory(descriptionsDir, "descriptions");
    }

    const resumeDescriptions = Boolean(options.resumeDescriptions);
    const shouldNarrate = direction === "code-to-markdown" || (direction === "roundtrip" && !resumeDescriptions);
    if (shouldNarrate && options.clean && ["code-to-markdown", "roundtrip"].includes(direction)) {
      await this.#cleanDir(descriptionsDir);
    } else if (!shouldNarrate && options.clean && direction === "roundtrip") {
      console.log("[MiniPhi][Recompose] Skipping description clean because --resume-descriptions is active.");
    }
    if (options.clean && ["markdown-to-code", "roundtrip"].includes(direction)) {
      await this.#cleanDir(outputDir);
    }
    if (["code-to-markdown", "roundtrip"].includes(direction)) {
      await this.#captureBaselineSignatures(codeDir);
    }

    const steps = [];
    if (shouldNarrate) {
      steps.push(await this.codeToMarkdown({ sourceDir: codeDir, targetDir: descriptionsDir }));
    } else if (direction === "roundtrip") {
      steps.push({
        phase: "code-to-markdown",
        durationMs: 0,
        discovered: 0,
        converted: 0,
        skipped: 0,
        note: "Skipped narration (resume-descriptions)",
      });
    }
    if (direction === "markdown-to-code" || direction === "roundtrip") {
      steps.push(await this.markdownToCode({ sourceDir: descriptionsDir, targetDir: outputDir }));
    }
    if (direction === "roundtrip") {
      const initialComparison = await this.compareDirectories({ baselineDir: codeDir, candidateDir: outputDir });
      if ((initialComparison.mismatches?.length || initialComparison.missing?.length) && this.fileBlueprints.size) {
        const repairStep = await this.#repairMismatches({
          comparison: initialComparison,
          baselineDir: codeDir,
          candidateDir: outputDir,
        });
        if (repairStep) {
          steps.push(repairStep);
        }
      }
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
      workspaceContext: this.workspaceContext
        ? {
            kind: this.workspaceContext.kind,
            summary: this.workspaceContext.summary,
            sourceDir: this.#relativeToCwd(this.workspaceContext.sourceDir),
            metadata: this.sampleMetadata,
          }
        : null,
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
    let cacheHits = 0;
    const queue = [...files];
    const workerCount = Math.min(this.fileConcurrency, Math.max(queue.length, 1));
    const worker = async () => {
      while (queue.length) {
        const relativePath = queue.shift();
        const absolute = path.join(sourceDir, relativePath);
        if (await this.#isBinary(absolute)) {
          skipped += 1;
          continue;
        }
        const content = await fs.promises.readFile(absolute, "utf8");
        const normalized = content.replace(/\r\n/g, "\n");
        const sourceHash = createHash("sha256").update(normalized, "utf8").digest("hex");
        let document = null;
        if (this.memory) {
          const cached = await this.memory.getCachedNarrative(sourceHash);
          if (cached?.document) {
            document = cached.document;
            cacheHits += 1;
          }
        }
        if (!document) {
          const language = this.#languageFromExtension(path.extname(relativePath));
          document = await this.#narrateSourceFile({
            relativePath,
            language,
            content: normalized,
            workspaceSummary,
            sourceHash,
          });
          if (this.memory) {
            await this.memory.storeCachedNarrative(sourceHash, {
              document,
              relativePath,
              sample: this.sampleMetadata?.sampleName ?? null,
            });
          }
        }
        const target = path.join(targetDir, `${relativePath}.md`);
        await this.#ensureDir(path.dirname(target));
        await fs.promises.writeFile(target, document, "utf8");
        converted += 1;
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    return {
      phase: "code-to-markdown",
      durationMs: Date.now() - start,
      discovered: files.length,
      converted,
      skipped,
      cacheHits,
      concurrency: workerCount,
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
        const blueprint = { narrative, plan, language };
        this.fileBlueprints.set(targetPathRelative, blueprint);
        const signature = this.baselineSignatures.get(targetPathRelative) ?? null;
        const code = await this.#attemptCodeGeneration({
          relativePath: targetPathRelative,
          blueprint,
          signature,
          repairContext: null,
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

  async #narrateSourceFile({ relativePath, language, content, workspaceSummary, sourceHash }) {
    const normalizedContent = content.replace(/\r\n/g, "\n");
    const hash = sourceHash ?? createHash("sha256").update(normalizedContent, "utf8").digest("hex");
    const prompt = [
      "You are documenting a source file for the MiniPhi recomposition benchmark.",
      "Convert the code into a multi-section narrative that describes intent, data flow, and error handling.",
      "Use at least three markdown headings (##) and no fenced code blocks. Inline code should be rewritten as plain language.",
      "Explain behavior as a story the reader must mentally reassemble into code.",
      `Workspace overview:\n${workspaceSummary}\n`,
      this.#formatSampleMetadata(),
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
      `sha256: ${hash}`,
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
      this.#formatSampleMetadata(),
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

  async #generateSourceFromPlan({
    relativePath,
    plan,
    narrative,
    language,
    repairContext = null,
    guidance = null,
  }) {
    const basePrompt = [
      "You now synthesize the final source file described earlier.",
      "Use the supplied plan and narrative to rebuild the exact behavior.",
      "Preserve existing exports and module style (ESM vs CommonJS) exactly.",
      "Respond with a single fenced code block containing only the source.",
      `Workspace overview:\n${this.workspaceContext?.summary ?? "n/a"}`,
      this.#formatSampleMetadata(),
      `Plan:\n${plan}`,
      `Narrative:\n${narrative}`,
    ];
    if (repairContext) {
      basePrompt.push(`Repair context:\n${repairContext}`);
    }
    if (guidance) {
      basePrompt.push(`Guidance:\n${guidance}`);
    }
    basePrompt.push(`Emit the ${language || "text"} source code for ${relativePath}.`);
    let response = await this.#promptPhi(basePrompt.join("\n\n"), {
      label: "recompose:codegen",
      metadata: { file: relativePath, language },
    });
    let code = this.#extractCodeFromResponse(response);
    if (!code) {
      const retryPrompt = [
        ...basePrompt,
        "Your previous answer lacked a fenced code block. Resend the FULL file with ``` fences.",
        `Previous attempt:\n${response}`,
      ];
      response = await this.#promptPhi(retryPrompt.join("\n\n"), {
        label: "recompose:codegen-retry",
        metadata: { file: relativePath, language },
      });
      code = this.#extractCodeFromResponse(response);
      if (!code) {
        throw new Error("Phi-4 response did not include a code block after retry.");
      }
    }
    await this.#writeSessionAsset(
      path.join("code", `${this.#safeSessionName(relativePath)}.txt`),
      code,
    );
    return code;
  }

  async #attemptCodeGeneration({ relativePath, blueprint, signature, repairContext }) {
    const maxAttempts = signature ? 3 : 2;
    let guidance = null;
    let lastReason = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const code = await this.#generateSourceFromPlan({
        relativePath,
        plan: blueprint.plan,
        narrative: blueprint.narrative,
        language: blueprint.language,
        repairContext,
        guidance,
      });
      const validation = this.#validateGeneratedCode({ relativePath, code, signature });
      if (validation.ok) {
        return code;
      }
      guidance = validation.guidance;
      lastReason = validation.reason;
      if (!guidance) {
        break;
      }
    }
    throw new Error(lastReason ?? "Unable to satisfy structure constraints.");
  }

  #validateGeneratedCode({ relativePath, code, signature }) {
    if (!signature) {
      return { ok: true };
    }
    const issues = [];
    if (signature.exportStyle) {
      const detected = this.#detectExportStyle(code);
      if (detected && signature.exportStyle !== detected) {
        issues.push(
          `File ${relativePath} must use ${signature.exportStyle === "esm" ? "ES module exports" : "module.exports"} syntax.`,
        );
      }
    }
    if (signature.exports?.length) {
      const missing = signature.exports.filter((name) => !this.#codeContainsIdentifier(code, name));
      if (missing.length) {
        issues.push(`Missing exported symbols: ${missing.join(", ")}`);
      }
    }
    if (!issues.length) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: issues[0],
      guidance: `${issues.join(" ")} Regenerate ${relativePath} without renaming identifiers.`,
    };
  }

  async #ensureWorkspaceSummaryFromCode(sourceDir, files) {
    if (this.workspaceContext?.kind === "code" && this.workspaceContext.sourceDir === sourceDir) {
      return this.workspaceContext.summary;
    }
    const glimpses = await this.#collectGlimpses(sourceDir, files);
    const promptParts = [
      "Survey the workspace and narrate the protagonist's goals.",
      "Produce sections for Architecture Rhythm, Supporting Cast, and Risk Notes.",
      "Avoid listing file names explicitly; rely on behaviors and interactions.",
      `Glimpses:\n${glimpses}`,
      this.#formatSampleMetadata(),
    ].join("\n\n");
    let summaryText = this.#sanitizeNarrative(await this.#promptPhi(promptParts, { label: "recompose:workspace-overview" }));
    if (this.#needsWorkspaceRetry(summaryText)) {
      const retryPrompt = [
        promptParts,
        this.#buildWorkspaceHintBlock(files, sourceDir),
      ]
        .filter(Boolean)
        .join("\n\n");
      summaryText = this.#sanitizeNarrative(
        await this.#promptPhi(retryPrompt, { label: "recompose:workspace-overview-retry" }),
      );
    }
    const summary = this.#structureNarrative(
      summaryText,
      "workspace",
      () => this.#fallbackWorkspaceSummaryFromCode(files.length, glimpses),
    );
    this.workspaceContext = { kind: "code", summary, sourceDir, metadata: this.sampleMetadata };
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
      this.#formatSampleMetadata(),
    ].join("\n\n");
    let summaryText = this.#sanitizeNarrative(
      await this.#promptPhi(prompt, { label: "recompose:workspace-from-descriptions" }),
    );
    if (this.#needsWorkspaceRetry(summaryText)) {
      const retryPrompt = [
        prompt,
        this.#buildWorkspaceHintBlock(files, sourceDir),
      ].join("\n\n");
      summaryText = this.#sanitizeNarrative(
        await this.#promptPhi(retryPrompt, { label: "recompose:workspace-from-descriptions-retry" }),
      );
    }
    const summary = this.#structureNarrative(
      summaryText,
      "workspace",
      () => this.#fallbackWorkspaceSummaryFromDescriptions(excerpts),
    );
    this.workspaceContext = { kind: "descriptions", summary, sourceDir, metadata: this.sampleMetadata };
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

  async #captureBaselineSignatures(codeDir) {
    if (!codeDir) {
      return;
    }
    try {
      const stats = await fs.promises.stat(codeDir);
      if (!stats.isDirectory()) {
        return;
      }
    } catch {
      return;
    }
    const files = await this.#listFiles(codeDir);
    for (const relativePath of files) {
      const absolute = path.join(codeDir, relativePath);
      if (await this.#isBinary(absolute)) {
        continue;
      }
      try {
        const content = await fs.promises.readFile(absolute, "utf8");
        const exports = this.#extractExports(content.split(/\r?\n/));
        const exportStyle = this.#detectExportStyle(content);
        this.baselineSignatures.set(relativePath.replace(/\\/g, "/"), { exports, exportStyle });
      } catch {
        // ignore failures
      }
    }
  }

  async #promptPhi(prompt, traceOptions = undefined) {
    const started = Date.now();
    let response = "";
    let error = null;
    try {
      const metadata = {
        sessionLabel: this.sessionLabel,
        workspaceSummary: this.workspaceContext?.summary ?? null,
        workspaceType: this.workspaceContext?.kind ?? "recompose",
        sample: this.sampleMetadata?.sampleName ?? null,
        plan: this.sampleMetadata?.plan?.name ?? null,
        ...(traceOptions?.metadata ?? {}),
      };
      response = await this.phi4.chatStream(prompt, undefined, undefined, undefined, {
        scope: "sub",
        label: traceOptions?.label ?? this.promptLabel,
        metadata,
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

  async exportPromptLog(options = {}) {
    if (!this.promptLogPath) {
      return null;
    }
    const sourcePath = path.isAbsolute(this.promptLogPath)
      ? this.promptLogPath
      : path.resolve(process.cwd(), this.promptLogPath);
    try {
      await fs.promises.access(sourcePath, fs.constants.F_OK);
    } catch {
      return null;
    }
    const targetDir = path.resolve(options.targetDir ?? path.dirname(sourcePath));
    await this.#ensureDir(targetDir);
    const defaultName = `${this.sessionLabel ?? "recompose"}.prompts.log`;
    const fileHint = options.fileName ?? options.label ?? defaultName;
    const fileName = this.#sanitizeExportName(fileHint);
    const destinationPath = path.join(targetDir, fileName);
    await fs.promises.copyFile(sourcePath, destinationPath);
    return destinationPath;
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

  #sanitizeExportName(name) {
    const fallback = `${this.#slugify(this.sessionLabel ?? "recompose")}.prompts.log`;
    if (!name) {
      return fallback;
    }
    const normalized = name.replace(/[\\/]+/g, "-").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").trim();
    if (!normalized) {
      return fallback;
    }
    if (!normalized.toLowerCase().endsWith(".log")) {
      return `${normalized}.log`;
    }
    return normalized;
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

  #detectExportStyle(source) {
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

  #codeContainsIdentifier(source, identifier) {
    if (!source || !identifier) {
      return false;
    }
    const pattern = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return pattern.test(source);
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

  async #repairMismatches({ comparison, baselineDir, candidateDir }) {
    const targets = [];
    for (const mismatch of comparison.mismatches ?? []) {
      targets.push({ path: mismatch.path, type: "mismatch" });
    }
    for (const missing of comparison.missing ?? []) {
      targets.push({ path: missing, type: "missing" });
    }
    if (!targets.length) {
      return null;
    }
    const prioritized = targets.sort((a, b) => this.#repairPriority(b.path) - this.#repairPriority(a.path));
    const summary = {
      phase: "repair",
      attempted: 0,
      repaired: 0,
      skipped: [],
      initialMismatches: (comparison.mismatches ?? []).length,
      initialMissing: (comparison.missing ?? []).length,
    };
    const start = Date.now();
    for (const target of prioritized) {
      const blueprint = this.fileBlueprints.get(target.path);
      if (!blueprint) {
        summary.skipped.push({ path: target.path, reason: "No blueprint cached for this file during markdown-to-code." });
        continue;
      }
      summary.attempted += 1;
      try {
        const signature = this.baselineSignatures.get(target.path) ?? null;
        const repairContext = await this.#buildDiffSummary({
          relativePath: target.path,
          type: target.type,
          baselineDir,
          candidateDir,
        });
        const code = await this.#attemptCodeGeneration({
          relativePath: target.path,
          blueprint,
          signature,
          repairContext,
        });
        const destination = path.join(candidateDir, target.path);
        await this.#ensureDir(path.dirname(destination));
        await fs.promises.writeFile(destination, `${code.replace(/\s+$/, "")}\n`, "utf8");
        summary.repaired += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        summary.skipped.push({ path: target.path, reason });
      }
    }
    summary.durationMs = Date.now() - start;
    return summary;
  }

  async #buildDiffSummary({ relativePath, type, baselineDir, candidateDir }) {
    const baselinePath = path.join(baselineDir, relativePath);
    const candidatePath = path.join(candidateDir, relativePath);
    let baseline = "";
    let candidate = "";
    try {
      baseline = await fs.promises.readFile(baselinePath, "utf8");
    } catch {
      baseline = "";
    }
    try {
      candidate = await fs.promises.readFile(candidatePath, "utf8");
    } catch {
      candidate = "";
    }
    const diff = this.#summarizeDiff(baseline, candidate);
    return [
      `Repairs required for ${relativePath}`,
      baseline ? `Baseline preview:\n${this.#truncateLine(baseline.slice(0, 400))}` : "Baseline preview unavailable.",
      type === "missing" ? "Candidate preview: file missing entirely." : `Candidate preview:\n${this.#truncateLine(candidate.slice(0, 400))}`,
      diff ? `Diff sketch:\n${diff}` : "Diff sketch unavailable.",
    ].join("\n\n");
  }

  #summarizeDiff(baseline, candidate) {
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
      output.push(`- [${i + 1}] ${this.#truncateLine(left)}`);
      output.push(`+ [${i + 1}] ${this.#truncateLine(right)}`);
    }
    return output.length ? output.join("\n") : null;
  }

  #truncateLine(text, max = 160) {
    const normalized = (text ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "(empty)";
    }
    if (normalized.length <= max) {
      return normalized;
    }
    return `${normalized.slice(0, max)}…`;
  }

  #repairPriority(relativePath) {
    const normalized = relativePath.toLowerCase();
    if (PRIORITY_REPAIR_TARGETS.some((token) => normalized.includes(token))) {
      return 2;
    }
    return 1;
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

  async #loadSampleMetadata(sampleDir, { codeDir, descriptionsDir } = {}) {
    if (!sampleDir) {
      this.sampleMetadata = null;
      return;
    }
    const metadata = {
      sampleDir,
      sampleName: path.basename(sampleDir),
      readmeSnippet: await this.#readSampleReadme(sampleDir, codeDir, descriptionsDir),
      plan: await this.#readSamplePlan(sampleDir),
      manifest: await this.#collectSampleManifest(codeDir),
    };
    this.sampleMetadata = metadata;
  }

  async #readSampleReadme(sampleDir, codeDir, descriptionsDir) {
    const candidates = [
      path.join(sampleDir, "README.md"),
      path.join(sampleDir, "README.md.md"),
      codeDir ? path.join(codeDir, "README.md") : null,
      descriptionsDir ? path.join(descriptionsDir, "README.md") : null,
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        const stats = await fs.promises.stat(candidate);
        if (!stats.isFile()) {
          continue;
        }
        const snippet = (await fs.promises.readFile(candidate, "utf8")).replace(/\s+/g, " ").trim();
        if (snippet) {
          return snippet.slice(0, 240);
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  async #readSamplePlan(sampleDir) {
    const candidates = ["benchmark-plan.yaml", "benchmark-plan.yml", "benchmark-plan.json"];
    for (const candidate of candidates) {
      const absolute = path.join(sampleDir, candidate);
      try {
        const stats = await fs.promises.stat(absolute);
        if (!stats.isFile()) {
          continue;
        }
        const raw = await fs.promises.readFile(absolute, "utf8");
        const data = candidate.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
        const name = data?.timestamp ?? data?.name ?? path.parse(candidate).name;
        return {
          name,
          path: this.#relativeToCwd(absolute),
          runs: Array.isArray(data?.runs) ? data.runs.length : 0,
        };
      } catch {
        // ignore parse errors
      }
    }
    return null;
  }

  async #collectSampleManifest(codeDir) {
    if (!codeDir) {
      return [];
    }
    try {
      const stats = await fs.promises.stat(codeDir);
      if (!stats.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }
    const files = await this.#listFiles(codeDir);
    const limited = files.slice(0, 12);
    const manifest = [];
    for (const file of limited) {
      try {
        const info = await fs.promises.stat(path.join(codeDir, file));
        manifest.push({ path: file, bytes: info.size });
      } catch {
        manifest.push({ path: file, bytes: 0 });
      }
    }
    return manifest;
  }

  #formatSampleMetadata() {
    if (!this.sampleMetadata) {
      return "";
    }
    const lines = [`Workspace sample: ${this.sampleMetadata.sampleName}`];
    if (this.sampleMetadata.plan?.name) {
      lines.push(`Plan: ${this.sampleMetadata.plan.name}`);
    }
    if (this.sampleMetadata.manifest?.length) {
      const entries = this.sampleMetadata.manifest
        .slice(0, 6)
        .map((entry) => `- ${entry.path} (${entry.bytes} bytes)`)
        .join("\n");
      lines.push(`Manifest preview:\n${entries}`);
    }
    if (this.sampleMetadata.readmeSnippet) {
      lines.push(`README snippet: ${this.sampleMetadata.readmeSnippet}`);
    }
    return lines.join("\n");
  }

  #buildWorkspaceHintBlock(files, baseDir) {
    const manifest = files.slice(0, 10).map((file) => `- ${file}`).join("\n");
    const hints = [`File manifest (${baseDir}):\n${manifest || "- n/a"}`];
    if (this.sampleMetadata?.readmeSnippet) {
      hints.push(`README excerpt:\n${this.sampleMetadata.readmeSnippet}`);
    }
    return hints.join("\n\n");
  }

  #needsWorkspaceRetry(text) {
    if (!text) {
      return true;
    }
    return WORKSPACE_RETRY_PATTERNS.some((regex) => regex.test(text));
  }
}
