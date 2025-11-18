import StreamAnalyzer from "./stream-analyzer.js";

const LOG_ANALYSIS_FALLBACK_SCHEMA = [
  "{",
  '  "task": "repeat the task in <= 10 words",',
  '  "root_cause": "concise summary or null",',
  '  "evidence": [',
  '    { "chunk": "Chunk 2", "line_hint": 120, "excerpt": "quoted or paraphrased line" }',
  "  ],",
  '  "recommended_fixes": [',
  '    { "description": "actionable fix", "files": ["path/to/file.js"], "commands": ["npm test"], "owner": "team" }',
  "  ],",
  '  "next_steps": ["follow-up diagnostic or verification step"]',
  "}",
].join("\n");

/**
 * Coordinates CLI execution, compression, and Phi-4 reasoning for arbitrarily large outputs.
 */
export default class EfficientLogAnalyzer {
  constructor(phi4Handler, cliExecutor, pythonSummarizer, options = undefined) {
    if (!phi4Handler || !cliExecutor || !pythonSummarizer) {
      throw new Error("EfficientLogAnalyzer requires Phi4Handler, CliExecutor, and PythonLogSummarizer instances.");
    }
    this.phi4 = phi4Handler;
    this.cli = cliExecutor;
    this.summarizer = pythonSummarizer;
    this.streamAnalyzer = options?.streamAnalyzer ?? new StreamAnalyzer(250);
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.schemaId = options?.schemaId ?? "log-analysis";
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
    } = options ?? {};

    if (verbose) {
      console.log(`[MiniPhi] Executing command: ${command}`);
    }

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

    const compression = await this.#compressLines(lines, summaryLevels, verbose);
    const prompt = this.generateSmartPrompt(
      task,
      compression.content,
      lines.length,
      {
        originalSize: totalSize,
        compressedTokens: compression.tokens,
      },
      {
        workspaceSummary: workspaceContext?.summary ?? null,
        workspaceType: workspaceContext?.classification?.label ?? workspaceContext?.classification?.domain ?? null,
        workspaceHint: workspaceContext?.hintBlock ?? null,
        manifestPreview: workspaceContext?.manifestPreview ?? null,
        readmeSnippet: workspaceContext?.readmeSnippet ?? null,
        taskPlanSummary: workspaceContext?.taskPlanSummary ?? null,
        taskPlanOutline: workspaceContext?.taskPlanOutline ?? null,
        capabilitySummary: workspaceContext?.capabilitySummary ?? null,
        connectionSummary:
          workspaceContext?.connectionSummary ?? workspaceContext?.connections?.summary ?? null,
        connectionGraphic: workspaceContext?.connectionGraphic ?? null,
      },
    );

    if (verbose) {
      console.log(`\n[MiniPhi] Dispatching analysis to Phi-4 (~${compression.tokens} tokens)\n`);
    }

    let analysis = "";
    this.#applyPromptTimeout(sessionDeadline);
    const traceOptions = {
      ...(promptContext ?? {}),
      schemaId: promptContext?.schemaId ?? this.schemaId,
    };
    await this.phi4.chatStream(
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
        throw new Error(`Phi-4 inference error: ${err}`);
      },
      traceOptions,
    );

    if (streamOutput) {
      process.stdout.write("\n");
    }

    return {
      command,
      task,
      prompt,
      linesAnalyzed: lines.length,
      compressedTokens: compression.tokens,
      compressedContent: compression.content,
      analysis,
      workspaceContext: workspaceContext ?? null,
    };
  }

  async analyzeLogFile(filePath, task, options = undefined) {
    const {
      summaryLevels = 3,
      streamOutput = true,
      sessionDeadline = undefined,
      promptContext = undefined,
      workspaceContext = undefined,
    } = options ?? {};
    const { chunks } = await this.summarizer.summarizeFile(filePath, {
      maxLinesPerChunk: options?.maxLinesPerChunk ?? 2000,
      recursionLevels: summaryLevels,
    });

    if (chunks.length === 0) {
      throw new Error(`No content found in ${filePath}`);
    }

    const totalLines = chunks.reduce((acc, chunk) => acc + (chunk?.input_lines ?? 0), 0);
    const formatted = chunks
      .map((chunk, idx) => this.formatSummary(chunk, `Chunk ${idx + 1}`))
      .join("\n");

    const tokens = Math.max(1, Math.ceil(formatted.length / 4));
    const prompt = this.generateSmartPrompt(
      task,
      formatted,
      totalLines || 1,
      {
        compressedTokens: tokens,
        originalSize: totalLines * 4,
      },
      {
        workspaceSummary: workspaceContext?.summary ?? null,
        workspaceType: workspaceContext?.classification?.label ?? workspaceContext?.classification?.domain ?? null,
        workspaceHint: workspaceContext?.hintBlock ?? null,
        manifestPreview: workspaceContext?.manifestPreview ?? null,
        readmeSnippet: workspaceContext?.readmeSnippet ?? null,
        taskPlanSummary: workspaceContext?.taskPlanSummary ?? null,
        taskPlanOutline: workspaceContext?.taskPlanOutline ?? null,
        capabilitySummary: workspaceContext?.capabilitySummary ?? null,
        connectionSummary:
          workspaceContext?.connectionSummary ?? workspaceContext?.connections?.summary ?? null,
        connectionGraphic: workspaceContext?.connectionGraphic ?? null,
      },
    );

    let analysis = "";
    this.#applyPromptTimeout(sessionDeadline);
    const traceOptions = {
      ...(promptContext ?? {}),
      schemaId: promptContext?.schemaId ?? this.schemaId,
    };
    await this.phi4.chatStream(
      prompt,
      (token) => {
        analysis += token;
        if (streamOutput) {
          process.stdout.write(token);
        }
      },
      undefined,
      (err) => {
        throw new Error(`Phi-4 inference error: ${err}`);
      },
      traceOptions,
    );

    if (streamOutput) {
      process.stdout.write("\n");
    }

    return {
      filePath,
      task,
      prompt,
      linesAnalyzed: totalLines,
      compressedTokens: tokens,
      compressedContent: formatted,
      analysis,
      workspaceContext: workspaceContext ?? null,
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

  formatSummary(summary, label = undefined) {
    if (!summary || !Array.isArray(summary.summary)) {
      return "";
    }

    let formatted = label ? `# ${label}\n\n` : "";
    for (const level of summary.summary) {
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

  generateSmartPrompt(task, compressedContent, totalLines, metadata, extraContext = undefined) {
    const contextSupplement = this.#formatContextSupplement(extraContext);
    const contextBlock = contextSupplement ? `\n\n${contextSupplement}` : "";
    const schemaInstructions = this.#buildSchemaInstructions();
    return `# Log/Output Analysis Task

You must respond strictly with valid JSON that matches this schema (omit comments, never add prose outside the JSON):
${schemaInstructions}

**Task:** ${task}${contextBlock}

**Dataset Overview:**
- Total lines: ${totalLines}
- Compressed to: ${metadata.compressedTokens} tokens
- Compression: ${this.#formatCompression(totalLines, metadata.compressedTokens)}
- Approx. original bytes: ${metadata.originalSize ?? "unknown"}

**Reporting Rules**
1. Every evidence entry must mention the chunk/section name (e.g., "Chunk 2" or "Level 1") and include an approximate \`line_hint\`. Use \`null\` only if no line reference exists.
2. Recommended fixes should contain concrete actions with files, commands, or owners when possible. Use empty arrays instead of omitting fields.
3. If information is unavailable, set the field to \`null\` instead of fabricating a value.

**Data:**
\`\`\`
${compressedContent}
\`\`\``;
  }

  #buildSchemaInstructions() {
    if (this.schemaRegistry && this.schemaId) {
      const block = this.schemaRegistry.buildInstructionBlock(this.schemaId);
      if (block) {
        return block;
      }
    }
    return ["```json", LOG_ANALYSIS_FALLBACK_SCHEMA, "```"].join("\n");
  }

  async #compressLines(lines, summaryLevels, verbose) {
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

  #formatCompression(totalLines, compressedTokens) {
    if (!totalLines || !compressedTokens) {
      return "N/A";
    }
    const approxCompressedLines = compressedTokens / 4;
    const ratio = totalLines / Math.max(1, approxCompressedLines);
    return `${ratio.toFixed(1)}x`;
  }

  #formatContextSupplement(extraContext) {
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
    if (extraContext.workspaceHint) {
      lines.push(extraContext.workspaceHint);
    } else if (Array.isArray(extraContext.manifestPreview) && extraContext.manifestPreview.length) {
      const manifest = extraContext.manifestPreview
        .slice(0, 6)
        .map((entry) => `- ${entry.path} (${entry.bytes} bytes)`)
        .join("\n");
      lines.push(`File manifest sample:\n${manifest}`);
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
    if (extraContext.connectionSummary) {
      lines.push(`File connection hints:\n${extraContext.connectionSummary}`);
    }
    if (extraContext.connectionGraphic) {
      lines.push(extraContext.connectionGraphic);
    }
    if (extraContext.capabilitySummary) {
      lines.push(`Available tools:\n${extraContext.capabilitySummary}`);
    }
    if (!lines.length) {
      return "";
    }
    return lines.join("\n");
  }
  #applyPromptTimeout(sessionDeadline) {
    if (!sessionDeadline) {
      this.phi4.setPromptTimeout(null);
      return;
    }
    const remaining = sessionDeadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error("MiniPhi session timeout exceeded before Phi-4 inference.");
    }
    this.phi4.setPromptTimeout(remaining);
  }
}
