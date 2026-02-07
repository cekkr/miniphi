import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import StreamAnalyzer from "./stream-analyzer.js";
import { LMStudioProtocolError } from "./lmstudio-handler.js";
import { buildStopReasonInfo } from "./lmstudio-error-utils.js";
import { extractTruncationPlanFromAnalysis, parseStrictJsonObject } from "./core-utils.js";
import { buildJsonSchemaResponseFormat } from "./json-schema-utils.js";
import { MIN_LMSTUDIO_REQUEST_TIMEOUT_MS } from "./runtime-defaults.js";

const TOKEN_CHARS_PER_TOKEN = 3;
const MIN_SESSION_TIMEOUT_MS = 1000;
const SESSION_PROMPT_CAP_MS = 120000;
const SESSION_PROMPT_BUDGET_RATIO = 0.4;
const KEYWORD_HIGHLIGHT_MAX_LINES = 12;
const KEYWORD_HIGHLIGHT_MAX_CHARS = 160;
const KEYWORD_HIGHLIGHT_MAX_BYTES = 2 * 1024 * 1024;
const KEYWORD_HINT_LIMIT = 24;
const KEYWORD_HINTS = [
  "simd",
  "opcode",
  "opcodes",
  "lane",
  "lanes",
  "v128",
  "i8x16",
  "i16x8",
  "i32x4",
  "i64x2",
  "f32x4",
  "f64x2",
  "extract_lane",
  "replace_lane",
  "shuffle",
];
const TASK_KEYWORD_STOPWORDS = new Set([
  "identify",
  "missing",
  "stubbed",
  "implement",
  "implements",
  "implemented",
  "implementation",
  "implementations",
  "operation",
  "operations",
  "analyze",
  "analysis",
  "file",
  "lines",
  "line",
  "table",
  "return",
  "returns",
  "needed",
  "needed",
]);

export const LOG_ANALYSIS_FALLBACK_SCHEMA = [
  "{",
  '  "task": "repeat the task in <= 10 words",',
  '  "root_cause": "concise summary or null",',
  '  "summary": "natural-language summary of the analysis",',
  '  "summary_updates": ["short progress update (can be empty)"],',
  '  "evidence": [',
  '    { "chunk": "Chunk 2", "line_hint": 120, "excerpt": "quoted or paraphrased line" }',
  "  ],",
  '  "recommended_fixes": [',
  '    { "description": "actionable fix", "files": ["path/to/file.js"], "commands": ["npm test"], "owner": "team" }',
  "  ],",
  '  "next_steps": ["follow-up diagnostic or verification step"],',
  '  "needs_more_context": false,',
  '  "missing_snippets": ["list the minimal snippets/files you need next"],',
  '  "truncation_strategy": {',
  '    "should_split": true,',
  '    "chunking_plan": [',
  '      { "goal": "Describe the next chunk to inspect", "priority": 1, "lines": null, "context": "Summaries + commands" }',
  "    ],",
  '    "carryover_fields": ["chunk", "line_hint", "symptom"],',
  '    "history_schema": "chunk_label,line_window,summary,commands",',
  '    "notes": "Update chunking details based on the captured evidence."',
  "  }",
  "}",
].join("\n");

/**
 * Coordinates CLI execution, compression, and Phi-4 reasoning for arbitrarily large outputs.
 */
export default class EfficientLogAnalyzer {
  constructor(phi4Handler, cliExecutor, pythonSummarizer, options = undefined) {
    if (!phi4Handler || !cliExecutor || !pythonSummarizer) {
      throw new Error(
        "EfficientLogAnalyzer requires LMStudioHandler, CliExecutor, and PythonLogSummarizer instances.",
      );
    }
    this.phi4 = phi4Handler;
    this.cli = cliExecutor;
    this.summarizer = pythonSummarizer;
    this.streamAnalyzer = options?.streamAnalyzer ?? new StreamAnalyzer(250);
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.schemaId = options?.schemaId ?? "log-analysis";
    this.commandAuthorizer = options?.commandAuthorizer ?? null;
    this.devLogDir =
      options?.devLogDir === null
        ? null
        : path.resolve(
            options?.devLogDir ?? path.join(process.cwd(), ".miniphi", "dev-logs"),
          );
  }

  async analyzeCommandOutput(command, task, options = undefined) {
    const {
      summaryLevels = 3,
      verbose = false,
      streamOutput = true,
      cwd = process.cwd(),
      timeout = 60000,
      sessionDeadline = undefined,
      promptContext = undefined,
      workspaceContext = undefined,
      commandDanger = "mid",
      commandSource = "user",
      authorizationContext = undefined,
      fallbackCache = null,
      fallbackCacheContext = undefined,
    } = options ?? {};

    this._resetPromptExchange();
    const devLog = this._startDevLog(`command-${this._safeLabel(command)}`, {
      type: "command",
      command,
      task,
      cwd,
    });
    if (verbose) {
      console.log(`[MiniPhi] Executing command: ${command}`);
    }
    this._logDev(devLog, `Executing command "${command}" (cwd: ${cwd})`);

    const invocationStartedAt = Date.now();
    const lines = [];
    let buffer = "";
    let stderrBuffer = "";
    let totalSize = 0;

    const pushLines = (chunk, isStdErr = false) => {
      const normalized = chunk.replace(/\r/g, "");
      const segments = (isStdErr ? stderrBuffer : buffer) + normalized;
      const parts = segments.split("\n");
      if (isStdErr) {
        stderrBuffer = parts.pop() ?? "";
      } else {
        buffer = parts.pop() ?? "";
      }
      for (const line of parts) {
        const value = line.trimEnd();
        if (value.length === 0) continue;
        lines.push(isStdErr ? `[stderr] ${value}` : value);
        if (verbose && lines.length % 100 === 0) {
          console.log(`[MiniPhi] Captured ${lines.length} lines...`);
        }
      }
    };

    try {
      if (this.commandAuthorizer) {
        await this.commandAuthorizer.ensureAuthorized(command, {
          danger: commandDanger,
          context: {
            source: commandSource,
            reason: authorizationContext?.reason ?? null,
            hint: authorizationContext?.hint ?? null,
          },
        });
      }
      await this.cli.executeCommand(command, {
        cwd,
        timeout,
        captureOutput: false,
        onStdout: (text) => {
          totalSize += Buffer.byteLength(text);
          pushLines(text, false);
        },
        onStderr: (text) => {
          totalSize += Buffer.byteLength(text);
          pushLines(text, true);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._logDev(devLog, `Command failed: ${message}`);
      throw new Error(`Command execution failed: ${message}`);
    }

    if (buffer.trim().length > 0) {
      lines.push(buffer.trimEnd());
    }
    if (stderrBuffer.trim().length > 0) {
      lines.push(`[stderr] ${stderrBuffer.trimEnd()}`);
    }

    if (verbose) {
      console.log(`[MiniPhi] Total lines captured: ${lines.length}`);
    }
    this._logDev(devLog, `Captured ${lines.length} lines (${totalSize} bytes).`);
    return this._analyzeDatasetLines(lines, task, {
      summaryLevels,
      verbose,
      streamOutput,
      sessionDeadline,
      promptContext,
      workspaceContext,
      datasetLabel: command,
      sourceLabel: command,
      command,
      originalSize: totalSize,
      fallbackCache,
      fallbackCacheContext,
      devLog,
      rerunCommand: command,
      datasetHint: `${lines.length} lines captured from ${command}`,
    });
  }

  async analyzeDatasetLines(lines, task, options = undefined) {
    const sourceLabel =
      typeof options?.sourceLabel === "string" && options.sourceLabel.trim().length > 0
        ? options.sourceLabel.trim()
        : null;
    const datasetLabel =
      typeof options?.datasetLabel === "string" && options.datasetLabel.trim().length > 0
        ? options.datasetLabel.trim()
        : sourceLabel ?? "dataset";
    this._resetPromptExchange();
    const devLog =
      options?.devLog ??
      this._startDevLog(`dataset-${this._safeLabel(datasetLabel)}`, {
        type: "dataset",
        label: datasetLabel,
        task,
      });
    return this._analyzeDatasetLines(lines, task, {
      ...(options ?? {}),
      datasetLabel,
      sourceLabel: sourceLabel ?? datasetLabel,
      devLog,
    });
  }

  async _analyzeDatasetLines(lines, task, options = undefined) {
    const {
      summaryLevels = 3,
      verbose = false,
      streamOutput = true,
      sessionDeadline = undefined,
      promptContext = undefined,
      workspaceContext = undefined,
      datasetLabel = "dataset",
      sourceLabel = null,
      command = null,
      originalSize = null,
      fallbackCache = null,
      fallbackCacheContext = undefined,
      devLog = null,
      rerunCommand = null,
      datasetHint = null,
      promptBudgetCapTokens = null,
      contextBudgetRatio = null,
    } = options ?? {};

    const normalizedLines = Array.isArray(lines)
      ? lines
          .filter((line) => typeof line === "string")
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
      : [];
    if (normalizedLines.length === 0) {
      throw new Error("No output lines captured for analysis.");
    }

    const totalSize =
      Number.isFinite(originalSize) && originalSize > 0
        ? originalSize
        : Buffer.byteLength(normalizedLines.join("\n"), "utf8");
    const compression = await this._compressLines(normalizedLines, summaryLevels, verbose);
    const explicitFileLists = this._extractExplicitFileLists(task);
    const schemaId = promptContext?.schemaId ?? this.schemaId;
    const promptBudget = await this._resolvePromptBudget({
      maxTokens: promptBudgetCapTokens,
    });
    const ratioValue = Number(contextBudgetRatio);
    const effectiveContextRatio =
      Number.isFinite(ratioValue) && ratioValue > 0
        ? Math.max(0.05, Math.min(0.5, ratioValue))
        : 0.3;
    const contextBudgetTokens = Math.max(96, Math.floor(promptBudget * effectiveContextRatio));
    const resolvedSourceLabel =
      typeof sourceLabel === "string" && sourceLabel.trim().length > 0
        ? sourceLabel.trim()
        : typeof datasetLabel === "string" && datasetLabel.trim().length > 0
          ? datasetLabel.trim()
          : typeof command === "string" && command.trim().length > 0
            ? command.trim()
            : "dataset";
    let prompt = this.generateSmartPrompt(
      task,
      compression.content,
      normalizedLines.length,
      {
        originalSize: totalSize,
        compressedTokens: compression.tokens,
        schemaId,
        contextBudgetTokens,
        sourceLabel: resolvedSourceLabel,
        explicitFileLists,
      },
      this._buildWorkspacePromptContext(workspaceContext),
    );
    const promptTokens = this._estimateTokens(prompt);
    if (promptTokens > promptBudget) {
      const truncated = this._truncateToBudget(prompt, promptBudget);
      prompt = truncated.prompt;
      this._logDev(
        devLog,
        `Prompt truncated in dataset mode (${truncated.tokens}/${promptBudget} tokens).`,
      );
    }
    const datasetHash = this._hashDatasetSignature({
      label: datasetLabel ?? resolvedSourceLabel,
      content: compression.content,
      lineCount: normalizedLines.length,
    });
    const fallbackContext = fallbackCacheContext ?? {};
    const promptJournalId =
      fallbackContext.promptJournalId ??
      promptContext?.promptJournalId ??
      null;
    let cachedFallback =
      datasetHash && fallbackCache?.loadFallbackSummary
        ? await this._lookupCachedFallback(
            fallbackCache,
            { datasetHash, promptJournalId },
            devLog,
          )
        : null;
    const invocationStartedAt = Date.now();

    if (!cachedFallback) {
      if (verbose) {
        console.log(`\n[MiniPhi] Dispatching analysis to Phi-4 (~${compression.tokens} tokens)\n`);
      }
      if (!streamOutput) {
        console.log("[MiniPhi] Awaiting Phi response (stream output disabled)...");
      }
      this._logDev(
        devLog,
        `Prompt (${compression.tokens} tokens):\n${this._truncateForLog(prompt)}`,
      );
    } else {
      const hashPreview = datasetHash ? datasetHash.slice(0, 12) : "unknown";
      this._logDev(
        devLog,
        `Skipping Phi dispatch; fallback cache hit for dataset ${hashPreview}.`,
      );
      console.warn(
        "[MiniPhi] Dataset matches a previous fallback run; reusing cached analysis instead of contacting Phi.",
      );
    }

    let analysis = cachedFallback?.analysis ?? "";
    let usedFallback = Boolean(cachedFallback);
    let fallbackReason = cachedFallback?.reason ?? null;
    let promptExchange = null;
    const analysisDiagnostics = {
      salvage: null,
      fallbackReason,
      stopReason: cachedFallback?.reason ?? null,
      stopReasonCode: cachedFallback ? "cached-fallback" : null,
      stopReasonDetail: cachedFallback?.reason ?? null,
    };
    const sanitizeOptions = {
      workspaceContext,
      explicitFileLists,
    };
    const reusedFallback = Boolean(cachedFallback);
    const responseFormat =
      promptContext?.responseFormat ?? this._buildJsonSchemaResponseFormat(schemaId) ?? null;
    const traceOptions = {
      ...(promptContext ?? {}),
      schemaId,
      responseFormat,
    };
    const fallbackDiagnostics = () =>
      this._formatFallbackDiagnostics({
        schemaId: traceOptions.schemaId ?? null,
        lines: normalizedLines.length,
        tokens: compression.tokens,
        chunkCount: null,
        datasetLabel: datasetLabel ?? resolvedSourceLabel,
      });
    let skipPhi = false;
    let stopHeartbeat = () => {};
    if (!cachedFallback) {
      try {
        this._applyPromptTimeout(sessionDeadline, {
          lineCount: normalizedLines.length,
          tokens: compression.tokens,
          source: command ? "command" : "dataset",
        });
      } catch (error) {
        skipPhi = true;
        usedFallback = true;
        const stopInfo = this._buildStopDiagnostics(error, {
          reason: "session-timeout",
          code: "session-timeout",
        });
        fallbackReason = stopInfo.reason ?? fallbackReason ?? "session-timeout";
        analysisDiagnostics.fallbackReason = fallbackReason;
        this._applyStopDiagnostics(analysisDiagnostics, stopInfo);
        const diag = fallbackDiagnostics();
        const detail = stopInfo.detail ?? fallbackReason;
        console.warn(
          `[MiniPhi] Phi analysis skipped: ${detail}. Using fallback summary.${diag ? ` ${diag}` : ""}`,
        );
        this._logDev(
          devLog,
          `Phi skipped (${detail}); emitting fallback JSON.${diag ? ` ${diag}` : ""}`,
        );
        const datasetHintText =
          typeof datasetHint === "string" && datasetHint.trim().length > 0
            ? datasetHint.trim()
            : null;
        const rerunCommandText =
          typeof rerunCommand === "string" && rerunCommand.trim().length > 0
            ? rerunCommand.trim()
            : null;
        analysis = this._buildFallbackAnalysis(task, detail, {
          datasetHint: datasetHintText,
          rerunCommand: rerunCommandText,
          explicitFileLists,
        });
      }
      if (!skipPhi) {
        stopHeartbeat = !streamOutput
          ? this._startHeartbeat("Still waiting for Phi response...", devLog)
          : () => {};
        if (verbose) {
          const originLabel = command
            ? `Command "${command}"`
            : `Dataset "${resolvedSourceLabel}"`;
          this._emitVerbosePromptPreview(prompt, compression.tokens, {
            schemaId: traceOptions.schemaId,
            origin: originLabel,
            lines: normalizedLines.length,
          });
        }
        try {
          await this._withSessionTimeout(sessionDeadline, () =>
            this.phi4.chatStream(
              prompt,
              (token) => {
                analysis += token;
                if (streamOutput) {
                  process.stdout.write(token);
                }
              },
              (thought) => {
                if (verbose) {
                  console.log("\n[Reasoning Block]\n");
                  console.log(thought);
                  console.log("\n[Solution Stream]");
                }
              },
              (err) => {
                this._logDev(devLog, `Phi error: ${err}`);
                throw new Error(`Phi-4 inference error: ${err}`);
              },
              traceOptions,
            ),
          );
        } catch (error) {
          if (error instanceof LMStudioProtocolError) {
            throw error;
          }
          usedFallback = true;
          const reason = error instanceof Error ? error.message : String(error);
          const stopInfo = this._buildStopDiagnostics(reason, {
            reason: "analysis-error",
            code: "analysis-error",
          });
          fallbackReason = stopInfo.reason ?? fallbackReason ?? reason;
          analysisDiagnostics.fallbackReason = fallbackReason;
          this._applyStopDiagnostics(analysisDiagnostics, stopInfo);
          const diag = fallbackDiagnostics();
          console.warn(
            `[MiniPhi] Phi analysis failed: ${stopInfo.detail ?? reason}. Using fallback summary.${diag ? ` ${diag}` : ""}`,
          );
          this._logDev(
            devLog,
            `Phi failure (${stopInfo.detail ?? reason}); emitting fallback JSON.${diag ? ` ${diag}` : ""}`,
          );
          const datasetHintText =
            typeof datasetHint === "string" && datasetHint.trim().length > 0
              ? datasetHint.trim()
              : null;
          const rerunCommandText =
            typeof rerunCommand === "string" && rerunCommand.trim().length > 0
              ? rerunCommand.trim()
              : null;
          analysis = this._buildFallbackAnalysis(task, stopInfo.detail ?? reason, {
            datasetHint: datasetHintText,
            rerunCommand: rerunCommandText,
            explicitFileLists,
          });
        } finally {
          stopHeartbeat();
        }
      }
    }

    if (streamOutput) {
      if (usedFallback) {
        process.stdout.write(`${analysis}\n`);
      } else {
        process.stdout.write("\n");
      }
    } else {
      if (usedFallback) {
        const diag = fallbackDiagnostics();
        console.log(
          `[MiniPhi] Phi response unavailable; emitted fallback summary.${diag ? ` ${diag}` : ""}`,
        );
      } else {
        console.log("[MiniPhi] Phi response received.");
      }
      if (verbose) {
        const originLabel = command
          ? `Command "${command}"`
          : `Dataset "${resolvedSourceLabel}"`;
        this._emitVerboseResponsePreview(analysis, {
          origin: originLabel,
        });
      }
    }
    if (streamOutput && usedFallback) {
      const diag = fallbackDiagnostics();
      console.log(
        `[MiniPhi] Phi response unavailable; emitted fallback summary.${diag ? ` ${diag}` : ""}`,
      );
    }

    if (!usedFallback) {
      const sanitizeAnalysis = () => {
        const sanitized = this._sanitizeJsonResponse(analysis, sanitizeOptions);
        if (sanitized) {
          analysis = sanitized;
          return true;
        }
        return false;
      };
      if (!sanitizeAnalysis()) {
        const salvage = await this._handleInvalidJsonAnalysis({
          analysis,
          devLog,
          schemaId: traceOptions?.schemaId ?? this.schemaId,
          task,
          command: command ?? resolvedSourceLabel,
          linesAnalyzed: normalizedLines.length,
          compression,
          traceOptions,
          fallbackDiagnosticsFn: fallbackDiagnostics,
        });
        if (salvage?.salvageReport) {
          analysisDiagnostics.salvage = salvage.salvageReport;
        }
        if (salvage?.analysis) {
          analysis = salvage.analysis;
          usedFallback = salvage.usedFallback ?? false;
          if (usedFallback && !fallbackReason) {
            fallbackReason = "JSON salvage fallback";
            analysisDiagnostics.fallbackReason = fallbackReason;
            this._applyStopDiagnostics(
              analysisDiagnostics,
              this._buildStopDiagnostics(fallbackReason, {
                reason: "invalid-response",
                code: "invalid-response",
              }),
            );
          }
          if (!usedFallback) {
            sanitizeAnalysis();
          }
        } else {
          usedFallback = true;
          const reason = "Phi response did not contain valid JSON";
          const stopInfo = this._buildStopDiagnostics(reason, {
            reason: "invalid-response",
            code: "invalid-response",
          });
          fallbackReason = stopInfo.reason ?? reason;
          analysisDiagnostics.fallbackReason = fallbackReason;
          this._applyStopDiagnostics(analysisDiagnostics, stopInfo);
          const diag = fallbackDiagnostics();
          console.warn(
            `[MiniPhi] ${stopInfo.detail ?? reason}; emitting fallback summary.${diag ? ` ${diag}` : ""}`,
          );
          this._logDev(
            devLog,
            `${stopInfo.detail ?? reason}; emitting fallback JSON.${diag ? ` ${diag}` : ""}`,
          );
          const datasetHintText =
            typeof datasetHint === "string" && datasetHint.trim().length > 0
              ? datasetHint.trim()
              : null;
          const rerunCommandText =
            typeof rerunCommand === "string" && rerunCommand.trim().length > 0
              ? rerunCommand.trim()
              : null;
          analysis = this._buildFallbackAnalysis(task, stopInfo.detail ?? reason, {
            datasetHint: datasetHintText,
            rerunCommand: rerunCommandText,
            explicitFileLists,
          });
        }
      }
    }

    const invocationFinishedAt = Date.now();
    this._logDev(
      devLog,
      `Phi response captured (${invocationFinishedAt - invocationStartedAt} ms):\n${this._truncateForLog(analysis)}`,
    );
    let truncationPlan = extractTruncationPlanFromAnalysis(analysis);
    if (truncationPlan) {
      truncationPlan.source = usedFallback ? "fallback" : "phi";
      if (truncationPlan.plan?.chunkingPlan?.length) {
        const chunkCount = truncationPlan.plan.chunkingPlan.length;
        const chunkPhrase = `${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`;
        console.log(
          `[MiniPhi] Truncation plan captured (${chunkPhrase}); rerun with --resume-truncation <execution-id> to apply it.`,
        );
        this._logDev(
          devLog,
          `Captured truncation strategy with ${chunkPhrase} (source=${truncationPlan.source}).`,
        );
      }
    }
    if (
      usedFallback &&
      !reusedFallback &&
      datasetHash &&
      fallbackCache?.saveFallbackSummary
    ) {
      await this._recordFallbackSummary(
        fallbackCache,
        {
          datasetHash,
          promptJournalId,
          promptId: traceOptions?.mainPromptId ?? null,
          promptLabel: traceOptions?.label ?? null,
          mode: fallbackContext?.mode ?? traceOptions?.metadata?.mode ?? null,
          command: command ?? null,
          filePath: fallbackContext?.filePath ?? null,
          task,
          analysis,
          truncationPlan,
          workspaceSummary: workspaceContext?.summary ?? null,
          reason: fallbackReason ?? "Phi fallback",
          linesAnalyzed: normalizedLines.length,
          compressedTokens: compression.tokens,
        },
        devLog,
      );
    }
    const schemaValidation = this._validateAnalysisSchema(
      traceOptions?.schemaId ?? this.schemaId,
      analysis,
    );
    const schemaValid = schemaValidation ? Boolean(schemaValidation.valid) : null;
    if (!cachedFallback) {
      promptExchange = this._consumePromptExchange();
    }
    return {
      command: command ?? null,
      task,
      prompt,
      linesAnalyzed: normalizedLines.length,
      compressedTokens: compression.tokens,
      compressedContent: compression.content,
      analysis,
      workspaceContext: workspaceContext ?? null,
      schemaId: traceOptions?.schemaId ?? this.schemaId ?? null,
      schemaValid,
      startedAt: invocationStartedAt,
      finishedAt: invocationFinishedAt,
      truncationPlan,
      analysisDiagnostics,
      promptExchange,
    };
  }

  async analyzeLogFile(filePath, task, options = undefined) {
    const {
      summaryLevels = 3,
      streamOutput = true,
      sessionDeadline = undefined,
      promptContext = undefined,
      workspaceContext = undefined,
      verbose = false,
      lineRange = undefined,
      fallbackCache = null,
      fallbackCacheContext = undefined,
    } = options ?? {};
    const maxLines = options?.maxLinesPerChunk ?? 2000;
    const explicitFileLists = this._extractExplicitFileLists(task);
    this._resetPromptExchange();
    const devLog = this._startDevLog(`file-${this._safeLabel(path.basename(filePath))}`, {
      type: "log-file",
      filePath,
      task,
      summaryLevels,
      maxLinesPerChunk: maxLines,
    });
    const rangeLabel =
      lineRange && (lineRange.startLine || lineRange.endLine)
        ? ` (lines ${lineRange.startLine ?? 1}-${lineRange.endLine ?? "end"})`
        : "";
    this._logDev(
      devLog,
      `Summarizing ${filePath}${rangeLabel} (maxLinesPerChunk=${maxLines})`,
    );
    const relativePath = path.relative(process.cwd(), filePath) || filePath;
    console.log(`[MiniPhi] Summarizing ${relativePath}${rangeLabel} ...`);
    const promptBudget = await this._resolvePromptBudget();
    const rawBudgetRatio = 0.75;
    const rawTokenBudget = Math.floor(promptBudget * rawBudgetRatio);
    const rawByteLimit = Math.max(65536, Math.floor(promptBudget * 4 * rawBudgetRatio));
    let chunks = [];
    let linesIncluded = 0;
    let usedRawContent = false;
    let sourceLineCount = null;

    if (this._isDocLikeFile(filePath)) {
      const rawCandidate = await this._loadRawFileLines(filePath, lineRange, rawByteLimit);
      if (rawCandidate && !rawCandidate.tooLarge) {
        sourceLineCount = rawCandidate.lines.length;
        const rawTokens = this._estimateTokens(rawCandidate.text);
        if (rawCandidate.lines.length > 0 && rawTokens <= rawTokenBudget) {
          usedRawContent = true;
          linesIncluded = rawCandidate.lines.length;
          chunks = this._buildRawChunks(rawCandidate.lines, {
            startLine: rawCandidate.startLine,
            maxLinesPerChunk: maxLines,
          });
          this._logDev(
            devLog,
            `Using raw file content (${linesIncluded} lines, ~${rawTokens} tokens).`,
          );
          console.log(`[MiniPhi] Using raw file content for ${relativePath}${rangeLabel} ...`);
        } else if (rawCandidate.lines.length > 0) {
          const previewBudget = Math.max(256, Math.floor(promptBudget * 0.35));
          const preview = this._buildDocPreviewLines(rawCandidate.lines, {
            startLine: rawCandidate.startLine,
            tokenBudget: previewBudget,
          });
          if (preview.lines.length > 0) {
            usedRawContent = true;
            linesIncluded = preview.lines.length;
            chunks = this._buildRawChunks(preview.lines, {
              startLine: rawCandidate.startLine,
              maxLinesPerChunk: maxLines,
            });
            this._logDev(
              devLog,
              `Using raw preview (${linesIncluded} lines, ~${preview.usedTokens} tokens) from ${sourceLineCount} total lines.`,
            );
            console.log(
              `[MiniPhi] Using raw preview content for ${relativePath}${rangeLabel} ...`,
            );
          }
        }
      }
    }

    if (!usedRawContent) {
      const summarizeStarted = Date.now();
      const summaryResult = await this.summarizer.summarizeFile(filePath, {
        maxLinesPerChunk: options?.maxLinesPerChunk ?? 2000,
        recursionLevels: summaryLevels,
        lineRange,
      });
      chunks = summaryResult.chunks ?? [];
      linesIncluded = summaryResult.linesIncluded ?? 0;
      const summarizeFinished = Date.now();
      this._logDev(
        devLog,
        `Summarizer produced ${chunks.length} chunks in ${summarizeFinished - summarizeStarted} ms.`,
      );
      console.log(
        `[MiniPhi] Summarizer produced ${chunks.length} chunks in ${
          summarizeFinished - summarizeStarted
        } ms`,
      );
    }

    if (chunks.length === 0) {
      throw new Error(`No content found in ${filePath}`);
    }

    const totalLines =
      Number.isFinite(sourceLineCount) && sourceLineCount > 0
        ? sourceLineCount
        : typeof linesIncluded === "number"
          ? linesIncluded
          : chunks.reduce((acc, chunk) => acc + (chunk?.input_lines ?? 0), 0);
    const chunkSummaries = chunks.map((chunk, idx) => {
      const label = `Chunk ${idx + 1}`;
      this._logDev(
        devLog,
        `${label}: ${chunk?.input_lines ?? 0} lines summarized; summary=${this._truncateForLog(
          JSON.stringify(chunk?.summary ?? []),
        )}`,
      );
      return { chunk, label };
    });
    let keywordHighlights = "";
    try {
      const highlights = await this._collectKeywordHighlights(filePath, {
        task,
        lineRange,
        maxLines: KEYWORD_HIGHLIGHT_MAX_LINES,
        maxChars: KEYWORD_HIGHLIGHT_MAX_CHARS,
        maxBytes: KEYWORD_HIGHLIGHT_MAX_BYTES,
      });
      keywordHighlights = this._formatKeywordHighlights(highlights);
      if (keywordHighlights) {
        this._logDev(devLog, `Keyword highlights captured (${highlights.length} lines).`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._logDev(devLog, `Keyword highlight scan failed: ${message}`);
    }
    const schemaId = promptContext?.schemaId ?? this.schemaId;
    const adjustment = this._buildBudgetedPrompt({
      chunkSummaries,
      summaryLevels,
      task,
      totalLines,
      workspaceContext,
      promptBudget,
      devLog,
      schemaId,
      chunking: {
        maxLinesPerChunk: maxLines,
        lineRange: lineRange ?? null,
      },
      sourceLabel: filePath,
      explicitFileLists,
      keywordHighlights,
    });
    const { prompt, body, linesUsed, tokensUsed, droppedChunks, detailLevel, detailReductions } =
      adjustment;
    const datasetHash = this._hashDatasetSignature({
      label: filePath,
      content: body,
      lineCount: linesUsed,
    });
    const fallbackContext = fallbackCacheContext ?? {};
    const promptJournalId =
      fallbackContext.promptJournalId ??
      promptContext?.promptJournalId ??
      null;
    let cachedFallback =
      datasetHash && fallbackCache?.loadFallbackSummary
        ? await this._lookupCachedFallback(
            fallbackCache,
            { datasetHash, promptJournalId },
            devLog,
          )
        : null;

    const invocationStartedAt = Date.now();

    let analysis = cachedFallback?.analysis ?? "";
    let usedFallback = Boolean(cachedFallback);
    let fallbackReason = cachedFallback?.reason ?? null;
    let promptExchange = null;
    const analysisDiagnostics = {
      salvage: null,
      fallbackReason,
      stopReason: cachedFallback?.reason ?? null,
      stopReasonCode: cachedFallback ? "cached-fallback" : null,
      stopReasonDetail: cachedFallback?.reason ?? null,
    };
    const sanitizeOptions = {
      workspaceContext,
      sourceFile: filePath,
      docLike: this._isDocLikeFile(filePath),
      explicitFileLists,
    };
    const reusedFallback = Boolean(cachedFallback);
    const responseFormat =
      promptContext?.responseFormat ?? this._buildJsonSchemaResponseFormat(schemaId) ?? null;
    const traceOptions = {
      ...(promptContext ?? {}),
      schemaId,
      responseFormat,
    };
    const fallbackDiagnostics = () =>
      this._formatFallbackDiagnostics({
        schemaId: traceOptions.schemaId ?? null,
        lines: linesUsed,
        tokens: tokensUsed,
        chunkCount: chunkSummaries.length,
        datasetLabel: filePath,
      });
    if (droppedChunks > 0) {
      this._logDev(devLog, `Prompt omitted ${droppedChunks} chunk(s) to fit the context budget.`);
    }
    if (detailReductions > 0) {
      this._logDev(devLog, `Summary detail reduced by ${detailReductions} level(s) for budgeting.`);
    }
    let stopHeartbeat = () => {};
    let skipPhi = false;
    if (!cachedFallback) {
      try {
        this._applyPromptTimeout(sessionDeadline, {
          lineCount: linesUsed,
          tokens: tokensUsed,
          source: "file",
        });
      } catch (error) {
        skipPhi = true;
        usedFallback = true;
        const stopInfo = this._buildStopDiagnostics(error, {
          reason: "session-timeout",
          code: "session-timeout",
        });
        fallbackReason = stopInfo.reason ?? fallbackReason ?? "session-timeout";
        analysisDiagnostics.fallbackReason = fallbackReason;
        this._applyStopDiagnostics(analysisDiagnostics, stopInfo);
        const diag = fallbackDiagnostics();
        const detail = stopInfo.detail ?? fallbackReason;
        console.warn(
          `[MiniPhi] Phi analysis skipped: ${detail}. Using fallback summary.${diag ? ` ${diag}` : ""}`,
        );
        this._logDev(
          devLog,
          `Phi skipped (${detail}); emitting fallback JSON.${diag ? ` ${diag}` : ""}`,
        );
        analysis = this._buildFallbackAnalysis(task, detail, {
          datasetHint: `Summarized ${linesUsed} lines across ${chunkSummaries.length} chunks`,
          rerunCommand: filePath,
          explicitFileLists,
        });
      }
      if (!skipPhi) {
        stopHeartbeat = !streamOutput
          ? this._startHeartbeat("Still waiting for Phi response...", devLog)
          : () => {};
        if (verbose) {
          this._emitVerbosePromptPreview(prompt, tokensUsed, {
            schemaId: traceOptions.schemaId,
            origin: `Log file ${path.basename(filePath)}`,
            lines: linesUsed,
          });
        }
        try {
          await this._withSessionTimeout(sessionDeadline, () =>
            this.phi4.chatStream(
              prompt,
              (token) => {
                analysis += token;
                if (streamOutput) {
                  process.stdout.write(token);
                }
              },
              undefined,
              (err) => {
                this._logDev(devLog, `Phi error: ${err}`);
                throw new Error(`Phi-4 inference error: ${err}`);
              },
              traceOptions,
            ),
          );
        } catch (error) {
          if (error instanceof LMStudioProtocolError) {
            throw error;
          }
          usedFallback = true;
          const reason = error instanceof Error ? error.message : String(error);
          const stopInfo = this._buildStopDiagnostics(reason, {
            reason: "analysis-error",
            code: "analysis-error",
          });
          fallbackReason = stopInfo.reason ?? fallbackReason ?? reason;
          analysisDiagnostics.fallbackReason = fallbackReason;
          this._applyStopDiagnostics(analysisDiagnostics, stopInfo);
          const diag = fallbackDiagnostics();
          console.warn(
            `[MiniPhi] Phi analysis failed: ${stopInfo.detail ?? reason}. Using fallback summary.${diag ? ` ${diag}` : ""}`,
          );
          this._logDev(
            devLog,
            `Phi failure (${stopInfo.detail ?? reason}); emitting fallback JSON.${diag ? ` ${diag}` : ""}`,
          );
          analysis = this._buildFallbackAnalysis(task, stopInfo.detail ?? reason, {
            datasetHint: `Summarized ${linesUsed} lines across ${chunkSummaries.length} chunks`,
            rerunCommand: filePath,
            explicitFileLists,
          });
        } finally {
          stopHeartbeat();
        }
      }
    } else {
      const hashPreview = datasetHash ? datasetHash.slice(0, 12) : "unknown";
      this._logDev(
        devLog,
        `Skipping Phi dispatch; fallback cache hit for dataset ${hashPreview}.`,
      );
      console.warn(
        "[MiniPhi] Dataset matches a previous fallback run; reusing cached analysis instead of contacting Phi.",
      );
    }
    if (streamOutput) {
      if (usedFallback) {
        process.stdout.write(`${analysis}\n`);
      } else {
        process.stdout.write("\n");
      }
    } else {
      if (usedFallback) {
        const diag = fallbackDiagnostics();
        console.log(
          `[MiniPhi] Phi response unavailable; emitted fallback summary.${diag ? ` ${diag}` : ""}`,
        );
      } else {
        console.log("[MiniPhi] Phi response received.");
      }
      if (verbose) {
        this._emitVerboseResponsePreview(analysis, {
          origin: `Log file ${path.basename(filePath)}`,
        });
      }
    }
    if (streamOutput && usedFallback) {
      const diag = fallbackDiagnostics();
      console.log(
        `[MiniPhi] Phi response unavailable; emitted fallback summary.${diag ? ` ${diag}` : ""}`,
      );
    }
    if (!usedFallback) {
      const sanitizeAnalysis = () => {
        const sanitized = this._sanitizeJsonResponse(analysis, sanitizeOptions);
        if (sanitized) {
          analysis = sanitized;
          return true;
        }
        return false;
      };
      if (!sanitizeAnalysis()) {
        const salvage = await this._handleInvalidJsonAnalysis({
          analysis,
          devLog,
          schemaId: traceOptions?.schemaId ?? this.schemaId,
          task,
          command: filePath,
          linesAnalyzed: linesUsed,
          compression: {
            content: body, // body already includes chunk summaries; reuse to avoid recompute.
          },
          traceOptions,
        });
        if (salvage?.salvageReport) {
          analysisDiagnostics.salvage = salvage.salvageReport;
        }
        if (salvage?.analysis) {
          analysis = salvage.analysis;
          usedFallback = salvage.usedFallback ?? false;
          if (usedFallback && !fallbackReason) {
            fallbackReason = "JSON salvage fallback";
            analysisDiagnostics.fallbackReason = fallbackReason;
            this._applyStopDiagnostics(
              analysisDiagnostics,
              this._buildStopDiagnostics(fallbackReason, {
                reason: "invalid-response",
                code: "invalid-response",
              }),
            );
          }
          if (!usedFallback) {
            sanitizeAnalysis();
          }
        } else {
          usedFallback = true;
          const reason = "Phi response did not contain valid JSON";
          const stopInfo = this._buildStopDiagnostics(reason, {
            reason: "invalid-response",
            code: "invalid-response",
          });
          fallbackReason = stopInfo.reason ?? reason;
          analysisDiagnostics.fallbackReason = fallbackReason;
          this._applyStopDiagnostics(analysisDiagnostics, stopInfo);
          console.warn(`[MiniPhi] ${stopInfo.detail ?? reason}; emitting fallback summary.`);
          this._logDev(devLog, `${stopInfo.detail ?? reason}; emitting fallback JSON.`);
          analysis = this._buildFallbackAnalysis(task, stopInfo.detail ?? reason, {
            datasetHint: `Summarized ${linesUsed} lines across ${chunkSummaries.length} chunks`,
            rerunCommand: filePath,
            explicitFileLists,
          });
        }
      }
    }
    const invocationFinishedAt = Date.now();
    this._logDev(
      devLog,
      `Phi response (${invocationFinishedAt - invocationStartedAt} ms):\n${this._truncateForLog(
        analysis,
      )}`,
    );
    let truncationPlan = extractTruncationPlanFromAnalysis(analysis);
    if (truncationPlan) {
      truncationPlan.source = usedFallback ? "fallback" : "phi";
      if (truncationPlan.plan?.chunkingPlan?.length) {
        const chunkCount = truncationPlan.plan.chunkingPlan.length;
        const chunkPhrase = `${chunkCount} chunk${chunkCount === 1 ? "" : "s"}`;
        console.log(
          `[MiniPhi] Truncation plan captured (${chunkPhrase}); rerun with --resume-truncation <execution-id> to apply it.`,
        );
        this._logDev(
          devLog,
          `Captured truncation strategy with ${chunkPhrase} (source=${truncationPlan.source}).`,
        );
      }
    }
    if (
      usedFallback &&
      !reusedFallback &&
      datasetHash &&
      fallbackCache?.saveFallbackSummary
    ) {
      await this._recordFallbackSummary(
        fallbackCache,
        {
          datasetHash,
          promptJournalId,
          promptId: traceOptions?.mainPromptId ?? null,
          promptLabel: traceOptions?.label ?? null,
          mode: fallbackContext?.mode ?? traceOptions?.metadata?.mode ?? null,
          command: filePath,
          filePath,
          task,
          analysis,
          truncationPlan,
          workspaceSummary: workspaceContext?.summary ?? null,
          reason: fallbackReason ?? "Phi fallback",
          linesAnalyzed: linesUsed,
          compressedTokens: tokensUsed,
        },
        devLog,
      );
    }
    const promptAdjustments = {
      droppedChunks: droppedChunks ?? 0,
      detailLevel: detailLevel ?? null,
      detailReductions: detailReductions ?? 0,
    };
    const schemaValidation = this._validateAnalysisSchema(
      traceOptions?.schemaId ?? this.schemaId,
      analysis,
    );
    const schemaValid = schemaValidation ? Boolean(schemaValidation.valid) : null;
    if (!cachedFallback) {
      promptExchange = this._consumePromptExchange();
    }
    return {
      filePath,
      task,
      prompt,
      linesAnalyzed: linesUsed,
      compressedTokens: tokensUsed,
      compressedContent: body,
      analysis,
      workspaceContext: workspaceContext ?? null,
      schemaId: traceOptions?.schemaId ?? this.schemaId ?? null,
      schemaValid,
      startedAt: invocationStartedAt,
      finishedAt: invocationFinishedAt,
      truncationPlan,
      lineRange: lineRange ?? null,
      promptAdjustments,
      analysisDiagnostics,
      promptExchange,
    };
  }

  extractKeyLines(lines, ratio = 0.3) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return "";
    }
    const keywords = ["ERROR", "WARN", "FAIL", "SUCCESS", "EXCEPTION"];
    const prioritized = lines.filter((line) =>
      keywords.some((kw) => line.toUpperCase().includes(kw)),
    );
    const others = lines.filter(
      (line) => !keywords.some((kw) => line.toUpperCase().includes(kw)),
    );
    const amount = Math.max(1, Math.ceil(lines.length * ratio));
    const prioritizedQuota = Math.ceil(amount / 2);
    const otherQuota = amount - prioritizedQuota;
    return [
      ...prioritized.slice(0, prioritizedQuota),
      ...others.slice(0, otherQuota),
    ].join("\n");
  }

  _isDocLikeFile(filePath) {
    if (!filePath || typeof filePath !== "string") {
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    return [
      ".md",
      ".markdown",
      ".mdx",
      ".txt",
      ".rst",
      ".adoc",
      ".asciidoc",
    ].includes(ext);
  }

  async _loadRawFileLines(filePath, lineRange = null, maxBytes = null) {
    if (!filePath || typeof filePath !== "string") {
      return null;
    }
    let stats;
    try {
      stats = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    if (!stats.isFile()) {
      return null;
    }
    if (Number.isFinite(maxBytes) && maxBytes > 0 && stats.size > maxBytes) {
      return { tooLarge: true, size: stats.size };
    }
    const content = await fs.promises.readFile(filePath, "utf8");
    let lines = content.split(/\r?\n/);
    let startLine = 1;
    if (lineRange && (lineRange.startLine || lineRange.endLine)) {
      const start = Number.isFinite(lineRange.startLine)
        ? Math.max(1, Math.floor(lineRange.startLine))
        : 1;
      const end = Number.isFinite(lineRange.endLine)
        ? Math.max(start, Math.floor(lineRange.endLine))
        : lines.length;
      lines = lines.slice(start - 1, end);
      startLine = start;
    }
    return {
      lines,
      text: lines.join("\n"),
      startLine,
      size: content.length,
    };
  }

  _buildRawChunks(lines, options = undefined) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return [];
    }
    const startLine =
      Number.isFinite(options?.startLine) && options.startLine > 0
        ? Math.floor(options.startLine)
        : 1;
    const maxLinesPerChunk =
      Number.isFinite(options?.maxLinesPerChunk) && options.maxLinesPerChunk > 0
        ? Math.floor(options.maxLinesPerChunk)
        : lines.length;
    const chunks = [];
    let lineNumber = startLine;
    for (let idx = 0; idx < lines.length; idx += maxLinesPerChunk) {
      const chunkLines = lines.slice(idx, idx + maxLinesPerChunk);
      const labeledLines = chunkLines.map(
        (line, offset) => `L${lineNumber + offset}: ${line}`,
      );
      chunks.push({
        input_lines: chunkLines.length,
        summary: {
          raw: labeledLines.join("\n"),
        },
      });
      lineNumber += chunkLines.length;
    }
    return chunks;
  }

  _buildDocPreviewLines(lines, options = undefined) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return { lines: [], usedTokens: 0, truncated: false };
    }
    const startLine =
      Number.isFinite(options?.startLine) && options.startLine > 0
        ? Math.floor(options.startLine)
        : 1;
    const tokenBudget =
      Number.isFinite(options?.tokenBudget) && options.tokenBudget > 0
        ? Math.floor(options.tokenBudget)
        : null;
    const preview = [];
    let usedTokens = 0;
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const labeled = `L${startLine + idx}: ${line}`;
      const lineTokens = this._estimateTokens(labeled);
      if (tokenBudget && preview.length > 0 && usedTokens + lineTokens > tokenBudget) {
        break;
      }
      preview.push(line);
      usedTokens += lineTokens;
    }
    return {
      lines: preview,
      usedTokens,
      truncated: preview.length < lines.length,
    };
  }

  _extractKeywordHints(task, options = undefined) {
    const includeDefaults = options?.includeDefaults !== false;
    const hints = new Set(includeDefaults ? KEYWORD_HINTS : []);
    if (!task || typeof task !== "string") {
      return Array.from(hints);
    }
    const words = task.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    for (const word of words) {
      if (word.length < 3) {
        continue;
      }
      if (TASK_KEYWORD_STOPWORDS.has(word)) {
        continue;
      }
      hints.add(word);
      if (hints.size >= KEYWORD_HINT_LIMIT) {
        break;
      }
    }
    return Array.from(hints);
  }

  async _collectKeywordHighlights(filePath, options = undefined) {
    if (!filePath || typeof filePath !== "string") {
      return [];
    }
    const taskHints = Array.isArray(options?.hints)
      ? options.hints
      : this._extractKeywordHints(options?.task, { includeDefaults: false });
    const priorityKeywords = [];
    const keywordSet = new Set();
    const addKeyword = (term) => {
      if (typeof term !== "string") {
        return;
      }
      const normalized = term.trim().toLowerCase();
      if (!normalized || keywordSet.has(normalized)) {
        return;
      }
      keywordSet.add(normalized);
      priorityKeywords.push(normalized);
    };
    taskHints.forEach(addKeyword);
    KEYWORD_HINTS.forEach(addKeyword);
    if (priorityKeywords.length === 0) {
      return [];
    }
    const maxLines =
      Number.isFinite(options?.maxLines) && options.maxLines > 0
        ? Math.floor(options.maxLines)
        : KEYWORD_HIGHLIGHT_MAX_LINES;
    const maxChars =
      Number.isFinite(options?.maxChars) && options.maxChars > 0
        ? Math.floor(options.maxChars)
        : KEYWORD_HIGHLIGHT_MAX_CHARS;
    const maxBytes =
      Number.isFinite(options?.maxBytes) && options.maxBytes > 0
        ? Math.floor(options.maxBytes)
        : null;
    const raw = await this._loadRawFileLines(filePath, options?.lineRange ?? null, maxBytes);
    if (!raw || raw.tooLarge || !Array.isArray(raw.lines)) {
      return [];
    }
    const perKeywordLimit = 2;
    const hitsByKeyword = new Map();
    const startLine = Number.isFinite(raw.startLine) ? raw.startLine : 1;
    for (let idx = 0; idx < raw.lines.length; idx += 1) {
      const line = raw.lines[idx];
      if (typeof line !== "string" || line.length === 0) {
        continue;
      }
      const haystack = line.toLowerCase();
      for (const keyword of priorityKeywords) {
        if (!haystack.includes(keyword)) {
          continue;
        }
        const list = hitsByKeyword.get(keyword) ?? [];
        if (list.length >= perKeywordLimit) {
          continue;
        }
        list.push({ lineNumber: startLine + idx, text: line.trimEnd(), keyword });
        hitsByKeyword.set(keyword, list);
      }
    }
    const highlights = [];
    const seenLines = new Set();
    const addHighlight = (hit) => {
      if (!hit || highlights.length >= maxLines || seenLines.has(hit.lineNumber)) {
        return;
      }
      seenLines.add(hit.lineNumber);
      let clipped = hit.text.trimEnd();
      if (clipped.length > maxChars) {
        const suffix = maxChars > 3 ? "..." : "";
        const sliceLimit = Math.max(0, maxChars - suffix.length);
        clipped = `${clipped.slice(0, sliceLimit).trimEnd()}${suffix}`;
      }
      highlights.push({ lineNumber: hit.lineNumber, text: clipped, keyword: hit.keyword });
    };
    for (const keyword of priorityKeywords) {
      const hits = hitsByKeyword.get(keyword) ?? [];
      if (hits.length > 0) {
        addHighlight(hits[0]);
      }
      if (highlights.length >= maxLines) {
        return highlights;
      }
    }
    if (highlights.length < maxLines) {
      const remaining = [];
      for (const hits of hitsByKeyword.values()) {
        for (const hit of hits) {
          if (!seenLines.has(hit.lineNumber)) {
            remaining.push(hit);
          }
        }
      }
      remaining.sort((a, b) => a.lineNumber - b.lineNumber);
      for (const hit of remaining) {
        addHighlight(hit);
        if (highlights.length >= maxLines) {
          break;
        }
      }
    }
    return highlights;
  }

  _formatKeywordHighlights(highlights) {
    if (!Array.isArray(highlights) || highlights.length === 0) {
      return "";
    }
    const lines = highlights
      .filter(
        (entry) =>
          entry &&
          Number.isFinite(entry.lineNumber) &&
          typeof entry.text === "string" &&
          entry.text.trim().length > 0,
      )
      .map((entry) => `L${Math.floor(entry.lineNumber)}: ${entry.text.trimEnd()}`);
    if (lines.length === 0) {
      return "";
    }
    return ["# Keyword highlights", ...lines].join("\n");
  }

  formatSummary(summary, label = undefined, maxLevel = Infinity) {
    if (!summary) {
      return "";
    }
    const labelPrefix = label ? `# ${label}\n\n` : "";
    if (typeof summary.raw === "string") {
      const trimmed = summary.raw.trimEnd();
      if (!trimmed) {
        return labelPrefix.trimEnd();
      }
      return `${labelPrefix}${trimmed}\n`;
    }
    if (typeof summary?.summary?.raw === "string") {
      const trimmed = summary.summary.raw.trimEnd();
      if (!trimmed) {
        return labelPrefix.trimEnd();
      }
      return `${labelPrefix}${trimmed}\n`;
    }
    const levels = Array.isArray(summary.summary)
      ? summary.summary
      : Array.isArray(summary)
        ? summary
        : null;
    if (!levels) {
      return "";
    }

    let formatted = labelPrefix;
    for (const level of levels) {
      if (typeof level.level === "number" && level.level > maxLevel) {
        continue;
      }
      formatted += `## Level ${level.level} (${level.total_lines} lines)\n`;
      for (const [category, data] of Object.entries(level.categories ?? {})) {
        formatted += `\n### ${category} (${data.count} occurrences)\n`;
        const samples = data.sample_lines ?? [];
        formatted += samples.map((line) => `- ${line}`).join("\n");
        formatted += "\n";
      }
      formatted += "\n";
    }
    return formatted;
  }

  _buildSchemaReference(schemaId) {
    const resolvedId =
      typeof schemaId === "string" && schemaId.trim().length > 0
        ? schemaId.trim()
        : this.schemaId ?? "log-analysis";
    if (this.schemaRegistry && resolvedId) {
      const schema = this.schemaRegistry.getSchema(resolvedId);
      if (schema?.definition && typeof schema.definition === "object") {
        return {
          id: schema.id ?? resolvedId,
          definition: schema.definition,
        };
      }
    }
    return {
      id: resolvedId ?? "log-analysis",
      definition: null,
      text: LOG_ANALYSIS_FALLBACK_SCHEMA,
    };
  }

  _buildWorkspacePromptContext(workspaceContext) {
    if (!workspaceContext) {
      return null;
    }
    return {
      workspaceSummary: workspaceContext?.summary ?? null,
      workspaceType:
        workspaceContext?.classification?.label ?? workspaceContext?.classification?.domain ?? null,
      workspaceHint: workspaceContext?.hintBlock ?? null,
      workspaceDirectives: workspaceContext?.planDirectives ?? workspaceContext?.directives ?? null,
      manifestPreview: workspaceContext?.manifestPreview ?? null,
      readmeSnippet: workspaceContext?.readmeSnippet ?? null,
      taskPlanSummary: workspaceContext?.taskPlanSummary ?? null,
      taskPlanOutline: workspaceContext?.taskPlanOutline ?? null,
      taskPlanSegmentsBlock: workspaceContext?.taskPlanSegmentsBlock ?? null,
      taskPlanRecommendationsBlock: workspaceContext?.taskPlanRecommendationsBlock ?? null,
      capabilitySummary: workspaceContext?.capabilitySummary ?? null,
      connectionSummary:
        workspaceContext?.connectionSummary ?? workspaceContext?.connections?.summary ?? null,
      connectionGraphic: workspaceContext?.connectionGraphic ?? null,
      navigationSummary: workspaceContext?.navigationSummary ?? null,
      navigationBlock: workspaceContext?.navigationBlock ?? null,
      helperScript: workspaceContext?.helperScript ?? null,
      truncationPlan: workspaceContext?.truncationPlan ?? null,
      fixedReferences: workspaceContext?.fixedReferences ?? null,
      indexSummaries: workspaceContext?.indexSummary ?? null,
      benchmarkHistory: workspaceContext?.benchmarkHistory ?? null,
      commandLibraryBlock: workspaceContext?.commandLibraryBlock ?? null,
      compositionBlock: workspaceContext?.compositionBlock ?? null,
      promptTemplateBlock: workspaceContext?.promptTemplateBlock ?? null,
    };
  }

  generateSmartPrompt(task, compressedContent, totalLines, metadata, extraContext = undefined) {
    const contextBudgetTokens =
      Number.isFinite(metadata?.contextBudgetTokens) && metadata.contextBudgetTokens > 0
        ? Math.floor(metadata.contextBudgetTokens)
        : null;
    const sourceLabel =
      typeof metadata?.sourceLabel === "string" && metadata.sourceLabel.trim().length > 0
        ? metadata.sourceLabel.trim().slice(0, 240)
        : null;
    const explicitFileLists =
      Array.isArray(metadata?.explicitFileLists) && metadata.explicitFileLists.length > 0
        ? metadata.explicitFileLists
        : null;
    const contextSupplement = this._formatContextSupplement(extraContext, {
      maxTokens: contextBudgetTokens,
    });
    const schemaReference = this._buildSchemaReference(metadata?.schemaId);
    const reportingRules = [
      "Every evidence entry must mention the chunk/section name and include an approximate line_hint; use null only if no line reference exists.",
      "Provide summary as a short natural-language update of the overall findings; for info-only tasks, use summary as the primary answer and keep recommended_fixes empty.",
      "Provide summary_updates as short progress updates in chronological order; keep each update terse and allow an empty array if there were no progress updates.",
      "Place summary and summary_updates near the top of the JSON response so streaming output surfaces them early.",
      "Recommended fixes should contain concrete actions with files, commands, or owners when possible. Use empty arrays instead of omitting fields.",
      "If the dataset is descriptive or lacks actionable defects, return an empty recommended_fixes array and do not invent commands or file names.",
      "When proposing fixes, only reference files visible in the workspace manifest or dataset source; otherwise leave files and commands empty.",
      "If information is unavailable, set the field to null instead of fabricating a value.",
      "Use needs_more_context and missing_snippets when the captured data is insufficient; list only the minimal follow-up snippets/commands required.",
      "When the dataset is truncated or you need more context, populate truncation_strategy with JSON describing how to split the remaining input (chunk goals, carryover fields, history schema, helper commands). Use null when no truncation plan is required.",
    ];
    if (explicitFileLists) {
      reportingRules.push(
        "If explicit_file_lists is provided, use those exact file arrays for recommended_fixes[i].files in order; do not leave files empty.",
      );
    }
    const payload = {
      task,
      dataset: {
        total_lines: totalLines,
        compressed_tokens: metadata.compressedTokens,
        compression: this._formatCompression(totalLines, metadata.compressedTokens),
        approx_original_bytes: metadata.originalSize ?? "unknown",
      },
      context: contextSupplement?.trim() || null,
      reporting_rules: reportingRules,
      data: compressedContent,
    };
    if (sourceLabel) {
      payload.dataset.source = sourceLabel;
    }
    if (metadata?.chunking) {
      payload.dataset.chunking = metadata.chunking;
    }
    if (explicitFileLists) {
      payload.explicit_file_lists = explicitFileLists;
    }

    const request = {
      request_type: "log-analysis",
      schema: schemaReference,
      response_format: "json_schema",
      instructions: [
        "Keep the response terse and within the schema; avoid extra prose or redundant fields.",
        "Always include summary and summary_updates; summary_updates can be an empty array.",
        "Respond with raw JSON only; no code fences, no markdown, no <think> blocks, and no prose outside the JSON object.",
      ],
      payload,
    };

    if (metadata?.pretty) {
      return JSON.stringify(request, null, 2);
    }
    return JSON.stringify(request);
  }

  _buildFallbackAnalysis(task, reason, context = undefined) {
    const taskLabel =
      typeof task === "string" && task.trim().length > 0
        ? task.trim().slice(0, 200)
        : "MiniPhi fallback report";
    const normalizedReason =
      typeof reason === "string" && reason.trim().length > 0
        ? reason.trim()
        : "Phi-4 did not complete the analysis.";
    const datasetHint =
      typeof context?.datasetHint === "string" && context.datasetHint.trim().length > 0
        ? context.datasetHint.trim()
        : null;
    const evidenceExcerpt = datasetHint ? `${normalizedReason} (${datasetHint})` : normalizedReason;
    const summaryText = `Fallback summary: ${normalizedReason}`;
    const summaryUpdates = ["Fallback summary emitted after Phi response was unavailable."];
    const nextStep =
      typeof context?.nextStep === "string" && context.nextStep.trim().length > 0
        ? context.nextStep.trim()
        : "Re-run the analysis once Phi-4 responds deterministically.";
    const rerunCommands =
      typeof context?.rerunCommand === "string" && context.rerunCommand.trim().length > 0
        ? [context.rerunCommand.trim()]
        : [];
    const explicitFileLists =
      Array.isArray(context?.explicitFileLists) && context.explicitFileLists.length > 0
        ? context.explicitFileLists
        : null;
    const chunkingPlan =
      datasetHint || rerunCommands.length
        ? [
            {
              goal: datasetHint ?? rerunCommands[0],
              priority: 1,
              lines: null,
              context: normalizedReason,
            },
          ]
        : [];
    const shouldSplit = chunkingPlan.length > 0;
    const fallbackFixes = explicitFileLists
      ? explicitFileLists.map((files, index) => ({
          description:
            index === 0
              ? "Follow explicit file list from the task; rerun after addressing the failure reason."
              : "Follow explicit file list from the task.",
          files,
          commands: index === 0 ? rerunCommands : [],
          owner: null,
        }))
      : [
          {
            description: "Re-run MiniPhi analyzer after addressing the failure reason.",
            files: [],
            commands: rerunCommands,
            owner: null,
          },
        ];
    const payload = {
      task: taskLabel,
      root_cause: null,
      summary: summaryText,
      summary_updates: summaryUpdates,
      evidence: [
        {
          chunk: "Fallback summary",
          line_hint: null,
          excerpt: evidenceExcerpt,
        },
      ],
      recommended_fixes: fallbackFixes,
      next_steps: [nextStep],
      needs_more_context: Boolean(datasetHint),
      missing_snippets: datasetHint ? [datasetHint] : [],
      truncation_strategy: {
        should_split: shouldSplit,
        chunking_plan: chunkingPlan,
        carryover_fields: ["chunk", "line_hint", "symptom"],
        history_schema: "chunk_label,line_window,summary,commands_run,follow_up_actions",
        notes: "Generated automatically after Phi-4 failed to emit tokens; refine after rerun.",
      },
    };
    return JSON.stringify(payload, null, 2);
  }

  _buildSchemaInstructions() {
    if (this.schemaRegistry && this.schemaId) {
      const block = this.schemaRegistry.buildInstructionBlock(this.schemaId, {
        compact: true,
        maxLength: 1800,
      });
      if (block) {
        return block;
      }
    }
    return ["```json", LOG_ANALYSIS_FALLBACK_SCHEMA, "```"].join("\n");
  }

  async _compressLines(lines, summaryLevels, verbose) {
    if (lines.length === 0) {
      return { content: "Command produced no output.", tokens: 32 };
    }

    let content;
    if (lines.length <= 50) {
      content = lines.join("\n");
    } else if (lines.length <= 500) {
      content = this.extractKeyLines(lines, 0.3);
    } else {
      if (verbose) {
        console.log("[MiniPhi] Invoking Python summarizer for recursive compression...");
      }
      try {
        const summary = await this.summarizer.summarizeLines(lines, summaryLevels);
        content = this.formatSummary(summary);
      } catch (error) {
        console.warn(
          `[MiniPhi] Summarizer failed (${error instanceof Error ? error.message : error}). Falling back to extractive compression.`,
        );
        content = this.extractKeyLines(lines, 0.2);
      }
    }

    const tokens = Math.max(1, Math.ceil(content.length / 4));
    return { content, tokens };
  }

  _formatCompression(totalLines, compressedTokens) {
    if (!totalLines || !compressedTokens) {
      return "N/A";
    }
    const approxCompressedLines = compressedTokens / 4;
    const ratio = totalLines / Math.max(1, approxCompressedLines);
    return `${ratio.toFixed(1)}x`;
  }

  _formatFallbackDiagnostics(details = undefined) {
    if (!details || typeof details !== "object") {
      return "";
    }
    const parts = [];
    const schemaId =
      typeof details.schemaId === "string" && details.schemaId.trim()
        ? details.schemaId.trim()
        : null;
    if (schemaId) {
      parts.push(`schema=${schemaId}`);
    }
    if (Number.isFinite(details.lines) && details.lines >= 0) {
      parts.push(`lines=${details.lines}`);
    }
    if (Number.isFinite(details.chunkCount)) {
      parts.push(`chunks=${details.chunkCount}`);
    }
    if (Number.isFinite(details.tokens) && details.tokens > 0) {
      if (Number.isFinite(details.lines) && details.lines > 0) {
        parts.push(`compression=${this._formatCompression(details.lines, details.tokens)}`);
      } else {
        parts.push(`tokens=${details.tokens}`);
      }
    }
    const datasetLabel = this._formatDatasetLabel(details.datasetLabel);
    if (datasetLabel) {
      parts.push(`dataset=${datasetLabel}`);
    }
    if (!parts.length) {
      return "";
    }
    return `Details: ${parts.join(" | ")}`;
  }

  _formatDatasetLabel(label) {
    if (!label && label !== 0) {
      return null;
    }
    const normalized = label.toString().trim();
    if (!normalized) {
      return null;
    }
    if (normalized.length <= 80) {
      return `"${normalized}"`;
    }
    return `"${normalized.slice(0, 77)}..."`;
  }

  _extractExplicitFileLists(task) {
    if (!task || typeof task !== "string") {
      return [];
    }
    const lists = [];
    const seen = new Set();
    const regex = /\bfiles?\b[^[]*(\[[^\]]+\])/gi;
    let match = null;
    while ((match = regex.exec(task))) {
      const raw = match[1];
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every((entry) => typeof entry === "string" && entry.trim())
        ) {
          const normalized = parsed.map((entry) => entry.trim());
          const key = JSON.stringify(normalized);
          if (!seen.has(key)) {
            seen.add(key);
            lists.push(normalized);
          }
        }
      } catch {
        // ignore invalid lists
      }
    }
    return lists;
  }

  async _resolvePromptBudget(options = undefined) {
    let budget = 4096;
    if (!this.phi4 || typeof this.phi4.getContextWindow !== "function") {
      const cap = Number(options?.maxTokens);
      if (Number.isFinite(cap) && cap > 0) {
        budget = Math.min(budget, Math.floor(cap));
      }
      return Math.max(768, budget);
    }
    try {
      const window = await this.phi4.getContextWindow();
      const normalized = Number(window);
      if (Number.isFinite(normalized) && normalized > 0) {
        budget = Math.max(1024, normalized - 1024);
      }
    } catch {
      // ignore errors and use fallback
    }
    const cap = Number(options?.maxTokens);
    if (Number.isFinite(cap) && cap > 0) {
      budget = Math.min(budget, Math.floor(cap));
    }
    return Math.max(768, budget);
  }

  _estimateTokens(text) {
    if (!text) {
      return 0;
    }
    return Math.max(1, Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN));
  }

  _buildBudgetedPrompt({
    chunkSummaries,
    summaryLevels,
    task,
    totalLines,
    workspaceContext,
    promptBudget,
    devLog,
    schemaId,
    chunking,
    sourceLabel,
    explicitFileLists,
    keywordHighlights,
  }) {
    let detailLevel = summaryLevels;
    let chunkLimit = chunkSummaries.length;
    const contextBudgetRatios = [0.3, 0.2, 0.15, 0.1, 0.05];
    let contextBudgetIndex = 0;
    const hasRawSummary = chunkSummaries.some((entry) => {
      const summary = entry?.chunk?.summary;
      return (
        typeof summary?.raw === "string" ||
        typeof summary?.summary?.raw === "string"
      );
    });
    const allowDetailReduction = !hasRawSummary;
    const highlightBlock =
      typeof keywordHighlights === "string" && keywordHighlights.trim().length > 0
        ? keywordHighlights.trim()
        : "";
    if (chunkLimit === 0) {
      const fallbackBody = highlightBlock || "(no content)";
      return {
        prompt: this.generateSmartPrompt(
          task,
          fallbackBody,
          0,
          {
            compressedTokens: this._estimateTokens(fallbackBody),
            schemaId,
            sourceLabel,
            explicitFileLists,
          },
          {},
        ),
        body: fallbackBody,
        linesUsed: 0,
        tokensUsed: this._estimateTokens(fallbackBody),
      };
    }
    let droppedChunks = 0;
    const startingDetail = detailLevel;
    let attempts = 0;
    let composed;
    let composedText = "";
    let prompt;
    let tokens;
    while (attempts < 20) {
      composed = this._composeChunkSummaries(chunkSummaries, chunkLimit, detailLevel);
      composedText = highlightBlock
        ? composed.text
          ? `${highlightBlock}\n\n${composed.text}`
          : highlightBlock
        : composed.text;
      const chunkingSummary = this._buildChunkingSummary({
        chunkSummaries,
        limit: chunkLimit,
        maxLinesPerChunk: chunking?.maxLinesPerChunk ?? null,
        lineRange: chunking?.lineRange ?? null,
        maxChunkRanges: 12,
      });
      const extraContext = {
        workspaceSummary: workspaceContext?.summary ?? null,
        workspaceType:
          workspaceContext?.classification?.label ?? workspaceContext?.classification?.domain ?? null,
        workspaceHint: workspaceContext?.hintBlock ?? null,
        workspaceDirectives: workspaceContext?.planDirectives ?? workspaceContext?.directives ?? null,
        manifestPreview: workspaceContext?.manifestPreview ?? null,
        readmeSnippet: workspaceContext?.readmeSnippet ?? null,
        taskPlanSummary: workspaceContext?.taskPlanSummary ?? null,
        taskPlanOutline: workspaceContext?.taskPlanOutline ?? null,
        taskPlanSegmentsBlock: workspaceContext?.taskPlanSegmentsBlock ?? null,
        taskPlanRecommendationsBlock: workspaceContext?.taskPlanRecommendationsBlock ?? null,
        capabilitySummary: workspaceContext?.capabilitySummary ?? null,
        connectionSummary:
          workspaceContext?.connectionSummary ?? workspaceContext?.connections?.summary ?? null,
        connectionGraphic: workspaceContext?.connectionGraphic ?? null,
        fixedReferences: workspaceContext?.fixedReferences ?? null,
        helperScript: workspaceContext?.helperScript ?? null,
        navigationSummary: workspaceContext?.navigationSummary ?? null,
        navigationBlock: workspaceContext?.navigationBlock ?? null,
        commandLibraryBlock: workspaceContext?.commandLibraryBlock ?? null,
        compositionBlock: workspaceContext?.compositionBlock ?? null,
        promptTemplateBlock: workspaceContext?.promptTemplateBlock ?? null,
        truncationPlan: workspaceContext?.truncationPlan ?? null,
      };
      const lineCount =
        Number.isFinite(totalLines) && totalLines > 0 ? totalLines : composed.lines || 1;
      const contextRatio = contextBudgetRatios[contextBudgetIndex] ?? 0.3;
      const contextBudgetTokens = Math.max(64, Math.floor(promptBudget * contextRatio));
      prompt = this.generateSmartPrompt(
        task,
        composedText,
        lineCount,
        {
          compressedTokens: this._estimateTokens(composedText),
          originalSize: totalLines * 4,
          schemaId,
          chunking: chunkingSummary,
          contextBudgetTokens,
          sourceLabel,
          explicitFileLists,
        },
        extraContext,
      );
      tokens = this._estimateTokens(prompt);
      if (tokens <= promptBudget) {
        break;
      }
      attempts += 1;
      if (contextBudgetIndex < contextBudgetRatios.length - 1) {
        contextBudgetIndex += 1;
        const ratioLabel = Math.round(contextBudgetRatios[contextBudgetIndex] * 100);
        const note = `Prompt exceeded budget (${tokens} > ${promptBudget}); reducing context supplement budget to ${ratioLabel}% of prompt budget.`;
        console.log(`[MiniPhi] ${note}`);
        this._logDev(devLog, note);
        continue;
      }
      if (detailLevel > 0 && allowDetailReduction) {
        detailLevel -= 1;
        const note = `Prompt exceeded budget (${tokens} > ${promptBudget}); reducing summary detail to level ${detailLevel}.`;
        console.log(`[MiniPhi] ${note}`);
        this._logDev(devLog, note);
        continue;
      }
      if (chunkLimit > 1) {
        chunkLimit -= 1;
        droppedChunks += 1;
        const msg = `Prompt still too large; dropping chunk ${chunkLimit + 1} and retrying.`;
        console.log(`[MiniPhi] ${msg}`);
        this._logDev(devLog, msg);
        continue;
      }
      break;
    }
    if (tokens > promptBudget) {
      const truncated = this._truncateToBudget(prompt, promptBudget);
      prompt = truncated.prompt;
      tokens = truncated.tokens;
      this._logDev(
        devLog,
        `Prompt truncated to fit context window (${tokens}/${promptBudget} tokens).`,
      );
    }
    const detailReductions = Math.max(0, startingDetail - detailLevel);
    const budgetNote = this._formatBudgetNote({
      promptBudget,
      tokens,
      droppedChunks,
      detailReductions,
    });
    if (budgetNote) {
      this._logDev(devLog, `Prompt budget note: ${budgetNote}`);
    }
    return {
      prompt,
      body: composedText || composed?.text || "",
      linesUsed: composed?.lines ?? totalLines,
      tokensUsed: tokens,
      droppedChunks,
      detailLevel,
      detailReductions,
    };
  }

  _composeChunkSummaries(chunkSummaries, limit, maxLevel) {
    const segments = [];
    let lines = 0;
    const count = Math.max(1, Math.min(limit, chunkSummaries.length));
    for (let idx = 0; idx < count; idx += 1) {
      const { chunk, label } = chunkSummaries[idx];
      const text = this.formatSummary(chunk, label, maxLevel);
      if (text) {
        segments.push(text);
      }
      lines += chunk?.input_lines ?? 0;
    }
    return {
      text: segments.join("\n"),
      lines,
    };
  }

  _buildChunkingSummary({ chunkSummaries, limit, maxLinesPerChunk, lineRange, maxChunkRanges }) {
    if (!Array.isArray(chunkSummaries) || chunkSummaries.length === 0) {
      return null;
    }
    const count = Math.max(1, Math.min(limit ?? chunkSummaries.length, chunkSummaries.length));
    const rangeLimit = Number.isFinite(maxChunkRanges) && maxChunkRanges > 0 ? maxChunkRanges : 12;
    const ranges = [];
    let cursor = Number.isFinite(lineRange?.startLine) ? lineRange.startLine : 1;
    for (let idx = 0; idx < count; idx += 1) {
      const { chunk, label } = chunkSummaries[idx];
      const inputLines =
        Number.isFinite(chunk?.input_lines) && chunk.input_lines >= 0 ? chunk.input_lines : 0;
      const startLine = cursor;
      const endLine = inputLines > 0 ? cursor + inputLines - 1 : cursor;
      if (ranges.length < rangeLimit) {
        ranges.push({
          label: label ?? `Chunk ${idx + 1}`,
          start_line: startLine,
          end_line: endLine,
          input_lines: inputLines,
        });
      }
      cursor = endLine + 1;
    }
    const totalChunks = chunkSummaries.length;
    const rangeSummary =
      lineRange && (lineRange.startLine || lineRange.endLine)
        ? {
            start_line: lineRange.startLine ?? null,
            end_line: lineRange.endLine ?? null,
          }
        : null;
    return {
      max_lines_per_chunk: Number.isFinite(maxLinesPerChunk) ? maxLinesPerChunk : null,
      total_chunks: totalChunks,
      included_chunks: count,
      dropped_chunks: totalChunks - count,
      line_range: rangeSummary,
      chunk_ranges: ranges,
      chunk_ranges_truncated: count > rangeLimit,
      chunk_ranges_omitted: count > rangeLimit ? count - rangeLimit : 0,
    };
  }

  _truncateToBudget(prompt, budgetTokens) {
    if (!prompt) {
      return { prompt: "", tokens: 0 };
    }
    const estimate = this._estimateTokens(prompt);
    if (estimate <= budgetTokens) {
      return { prompt, tokens: estimate };
    }
    let parsed;
    try {
      parsed = JSON.parse(prompt);
    } catch {
      return { prompt, tokens: estimate };
    }
    if (!parsed || typeof parsed !== "object") {
      return { prompt, tokens: estimate };
    }
    let compacted = this._compactPromptRequest(parsed);
    let serialized = JSON.stringify(compacted);
    let tokens = this._estimateTokens(serialized);
    if (tokens <= budgetTokens) {
      return { prompt: serialized, tokens };
    }

    const data = compacted?.payload?.data;
    if (typeof data !== "string" || data.length === 0) {
      return { prompt: serialized, tokens };
    }
    const basePayload = {
      ...(compacted.payload ?? {}),
      data: "",
    };
    const baseRequest = {
      ...compacted,
      payload: basePayload,
    };
    const baseTokens = this._estimateTokens(JSON.stringify(baseRequest));
    if (baseTokens >= budgetTokens) {
      compacted.payload = basePayload;
      compacted.payload.data = "[Prompt truncated due to context limit]";
      serialized = JSON.stringify(compacted);
      tokens = this._estimateTokens(serialized);
      return { prompt: serialized, tokens };
    }

    const note = "[Prompt truncated due to context limit]";
    const availableTokens = Math.max(1, budgetTokens - baseTokens);
    let targetLength = Math.max(0, Math.floor(availableTokens * 4) - note.length - 8);
    let truncatedData = data.slice(0, targetLength).trimEnd();
    truncatedData = truncatedData ? `${truncatedData}\n${note}` : note;
    compacted.payload.data = truncatedData;
    serialized = JSON.stringify(compacted);
    tokens = this._estimateTokens(serialized);
    let attempts = 0;
    while (tokens > budgetTokens && truncatedData.length > 0 && attempts < 8) {
      targetLength = Math.max(0, Math.floor(targetLength * (budgetTokens / tokens)) - note.length - 8);
      truncatedData = data.slice(0, targetLength).trimEnd();
      truncatedData = truncatedData ? `${truncatedData}\n${note}` : note;
      compacted.payload.data = truncatedData;
      serialized = JSON.stringify(compacted);
      tokens = this._estimateTokens(serialized);
      attempts += 1;
    }
    return { prompt: serialized, tokens };
  }

  _compactPromptRequest(request) {
    const compacted = JSON.parse(JSON.stringify(request ?? {}));
    const trimmed = [];
    if (compacted.payload?.reporting_rules) {
      delete compacted.payload.reporting_rules;
      trimmed.push("payload.reporting_rules");
    }
    if (compacted.payload?.context) {
      delete compacted.payload.context;
      trimmed.push("payload.context");
    }
    if (compacted.payload?.dataset) {
      delete compacted.payload.dataset.compression;
      delete compacted.payload.dataset.approx_original_bytes;
    }
    const chunking = compacted.payload?.dataset?.chunking;
    if (chunking?.chunk_ranges?.length) {
      const omitted = chunking.chunk_ranges.length;
      chunking.chunk_ranges = [];
      chunking.chunk_ranges_truncated = true;
      chunking.chunk_ranges_omitted = omitted;
      trimmed.push("payload.dataset.chunking.chunk_ranges");
    }
    if (compacted.schema?.definition && typeof compacted.schema.definition === "object") {
      compacted.schema.definition = this._stripSchemaDescriptions(compacted.schema.definition);
      compacted.schema.compacted = true;
      trimmed.push("schema.definition.description");
    }
    if (trimmed.length) {
      compacted.compaction = {
        removed: trimmed,
        note: "Compacted prompt scaffolding to fit context budget.",
      };
    }
    return compacted;
  }

  _stripSchemaDescriptions(value) {
    if (!value || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this._stripSchemaDescriptions(entry));
    }
    const cleaned = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "description") {
        continue;
      }
      cleaned[key] = this._stripSchemaDescriptions(entry);
    }
    return cleaned;
  }

  async _handleInvalidJsonAnalysis(payload) {
    const {
      analysis,
      devLog,
      schemaId,
      task,
      command,
      linesAnalyzed,
      compression,
      traceOptions,
      fallbackDiagnosticsFn,
    } = payload ?? {};
    if (!analysis) {
      return null;
    }
    const artifactPath = await this._writeRawResponseArtifact(
      analysis,
      devLog,
      `${this._safeLabel(command ?? task ?? "analysis") || "analysis"}-raw-response`,
    );
    if (artifactPath) {
      this._logDev(devLog, `Saved raw Phi response to ${artifactPath}`);
    }
    const salvageReport = {
      strategy: "raw-capture",
      rawArtifactPath: artifactPath ?? null,
      note: null,
      linesAnalyzed: linesAnalyzed ?? null,
    };
    const retry = await this._retrySchemaOnlyPrompt({
      schemaId,
      task,
      command,
      compression,
      traceOptions,
      devLog,
    });
    if (retry) {
      console.warn("[MiniPhi] Phi response failed validation; schema-only retry succeeded.");
      this._logDev(devLog, "Schema-only retry produced valid JSON response.");
      salvageReport.strategy = "schema-retry";
      salvageReport.note = "Schema-only retry produced valid JSON.";
      return { analysis: retry, usedFallback: false, salvageReport };
    }
    this._logDev(devLog, "JSON salvage and schema-only retry failed; falling back.");
    salvageReport.strategy = "schema-retry-failed";
    salvageReport.note = "JSON salvage and schema-only retry failed.";
    return { analysis: null, usedFallback: false, salvageReport };
  }

  async _retrySchemaOnlyPrompt({ schemaId, task, command, compression, traceOptions, devLog }) {
    if (!this.phi4) {
      return null;
    }
    const schemaReference = this._buildSchemaReference(schemaId);
    const datasetSummary = this._clampContextForSchemaRetry(compression?.content ?? "");
    const retryPrompt = JSON.stringify(
      {
        request_type: "analysis-schema-retry",
        schema: schemaReference,
        response_format: "json_schema",
        instructions: [
          "Re-run the analysis and return STRICT JSON that matches the schema.",
          "Do not include explanations, greetings, or code fences around the JSON.",
        ],
        task: task ?? null,
        origin: command ?? null,
        context_excerpt: datasetSummary || null,
      },
      null,
      2,
    );

    const priorHistory =
      typeof this.phi4.getHistory === "function" ? this.phi4.getHistory() : null;
    let retryResponse = "";
    try {
      if (typeof this.phi4.setHistory === "function") {
        // isolate retry to avoid contaminating the main chat history with previous attempts
        this.phi4.setHistory(priorHistory ? [priorHistory[0]] : null);
      }
      await this.phi4.chatStream(
        retryPrompt,
        (token) => {
          retryResponse += token;
        },
        undefined,
        (err) => {
          this._logDev(devLog, `Schema-only retry error: ${err}`);
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(message);
        },
        {
          ...(traceOptions ?? {}),
          label: "analysis-schema-retry",
          schemaId: schemaId ?? this.schemaId,
          responseFormat:
            traceOptions?.responseFormat ??
            this._buildJsonSchemaResponseFormat(schemaId ?? this.schemaId) ??
            null,
        },
      );
    } catch (error) {
      if (error instanceof LMStudioProtocolError) {
        throw error;
      }
      return null;
    } finally {
      if (priorHistory && typeof this.phi4.setHistory === "function") {
        this.phi4.setHistory(priorHistory);
      }
    }
    const sanitized = this._sanitizeJsonResponse(retryResponse);
    return sanitized ?? null;
  }

  _clampContextForSchemaRetry(contextText, maxLength = 4000) {
    if (!contextText || typeof contextText !== "string") {
      return "";
    }
    const normalized = contextText.trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength)}\n[context trimmed for schema retry]`;
  }

  _buildJsonSchemaResponseFormat(schemaId) {
    if (
      !schemaId ||
      !this.schemaRegistry ||
      typeof this.schemaRegistry.getSchema !== "function"
    ) {
      return null;
    }
    const schema = this.schemaRegistry.getSchema(schemaId);
    if (!schema?.definition || typeof schema.definition !== "object") {
      return null;
    }
    return buildJsonSchemaResponseFormat(schema.definition, schema.id ?? schemaId);
  }

  _validateAnalysisSchema(schemaId, analysisText) {
    if (
      !schemaId ||
      !analysisText ||
      !this.schemaRegistry ||
      typeof this.schemaRegistry.validate !== "function"
    ) {
      return null;
    }
    try {
      return this.schemaRegistry.validate(schemaId, analysisText);
    } catch {
      return null;
    }
  }

  _sanitizeJsonResponse(text, options = undefined) {
    if (!text) {
      return null;
    }
    const parsed = parseStrictJsonObject(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return null;
    }
    const normalized = this._normalizeContextFields(parsed, options);
    return JSON.stringify(normalized, null, 2);
  }

  _normalizeContextFields(parsed, options = undefined) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return parsed;
    }
    const needsMoreContext =
      typeof parsed.needs_more_context === "boolean"
        ? parsed.needs_more_context
        : typeof parsed.needsMoreContext === "boolean"
          ? parsed.needsMoreContext
          : false;
    if (typeof parsed.needs_more_context !== "boolean") {
      parsed.needs_more_context = needsMoreContext;
    }
    if (!Array.isArray(parsed.missing_snippets)) {
      parsed.missing_snippets = Array.isArray(parsed.missingSnippets)
        ? parsed.missingSnippets
        : [];
    }
    return this._sanitizeRecommendedFixes(parsed, options);
  }

  _sanitizeRecommendedFixes(parsed, options = undefined) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return parsed;
    }
    if (!Array.isArray(parsed.recommended_fixes)) {
      return parsed;
    }
    const docLike =
      typeof options?.docLike === "boolean"
        ? options.docLike
        : typeof options?.sourceFile === "string" && this._isDocLikeFile(options.sourceFile);
    const fileHints = this._buildAllowedFileHints(options);
    const explicitFileLists = Array.isArray(options?.explicitFileLists)
      ? options.explicitFileLists
      : null;
    const sanitized = [];
    for (const entry of parsed.recommended_fixes) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const description =
        typeof entry.description === "string" ? entry.description.trim() : "";
      if (!description) {
        continue;
      }
      const files = Array.isArray(entry.files)
        ? entry.files
            .filter((file) => typeof file === "string")
            .map((file) => file.trim())
            .filter(Boolean)
        : [];
      const commands = Array.isArray(entry.commands)
        ? entry.commands
            .filter((command) => typeof command === "string")
            .map((command) => command.trim())
            .filter(Boolean)
        : [];
      const validFiles = files.filter((file) => this._isAllowedFileReference(file, fileHints));
      const commandMentions = commands.some((command) =>
        this._commandMentionsAllowedFile(command, fileHints),
      );
      if (docLike && validFiles.length === 0 && !commandMentions) {
        continue;
      }
      if (!docLike && files.length > 0 && validFiles.length === 0 && !commandMentions) {
        continue;
      }
      sanitized.push({
        ...entry,
        description,
        files: validFiles,
        commands,
      });
    }
    if (explicitFileLists && explicitFileLists.length) {
      sanitized.forEach((entry, index) => {
        if (!entry || !Array.isArray(entry.files) || entry.files.length > 0) {
          return;
        }
        const explicit = explicitFileLists[index];
        if (!Array.isArray(explicit) || explicit.length === 0) {
          return;
        }
        const normalized = explicit
          .filter((file) => typeof file === "string")
          .map((file) => file.trim())
          .filter(Boolean);
        if (normalized.length > 0) {
          entry.files = normalized;
        }
      });
    }
    parsed.recommended_fixes = sanitized;
    return parsed;
  }

  _buildAllowedFileHints(options = undefined) {
    const workspaceContext = options?.workspaceContext ?? null;
    const root =
      typeof workspaceContext?.root === "string" && workspaceContext.root.trim().length
        ? path.resolve(workspaceContext.root)
        : process.cwd();
    const hints = {
      root,
      paths: new Set(),
      basenames: new Set(),
    };
    const addCandidate = (candidate) => {
      const normalized = this._normalizeFileHint(candidate);
      if (!normalized) {
        return;
      }
      const lower = normalized.toLowerCase();
      hints.paths.add(lower);
      const basename = path.basename(normalized).toLowerCase();
      if (basename) {
        hints.basenames.add(basename);
      }
      const absolute = path.isAbsolute(normalized)
        ? path.resolve(normalized)
        : path.resolve(hints.root, normalized);
      if (absolute) {
        const absoluteNormalized = absolute.replace(/\\/g, "/").toLowerCase();
        hints.paths.add(absoluteNormalized);
        const rootLower = hints.root.replace(/\\/g, "/").toLowerCase();
        if (absoluteNormalized.startsWith(rootLower)) {
          const relative = path
            .relative(hints.root, absolute)
            .replace(/\\/g, "/")
            .toLowerCase();
          if (relative) {
            hints.paths.add(relative);
          }
        }
      }
    };
    if (typeof options?.sourceFile === "string") {
      addCandidate(options.sourceFile);
    }
    if (Array.isArray(workspaceContext?.manifestPreview)) {
      for (const entry of workspaceContext.manifestPreview) {
        addCandidate(entry?.path);
      }
    }
    if (Array.isArray(workspaceContext?.fixedReferences)) {
      for (const ref of workspaceContext.fixedReferences) {
        addCandidate(ref?.path ?? ref?.relative ?? ref?.label);
      }
    }
    if (Array.isArray(options?.explicitFileLists)) {
      for (const list of options.explicitFileLists) {
        if (!Array.isArray(list)) {
          continue;
        }
        for (const entry of list) {
          addCandidate(entry);
        }
      }
    }
    return hints;
  }

  _normalizeFileHint(candidate) {
    if (!candidate || typeof candidate !== "string") {
      return null;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.replace(/\\/g, "/");
  }

  _isAllowedFileReference(filePath, hints) {
    if (!filePath || typeof filePath !== "string") {
      return false;
    }
    const normalized = this._normalizeFileHint(filePath);
    if (!normalized) {
      return false;
    }
    const lower = normalized.toLowerCase();
    if (hints?.paths?.has(lower)) {
      return true;
    }
    const basename = path.basename(normalized).toLowerCase();
    if (basename && hints?.basenames?.has(basename)) {
      return true;
    }
    const root = hints?.root;
    if (root) {
      const absolute = path.isAbsolute(normalized)
        ? path.resolve(normalized)
        : path.resolve(root, normalized);
      const rootLower = root.replace(/\\/g, "/").toLowerCase();
      const absoluteLower = absolute.replace(/\\/g, "/").toLowerCase();
      if (absoluteLower.startsWith(rootLower) && fs.existsSync(absolute)) {
        return true;
      }
    } else if (path.isAbsolute(normalized) && fs.existsSync(normalized)) {
      return true;
    }
    return false;
  }

  _commandMentionsAllowedFile(command, hints) {
    if (!command || !hints?.basenames?.size) {
      return false;
    }
    const normalized = command.toLowerCase();
    for (const basename of hints.basenames) {
      if (basename && normalized.includes(basename)) {
        return true;
      }
    }
    return false;
  }

  _formatBudgetNote({ promptBudget, tokens, droppedChunks, detailReductions }) {
    const parts = [];
    if (detailReductions > 0) {
      parts.push(`Reduced summary detail by ${detailReductions} level(s).`);
    }
    if (droppedChunks > 0) {
      parts.push(`Dropped ${droppedChunks} chunk(s) to fit context.`);
    }
    if (tokens > promptBudget) {
      parts.push(`Final prompt still near/over budget (${tokens}/${promptBudget} est. tokens).`);
    }
    return parts.join(" ");
  }

  _formatContextSupplement(extraContext, options = undefined) {
    if (!extraContext) {
      return "";
    }
    const lines = [];
    if (extraContext.workspaceType) {
      lines.push(`**Workspace type detected:** ${extraContext.workspaceType}`);
    }
    if (extraContext.workspaceSummary) {
      lines.push(extraContext.workspaceSummary);
    }
    const workspaceHint =
      typeof extraContext.workspaceHint === "string" ? extraContext.workspaceHint : "";
    if (workspaceHint) {
      lines.push(workspaceHint);
    } else if (Array.isArray(extraContext.manifestPreview) && extraContext.manifestPreview.length) {
      const manifest = extraContext.manifestPreview
        .slice(0, 6)
        .map((entry) => `- ${entry.path} (${entry.bytes} bytes)`)
        .join("\n");
      lines.push(`File manifest sample:\n${manifest}`);
    }
    if (
      extraContext.workspaceDirectives &&
      (!workspaceHint || !workspaceHint.includes("Workspace directives:"))
    ) {
      lines.push(`Workspace directives: ${extraContext.workspaceDirectives}`);
    }
    if (extraContext.readmeSnippet) {
      lines.push(`README excerpt:\n${extraContext.readmeSnippet}`);
    }
    if (extraContext.taskPlanSummary) {
      lines.push(`Task plan:\n${extraContext.taskPlanSummary}`);
    }
    if (extraContext.taskPlanOutline) {
      const outlineLines = extraContext.taskPlanOutline.split(/\r?\n/);
      const preview = outlineLines.slice(0, 12).join("\n");
      const suffix = outlineLines.length > 12 ? "\n..." : "";
      lines.push(`Task plan outline:\n${preview}${suffix}`);
    }
    if (extraContext.taskPlanSegmentsBlock) {
      lines.push(`Task plan segments:\n${extraContext.taskPlanSegmentsBlock}`);
    }
    if (extraContext.taskPlanRecommendationsBlock) {
      lines.push(extraContext.taskPlanRecommendationsBlock);
    }
    if (extraContext.connectionSummary) {
      lines.push(`File connection hints:\n${extraContext.connectionSummary}`);
    }
    if (extraContext.connectionGraphic) {
      lines.push(extraContext.connectionGraphic);
    }
    if (extraContext.capabilitySummary) {
      lines.push(`Available tools:\n${extraContext.capabilitySummary}`);
    }
    if (extraContext.navigationBlock) {
      lines.push(extraContext.navigationBlock);
    } else if (extraContext.navigationSummary) {
      lines.push(`Navigation hints: ${extraContext.navigationSummary}`);
    }
    if (Array.isArray(extraContext.fixedReferences) && extraContext.fixedReferences.length) {
      const refs = extraContext.fixedReferences
        .slice(0, 4)
        .map((ref) => {
          const status = ref.error ? `missing (${ref.error})` : `${ref.bytes ?? "?"} bytes`;
          const hash =
            typeof ref.hash === "string" && ref.hash.length
              ? `sha256=${ref.hash.slice(0, 12)}`
              : null;
          const meta = [status, hash].filter(Boolean).join(" | ");
          return `- ${ref.relative ?? ref.path}: ${meta}`;
        })
        .join("\n");
      lines.push(`Fixed references pinned for this task:\n${refs}`);
    }
    if (extraContext.helperScript) {
      const helper = extraContext.helperScript;
      const helperParts = [];
      if (helper.version) {
        helperParts.push(`v${helper.version}`);
      }
      if (helper.description) {
        helperParts.push(helper.description);
      }
      if (helper.run?.summary) {
        helperParts.push(helper.run.summary);
      }
      if (helper.path) {
        helperParts.push(`saved at ${helper.path}`);
      }
      if (helper.stdin) {
        helperParts.push(`stdin available: ${this._truncateForLog(helper.stdin, 160)}`);
      }
      if (helperParts.length) {
        lines.push(`Helper script (${helper.language ?? "node"}): ${helperParts.join(" | ")}`);
      }
    }
    if (extraContext.commandLibraryBlock) {
      lines.push(extraContext.commandLibraryBlock);
    }
    if (extraContext.compositionBlock) {
      lines.push(extraContext.compositionBlock);
    }
    if (extraContext.promptTemplateBlock) {
      lines.push(extraContext.promptTemplateBlock);
    }
    if (
      extraContext.indexSummaries?.entries &&
      Array.isArray(extraContext.indexSummaries.entries) &&
      extraContext.indexSummaries.entries.length
    ) {
      const header = `MiniPhi index overview (updated ${extraContext.indexSummaries.updatedAt ?? "unknown"}):`;
      const summaryText = extraContext.indexSummaries.entries
        .map((entry) => {
          const parts = [];
          if (entry.entries !== null && entry.entries !== undefined) {
            parts.push(`${entry.entries} entries`);
          }
          if (entry.summary) {
            parts.push(entry.summary);
          }
          const fallback = parts.length ? parts.join(" | ") : "no summary";
          return `- ${entry.name}: ${fallback}`;
        })
        .join("\n");
      lines.push(`${header}\n${summaryText}`);
    }
    if (Array.isArray(extraContext.benchmarkHistory) && extraContext.benchmarkHistory.length) {
      const header = `Recent benchmark digests (latest ${extraContext.benchmarkHistory.length}):`;
      const historyText = extraContext.benchmarkHistory
        .map((entry) => {
          const parts = [];
          if (entry.directory) {
            parts.push(entry.directory);
          }
          if (entry.totalRuns !== null && entry.totalRuns !== undefined) {
            parts.push(`${entry.totalRuns} run${entry.totalRuns === 1 ? "" : "s"}`);
          }
          if (entry.warningRuns !== null && entry.warningRuns !== undefined) {
            parts.push(`${entry.warningRuns} warning entries`);
          }
          if (entry.mismatchRuns !== null && entry.mismatchRuns !== undefined) {
            parts.push(`${entry.mismatchRuns} mismatch entries`);
          }
          const label = parts.length ? parts.join(" | ") : entry.type ?? "benchmark";
          const timestamp = entry.analyzedAt ? `analyzed ${entry.analyzedAt}` : "analysis time unknown";
          const artifactNote =
            entry.artifacts?.summary && typeof entry.artifacts.summary === "string"
              ? `summary artifact ${entry.artifacts.summary}`
              : null;
          return `- ${label} (${timestamp}${artifactNote ? `; ${artifactNote}` : ""})`;
        })
        .join("\n");
      lines.push(`${header}\n${historyText}`);
    }
    if (extraContext.truncationPlan) {
      const planBlock = this._formatTruncationPlan(extraContext.truncationPlan);
      if (planBlock) {
        lines.push(planBlock);
      }
    }
    if (!lines.length) {
      return "";
    }
    const context = lines.join("\n");
    if (options?.maxTokens && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
      return this._truncateContextSupplement(context, options.maxTokens);
    }
    return context;
  }

  _truncateContextSupplement(text, maxTokens) {
    if (!text) {
      return "";
    }
    const maxChars = Math.max(256, Math.floor(maxTokens * 4));
    if (text.length <= maxChars) {
      return text;
    }
    const trimmed = text.slice(0, maxChars).trimEnd();
    return `${trimmed}\n[context trimmed for budget]`;
  }

  _formatTruncationPlan(context) {
    if (!context) {
      return "";
    }
    const plan = context.plan ?? context;
    if (!plan || !Array.isArray(plan.chunkingPlan)) {
      return "";
    }
    const lines = [];
    const sourceLabelParts = [];
    if (context.executionId) {
      sourceLabelParts.push(`execution ${context.executionId}`);
    }
    if (context.createdAt) {
      sourceLabelParts.push(`captured ${context.createdAt}`);
    }
    if (sourceLabelParts.length) {
      lines.push(`Truncation plan from ${sourceLabelParts.join(" / ")}`);
    } else {
      lines.push("Truncation plan summary");
    }
    if (Array.isArray(plan.carryoverFields) && plan.carryoverFields.length) {
      lines.push(`Carryover fields: ${plan.carryoverFields.join(", ")}`);
    }
    if (plan.historySchema) {
      lines.push(`History schema: ${plan.historySchema}`);
    }
    const selected = context.selectedChunk;
    if (selected) {
      const selectedRange =
        selected.startLine || selected.endLine
          ? `lines ${selected.startLine ?? "?"}-${selected.endLine ?? "end"}`
          : null;
      const selectedParts = [`Active chunk: ${selected.goal ?? selected.label ?? "Chunk"}`];
      if (selectedRange) {
        selectedParts.push(selectedRange);
      }
      if (selected.context) {
        selectedParts.push(selected.context);
      }
      lines.push(selectedParts.join(" | "));
    }
    const preview = plan.chunkingPlan.slice(0, 3).map((chunk) => {
      const priorityLabel =
        Number.isFinite(chunk.priority) && chunk.priority > 0
          ? `#${chunk.priority}`
          : `#${chunk.index + 1}`;
      const range =
        chunk.startLine || chunk.endLine
          ? ` (lines ${chunk.startLine ?? "?"}-${chunk.endLine ?? "end"})`
          : "";
      const helperHint =
        Array.isArray(chunk.helperCommands) && chunk.helperCommands.length
          ? ` helpers: ${chunk.helperCommands.join(", ")}`
          : "";
      const contextNote = chunk.context ? ` — ${chunk.context}` : "";
      return `- ${priorityLabel} ${chunk.goal}${range}${contextNote}${helperHint}`;
    });
    if (plan.chunkingPlan.length > preview.length) {
      preview.push(`- ... (${plan.chunkingPlan.length - preview.length} more chunk targets)`);
    }
    lines.push(...preview);
    if (plan.notes) {
      lines.push(`Plan notes: ${plan.notes}`);
    }
    return lines.join("\n");
  }

  _buildStopDiagnostics(error, defaults = undefined) {
    const stopInfo = buildStopReasonInfo({
      error,
      fallbackReason: defaults?.reason,
      fallbackCode: defaults?.code,
      fallbackDetail: defaults?.detail,
    });
    const reason = stopInfo.reason ?? defaults?.reason ?? "analysis-error";
    const code = stopInfo.code ?? defaults?.code ?? "analysis-error";
    const detail =
      stopInfo.detail ??
      stopInfo.message ??
      defaults?.detail ??
      defaults?.reason ??
      reason;
    return {
      reason,
      code,
      detail,
    };
  }

  _applyStopDiagnostics(target, info) {
    if (!target || !info) {
      return;
    }
    if (info.reason && !target.stopReason) {
      target.stopReason = info.reason;
    }
    if (info.code && !target.stopReasonCode) {
      target.stopReasonCode = info.code;
    }
    if (info.detail && !target.stopReasonDetail) {
      target.stopReasonDetail = info.detail;
    }
  }

  _applyPromptTimeout(sessionDeadline, promptHints = undefined) {
    const timeout = this._computePromptTimeout(sessionDeadline, promptHints);
    const hasSessionDeadline = Boolean(sessionDeadline);
    const timeoutOptions = hasSessionDeadline
      ? { allowShorter: true, minTimeoutMs: MIN_SESSION_TIMEOUT_MS }
      : undefined;
    this.phi4.setPromptTimeout(timeout, timeoutOptions);
    if (typeof this.phi4.setNoTokenTimeout === "function") {
      this.phi4.setNoTokenTimeout(timeout, timeoutOptions);
    }
  }

  _withSessionTimeout(sessionDeadline, task) {
    if (!Number.isFinite(sessionDeadline)) {
      return task();
    }
    const remaining = sessionDeadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return Promise.reject(new Error("session-timeout: session deadline exceeded."));
    }
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("session-timeout: session deadline exceeded."));
      }, remaining);
      timer?.unref?.();
    });
    return Promise.race([task(), timeoutPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  _hashDatasetSignature(details = undefined) {
    const label = typeof details?.label === "string" ? details.label : "dataset";
    const lines = Number.isFinite(details?.lineCount) ? details.lineCount : 0;
    const content =
      typeof details?.content === "string"
        ? details.content
        : JSON.stringify(details?.content ?? "");
    return createHash("sha1").update(`${label}::${lines}::${content}`, "utf8").digest("hex");
  }

  async _lookupCachedFallback(cache, query, devLog) {
    if (!cache || typeof cache.loadFallbackSummary !== "function" || !query?.datasetHash) {
      return null;
    }
    try {
      return await cache.loadFallbackSummary(query);
    } catch (error) {
      this._logDev(
        devLog,
        `[FallbackCache] lookup failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async _recordFallbackSummary(cache, payload, devLog) {
    if (!cache || typeof cache.saveFallbackSummary !== "function") {
      return;
    }
    try {
      await cache.saveFallbackSummary(payload);
    } catch (error) {
      this._logDev(
        devLog,
        `[FallbackCache] save failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  _computePromptTimeout(sessionDeadline, promptHints = undefined) {
    const baseTimeout = Number.isFinite(this.phi4?.promptTimeoutMs)
      ? this.phi4.promptTimeoutMs
      : null;
    const minTimeout = sessionDeadline ? MIN_SESSION_TIMEOUT_MS : MIN_LMSTUDIO_REQUEST_TIMEOUT_MS;
    let timeout = baseTimeout ?? null;
    let sessionCap = null;
    if (sessionDeadline) {
      const remaining = sessionDeadline - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new Error("MiniPhi session timeout exceeded before Phi-4 inference.");
      }
      timeout = timeout ? Math.min(timeout, remaining) : remaining;
      sessionCap = Math.min(
        Math.max(MIN_SESSION_TIMEOUT_MS, Math.floor(remaining * SESSION_PROMPT_BUDGET_RATIO)),
        SESSION_PROMPT_CAP_MS,
        remaining,
      );
    }
    const lineCount =
      Number.isFinite(promptHints?.lineCount) && promptHints.lineCount >= 0
        ? promptHints.lineCount
        : null;
    const tokenEstimate =
      Number.isFinite(promptHints?.tokens) && promptHints.tokens >= 0
        ? promptHints.tokens
        : null;
    const tinyLog =
      (lineCount !== null && lineCount <= 20) || (tokenEstimate !== null && tokenEstimate <= 800);
    if (tinyLog) {
      const tinyCapMs = Math.max(120000, minTimeout);
      timeout = timeout ? Math.min(timeout, tinyCapMs) : tinyCapMs;
    }
    if (sessionCap) {
      timeout = timeout ? Math.min(timeout, sessionCap) : sessionCap;
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      timeout = Math.max(timeout, minTimeout);
    }
    return timeout;
  }

  _emitVerbosePromptPreview(prompt, tokens, context = undefined) {
    if (!prompt) {
      return;
    }
    const schemaLabel = context?.schemaId ?? this.schemaId ?? "log-analysis";
    const origin = context?.origin ?? "Phi request";
    const lines =
      typeof context?.lines === "number" && Number.isFinite(context.lines) ? context.lines : null;
    const limit = context?.limit ?? 1200;
    const lineClause = lines !== null ? `, ${lines} lines summarized` : "";
    console.log(
      `[MiniPhi] ${origin}: dispatching ${tokens ?? "unknown"} tokens to Phi-4 (schema=${schemaLabel}${lineClause}).`,
    );
    const truncated = typeof prompt === "string" && prompt.length > limit;
    const preview = this._truncateForLog(prompt, limit);
    console.log(`[MiniPhi] --- Prompt preview (first ${limit} chars) ---\n${preview}`);
    console.log(`[MiniPhi] --- End prompt preview${truncated ? " (truncated)" : ""} ---`);
  }

  _emitVerboseResponsePreview(response, context = undefined) {
    const origin = context?.origin ?? "Phi response";
    if (!response) {
      console.log(`[MiniPhi] ${origin}: no response body captured.`);
      return;
    }
    const limit = context?.limit ?? 1200;
    const truncated = typeof response === "string" && response.length > limit;
    const preview = this._truncateForLog(response, limit);
    console.log(
      `[MiniPhi] ${origin}: captured ${response.length ?? preview.length} characters from Phi-4.`,
    );
    console.log(`[MiniPhi] --- Response preview (first ${limit} chars) ---\n${preview}`);
    console.log(`[MiniPhi] --- End response preview${truncated ? " (truncated)" : ""} ---`);
  }

  _resetPromptExchange() {
    if (this.phi4 && typeof this.phi4.consumeLastPromptExchange === "function") {
      this.phi4.consumeLastPromptExchange();
    }
  }

  _consumePromptExchange() {
    if (this.phi4 && typeof this.phi4.consumeLastPromptExchange === "function") {
      return this.phi4.consumeLastPromptExchange();
    }
    if (this.phi4 && typeof this.phi4.getLastPromptExchange === "function") {
      return this.phi4.getLastPromptExchange();
    }
    return null;
  }

  _startDevLog(label, metadata = undefined) {
    if (!this.devLogDir) {
      return null;
    }
    try {
      fs.mkdirSync(this.devLogDir, { recursive: true });
    } catch {
      return null;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = this._safeLabel(label) || "log";
    const filePath = path.join(this.devLogDir, `${stamp}-${safeLabel}.log`);
    const header = [
      `# MiniPhi Developer Log - ${label}`,
      `created_at: ${new Date().toISOString()}`,
      metadata ? `metadata: ${JSON.stringify(metadata)}` : null,
      "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      fs.writeFileSync(filePath, `${header}\n`, "utf8");
    } catch {
      return null;
    }
    return { filePath };
  }

  async _writeRawResponseArtifact(text, devLogHandle, label) {
    const targetDir = devLogHandle?.filePath
      ? path.dirname(devLogHandle.filePath)
      : this.devLogDir;
    if (!targetDir) {
      return null;
    }
    const safeName = this._safeLabel(label) || "analysis";
    const fileName = `${safeName}-${Date.now()}.txt`;
    const fullPath = path.join(targetDir, fileName);
    try {
      await fs.promises.mkdir(targetDir, { recursive: true });
      await fs.promises.writeFile(fullPath, text, "utf8");
      return fullPath;
    } catch {
      return null;
    }
  }

  _logDev(handle, message) {
    if (!handle?.filePath || !message) {
      return;
    }
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      fs.appendFileSync(handle.filePath, line, "utf8");
    } catch {
      // ignore logging failures
    }
  }

  _safeLabel(value) {
    if (!value) {
      return "";
    }
    return value
      .toString()
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 80);
  }

  _truncateForLog(value, limit = 2000) {
    if (!value) {
      return "";
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}...`;
  }

  _startHeartbeat(message, devLogHandle, intervalMs = 15000) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return () => {};
    }
    let firedOnce = false;
    const emit = () => {
      const line = `[MiniPhi] ${message}`;
      console.log(line);
      if (!firedOnce) {
        this._logDev(devLogHandle, message);
        firedOnce = true;
      }
    };
    const timer = setInterval(emit, intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return () => {
      clearInterval(timer);
    };
  }
}
