import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import EfficientLogAnalyzer from "../src/libs/efficient-log-analyzer.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";

class FakeCli {
  async executeCommand() {
    return { code: 0 };
  }
}

class FakePhi {
  constructor(responseText) {
    this.responseText = responseText;
    this.prompts = [];
    this.traceOptions = [];
    this.promptTimeoutMs = null;
  }

  setPromptTimeout(ms) {
    this.promptTimeoutMs = ms;
  }

  setNoTokenTimeout(ms) {
    this.noTokenTimeoutMs = ms;
  }

  async getContextWindow() {
    return 8192;
  }

  async chatStream(prompt, onToken, _onThought, _onError, traceOptions) {
    this.prompts.push(prompt);
    this.traceOptions.push(traceOptions ?? null);
    if (onToken) {
      onToken(this.responseText);
    }
  }
}

class FakeSummarizer {
  constructor() {
    this.calls = [];
  }

  async summarizeFile(filePath, options = undefined) {
    this.calls.push({ filePath, options: options ?? {} });
    const maxLines = Number.isFinite(options?.maxLinesPerChunk)
      ? Math.floor(options.maxLinesPerChunk)
      : 10;
    return {
      chunks: [
        {
          input_lines: maxLines,
          raw: "Romeo summary chunk one.",
        },
        {
          input_lines: maxLines,
          raw: "Romeo summary chunk two.",
        },
      ],
      linesIncluded: maxLines * 2,
      lineRange: options?.lineRange ?? null,
    };
  }

  async summarizeLines(lines) {
    return { raw: Array.isArray(lines) ? lines.join("\n") : "", input_lines: lines?.length ?? 0 };
  }
}

function buildResponseJson(fileLabel) {
  return JSON.stringify({
    task: "Summarize romeo log",
    root_cause: null,
    summary: "Stubbed JSON summary for the Romeo sample.",
    summary_updates: ["Chunk summaries captured."],
    evidence: [
      {
        chunk: "Chunk 1",
        line_hint: 1,
        excerpt: "Sample excerpt for verification.",
      },
    ],
    recommended_fixes: [
      {
        description: "Review the Romeo excerpt for narrative continuity.",
        files: [fileLabel],
        commands: [],
        owner: null,
      },
    ],
    next_steps: ["No further action required."],
    needs_more_context: false,
    missing_snippets: [],
    truncation_strategy: null,
  });
}

async function stageRomeoLogFile(workspaceRoot) {
  const sampleSource = path.resolve("samples", "txt", "romeoAndJuliet-part1.txt");
  const destination = path.join(workspaceRoot, "romeo-sample.log");
  await fs.copyFile(sampleSource, destination);
  return destination;
}

test("EfficientLogAnalyzer file flow uses chunked summaries with stubbed Phi", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-romeo-"));
  try {
    const logPath = await stageRomeoLogFile(workspace);
    const fileLabel = path.basename(logPath);
    const phi = new FakePhi(buildResponseJson(fileLabel));
    const summarizer = new FakeSummarizer();
    const schemaRegistry = new PromptSchemaRegistry();
    const analyzer = new EfficientLogAnalyzer(phi, new FakeCli(), summarizer, {
      schemaRegistry,
      schemaId: "log-analysis",
    });

    const result = await analyzer.analyzeLogFile(logPath, "Analyze the Romeo sample.", {
      summaryLevels: 2,
      maxLinesPerChunk: 12,
      streamOutput: false,
      promptContext: {
        schemaId: "log-analysis",
      },
    });

    assert.equal(summarizer.calls.length, 1);
    assert.equal(summarizer.calls[0].options.maxLinesPerChunk, 12);
    assert.equal(summarizer.calls[0].options.recursionLevels, 2);

    assert.equal(phi.prompts.length, 1);
    assert.ok(phi.prompts[0].includes("Chunk 1"));
    assert.ok(phi.prompts[0].includes("Chunk 2"));
    assert.equal(phi.traceOptions.length, 1);
    assert.equal(phi.traceOptions[0]?.responseFormat?.type, "json_schema");

    const analysis = JSON.parse(result.analysis);
    assert.equal(analysis.task, "Summarize romeo log");
    assert.equal(analysis.needs_more_context, false);
    assert.deepEqual(analysis.missing_snippets, []);
    assert.ok(Array.isArray(analysis.recommended_fixes));
    assert.equal(analysis.recommended_fixes.length, 1);
    assert.deepEqual(analysis.recommended_fixes[0].files, [fileLabel]);
    assert.equal(result.schemaValid, true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
