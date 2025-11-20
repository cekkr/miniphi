import fs from "fs";
import path from "path";
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
    } = options ?? {};

    const devLog = this.#startDevLog(`command-${this.#safeLabel(command)}`, {
      type: "command",
      command,
      task,
      cwd,
    });
    if (verbose) {
      console.log(`[MiniPhi] Executing command: ${command}`);
    }
    this.#logDev(devLog, `Executing command "${command}" (cwd: ${cwd})`);

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
      this.#logDev(devLog, `Command failed: ${message}`);
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
    this.#logDev(devLog, `Captured ${lines.length} lines (${totalSize} bytes).`);

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
        navigationSummary: workspaceContext?.navigationSummary ?? null,
        navigationBlock: workspaceContext?.navigationBlock ?? null,
        helperScript: workspaceContext?.helperScript ?? null,
        fixedReferences: workspaceContext?.fixedReferences ?? null,
      },
    );

    if (verbose) {
      console.log(`\n[MiniPhi] Dispatching analysis to Phi-4 (~${compression.tokens} tokens)\n`);
    }
    if (!streamOutput) {
      console.log("[MiniPhi] Awaiting Phi response (stream output disabled)...");
    }
    this.#logDev(
      devLog,
      `Prompt (${compression.tokens} tokens):\n${this.#truncateForLog(prompt)}`,
    );

    let analysis = "";
    this.#applyPromptTimeout(sessionDeadline);
    const traceOptions = {
      ...(promptContext ?? {}),
      schemaId: promptContext?.schemaId ?? this.schemaId,
    };
    const stopHeartbeat = !streamOutput
      ? this.#startHeartbeat("Still waiting for Phi response...", devLog)
      : () => {};
    try {
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
          this.#logDev(devLog, `Phi error: ${err}`);
          throw new Error(`Phi-4 inference error: ${err}`);
        },
        traceOptions,
      );
    } finally {
      stopHeartbeat();
    }

    if (streamOutput) {
      process.stdout.write("\n");
    }

    const invocationFinishedAt = Date.now();
    this.#logDev(
      devLog,
      `Phi response captured (${invocationFinishedAt - invocationStartedAt} ms):\n${this.#truncateForLog(analysis)}`,
    );
    return {
      command,
      task,
      prompt,
      linesAnalyzed: lines.length,
      compressedTokens: compression.tokens,
      compressedContent: compression.content,
      analysis,
      workspaceContext: workspaceContext ?? null,
      schemaId: traceOptions?.schemaId ?? this.schemaId ?? null,
      startedAt: invocationStartedAt,
      finishedAt: invocationFinishedAt,
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
    const maxLines = options?.maxLinesPerChunk ?? 2000;
    const devLog = this.#startDevLog(`file-${this.#safeLabel(path.basename(filePath))}`, {
      type: "log-file",
      filePath,
      task,
      summaryLevels,
      maxLinesPerChunk: maxLines,
    });
    this.#logDev(devLog, `Summarizing ${filePath} (maxLinesPerChunk=${maxLines})`);
    console.log(
      `[MiniPhi] Summarizing ${path.relative(process.cwd(), filePath) || filePath} ...`,
    );
    const summarizeStarted = Date.now();
    const { chunks } = await this.summarizer.summarizeFile(filePath, {
      maxLinesPerChunk: options?.maxLinesPerChunk ?? 2000,
      recursionLevels: summaryLevels,
    });
    const summarizeFinished = Date.now();
    this.#logDev(
      devLog,
      `Summarizer produced ${chunks.length} chunks in ${summarizeFinished - summarizeStarted} ms.`,
    );
    console.log(
      `[MiniPhi] Summarizer produced ${chunks.length} chunks in ${
        summarizeFinished - summarizeStarted
      } ms`,
    );

    if (chunks.length === 0) {
      throw new Error(`No content found in ${filePath}`);
    }

    const totalLines = chunks.reduce((acc, chunk) => acc + (chunk?.input_lines ?? 0), 0);
    const chunkSummaries = chunks.map((chunk, idx) => {
      const label = `Chunk ${idx + 1}`;
      this.#logDev(
        devLog,
        `${label}: ${chunk?.input_lines ?? 0} lines summarized → ${this.#truncateForLog(
          JSON.stringify(chunk?.summary ?? []),
        )}`,
      );
      return { chunk, label };
    });
    const promptBudget = await this.#resolvePromptBudget();
    const adjustment = this.#buildBudgetedPrompt({
      chunkSummaries,
      summaryLevels,
      task,
      totalLines,
      workspaceContext,
      promptBudget,
      devLog,
    });
    const { prompt, body, linesUsed, tokensUsed } = adjustment;

    const invocationStartedAt = Date.now();

    let analysis = "";
    this.#applyPromptTimeout(sessionDeadline);
    const traceOptions = {
      ...(promptContext ?? {}),
      schemaId: promptContext?.schemaId ?? this.schemaId,
    };
    const stopHeartbeat = !streamOutput
      ? this.#startHeartbeat("Still waiting for Phi response...", devLog)
      : () => {};
    try {
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
          this.#logDev(devLog, `Phi error: ${err}`);
          throw new Error(`Phi-4 inference error: ${err}`);
        },
        traceOptions,
      );
    } finally {
      stopHeartbeat();
    }

    if (streamOutput) {
      process.stdout.write("\n");
    } else {
      console.log("[MiniPhi] Phi response received.");
    }
    const invocationFinishedAt = Date.now();
    this.#logDev(
      devLog,
      `Phi response (${invocationFinishedAt - invocationStartedAt} ms):\n${this.#truncateForLog(
        analysis,
      )}`,
    );
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
      startedAt: invocationStartedAt,
      finishedAt: invocationFinishedAt,
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

  formatSummary(summary, label = undefined, maxLevel = Infinity) {
    if (!summary || !Array.isArray(summary.summary)) {
      return "";
    }

    let formatted = label ? `# ${label}\n\n` : "";
    for (const level of summary.summary) {
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

  async #resolvePromptBudget() {
    if (!this.phi4 || typeof this.phi4.getContextWindow !== "function") {
      return 4096;
    }
    try {
      const window = await this.phi4.getContextWindow();
      const normalized = Number(window);
      if (Number.isFinite(normalized) && normalized > 0) {
        return Math.max(1024, normalized - 1024);
      }
    } catch {
      // ignore errors and fall through
    }
    return 4096;
  }

  #estimateTokens(text) {
    if (!text) {
      return 0;
    }
    return Math.max(1, Math.ceil(text.length / 4));
  }

  #buildBudgetedPrompt({
    chunkSummaries,
    summaryLevels,
    task,
    totalLines,
    workspaceContext,
    promptBudget,
    devLog,
  }) {
    let detailLevel = summaryLevels;
    let chunkLimit = chunkSummaries.length;
    if (chunkLimit === 0) {
      return {
        prompt: this.generateSmartPrompt(task, "(no content)", 0, { compressedTokens: 1 }, {}),
        body: "(no content)",
        linesUsed: 0,
        tokensUsed: 1,
      };
    }
    let attempts = 0;
    let composed;
    let prompt;
    let tokens;
    while (attempts < 20) {
      composed = this.#composeChunkSummaries(chunkSummaries, chunkLimit, detailLevel);
      const extraContext = {
        workspaceSummary: workspaceContext?.summary ?? null,
        workspaceType:
          workspaceContext?.classification?.label ?? workspaceContext?.classification?.domain ?? null,
        workspaceHint: workspaceContext?.hintBlock ?? null,
        manifestPreview: workspaceContext?.manifestPreview ?? null,
        readmeSnippet: workspaceContext?.readmeSnippet ?? null,
        taskPlanSummary: workspaceContext?.taskPlanSummary ?? null,
        taskPlanOutline: workspaceContext?.taskPlanOutline ?? null,
        capabilitySummary: workspaceContext?.capabilitySummary ?? null,
        connectionSummary:
          workspaceContext?.connectionSummary ?? workspaceContext?.connections?.summary ?? null,
        connectionGraphic: workspaceContext?.connectionGraphic ?? null,
        fixedReferences: workspaceContext?.fixedReferences ?? null,
        helperScript: workspaceContext?.helperScript ?? null,
        navigationSummary: workspaceContext?.navigationSummary ?? null,
        navigationBlock: workspaceContext?.navigationBlock ?? null,
      };
      prompt = this.generateSmartPrompt(
        task,
        composed.text,
        composed.lines || totalLines || 1,
        {
          compressedTokens: this.#estimateTokens(composed.text),
          originalSize: totalLines * 4,
        },
        extraContext,
      );
      tokens = this.#estimateTokens(prompt);
      if (tokens <= promptBudget) {
        break;
      }
      attempts += 1;
      if (detailLevel > 0) {
        detailLevel -= 1;
        const note = `Prompt exceeded budget (${tokens} > ${promptBudget}); reducing summary detail to level ${detailLevel}.`;
        console.log(`[MiniPhi] ${note}`);
        this.#logDev(devLog, note);
        continue;
      }
      if (chunkLimit > 1) {
        chunkLimit -= 1;
        const msg = `Prompt still too large; dropping chunk ${chunkLimit + 1} and retrying.`;
        console.log(`[MiniPhi] ${msg}`);
        this.#logDev(devLog, msg);
        continue;
      }
      break;
    }
    if (tokens > promptBudget) {
      const truncated = this.#truncateToBudget(prompt, promptBudget);
      prompt = truncated.prompt;
      tokens = truncated.tokens;
      this.#logDev(
        devLog,
        `Prompt truncated to fit context window (${tokens}/${promptBudget} tokens).`,
      );
    }
    return {
      prompt,
      body: composed?.text ?? "",
      linesUsed: composed?.lines ?? totalLines,
      tokensUsed: tokens,
    };
  }

  #composeChunkSummaries(chunkSummaries, limit, maxLevel) {
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

  #truncateToBudget(prompt, budgetTokens) {
    if (!prompt) {
      return { prompt: "", tokens: 0 };
    }
    const estimate = this.#estimateTokens(prompt);
    if (estimate <= budgetTokens) {
      return { prompt, tokens: estimate };
    }
    const ratio = budgetTokens / estimate;
    const maxChars = Math.max(512, Math.floor(prompt.length * ratio) - 100);
    const truncated = `${prompt.slice(0, maxChars)}\n[Prompt truncated due to context limit]`;
    return { prompt: truncated, tokens: this.#estimateTokens(truncated) };
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
          return `- ${ref.relative ?? ref.path}: ${status}`;
        })
        .join("\n");
      lines.push(`Fixed references pinned for this task:\n${refs}`);
    }
    if (extraContext.helperScript) {
      const helper = extraContext.helperScript;
      const helperParts = [];
      if (helper.description) {
        helperParts.push(helper.description);
      }
      if (helper.run?.summary) {
        helperParts.push(helper.run.summary);
      }
      if (helper.path) {
        helperParts.push(`saved at ${helper.path}`);
      }
      if (helperParts.length) {
        lines.push(`Helper script (${helper.language ?? "node"}): ${helperParts.join(" | ")}`);
      }
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

  #startDevLog(label, metadata = undefined) {
    if (!this.devLogDir) {
      return null;
    }
    try {
      fs.mkdirSync(this.devLogDir, { recursive: true });
    } catch {
      return null;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = this.#safeLabel(label) || "log";
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

  #logDev(handle, message) {
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

  #safeLabel(value) {
    if (!value) {
      return "";
    }
    return value
      .toString()
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 80);
  }

  #truncateForLog(value, limit = 2000) {
    if (!value) {
      return "";
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}...`;
  }

  #startHeartbeat(message, devLogHandle, intervalMs = 15000) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return () => {};
    }
    let firedOnce = false;
    const emit = () => {
      const line = `[MiniPhi] ${message}`;
      console.log(line);
      if (!firedOnce) {
        this.#logDev(devLogHandle, message);
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
