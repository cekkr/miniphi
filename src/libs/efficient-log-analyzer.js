import StreamAnalyzer from "./stream-analyzer.js";

/**
 * Coordinates CLI execution, compression, and Phi-4 reasoning for arbitrarily large outputs.
 */
export default class EfficientLogAnalyzer {
  constructor(phi4Handler, cliExecutor, pythonSummarizer, streamAnalyzer = undefined) {
    if (!phi4Handler || !cliExecutor || !pythonSummarizer) {
      throw new Error("EfficientLogAnalyzer requires Phi4Handler, CliExecutor, and PythonLogSummarizer instances.");
    }
    this.phi4 = phi4Handler;
    this.cli = cliExecutor;
    this.summarizer = pythonSummarizer;
    this.streamAnalyzer = streamAnalyzer ?? new StreamAnalyzer(250);
  }

  async analyzeCommandOutput(command, task, options = undefined) {
    const {
      summaryLevels = 3,
      verbose = false,
      streamOutput = true,
      cwd = process.cwd(),
      timeout = 60000,
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
    const prompt = this.generateSmartPrompt(task, compression.content, lines.length, {
      originalSize: totalSize,
      compressedTokens: compression.tokens,
    });

    if (verbose) {
      console.log(`\n[MiniPhi] Dispatching analysis to Phi-4 (~${compression.tokens} tokens)\n`);
    }

    let analysis = "";
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
      analysis,
    };
  }

  async analyzeLogFile(filePath, task, options = undefined) {
    const { summaryLevels = 3, streamOutput = true } = options ?? {};
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
    const prompt = this.generateSmartPrompt(task, formatted, totalLines || 1, {
      compressedTokens: tokens,
      originalSize: totalLines * 4,
    });

    let analysis = "";
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
      analysis,
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

  generateSmartPrompt(task, compressedContent, totalLines, metadata) {
    return `# Log/Output Analysis Task

**Task:** ${task}

**Dataset:**
- Total lines: ${totalLines}
- Compressed to: ${metadata.compressedTokens} tokens
- Compression: ${this.#formatCompression(totalLines, metadata.compressedTokens)}

**Data:**
\`\`\`
${compressedContent}
\`\`\`

**Analysis Objectives**
1. Identify the primary root cause or key insight.
2. Provide actionable recommendations.
3. Outline next diagnostic or remediation steps if needed.`;
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
}
