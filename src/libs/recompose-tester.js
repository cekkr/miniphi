import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import YAML from "yaml";
import { extractJsonBlock } from "./core-utils.js";
import {
  buildWorkspaceHintBlock,
  collectManifestSummary,
  formatMetadataSummary,
  listWorkspaceFiles,
  readReadmeSnippet,
} from "./workspace-context-utils.js";

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
const DEFAULT_FILE_CONCURRENCY = 1;
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
const MAX_OVERVIEW_CHAR_BUDGET = 8000;
const MAX_OVERVIEW_SUMMARY_LINES = 4;
const OVERVIEW_COMMENT_PREFIX = /^(?:\/\/+|\/\*+|\*+|#+|--)/;
const DEFAULT_OVERVIEW_TIMEOUT_MS = 120000;
const DEFAULT_OVERVIEW_PROGRESSIVE = [1, 0.65, 0.35];
const RECOMPOSE_SCHEMA_IDS = {
  workspace: "recompose-workspace-overview",
  narrative: "recompose-file-narrative",
  plan: "recompose-file-plan",
  codegen: "recompose-codegen",
};

export default class RecomposeTester {
  constructor(options = {}) {
    this.ignoredDirs = new Set(options.ignoredDirs ?? ["node_modules", ".git"]);
    this.phi4 = options.phi4 ?? null;
    this.sessionRoot = options.sessionRoot ?? path.join(process.cwd(), ".miniphi", "recompose");
    this.promptLabel = options.promptLabel ?? "recompose";
    this.verboseLogging = Boolean(options.verboseLogging);
    this.fileConcurrency = Math.max(1, Number(options.fileConcurrency ?? DEFAULT_FILE_CONCURRENCY) || DEFAULT_FILE_CONCURRENCY);
    this.memory = options.memory ?? null;
    this.schemaRegistry = options.schemaRegistry ?? null;
    this.useLivePrompts = options.useLivePrompts !== undefined ? Boolean(options.useLivePrompts) : true;
    this.offlineFallbackActive = !this.useLivePrompts;
    this.promptFailureBudget =
      typeof options.promptFailureBudget === "number" && Number.isFinite(options.promptFailureBudget)
        ? options.promptFailureBudget
        : 1;
    this.workspaceContext = null;
    this.sampleMetadata = null;
    this.baselineSignatures = new Map();
    this.fileBlueprints = new Map();
    this.sessionDir = null;
    this.sessionLabel = null;
    this.promptLogPath = null;
    const timeoutCandidate = Number(options.workspaceOverviewTimeoutMs);
    this.workspaceOverviewTimeoutMs =
      Number.isFinite(timeoutCandidate) && timeoutCandidate > 0
        ? timeoutCandidate
        : DEFAULT_OVERVIEW_TIMEOUT_MS;
    const progression =
      Array.isArray(options.workspaceOverviewProgression) &&
      options.workspaceOverviewProgression.length
        ? options.workspaceOverviewProgression
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0)
        : DEFAULT_OVERVIEW_PROGRESSIVE;
    this.workspaceOverviewProgression = progression.length ? progression : DEFAULT_OVERVIEW_PROGRESSIVE;
  }

  async run(options = {}) {
    const direction = (options.direction ?? "roundtrip").toLowerCase();
    if (!["code-to-markdown", "markdown-to-code", "roundtrip"].includes(direction)) {
      throw new Error(`Unsupported recompose direction "${direction}".`);
    }

    this._requirePhi();
    if (typeof this.phi4?.clearHistory === "function") {
      this.phi4.clearHistory();
    }
    await this._startSession(options.sessionLabel ?? this.promptLabel);

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
    await this._loadSampleMetadata(sampleDir, { codeDir, descriptionsDir });

    if (["code-to-markdown", "roundtrip"].includes(direction)) {
      await this._assertDirectory(codeDir, "code");
    }
    if (["markdown-to-code", "roundtrip"].includes(direction)) {
      await this._assertDirectory(descriptionsDir, "descriptions");
    }

    const resumeDescriptions = Boolean(options.resumeDescriptions);
    const shouldNarrate = direction === "code-to-markdown" || (direction === "roundtrip" && !resumeDescriptions);
    if (shouldNarrate && options.clean && ["code-to-markdown", "roundtrip"].includes(direction)) {
      await this._cleanDir(descriptionsDir);
    } else if (!shouldNarrate && options.clean && direction === "roundtrip") {
      console.log("[MiniPhi][Recompose] Skipping description clean because --resume-descriptions is active.");
    }
    if (options.clean && ["markdown-to-code", "roundtrip"].includes(direction)) {
      await this._cleanDir(outputDir);
    }
    if (["code-to-markdown", "roundtrip"].includes(direction)) {
      await this._captureBaselineSignatures(codeDir);
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
        const repairStep = await this._repairMismatches({
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
      sampleDir: this._relativeToCwd(sampleDir),
      codeDir: this._relativeToCwd(codeDir),
      descriptionsDir: this._relativeToCwd(descriptionsDir),
      outputDir: this._relativeToCwd(outputDir),
      steps,
      sessionDir: this._relativeToCwd(this.sessionDir),
      promptLog: this._relativeToCwd(this.promptLogPath),
      workspaceContext: this.workspaceContext
        ? {
            kind: this.workspaceContext.kind,
            summary: this.workspaceContext.summary,
            sourceDir: this._relativeToCwd(this.workspaceContext.sourceDir),
            metadata: this.sampleMetadata,
          }
        : null,
      sessionLabel: this.sessionLabel,
      generatedAt: new Date().toISOString(),
    };
  }

  async codeToMarkdown({ sourceDir, targetDir }) {
    const start = Date.now();
    const files = await listWorkspaceFiles(sourceDir, { ignoredDirs: this.ignoredDirs });
    const workspaceSummary = await this._ensureWorkspaceSummaryFromCode(sourceDir, files);
    let converted = 0;
    let skipped = 0;
    let cacheHits = 0;
    const queue = [...files];
    const workerCount = Math.min(this.fileConcurrency, Math.max(queue.length, 1));
    const worker = async () => {
      while (queue.length) {
        const relativePath = queue.shift();
        const absolute = path.join(sourceDir, relativePath);
        if (await this._isBinary(absolute)) {
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
          const language = this._languageFromExtension(path.extname(relativePath));
          document = await this._narrateSourceFile({
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
        await this._ensureDir(path.dirname(target));
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
      descriptionsDir: this._relativeToCwd(targetDir),
    };
  }

  async markdownToCode({ sourceDir, targetDir }) {
    const start = Date.now();
    const files = (await listWorkspaceFiles(sourceDir, { ignoredDirs: this.ignoredDirs })).filter((file) =>
      file.toLowerCase().endsWith(".md"),
    );
    const workspaceSummary = await this._ensureWorkspaceSummaryFromDescriptions(sourceDir, files);
    let converted = 0;
    const warnings = [];

    for (const relativePath of files) {
      const absolute = path.join(sourceDir, relativePath);
      const raw = await fs.promises.readFile(absolute, "utf8");
      const { metadata, body } = this._parseMarkdown(raw);
      const narrative = body.trim();
      if (!narrative) {
        warnings.push({ path: relativePath, reason: "missing narrative content" });
        continue;
      }
      const targetPathRelative =
        metadata.source ?? relativePath.replace(/\.md$/i, "").replace(/\\/g, "/");
      const language = metadata.language ?? this._languageFromExtension(path.extname(targetPathRelative));
      try {
        const plan = await this._planCodeFromNarrative({
          relativePath: targetPathRelative,
          narrative,
          workspaceSummary,
        });
        const blueprint = { narrative, plan, language };
        this.fileBlueprints.set(targetPathRelative, blueprint);
        const signature = this.baselineSignatures.get(targetPathRelative) ?? null;
        const code = await this._attemptCodeGeneration({
          relativePath: targetPathRelative,
          blueprint,
          signature,
          repairContext: null,
        });
        const targetPath = path.join(targetDir, targetPathRelative);
        await this._ensureDir(path.dirname(targetPath));
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
      outputDir: this._relativeToCwd(targetDir),
      warnings,
    };
  }

  async compareDirectories({ baselineDir, candidateDir }) {
    const start = Date.now();
    const baselineFiles = await listWorkspaceFiles(baselineDir, { ignoredDirs: this.ignoredDirs });
    const candidateFiles = await listWorkspaceFiles(candidateDir, { ignoredDirs: this.ignoredDirs });

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
      const baselineHash = await this._hashFile(baselinePath);
      const candidateHash = await this._hashFile(candidatePath);
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

  async _narrateSourceFile({ relativePath, language, content, workspaceSummary, sourceHash }) {
    const normalizedContent = content.replace(/\r\n/g, "\n");
    const hash = sourceHash ?? createHash("sha256").update(normalizedContent, "utf8").digest("hex");
    const prompt = [
      this._buildSchemaInstructions(RECOMPOSE_SCHEMA_IDS.narrative, [
        'Populate "narrative" with a multi-section markdown description (no code fences).',
        'Set "needs_more_context" to true and list missing snippets in "missing_snippets" if the narrative cannot be completed.',
      ]),
      "You are documenting a source file for the MiniPhi recomposition benchmark.",
      "Convert the code into a multi-section narrative that describes intent, data flow, and error handling.",
      "Use at least three markdown headings (##) and no fenced code blocks. Inline code should be rewritten as plain language.",
      "Explain behavior as a story the reader must mentally reassemble into code.",
      `Workspace overview:\n${workspaceSummary}\n`,
      formatMetadataSummary(this.sampleMetadata),
      `Describe the file (${relativePath}) written in ${language}.`,
      "Raw source follows:",
      `"""`,
      normalizedContent.slice(0, MAX_SNIPPET_CHARS * 4),
      `"""`,
    ].join("\n\n");

    const { payload, raw } = await this._promptJson(prompt, {
      label: "recompose:file-narrative",
      schemaId: RECOMPOSE_SCHEMA_IDS.narrative,
      metadata: { file: relativePath },
    });
    const structured = this._structureNarrative(
      this._sanitizeNarrative(this._pickNarrativeField(payload, "narrative", raw)),
      relativePath,
      () =>
        this._fallbackFileNarrative({
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
    await this._writeSessionAsset(
      path.join("files", `${this._safeSessionName(relativePath)}.md`),
      `# Narrative for ${relativePath}\n\n${structured}\n`,
    );
    return document;
  }

  async _planCodeFromNarrative({ relativePath, narrative, workspaceSummary }) {
    const prompt = [
      this._buildSchemaInstructions(RECOMPOSE_SCHEMA_IDS.plan, [
        'Populate "plan" with markdown headings for Inputs, Transformations, Outputs, and Failure Modes.',
        'Use the optional arrays (inputs, transformations, outputs, failure_modes) when they help summarize details.',
        'Set "needs_more_context" to true and list missing snippets in "missing_snippets" if the plan cannot be completed.',
      ]),
      "You previously helped convert code into prose for a secure recomposition test.",
      "Given the narrative description, outline the concrete implementation strategy.",
      "Describe the modules, helper functions, and edge cases that must exist.",
      "Return markdown with headings for Inputs, Transformations, Outputs, and Failure Modes. Do not write code.",
      `Workspace overview:\n${workspaceSummary}`,
      formatMetadataSummary(this.sampleMetadata),
      `Narrative for ${relativePath}:\n${narrative}`,
    ].join("\n\n");
    const { payload, raw } = await this._promptJson(prompt, {
      label: "recompose:file-plan",
      schemaId: RECOMPOSE_SCHEMA_IDS.plan,
      metadata: { file: relativePath },
    });
    const planText = this._sanitizeNarrative(this._pickNarrativeField(payload, "plan", raw));
    const plan = this._structureNarrative(planText, relativePath, () =>
      this._fallbackPlanFromNarrative(relativePath, narrative),
    );
    await this._writeSessionAsset(
      path.join("plans", `${this._safeSessionName(relativePath)}.md`),
      `# Plan for ${relativePath}\n\n${plan}\n`,
    );
    return plan;
  }

  async _generateSourceFromPlan({
    relativePath,
    plan,
    narrative,
    language,
    repairContext = null,
    guidance = null,
  }) {
    const basePrompt = [
      this._buildSchemaInstructions(RECOMPOSE_SCHEMA_IDS.codegen, [
        'Populate "code" with the complete source file (no code fences).',
        'Set "needs_more_context" to true and list missing snippets in "missing_snippets" if code cannot be produced.',
      ]),
      "You now synthesize the final source file described earlier.",
      "Use the supplied plan and narrative to rebuild the exact behavior.",
      "Preserve existing exports and module style (ESM vs CommonJS) exactly.",
      `Workspace overview:\n${this.workspaceContext?.summary ?? "n/a"}`,
      formatMetadataSummary(this.sampleMetadata),
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
    let response = await this._promptJson(basePrompt.join("\n\n"), {
      label: "recompose:codegen",
      schemaId: RECOMPOSE_SCHEMA_IDS.codegen,
      metadata: { file: relativePath, language },
    });
    let code = this._extractCodeFromPayload(response.payload, response.raw);
    if (!code) {
      const retryPrompt = [
        ...basePrompt,
        "Your previous answer did not include usable code. Resend the FULL file as JSON with the code field populated.",
        `Previous attempt:\n${response.raw ?? ""}`,
      ];
      response = await this._promptJson(retryPrompt.join("\n\n"), {
        label: "recompose:codegen-retry",
        schemaId: RECOMPOSE_SCHEMA_IDS.codegen,
        metadata: { file: relativePath, language },
      });
      code = this._extractCodeFromPayload(response.payload, response.raw);
      if (!code) {
        throw new Error("Phi-4 response did not include code after retry.");
      }
    }
    await this._writeSessionAsset(
      path.join("code", `${this._safeSessionName(relativePath)}.txt`),
      code,
    );
    return code;
  }

  async _attemptCodeGeneration({ relativePath, blueprint, signature, repairContext }) {
    if (this.offlineFallbackActive) {
      return this._buildOfflineCodeStub({ relativePath, blueprint, signature });
    }
    const maxAttempts = signature ? 3 : 2;
    let guidance = null;
    let lastReason = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const code = await this._generateSourceFromPlan({
        relativePath,
        plan: blueprint.plan,
        narrative: blueprint.narrative,
        language: blueprint.language,
        repairContext,
        guidance,
      });
      const validation = this._validateGeneratedCode({ relativePath, code, signature });
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

  _validateGeneratedCode({ relativePath, code, signature }) {
    if (!signature) {
      return { ok: true };
    }
    const issues = [];
    if (signature.exportStyle) {
      const detected = this._detectExportStyle(code);
      if (detected && signature.exportStyle !== detected) {
        issues.push(
          `File ${relativePath} must use ${signature.exportStyle === "esm" ? "ES module exports" : "module.exports"} syntax.`,
        );
      }
    }
    if (signature.exports?.length) {
      const missing = signature.exports.filter((name) => !this._codeContainsIdentifier(code, name));
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

  async _ensureWorkspaceSummaryFromCode(sourceDir, files) {
    if (this.workspaceContext?.kind === "code" && this.workspaceContext.sourceDir === sourceDir) {
      return this.workspaceContext.summary;
    }
    const glimpsesInfo = await this._collectGlimpses(sourceDir, files);
    const glimpses = this._renderGlimpsesText(glimpsesInfo);
    const workspaceHints = buildWorkspaceHintBlock(
      files,
      sourceDir,
      this.sampleMetadata?.readmeSnippet,
      { limit: 12 },
    );
    const overviewIntro = [
      "Survey the workspace and narrate the protagonist's goals.",
      "Produce sections for Architecture Rhythm, Supporting Cast, and Risk Notes.",
      "Avoid listing file names explicitly; rely on behaviors and interactions.",
    ].join("\n\n");
    const metadataSummary = formatMetadataSummary(this.sampleMetadata);
    const schemaInstructions = this._buildSchemaInstructions(RECOMPOSE_SCHEMA_IDS.workspace, [
      'Populate "summary" with the narrative overview using markdown headings for Architecture Rhythm, Supporting Cast, and Risk Notes.',
      'Set "needs_more_context" to true and list missing snippets in "missing_snippets" if the overview cannot be completed.',
    ]);
    const attempts = this._buildWorkspaceOverviewAttempts(glimpsesInfo);
    let summaryText = "";
    for (const attempt of attempts) {
      const prompt = this._composeWorkspaceOverviewPrompt({
        schemaInstructions,
        intro: overviewIntro,
        glimpsesText: attempt.glimpsesText,
        workspaceHints,
        metadataSummary,
      });
      const { payload, raw } = await this._promptJson(prompt, {
        label: attempt.label,
        timeoutMs: this.workspaceOverviewTimeoutMs,
        schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
      });
      summaryText = this._sanitizeNarrative(this._pickNarrativeField(payload, "summary", raw));
      const needsRetry = this._needsMoreContext(payload) || this._needsWorkspaceRetry(summaryText);
      if (needsRetry) {
        const retryPrompt = this._composeWorkspaceOverviewPrompt({
          schemaInstructions,
          intro: overviewIntro,
          glimpsesText: attempt.glimpsesText,
          workspaceHints,
          metadataSummary,
          hintLabel: "Workspace hints (retry)",
        });
        const retryResponse = await this._promptJson(retryPrompt, {
          label: `${attempt.label}-retry`,
          timeoutMs: this.workspaceOverviewTimeoutMs,
          schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
        });
        summaryText = this._sanitizeNarrative(
          this._pickNarrativeField(retryResponse.payload, "summary", retryResponse.raw),
        );
        if (!this._needsMoreContext(retryResponse.payload) && summaryText?.trim()) {
          break;
        }
      }
      if (summaryText?.trim()) {
        break;
      }
    }
    let fallbackUsed = false;
    const summary = this._structureNarrative(
      summaryText,
      "workspace",
      () => {
        fallbackUsed = true;
        return this._fallbackWorkspaceSummaryFromCode(files.length, glimpses);
      },
    );
    if (fallbackUsed) {
      this._warnWorkspaceOverviewFallback(attempts.length);
    }
    this.workspaceContext = { kind: "code", summary, sourceDir, metadata: this.sampleMetadata };
    await this._writeSessionAsset(WORKSPACE_OVERVIEW_FILE, `# Workspace Overview\n\n${summary}\n`);
    return summary;
  }

  async _ensureWorkspaceSummaryFromDescriptions(sourceDir, files) {
    if (this.workspaceContext?.summary) {
      return this.workspaceContext.summary;
    }
    const excerpts = await Promise.all(
      files.slice(0, MAX_OVERVIEW_FILES).map(async (relativePath) => {
        const absolute = path.join(sourceDir, relativePath);
        const raw = await fs.promises.readFile(absolute, "utf8");
        const { body } = this._parseMarkdown(raw);
        return `### ${relativePath}\n${body.split(/\n+/).slice(0, 6).join("\n")}`;
      }),
    );
    const prompt = [
      this._buildSchemaInstructions(RECOMPOSE_SCHEMA_IDS.workspace, [
        'Populate "summary" with the narrative overview of the workspace.',
        'Set "needs_more_context" to true and list missing snippets in "missing_snippets" if the overview cannot be completed.',
      ]),
      "The workspace contains prose-only descriptions of code files.",
      "Summarize the project from these excerpts so Phi-4 can rebuild it.",
      `Excerpts:\n${excerpts.join("\n\n")}`,
      formatMetadataSummary(this.sampleMetadata),
    ].join("\n\n");
    let summaryPayload = await this._promptJson(prompt, {
      label: "recompose:workspace-from-descriptions",
      schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
    });
    let summaryText = this._sanitizeNarrative(
      this._pickNarrativeField(summaryPayload.payload, "summary", summaryPayload.raw),
    );
    if (this._needsMoreContext(summaryPayload.payload) || this._needsWorkspaceRetry(summaryText)) {
      const retryPrompt = [
        prompt,
        buildWorkspaceHintBlock(files, sourceDir, this.sampleMetadata?.readmeSnippet),
      ].join("\n\n");
      summaryPayload = await this._promptJson(retryPrompt, {
        label: "recompose:workspace-from-descriptions-retry",
        schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
      });
      summaryText = this._sanitizeNarrative(
        this._pickNarrativeField(summaryPayload.payload, "summary", summaryPayload.raw),
      );
    }
    const summary = this._structureNarrative(
      summaryText,
      "workspace",
      () => this._fallbackWorkspaceSummaryFromDescriptions(excerpts),
    );
    this.workspaceContext = { kind: "descriptions", summary, sourceDir, metadata: this.sampleMetadata };
    await this._writeSessionAsset(WORKSPACE_OVERVIEW_FILE, `# Workspace Overview\n\n${summary}\n`);
    return summary;
  }

  async _collectGlimpses(baseDir, files) {
    if (!Array.isArray(files) || files.length === 0) {
      return "Workspace scan produced no narrative glimpses.";
    }
    const prioritized = this._prioritizeOverviewFiles(files);
    const glimpses = [];
    let included = 0;
    let budget = MAX_OVERVIEW_CHAR_BUDGET;
    for (const relative of prioritized) {
      if (included >= MAX_OVERVIEW_FILES || budget <= 0) {
        break;
      }
      const summary = await this._summarizeFileForOverview(baseDir, relative);
      if (!summary) {
        continue;
      }
      const block = `### ${relative}\n${summary}`;
      const blockLength = block.length;
      if (blockLength > budget && included > 0) {
        break;
      }
      glimpses.push(block);
      included += 1;
      budget -= blockLength;
    }
    const omitted = files.length - included;
    const metaNote =
      omitted > 0 ? `(+${omitted} additional files omitted for brevity)` : null;
    const contentBlocks = glimpses.length ? glimpses : ["Workspace scan produced no narrative glimpses."];
    return {
      contentBlocks,
      metaNote,
      totalFiles: files.length,
    };
  }

  _renderGlimpsesText(glimpseInfo, limit = null) {
    if (!glimpseInfo) {
      return "Workspace scan produced no narrative glimpses.";
    }
    const blocks = Array.isArray(glimpseInfo.contentBlocks)
      ? glimpseInfo.contentBlocks.slice()
      : ["Workspace scan produced no narrative glimpses."];
    const total = Math.max(blocks.length, 1);
    const resolvedLimit =
      limit === null || limit === undefined ? total : Math.min(Math.max(Math.round(limit), 1), total);
    const selected = blocks.slice(0, resolvedLimit);
    const remaining = total - resolvedLimit;
    if (remaining > 0) {
      selected.push(`(+${remaining} additional files omitted after trimming the overview context)`);
    } else if (glimpseInfo.metaNote) {
      selected.push(glimpseInfo.metaNote);
    }
    return selected.join("\n\n");
  }

  _buildWorkspaceOverviewAttempts(glimpseInfo) {
    const progression = this.workspaceOverviewProgression ?? DEFAULT_OVERVIEW_PROGRESSIVE;
    const totalBlocks = Math.max(glimpseInfo?.contentBlocks?.length ?? 0, 1);
    const attempts = [];
    const seenLimits = new Set();
    progression.forEach((fraction, index) => {
      const normalized = Math.min(Math.max(Number(fraction) || 0, 0.05), 1);
      const limit = Math.max(1, Math.round(totalBlocks * normalized));
      if (seenLimits.has(limit)) {
        return;
      }
      seenLimits.add(limit);
      attempts.push({
        label: index === 0 ? "recompose:workspace-overview" : `recompose:workspace-overview-trim-${limit}`,
        glimpsesText: this._renderGlimpsesText(glimpseInfo, limit),
      });
    });
    if (!attempts.length) {
      attempts.push({
        label: "recompose:workspace-overview",
        glimpsesText: this._renderGlimpsesText(glimpseInfo),
      });
    }
    return attempts;
  }

  _composeWorkspaceOverviewPrompt({
    schemaInstructions,
    intro,
    glimpsesText,
    workspaceHints,
    metadataSummary,
    hintLabel = "Workspace hints",
  }) {
    const parts = [
      schemaInstructions,
      intro,
      `Glimpses:\n${glimpsesText}`,
      workspaceHints ? `${hintLabel}:\n${workspaceHints}` : null,
      metadataSummary,
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  async _readSnippet(filePath) {
    const content = await fs.promises.readFile(filePath, "utf8");
    return content.replace(/\r\n/g, "\n").slice(0, MAX_SNIPPET_CHARS);
  }

  _prioritizeOverviewFiles(files) {
    return [...(files ?? [])]
      .map((relative) => ({
        relative,
        score: this._overviewPriorityScore(relative),
      }))
      .sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative))
      .map((entry) => entry.relative);
  }

  _overviewPriorityScore(relativePath) {
    const normalized = (relativePath ?? "").toLowerCase();
    let score = 200 - normalized.length;
    if (normalized.includes("readme")) {
      score += 400;
    }
    for (const target of PRIORITY_REPAIR_TARGETS) {
      if (normalized.includes(target)) {
        score += 250;
      }
    }
    if (normalized.includes("/flows/")) {
      score += 120;
    }
    if (normalized.includes("/shared/")) {
      score += 90;
    }
    if (normalized.endsWith(".md")) {
      score += 40;
    }
    return score;
  }

  async _summarizeFileForOverview(baseDir, relativePath) {
    if (!relativePath) {
      return null;
    }
    const absolute = path.join(baseDir, relativePath);
    if (await this._isBinary(absolute)) {
      return null;
    }
    let raw;
    try {
      raw = await fs.promises.readFile(absolute, "utf8");
    } catch {
      return null;
    }
    const normalized = raw.replace(/\r\n/g, "\n").slice(0, MAX_SNIPPET_CHARS);
    const lines = normalized.split("\n");
    const summary = [];
    for (const line of lines) {
      if (summary.length >= MAX_OVERVIEW_SUMMARY_LINES) {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const comment = this._extractCommentNarrative(trimmed);
      if (comment) {
        summary.push(comment);
        continue;
      }
      const codeLine = this._summarizeCodeLine(trimmed);
      if (codeLine) {
        summary.push(codeLine);
      }
    }
    if (!summary.length) {
      const fallback = this._normalizeWhitespace(lines.slice(0, 6).join(" "));
      if (fallback) {
        summary.push(fallback.slice(0, 240));
      }
    }
    if (!summary.length) {
      return null;
    }
    return summary.map((line) => `- ${line}`).join("\n");
  }

  _extractCommentNarrative(line) {
    if (!line || !OVERVIEW_COMMENT_PREFIX.test(line)) {
      return null;
    }
    return line
      .replace(/^\/\*+/, "")
      .replace(/\*+\/$/, "")
      .replace(/^(?:\/\/+|#+|--|\*+)\s*/, "")
      .trim();
  }

  _summarizeCodeLine(line) {
    if (!line) {
      return null;
    }
    const fn = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (fn) {
      return `Defines function ${fn[1]}().`;
    }
    const arrow = line.match(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/);
    if (arrow) {
      return `Introduces helper ${arrow[1]} via arrow function.`;
    }
    const classMatch = line.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/);
    if (classMatch) {
      return `Declares class ${classMatch[1]}.`;
    }
    const importMatch = line.match(/^import\s+(?:.+)\s+from\s+["'](.+)["']/);
    if (importMatch) {
      return `Imports module ${importMatch[1]}.`;
    }
    const requireMatch = line.match(/^const\s+([A-Za-z0-9_$]+)\s*=\s*require\(["'](.+)["']\)/);
    if (requireMatch) {
      return `Requires module ${requireMatch[2]} as ${requireMatch[1]}.`;
    }
    const exportConst = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/);
    if (exportConst) {
      return `Exports constant ${exportConst[1]}.`;
    }
    if (/return\s+[{[]/.test(line)) {
      return "Returns a structured object.";
    }
    if (/logger\./i.test(line)) {
      return "Emits structured telemetry.";
    }
    return null;
  }

  _warnWorkspaceOverviewFallback(attemptCount) {
    const logLabel = this.promptLogPath ? this._relativeToCwd(this.promptLogPath) : null;
    const attempts = Number(attemptCount) || 1;
    const suffix = logLabel ? ` (see ${logLabel})` : "";
    console.warn(
      `[MiniPhi][Recompose] Workspace overview prompt failed after ${attempts} attempt${
        attempts === 1 ? "" : "s"
      }; saved a fallback summary built from file glimpses${suffix}. Re-run with --workspace-overview-timeout to grant Phi more time if needed.`,
    );
  }

  _normalizeWhitespace(text) {
    return (text ?? "").replace(/\s+/g, " ").trim();
  }

  async _captureBaselineSignatures(codeDir) {
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
    const files = await listWorkspaceFiles(codeDir, { ignoredDirs: this.ignoredDirs });
    for (const relativePath of files) {
      const absolute = path.join(codeDir, relativePath);
      if (await this._isBinary(absolute)) {
        continue;
      }
      try {
        const content = await fs.promises.readFile(absolute, "utf8");
        const exports = this._extractExports(content.split(/\r?\n/));
        const exportStyle = this._detectExportStyle(content);
        this.baselineSignatures.set(relativePath.replace(/\\/g, "/"), { exports, exportStyle });
      } catch {
        // ignore failures
      }
    }
  }

  _buildSchemaInstructions(schemaId, extraLines = []) {
    const lines = [
      "Return JSON only that matches the schema below. Do not include prose outside the JSON.",
      ...(Array.isArray(extraLines) ? extraLines : []),
    ];
    const schemaBlock = this.schemaRegistry?.buildInstructionBlock(schemaId, {
      compact: true,
      maxLength: 1600,
    });
    if (schemaBlock) {
      lines.push(`JSON schema:\n${schemaBlock}`);
    }
    return lines.filter(Boolean).join("\n\n");
  }

  _looksLikeJson(text) {
    const trimmed = String(text ?? "").trim();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }

  _extractJsonPayload(responseText) {
    const parsed = extractJsonBlock(responseText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  }

  _pickNarrativeField(payload, field, raw) {
    if (payload && typeof payload[field] === "string" && payload[field].trim()) {
      return payload[field];
    }
    if (raw && !this._looksLikeJson(raw)) {
      return String(raw);
    }
    return "";
  }

  _needsMoreContext(payload) {
    return Boolean(payload && typeof payload === "object" && payload.needs_more_context === true);
  }

  _missingSnippets(payload) {
    const missing = payload?.missing_snippets;
    if (!Array.isArray(missing)) {
      return [];
    }
    return missing
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }

  _warnContextRequest(label, payload) {
    if (!this._needsMoreContext(payload)) {
      return;
    }
    const missing = this._missingSnippets(payload);
    const missingNote = missing.length ? ` Missing: ${missing.join("; ")}` : "";
    console.warn(
      `[MiniPhi][Recompose] ${label ?? "prompt"} requested more context.${missingNote}`,
    );
  }

  async _promptJson(prompt, traceOptions = undefined) {
    const responseText = await this._promptPhi(prompt, traceOptions);
    const payload = this._extractJsonPayload(responseText);
    this._warnContextRequest(traceOptions?.label, payload);
    return { payload, raw: responseText };
  }

  _extractCodeFromPayload(payload, raw) {
    if (payload && typeof payload.code === "string" && payload.code.trim()) {
      return payload.code;
    }
    const fenced = this._extractCodeFromResponse(raw);
    if (fenced) {
      return fenced;
    }
    if (raw && !this._looksLikeJson(raw)) {
      return String(raw);
    }
    return null;
  }

  async _promptPhi(prompt, traceOptions = undefined) {
    const started = Date.now();
    let response = "";
    let error = null;
    const metadata = {
      sessionLabel: this.sessionLabel,
      workspaceSummary: this.workspaceContext?.summary ?? null,
      workspaceType: this.workspaceContext?.kind ?? "recompose",
      sample: this.sampleMetadata?.sampleName ?? null,
      plan: this.sampleMetadata?.plan?.name ?? null,
      schemaId: traceOptions?.schemaId ?? null,
      ...(traceOptions?.metadata ?? {}),
    };
    if (this.offlineFallbackActive) {
      if (this.verboseLogging) {
        console.warn(
          `[MiniPhi][Recompose][Prompt] ${traceOptions?.label ?? "prompt"} bypassed (offline fallback).`,
        );
      }
      await this._logPromptEvent({
        label: traceOptions?.label ?? this.promptLabel,
        prompt,
        response: "",
        error: "Phi-4 bypassed (offline fallback)",
        metadata: traceOptions?.metadata ?? null,
        durationMs: 0,
      });
      return "";
    }
    const overrideTimeout = Number(traceOptions?.timeoutMs);
    let restorePromptTimeout = null;
    const shouldOverrideTimeout =
      this.phi4 &&
      typeof this.phi4.setPromptTimeout === "function" &&
      Number.isFinite(overrideTimeout) &&
      overrideTimeout > 0;
    if (shouldOverrideTimeout) {
      restorePromptTimeout =
        typeof this.phi4.promptTimeoutMs === "number" ? this.phi4.promptTimeoutMs : null;
      this.phi4.setPromptTimeout(overrideTimeout);
    }
    try {
      response = await this.phi4.chatStream(prompt, undefined, undefined, undefined, {
        scope: "sub",
        label: traceOptions?.label ?? this.promptLabel,
        metadata,
        schemaId: traceOptions?.schemaId ?? null,
        responseFormat: traceOptions?.responseFormat ?? null,
      });
      return response;
    } catch (err) {
      error = err;
      this._handlePromptFailure(err);
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
      await this._logPromptEvent({
        label: traceOptions?.label ?? this.promptLabel,
        prompt,
        response,
        error,
        metadata: traceOptions?.metadata ?? null,
        durationMs: Date.now() - started,
      });
      if (shouldOverrideTimeout && restorePromptTimeout !== null) {
        this.phi4.setPromptTimeout(restorePromptTimeout);
      }
    }
  }

  _sanitizeNarrative(text) {
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

  _structureNarrative(text, label, fallbackFactory = null) {
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

  _extractCodeFromResponse(response) {
    if (!response) {
      return null;
    }
    const match = response.match(/```[a-z0-9+-]*\s*\r?\n([\s\S]*?)```/i);
    if (match) {
      return match[1];
    }
    return null;
  }

  async _startSession(label) {
    const slug = this._slugify(label ?? this.promptLabel ?? "recompose");
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

  async _writeSessionAsset(relativePath, content) {
    if (!this.sessionDir) {
      return null;
    }
    const target = path.join(this.sessionDir, relativePath);
    await this._ensureDir(path.dirname(target));
    await fs.promises.writeFile(target, content, "utf8");
    return target;
  }

  _safeSessionName(relativePath) {
    return relativePath.replace(/[\\/]+/g, "__");
  }

  async _logPromptEvent({ label, prompt, response, error, metadata, durationMs }) {
    if (!this.promptLogPath) {
      return;
    }
    const lines = [
      `[${new Date().toISOString()}][${label ?? "prompt"}] ${error ? "ERROR" : "OK"} (${durationMs ?? 0} ms)`,
      metadata ? `meta: ${JSON.stringify(metadata)}` : null,
      "Prompt:",
      this._truncateForLog(prompt),
      "Response:",
      error ? String(error instanceof Error ? error.message : error) : this._truncateForLog(response),
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
    await this._ensureDir(targetDir);
    const defaultName = `${this.sessionLabel ?? "recompose"}.prompts.log`;
    const fileHint = options.fileName ?? options.label ?? defaultName;
    const fileName = this._sanitizeExportName(fileHint);
    const destinationPath = path.join(targetDir, fileName);
    await fs.promises.copyFile(sourcePath, destinationPath);
    return destinationPath;
  }

  _truncateForLog(text) {
    if (!text) {
      return "(empty)";
    }
    const normalized = String(text).trim();
    if (normalized.length <= LOG_SNIPPET_LIMIT) {
      return normalized;
    }
    return `${normalized.slice(0, LOG_SNIPPET_LIMIT)}…`;
  }

  _fallbackFileNarrative({ relativePath, language, content }) {
    if (language === "markdown") {
      return this._fallbackMarkdownNarrative(relativePath, content);
    }
    const lines = content.split(/\r?\n/);
    const imports = this._extractImports(lines);
    const exports = this._extractExports(lines);
    const classNames = this._extractClasses(lines);
    const responsibilities = [];
    if (imports.length) {
      responsibilities.push(
        `Pulls in ${imports.length} helper${imports.length === 1 ? "" : "s"} (${this._summarizeList(imports)}).`,
      );
    }
    if (exports.length) {
      responsibilities.push(
        `Exposes ${exports.length} exported symbol${exports.length === 1 ? "" : "s"} (${this._summarizeList(exports)}).`,
      );
    }
    if (classNames.length) {
      responsibilities.push(`Defines class constructs such as ${this._summarizeList(classNames)}.`);
    }
    const approxLength = lines.length;
    const structure = [
      "## Purpose",
      `The file ${relativePath} operates as a ${language} module with roughly ${approxLength} line${approxLength === 1 ? "" : "s"}.`,
      responsibilities.length ? responsibilities.join(" ") : "It focuses on orchestration and light data shaping.",
      "## Key Elements",
      imports.length ? `- Dependencies: ${this._summarizeList(imports, 6)}` : "- Dependencies: internal-only helpers.",
      exports.length ? `- Public interface: ${this._summarizeList(exports, 6)}` : "- Public interface: internal utilities only.",
      classNames.length ? `- Classes: ${this._summarizeList(classNames, 4)}` : "- Classes: none, relies on functions.",
      "## Flow & Edge Cases",
      "Execution revolves around sanitizing input, coordinating helper utilities, and emitting structured results/logs. Edge cases are handled defensively (nullish names, insufficient samples, or missing state) prior to returning values.",
    ];
    return structure.join("\n\n");
  }

  _fallbackMarkdownNarrative(relativePath, content) {
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

  _sanitizeExportName(name) {
    const fallback = `${this._slugify(this.sessionLabel ?? "recompose")}.prompts.log`;
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

  _fallbackPlanFromNarrative(relativePath, narrative) {
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

  _fallbackWorkspaceSummaryFromCode(fileCount, glimpses) {
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

  _fallbackWorkspaceSummaryFromDescriptions(excerpts) {
    return [
      "## Architecture Rhythm",
      "Descriptions emphasize a greeting-to-analysis journey: values are validated, normalized, summarized, then logged.",
      "## Supporting Cast",
      `Narrative excerpts referenced modules such as flows/pipeline, math helpers, and persistence. Sample excerpt:\n${excerpts[0] ?? "n/a"}`,
      "## Risk Notes",
      "Maintaining prose-only files protects the benchmark from copy/paste shortcuts. When regenerating code, rely on the storyline rather than original syntax.",
    ].join("\n\n");
  }

  _handlePromptFailure(error) {
    if (this.offlineFallbackActive || this.promptFailureBudget <= 0) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!message || !/prompt session exceeded|model unloaded|connection/i.test(message)) {
      return;
    }
    this.promptFailureBudget -= 1;
    if (this.promptFailureBudget <= 0) {
      this.offlineFallbackActive = true;
      if (this.verboseLogging) {
        console.warn("[MiniPhi][Recompose] Enabling offline fallback after repeated Phi-4 failures.");
      }
    }
  }

  _buildOfflineCodeStub({ relativePath, blueprint, signature }) {
    const normalizedName = this._normalizeExportName(relativePath);
    const summary = this._normalizeWhitespace(blueprint?.narrative ?? "");
    const exports = Array.isArray(signature?.exports) && signature.exports.length ? signature.exports : null;
    const exportStyle = signature?.exportStyle ?? "commonjs";
    const lines = [];
    lines.push(`// Offline stub generated for ${relativePath}`);
    if (summary) {
      lines.push(`// Narrative excerpt: ${summary.slice(0, 200)}`);
    }
    if (exportStyle === "esm") {
      if (exports) {
        for (const name of exports) {
          const safe = this._normalizeExportName(name);
          lines.push(`export function ${safe}() {`);
          lines.push(`  throw new Error("Offline stub executed for ${relativePath}");`);
          lines.push("}");
        }
      } else {
        lines.push(`export default function ${normalizedName}Stub() {`);
        lines.push(`  throw new Error("Offline stub executed for ${relativePath}");`);
        lines.push("}");
      }
    } else {
      const exportNames = exports ?? [`${normalizedName}Stub`];
      for (const name of exportNames) {
        const safe = this._normalizeExportName(name);
        lines.push(`function ${safe}() {`);
        lines.push(`  throw new Error("Offline stub executed for ${relativePath}");`);
        lines.push("}");
      }
      if (exportNames.length === 1) {
        lines.push(`module.exports = ${this._normalizeExportName(exportNames[0])};`);
      } else {
        lines.push(
          `module.exports = { ${exportNames.map((name) => this._normalizeExportName(name)).join(", ")} };`,
        );
      }
    }
    return lines.join("\n");
  }

  _normalizeExportName(name) {
    if (!name) {
      return "offlineStub";
    }
    const sanitized = name.replace(/[^\w]/g, "_");
    return sanitized || "offlineStub";
  }

  _extractImports(lines) {
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

  _extractExports(lines) {
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

  _extractClasses(lines) {
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

  _summarizeList(items, limit = 5) {
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

  _detectExportStyle(source) {
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

  _codeContainsIdentifier(source, identifier) {
    if (!source || !identifier) {
      return false;
    }
    const pattern = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return pattern.test(source);
  }

  async _isBinary(filePath) {
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

  _languageFromExtension(ext) {
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

  _parseMarkdown(raw) {
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

  async _hashFile(filePath) {
    const content = await fs.promises.readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  }

  async _ensureDir(dirPath) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  async _cleanDir(targetDir) {
    await fs.promises.rm(targetDir, { recursive: true, force: true });
  }

  async _repairMismatches({ comparison, baselineDir, candidateDir }) {
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
    const prioritized = targets.sort((a, b) => this._repairPriority(b.path) - this._repairPriority(a.path));
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
        const repairContext = await this._buildDiffSummary({
          relativePath: target.path,
          type: target.type,
          baselineDir,
          candidateDir,
        });
        const code = await this._attemptCodeGeneration({
          relativePath: target.path,
          blueprint,
          signature,
          repairContext,
        });
        const destination = path.join(candidateDir, target.path);
        await this._ensureDir(path.dirname(destination));
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

  async _buildDiffSummary({ relativePath, type, baselineDir, candidateDir }) {
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
    const diff = this._summarizeDiff(baseline, candidate);
    return [
      `Repairs required for ${relativePath}`,
      baseline ? `Baseline preview:\n${this._truncateLine(baseline.slice(0, 400))}` : "Baseline preview unavailable.",
      type === "missing" ? "Candidate preview: file missing entirely." : `Candidate preview:\n${this._truncateLine(candidate.slice(0, 400))}`,
      diff ? `Diff sketch:\n${diff}` : "Diff sketch unavailable.",
    ].join("\n\n");
  }

  _summarizeDiff(baseline, candidate) {
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
      output.push(`- [${i + 1}] ${this._truncateLine(left)}`);
      output.push(`+ [${i + 1}] ${this._truncateLine(right)}`);
    }
    return output.length ? output.join("\n") : null;
  }

  _truncateLine(text, max = 160) {
    const normalized = (text ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "(empty)";
    }
    if (normalized.length <= max) {
      return normalized;
    }
    return `${normalized.slice(0, max)}…`;
  }

  _repairPriority(relativePath) {
    const normalized = relativePath.toLowerCase();
    if (PRIORITY_REPAIR_TARGETS.some((token) => normalized.includes(token))) {
      return 2;
    }
    return 1;
  }

  async _assertDirectory(dirPath, label) {
    try {
      const stats = await fs.promises.stat(dirPath);
      if (!stats.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error(`Missing ${label} directory: ${dirPath}`);
    }
  }

  _relativeToCwd(target) {
    if (!target) {
      return null;
    }
    const relative = path.relative(process.cwd(), target);
    if (relative && !relative.startsWith("..")) {
      return relative.replace(/\\/g, "/");
    }
    return target;
  }

  _slugify(text) {
    const normalized = (text ?? "")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized || "recompose";
  }

  _requirePhi() {
    if (!this.offlineFallbackActive && !this.phi4) {
      throw new Error("Phi-4 handler is required for live recompose benchmarks.");
    }
  }

  async _loadSampleMetadata(sampleDir, { codeDir, descriptionsDir } = {}) {
    if (!sampleDir) {
      this.sampleMetadata = null;
      return;
    }
    const readmeSnippet = await readReadmeSnippet({
      candidates: [
        path.join(sampleDir, "README.md"),
        path.join(sampleDir, "README.md.md"),
        codeDir ? path.join(codeDir, "README.md") : null,
        descriptionsDir ? path.join(descriptionsDir, "README.md") : null,
      ].filter(Boolean),
    });
    const plan = await this._readSamplePlan(sampleDir);
    const manifestResult = codeDir
      ? await collectManifestSummary(codeDir, { ignoredDirs: this.ignoredDirs, limit: 12 })
      : { manifest: [] };
    this.sampleMetadata = {
      sampleDir,
      sampleName: path.basename(sampleDir),
      readmeSnippet,
      plan,
      manifest: manifestResult.manifest,
    };
  }

  async _readSamplePlan(sampleDir) {
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
          path: this._relativeToCwd(absolute),
          runs: Array.isArray(data?.runs) ? data.runs.length : 0,
        };
      } catch {
        // ignore parse errors
      }
    }
    return null;
  }

  _needsWorkspaceRetry(text) {
    if (!text) {
      return true;
    }
    return WORKSPACE_RETRY_PATTERNS.some((regex) => regex.test(text));
  }
}
