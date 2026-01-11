import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import YAML from "yaml";
import { parseStrictJsonObject } from "./core-utils.js";
import { writeFileWithGuard } from "./file-edit-guard.js";
import {
  buildWorkspaceOverviewAttempts,
  codeContainsIdentifier,
  composeWorkspaceOverviewPrompt,
  detectExportStyle,
  extractClasses,
  extractCommentNarrative,
  extractExports,
  extractImports,
  hasDefaultExport,
  languageFromExtension,
  normalizeExportName,
  normalizeSnippetLabel,
  normalizeWhitespace,
  parseMarkdown,
  prioritizeOverviewFiles,
  relativeToCwd,
  renderGlimpsesText,
  safeSessionName,
  sanitizeNarrative,
  sanitizeExportName,
  slugify,
  structureNarrative,
  summarizeCodeLine,
  summarizeDiff,
  summarizeList,
  truncateBlock,
  truncateLine,
  warnWorkspaceOverviewFallback,
} from "./recompose-utils.js";
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
const DEFAULT_OVERVIEW_TIMEOUT_MS = 120000;
const DEFAULT_OVERVIEW_PROGRESSIVE = [1, 0.65, 0.35];
const RECOMPOSE_SCHEMA_IDS = {
  workspace: "recompose-workspace-overview",
  narrative: "recompose-file-narrative",
  plan: "recompose-file-plan",
  codegen: "recompose-codegen",
};
const DEFAULT_AGENT_OBJECTIVE =
  "Recompose runs as a natural-language unit test of the MiniPhi agent (via src/index.js) rather than a standalone code-only harness.";

// Natural-language MiniPhi agent unit-test harness (recompose), not a recomposition-only library.
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
    this.descriptionDir = null;
    this.codeDir = null;
    this.codeFiles = null;
    this.descriptionFiles = null;
    this.sessionDir = null;
    this.sessionLabel = null;
    this.promptLogPath = null;
    this.editDir = null;
    this.editLogPath = null;
    this.editLogQueue = Promise.resolve();
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
    this.agentObjective =
      typeof options.agentObjective === "string" && options.agentObjective.trim()
        ? options.agentObjective.trim()
        : DEFAULT_AGENT_OBJECTIVE;
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
    this.codeDir = codeDir;
    this.descriptionDir = descriptionsDir;
    this.codeFiles = null;
    this.descriptionFiles = null;
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
      sampleDir: relativeToCwd(sampleDir),
      codeDir: relativeToCwd(codeDir),
      descriptionsDir: relativeToCwd(descriptionsDir),
      outputDir: relativeToCwd(outputDir),
      steps,
      sessionDir: relativeToCwd(this.sessionDir),
      promptLog: relativeToCwd(this.promptLogPath),
      editDir: relativeToCwd(this.editDir),
      editLog: relativeToCwd(this.editLogPath),
      workspaceContext: this.workspaceContext
        ? {
            kind: this.workspaceContext.kind,
            summary: this.workspaceContext.summary,
            sourceDir: relativeToCwd(this.workspaceContext.sourceDir),
            purpose: this.workspaceContext.purpose ?? this.agentObjective ?? null,
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
    this.codeDir = sourceDir;
    this.codeFiles = files;
    const workspaceSummary = await this._ensureWorkspaceSummaryFromCode(sourceDir, files);
    let converted = 0;
    let skipped = 0;
    let cacheHits = 0;
    let unchanged = 0;
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
          const language = languageFromExtension(path.extname(relativePath));
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
        const writeResult = await this._writeFileWithGuard({
          relativePath: `${relativePath}.md`,
          targetPath: target,
          content: document,
          phase: "code-to-markdown",
        });
        if (writeResult.status === "unchanged") {
          unchanged += 1;
        }
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
      unchanged,
      concurrency: workerCount,
      descriptionsDir: relativeToCwd(targetDir),
    };
  }

  async markdownToCode({ sourceDir, targetDir }) {
    const start = Date.now();
    const files = (await listWorkspaceFiles(sourceDir, { ignoredDirs: this.ignoredDirs })).filter((file) =>
      file.toLowerCase().endsWith(".md"),
    );
    this.descriptionDir = sourceDir;
    this.descriptionFiles = files;
    const workspaceSummary = await this._ensureWorkspaceSummaryFromDescriptions(sourceDir, files);
    let converted = 0;
    let unchanged = 0;
    const warnings = [];

    for (const relativePath of files) {
      const absolute = path.join(sourceDir, relativePath);
      const raw = await fs.promises.readFile(absolute, "utf8");
      const { metadata, body } = parseMarkdown(raw);
      const narrative = body.trim();
      if (!narrative) {
        warnings.push({ path: relativePath, reason: "missing narrative content" });
        continue;
      }
      const targetPathRelative =
        metadata.source ?? relativePath.replace(/\.md$/i, "").replace(/\\/g, "/");
      const language = metadata.language ?? languageFromExtension(path.extname(targetPathRelative));
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
        const writeResult = await this._writeFileWithGuard({
          relativePath: targetPathRelative,
          targetPath,
          content: `${code.replace(/\s+$/, "")}\n`,
          phase: "markdown-to-code",
        });
        if (writeResult.status === "unchanged") {
          unchanged += 1;
        }
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
      unchanged,
      outputDir: relativeToCwd(targetDir),
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
        'Only set "needs_more_context" to true if the narrative cannot be completed at all; otherwise set it to false.',
        'If more context is required, list repo-relative file paths (e.g., src/index.js) in "missing_snippets".',
      ]),
      this._agentObjectiveLine(
        "Recompose is a natural-language MiniPhi agent unit test invoked via src/index.js; avoid treating this as a standalone recomposition-only helper.",
      ),
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
    const structured = structureNarrative(
      sanitizeNarrative(this._pickNarrativeField(payload, "narrative", raw)),
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
      path.join("files", `${safeSessionName(relativePath)}.md`),
      `# Narrative for ${relativePath}\n\n${structured}\n`,
    );
    return document;
  }

  async _planCodeFromNarrative({ relativePath, narrative, workspaceSummary }) {
    const prompt = [
      this._buildSchemaInstructions(RECOMPOSE_SCHEMA_IDS.plan, [
        'Populate "plan" with markdown headings for Inputs, Transformations, Outputs, and Failure Modes.',
        'Use the optional arrays (inputs, transformations, outputs, failure_modes) when they help summarize details.',
        'Only set "needs_more_context" to true if the plan cannot be completed at all; otherwise set it to false.',
        'If more context is required, list repo-relative file paths (e.g., src/index.js) in "missing_snippets".',
      ]),
      this._agentObjectiveLine(
        "Recompose is framed as a natural-language MiniPhi agent unit test; shape the plan so the main CLI prompt flow can execute it end-to-end.",
      ),
      "You previously helped convert code into prose for a secure recomposition test.",
      "Given the narrative description, outline the concrete implementation strategy.",
      "Describe the modules, helper functions, and edge cases that must exist.",
      "Return markdown with headings for Inputs, Transformations, Outputs, and Failure Modes. Do not write code.",
      `Workspace overview:\n${workspaceSummary}`,
      formatMetadataSummary(this.sampleMetadata),
      `Narrative for ${relativePath}:\n${narrative}`,
    ].join("\n\n");
    let response = await this._promptJson(prompt, {
      label: "recompose:file-plan",
      schemaId: RECOMPOSE_SCHEMA_IDS.plan,
      metadata: { file: relativePath },
    });
    let planText = sanitizeNarrative(
      this._pickNarrativeField(response.payload, "plan", response.raw),
    );
    if (this._needsMoreContext(response.payload)) {
      const missing = this._missingSnippets(response.payload);
      const extraContext = await this._collectMissingContext({
        relativePath,
        missingSnippets: missing,
      });
      if (extraContext) {
        const contextPrompt = [
          prompt,
          "Additional context requested by the previous response:",
          extraContext,
          "Use the added context to complete the plan. Return JSON only.",
        ].join("\n\n");
        response = await this._promptJson(contextPrompt, {
          label: "recompose:file-plan-context",
          schemaId: RECOMPOSE_SCHEMA_IDS.plan,
          metadata: { file: relativePath },
        });
        planText = sanitizeNarrative(
          this._pickNarrativeField(response.payload, "plan", response.raw),
        );
      }
    }
    const plan = structureNarrative(planText, relativePath, () =>
      this._fallbackPlanFromNarrative(relativePath, narrative),
    );
    await this._writeSessionAsset(
      path.join("plans", `${safeSessionName(relativePath)}.md`),
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
        'If more context is required, list repo-relative file paths (e.g., src/index.js) in "missing_snippets".',
      ]),
      this._agentObjectiveLine(
        "Recompose acts as a natural-language MiniPhi agent unit test routed through src/index.js; lean on the model rather than bespoke recomposition-only heuristics.",
      ),
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
    if (this._needsMoreContext(response.payload)) {
      const missing = this._missingSnippets(response.payload);
      const extraContext = await this._collectMissingContext({ relativePath, missingSnippets: missing });
      if (!extraContext) {
        const missingNote = missing.length ? ` Missing: ${missing.join("; ")}` : "";
        throw new Error(`Recompose codegen needs more context for ${relativePath}.${missingNote}`);
      }
      const contextPrompt = [
        ...basePrompt,
        "Additional context requested by the previous response:",
        extraContext,
        "Use the added context to rebuild the file. Return JSON only.",
      ];
      response = await this._promptJson(contextPrompt.join("\n\n"), {
        label: "recompose:codegen-context",
        schemaId: RECOMPOSE_SCHEMA_IDS.codegen,
        metadata: { file: relativePath, language },
      });
      if (this._needsMoreContext(response.payload)) {
        const retryMissing = this._missingSnippets(response.payload);
        const retryNote = retryMissing.length ? ` Missing: ${retryMissing.join("; ")}` : "";
        throw new Error(`Recompose codegen still needs more context for ${relativePath}.${retryNote}`);
      }
    }
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
        throw new Error(`${this._modelLabel()} response did not include code after retry.`);
      }
    }
    await this._writeSessionAsset(
      path.join("code", `${safeSessionName(relativePath)}.txt`),
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
      const detected = detectExportStyle(code);
      if (!detected) {
        issues.push(
          `File ${relativePath} must use ${signature.exportStyle === "esm" ? "ES module exports" : "module.exports"} syntax, but no export style was detected.`,
        );
      } else if (signature.exportStyle !== detected) {
        issues.push(
          `File ${relativePath} must use ${signature.exportStyle === "esm" ? "ES module exports" : "module.exports"} syntax.`,
        );
      }
    }
    if (signature.hasDefaultExport && !hasDefaultExport(code)) {
      issues.push(`File ${relativePath} must include an export default declaration.`);
    }
    if (signature.exports?.length) {
      const missing = signature.exports.filter((name) => !codeContainsIdentifier(code, name));
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
    const glimpses = renderGlimpsesText(glimpsesInfo);
    const workspaceHints = buildWorkspaceHintBlock(
      files,
      sourceDir,
      this.sampleMetadata?.readmeSnippet,
      { limit: 12 },
    );
    const overviewAttempts = [];
    const overviewIntro = [
      this._agentObjectiveLine(
        "Treat this overview as the natural-language setup for the MiniPhi agent rather than a recomposition-only harness.",
      ),
      "Survey the workspace and narrate the protagonist's goals.",
      "Produce sections for Architecture Rhythm, Supporting Cast, and Risk Notes.",
      "Avoid listing file names explicitly; rely on behaviors and interactions.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const metadataSummary = formatMetadataSummary(this.sampleMetadata);
    const schemaInstructions = this._buildSchemaInstructions(RECOMPOSE_SCHEMA_IDS.workspace, [
      'Populate "summary" with the narrative overview using markdown headings for Architecture Rhythm, Supporting Cast, and Risk Notes.',
      'Only set "needs_more_context" to true if the overview cannot be completed at all; otherwise set it to false.',
      'If more context is required, list repo-relative file paths (e.g., src/index.js) in "missing_snippets".',
    ]);
    const attempts = buildWorkspaceOverviewAttempts(glimpsesInfo, {
      progression: this.workspaceOverviewProgression ?? DEFAULT_OVERVIEW_PROGRESSIVE,
    });
    let summaryText = "";
    for (const attempt of attempts) {
      const prompt = composeWorkspaceOverviewPrompt({
        schemaInstructions,
        intro: overviewIntro,
        glimpsesText: attempt.glimpsesText,
        workspaceHints,
        metadataSummary,
      });
      let response = await this._promptJson(prompt, {
        label: attempt.label,
        timeoutMs: this.workspaceOverviewTimeoutMs,
        schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
      });
      let payload = response.payload;
      let raw = response.raw;
      summaryText = sanitizeNarrative(this._pickNarrativeField(payload, "summary", raw));
      overviewAttempts.push({ label: attempt.label, raw, summary: summaryText });
      if (this._needsMoreContext(payload)) {
        const missing = this._missingSnippets(payload);
        const extraContext = await this._collectMissingContext({
          relativePath: "workspace",
          missingSnippets: missing,
        });
        if (extraContext) {
          const contextPrompt = [
            composeWorkspaceOverviewPrompt({
              schemaInstructions,
              intro: overviewIntro,
              glimpsesText: attempt.glimpsesText,
              workspaceHints,
              metadataSummary,
            }),
            "Additional context requested by the previous response:",
            extraContext,
            "Use the added context to complete the overview. Return JSON only.",
          ].join("\n\n");
          response = await this._promptJson(contextPrompt, {
            label: `${attempt.label}-context`,
            timeoutMs: this.workspaceOverviewTimeoutMs,
            schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
          });
          payload = response.payload;
          raw = response.raw;
          summaryText = sanitizeNarrative(this._pickNarrativeField(payload, "summary", raw));
          overviewAttempts.push({ label: `${attempt.label}-context`, raw, summary: summaryText });
        }
      }
      const needsRetry = this._needsMoreContext(payload) || this._needsWorkspaceRetry(summaryText);
      if (needsRetry) {
        const retryPrompt = composeWorkspaceOverviewPrompt({
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
        summaryText = sanitizeNarrative(
          this._pickNarrativeField(retryResponse.payload, "summary", retryResponse.raw),
        );
        overviewAttempts.push({
          label: `${attempt.label}-retry`,
          raw: retryResponse.raw,
          summary: summaryText,
        });
        if (!this._needsMoreContext(retryResponse.payload) && summaryText?.trim()) {
          break;
        }
      }
      if (summaryText?.trim()) {
        break;
      }
    }
    let fallbackUsed = false;
    let partialOverview = null;
    let partialOverviewPath = null;
    const summary = structureNarrative(
      summaryText,
      "workspace",
      () => {
        fallbackUsed = true;
        return this._fallbackWorkspaceSummaryFromCode(files.length, glimpses);
      },
    );
    if (fallbackUsed) {
      partialOverview = this._capturePartialOverview(overviewAttempts);
      if (partialOverview?.content) {
        partialOverviewPath = await this._writeSessionAsset(
          "workspace-overview.partial.md",
          `# Partial workspace overview attempts\n\n${partialOverview.content}\n`,
        );
      }
      warnWorkspaceOverviewFallback({
        promptLogPath: this.promptLogPath,
        attemptCount: attempts.length,
        partialPath: partialOverviewPath,
        partialPreview: partialOverview?.preview,
      });
    }
    this.workspaceContext = {
      kind: "code",
      summary,
      sourceDir,
      metadata: this.sampleMetadata,
      overviewStatus: fallbackUsed ? "fallback" : "ok",
      partialOverviewPath: partialOverviewPath ? relativeToCwd(partialOverviewPath) : null,
      partialOverview: fallbackUsed ? partialOverview?.preview ?? null : null,
      purpose: this.agentObjective,
    };
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
        const { body } = parseMarkdown(raw);
        return `### ${relativePath}\n${body.split(/\n+/).slice(0, 6).join("\n")}`;
      }),
    );
    const prompt = [
      this._buildSchemaInstructions(RECOMPOSE_SCHEMA_IDS.workspace, [
        'Populate "summary" with the narrative overview of the workspace.',
        'Only set "needs_more_context" to true if the overview cannot be completed at all; otherwise set it to false.',
        'If more context is required, list repo-relative file paths (e.g., src/index.js) in "missing_snippets".',
      ]),
      this._agentObjectiveLine(
        "This run treats recompose as a natural-language MiniPhi agent unit test; summarize so the agent can act through the main CLI without a bespoke recomposition layer.",
      ),
      "The workspace contains prose-only descriptions of code files.",
      `Summarize the project from these excerpts so ${this._modelLabel()} can rebuild it.`,
      `Excerpts:\n${excerpts.join("\n\n")}`,
      formatMetadataSummary(this.sampleMetadata),
    ].join("\n\n");
    let summaryPayload = await this._promptJson(prompt, {
      label: "recompose:workspace-from-descriptions",
      schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
    });
    let summaryText = sanitizeNarrative(
      this._pickNarrativeField(summaryPayload.payload, "summary", summaryPayload.raw),
    );
    if (this._needsMoreContext(summaryPayload.payload)) {
      const missing = this._missingSnippets(summaryPayload.payload);
      const extraContext = await this._collectMissingContext({
        relativePath: "workspace",
        missingSnippets: missing,
      });
      if (extraContext) {
        const contextPrompt = [
          prompt,
          "Additional context requested by the previous response:",
          extraContext,
          "Use the added context to complete the overview. Return JSON only.",
        ].join("\n\n");
        summaryPayload = await this._promptJson(contextPrompt, {
          label: "recompose:workspace-from-descriptions-context",
          schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
        });
        summaryText = sanitizeNarrative(
          this._pickNarrativeField(summaryPayload.payload, "summary", summaryPayload.raw),
        );
      }
    }
    if (this._needsMoreContext(summaryPayload.payload) || this._needsWorkspaceRetry(summaryText)) {
      const retryPrompt = [
        prompt,
        buildWorkspaceHintBlock(files, sourceDir, this.sampleMetadata?.readmeSnippet),
      ].join("\n\n");
      summaryPayload = await this._promptJson(retryPrompt, {
        label: "recompose:workspace-from-descriptions-retry",
        schemaId: RECOMPOSE_SCHEMA_IDS.workspace,
      });
      summaryText = sanitizeNarrative(
        this._pickNarrativeField(summaryPayload.payload, "summary", summaryPayload.raw),
      );
    }
    const summary = structureNarrative(
      summaryText,
      "workspace",
      () => this._fallbackWorkspaceSummaryFromDescriptions(excerpts),
    );
    this.workspaceContext = {
      kind: "descriptions",
      summary,
      sourceDir,
      metadata: this.sampleMetadata,
      purpose: this.agentObjective,
    };
    await this._writeSessionAsset(WORKSPACE_OVERVIEW_FILE, `# Workspace Overview\n\n${summary}\n`);
    return summary;
  }

  async _collectGlimpses(baseDir, files) {
    if (!Array.isArray(files) || files.length === 0) {
      return "Workspace scan produced no narrative glimpses.";
    }
    const prioritized = prioritizeOverviewFiles(files, PRIORITY_REPAIR_TARGETS);
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

  _capturePartialOverview(attempts = []) {
    if (!Array.isArray(attempts) || !attempts.length) {
      return null;
    }
    const blocks = [];
    let previewSource = null;
    for (const attempt of attempts) {
      const normalizedSummary = sanitizeNarrative(attempt?.summary ?? "");
      const normalizedRaw = attempt?.raw ? sanitizeNarrative(attempt.raw) : "";
      if (!previewSource && normalizedSummary) {
        previewSource = normalizedSummary;
      } else if (!previewSource && normalizedRaw) {
        previewSource = normalizedRaw;
      }
      const parts = [];
      if (attempt?.label) {
        parts.push(`## ${attempt.label}`);
      }
      if (normalizedSummary) {
        parts.push(normalizedSummary);
      } else if (attempt?.raw) {
        parts.push(this._truncateForLog(attempt.raw));
      }
      if (parts.length) {
        blocks.push(parts.join("\n\n"));
      }
    }
    if (!blocks.length || !previewSource) {
      return null;
    }
    const preview = truncateLine(normalizeWhitespace(previewSource), 220);
    return {
      content: blocks.join("\n\n"),
      preview,
    };
  }

  async _readSnippet(filePath) {
    const content = await fs.promises.readFile(filePath, "utf8");
    return content.replace(/\r\n/g, "\n").slice(0, MAX_SNIPPET_CHARS);
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
      const comment = extractCommentNarrative(trimmed);
      if (comment) {
        summary.push(comment);
        continue;
      }
      const codeLine = summarizeCodeLine(trimmed);
      if (codeLine) {
        summary.push(codeLine);
      }
    }
    if (!summary.length) {
      const fallback = normalizeWhitespace(lines.slice(0, 6).join(" "));
      if (fallback) {
        summary.push(fallback.slice(0, 240));
      }
    }
    if (!summary.length) {
      return null;
    }
    return summary.map((line) => `- ${line}`).join("\n");
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
        const exports = extractExports(content.split(/\r?\n/));
        const exportStyle = detectExportStyle(content);
        const hasDefaultExport = hasDefaultExport(content);
        this.baselineSignatures.set(relativePath.replace(/\\/g, "/"), {
          exports,
          exportStyle,
          hasDefaultExport,
        });
      } catch {
        // ignore failures
      }
    }
  }

  _agentObjectiveLine(extra = null) {
    const base =
      typeof this.agentObjective === "string" && this.agentObjective.trim()
        ? this.agentObjective.trim()
        : DEFAULT_AGENT_OBJECTIVE;
    const suffix = typeof extra === "string" && extra.trim() ? extra.trim() : "";
    const combined = [base, suffix].filter(Boolean).join(" ");
    return combined || null;
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
    const parsed = parseStrictJsonObject(responseText);
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

  async _collectMissingContext({ relativePath, missingSnippets }) {
    if (!Array.isArray(missingSnippets) || missingSnippets.length === 0) {
      return null;
    }
    const sections = [];
    for (const snippet of missingSnippets) {
      const label = normalizeSnippetLabel(snippet);
      if (!label) {
        continue;
      }
      const candidates = this._resolveMissingSnippetCandidates(label);
      let selected = null;
      let block = [];
      for (const candidate of candidates) {
        const parts = [];
        const blueprint = this._lookupBlueprint(candidate);
        if (blueprint?.narrative) {
          parts.push(`Narrative:\n${truncateBlock(blueprint.narrative)}`);
        }
        if (blueprint?.plan) {
          parts.push(`Plan:\n${truncateBlock(blueprint.plan)}`);
        }
        if (!parts.length) {
          const description = await this._loadDescriptionSnippet(candidate);
          if (description) {
            parts.push(`Narrative:\n${truncateBlock(description)}`);
          }
        }
        if (!parts.length) {
          const codeSnippet = await this._loadCodeSnippet(candidate);
          if (codeSnippet) {
            parts.push(`Source excerpt:\n${truncateBlock(codeSnippet)}`);
          }
        }
        if (parts.length) {
          selected = candidate;
          block = parts;
          break;
        }
      }
      if (block.length) {
        const heading = selected && selected !== label ? `${label} (${selected})` : label;
        sections.push([`### ${heading}`, block.join("\n\n")].join("\n"));
      }
    }
    if (!sections.length) {
      return null;
    }
    return [
      `The missing context applies to ${relativePath}.`,
      ...sections,
    ].join("\n\n");
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
    return null;
  }

  _modelLabel() {
    return this.phi4?.modelKey ?? "model";
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
        error: `${this._modelLabel()} bypassed (offline fallback)`,
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

  async _startSession(label) {
    const slug = slugify(label ?? this.promptLabel ?? "recompose");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const root = this.sessionRoot ?? path.join(process.cwd(), ".miniphi", "recompose");
    this.sessionDir = path.join(root, `${timestamp}-${slug}`);
    this.sessionLabel = slug;
    this.workspaceContext = null;
    await fs.promises.mkdir(path.join(this.sessionDir, "files"), { recursive: true });
    await fs.promises.mkdir(path.join(this.sessionDir, "plans"), { recursive: true });
    await fs.promises.mkdir(path.join(this.sessionDir, "code"), { recursive: true });
    this.editDir = path.join(this.sessionDir, "edits");
    await fs.promises.mkdir(this.editDir, { recursive: true });
    this.editLogPath = path.join(this.editDir, "edits.jsonl");
    this.editLogQueue = Promise.resolve();
    this.promptLogPath = path.join(this.sessionDir, "prompts.log");
    const header = [
      `# MiniPhi Agent Prompt Log (recompose unit test)`,
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

  async _logEditEntry(entry) {
    if (!this.editLogPath) {
      return;
    }
    const payload = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    const line = `${JSON.stringify(payload)}\n`;
    const append = async () => {
      await fs.promises.appendFile(this.editLogPath, line, "utf8");
    };
    this.editLogQueue = this.editLogQueue.then(append, append).catch(() => {});
    return this.editLogQueue;
  }

  async _writeFileWithGuard({ relativePath, targetPath, content, phase, expectedHash = null }) {
    const logPath = relativePath ? relativePath.replace(/\\/g, "/") : relativeToCwd(targetPath) ?? targetPath;
    const result = await writeFileWithGuard({
      targetPath,
      content,
      expectedHash,
      rollbackDir: this.editDir,
      rollbackLabel: logPath,
      diffSummaryFn: summarizeDiff,
    });
    await this._logEditEntry({
      phase: phase ?? "edit",
      path: logPath,
      status: result.status,
      beforeHash: result.beforeHash ?? null,
      afterHash: result.afterHash ?? null,
      expectedHash: result.expectedHash ?? null,
      diffSummary: result.diffSummary ?? null,
      rollbackPath: result.rollbackPath ? relativeToCwd(result.rollbackPath) : null,
      rollbackError: result.rollbackError ?? null,
      error: result.error ?? null,
    });
    if (result.status === "hash-mismatch") {
      throw new Error(`Edit guard blocked write for ${logPath} (hash mismatch).`);
    }
    if (result.status === "failed" || result.status === "rollback") {
      const note = result.error ? ` ${result.error}` : "";
      throw new Error(`Write failed for ${logPath}.${note}`);
    }
    return result;
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
    const fileName = sanitizeExportName(fileHint, this.sessionLabel ?? "recompose");
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
    const imports = extractImports(lines);
    const exports = extractExports(lines);
    const classNames = extractClasses(lines);
    const responsibilities = [];
    if (imports.length) {
      responsibilities.push(
        `Pulls in ${imports.length} helper${imports.length === 1 ? "" : "s"} (${summarizeList(imports)}).`,
      );
    }
    if (exports.length) {
      responsibilities.push(
        `Exposes ${exports.length} exported symbol${exports.length === 1 ? "" : "s"} (${summarizeList(exports)}).`,
      );
    }
    if (classNames.length) {
      responsibilities.push(`Defines class constructs such as ${summarizeList(classNames)}.`);
    }
    const approxLength = lines.length;
    const structure = [
      "## Purpose",
      `The file ${relativePath} operates as a ${language} module with roughly ${approxLength} line${approxLength === 1 ? "" : "s"}.`,
      responsibilities.length ? responsibilities.join(" ") : "It focuses on orchestration and light data shaping.",
      "## Key Elements",
      imports.length ? `- Dependencies: ${summarizeList(imports, 6)}` : "- Dependencies: internal-only helpers.",
      exports.length ? `- Public interface: ${summarizeList(exports, 6)}` : "- Public interface: internal utilities only.",
      classNames.length ? `- Classes: ${summarizeList(classNames, 4)}` : "- Classes: none, relies on functions.",
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
        console.warn(
          `[MiniPhi][Recompose] Enabling offline fallback after repeated ${this._modelLabel()} failures.`,
        );
      }
    }
  }

  _buildOfflineCodeStub({ relativePath, blueprint, signature }) {
    const normalizedName = normalizeExportName(relativePath);
    const summary = normalizeWhitespace(blueprint?.narrative ?? "");
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
          const safe = normalizeExportName(name);
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
        const safe = normalizeExportName(name);
        lines.push(`function ${safe}() {`);
        lines.push(`  throw new Error("Offline stub executed for ${relativePath}");`);
        lines.push("}");
      }
      if (exportNames.length === 1) {
        lines.push(`module.exports = ${normalizeExportName(exportNames[0])};`);
      } else {
        lines.push(
          `module.exports = { ${exportNames.map((name) => normalizeExportName(name)).join(", ")} };`,
        );
      }
    }
    return lines.join("\n");
  }

  _lookupBlueprint(label) {
    if (!label) {
      return null;
    }
    const normalized = label.replace(/\\/g, "/");
    const withoutMd = normalized.replace(/\.md$/i, "");
    if (this.fileBlueprints.has(withoutMd)) {
      return this.fileBlueprints.get(withoutMd);
    }
    if (this.fileBlueprints.has(normalized)) {
      return this.fileBlueprints.get(normalized);
    }
    const needle = withoutMd.toLowerCase();
    for (const [key, value] of this.fileBlueprints.entries()) {
      const keyLower = key.toLowerCase();
      if (keyLower.endsWith(needle) || path.posix.basename(keyLower) === needle) {
        return value;
      }
    }
    return null;
  }

  _findWorkspaceMatches(label) {
    if (!label) {
      return [];
    }
    const files = Array.isArray(this.codeFiles) ? this.codeFiles : [];
    if (!files.length) {
      return [];
    }
    const normalized = label.replace(/\\/g, "/").toLowerCase();
    if (!normalized) {
      return [];
    }
    const base = path.posix.basename(normalized);
    const baseNoExt = base.replace(/\.[^.]+$/, "");
    const tokenSet = new Set(
      normalized
        .split(/[^a-z0-9_.-]+/)
        .map((token) => token.trim())
        .filter(Boolean),
    );
    const matches = [];
    for (const file of files) {
      const normalizedFile = file.replace(/\\/g, "/").toLowerCase();
      const fileBase = path.posix.basename(normalizedFile);
      const fileBaseNoExt = fileBase.replace(/\.[^.]+$/, "");
      if (
        normalizedFile === normalized ||
        normalizedFile.endsWith(`/${normalized}`) ||
        fileBase === base ||
        (baseNoExt && fileBaseNoExt === baseNoExt) ||
        (fileBaseNoExt.length >= 4 && tokenSet.has(fileBaseNoExt))
      ) {
        matches.push(file.replace(/\\/g, "/"));
      }
    }
    return matches;
  }

  _resolveMissingSnippetCandidates(label) {
    const normalized = normalizeSnippetLabel(label);
    if (!normalized) {
      return [];
    }
    const normalizedPath = normalized.replace(/\\/g, "/").trim();
    const candidates = new Set();
    const addCandidate = (value) => {
      const entry = value ? value.replace(/\\/g, "/").trim() : "";
      if (entry) {
        candidates.add(entry);
      }
    };
    addCandidate(normalizedPath);
    const pathMatches = normalizedPath.match(/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g);
    if (pathMatches) {
      pathMatches.forEach((match) => addCandidate(match));
    }
    this._findWorkspaceMatches(normalizedPath).forEach((match) => addCandidate(match));
    if (pathMatches) {
      pathMatches.forEach((match) => {
        this._findWorkspaceMatches(match).forEach((resolved) => addCandidate(resolved));
      });
    }
    return Array.from(candidates);
  }

  async _loadDescriptionSnippet(label) {
    if (!label || !this.descriptionDir) {
      return null;
    }
    const normalized = label.replace(/\\/g, "/");
    const candidates = normalized.endsWith(".md")
      ? [normalized, `${normalized}.md`]
      : [`${normalized}.md`];
    for (const candidate of candidates) {
      const absolute = path.join(this.descriptionDir, ...candidate.split("/"));
      try {
        const raw = await fs.promises.readFile(absolute, "utf8");
        const { body } = parseMarkdown(raw);
        const trimmed = body.trim();
        if (trimmed) {
          return trimmed;
        }
      } catch {
        // ignore missing snippets
      }
    }
    return null;
  }

  async _loadCodeSnippet(label) {
    if (!label || !this.codeDir) {
      return null;
    }
    const normalized = label.replace(/\\/g, "/");
    const absolute = path.join(this.codeDir, ...normalized.split("/"));
    try {
      if (await this._isBinary(absolute)) {
        return null;
      }
      const raw = await fs.promises.readFile(absolute, "utf8");
      const trimmed = raw.replace(/\r\n/g, "\n").trim();
      if (!trimmed) {
        return null;
      }
      return trimmed.slice(0, MAX_SNIPPET_CHARS);
    } catch {
      return null;
    }
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
        const writeResult = await this._writeFileWithGuard({
          relativePath: target.path,
          targetPath: destination,
          content: `${code.replace(/\s+$/, "")}\n`,
          phase: "repair",
        });
        if (writeResult.status === "unchanged") {
          summary.skipped.push({
            path: target.path,
            reason: "Generated code matched the existing candidate; no write needed.",
          });
        } else {
          summary.repaired += 1;
        }
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
    const diff = summarizeDiff(baseline, candidate);
    return [
      `Repairs required for ${relativePath}`,
      baseline ? `Baseline preview:\n${truncateLine(baseline.slice(0, 400))}` : "Baseline preview unavailable.",
      type === "missing" ? "Candidate preview: file missing entirely." : `Candidate preview:\n${truncateLine(candidate.slice(0, 400))}`,
      diff ? `Diff sketch:\n${diff}` : "Diff sketch unavailable.",
    ].join("\n\n");
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

  _requirePhi() {
    if (!this.offlineFallbackActive && !this.phi4) {
      throw new Error("LM Studio handler is required for live recompose benchmarks.");
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
          path: relativeToCwd(absolute),
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
