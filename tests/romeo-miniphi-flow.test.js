import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import EfficientLogAnalyzer from "../src/libs/efficient-log-analyzer.js";

const romeoPath = path.join(process.cwd(), "samples", "txt", "romeoAndJuliet-part1.txt");
const romeoText = await fs.readFile(romeoPath, "utf8");

class StubPhi {
  constructor(responder, options = undefined) {
    this.responder = responder;
    this.calls = [];
    this.contextWindow = options?.contextWindow ?? 8000;
    this.promptTimeoutMs = null;
    this.noTokenTimeoutMs = null;
  }

  async chatStream(prompt, onToken, onThink, onError, traceOptions = undefined) {
    this.calls.push({ prompt, traceOptions });
    try {
      const response = await this.responder({ prompt, traceOptions });
      if (onToken) {
        onToken(response);
      }
      return response;
    } catch (error) {
      if (onError) {
        const message = error instanceof Error ? error.message : String(error);
        onError(message);
      }
      throw error;
    }
  }

  async getContextWindow() {
    return this.contextWindow;
  }

  setPromptTimeout(timeoutMs) {
    this.promptTimeoutMs = timeoutMs;
  }

  setNoTokenTimeout(timeoutMs) {
    this.noTokenTimeoutMs = timeoutMs;
  }

  setHistory() {}

  getHistory() {
    return [];
  }

  setRestClient() {}

  setPromptRecorder() {}

  setPerformanceTracker() {}

  setSchemaRegistry() {}
}

class CharacterChunkSummarizer {
  constructor(maxChars) {
    this.maxChars = maxChars;
  }

  async summarizeFile(filePath, options = undefined) {
    const text = normalizeNewlines(await fs.readFile(filePath, "utf8"));
    const limit = Number(options?.maxLinesPerChunk) || this.maxChars || 2000;
    const chunks = [];
    for (let offset = 0; offset < text.length; offset += limit) {
      const slice = text.slice(offset, offset + limit);
      const lines = slice.split("\n");
      chunks.push({
        input_lines: lines.length,
        summary: [
          {
            level: 0,
            total_lines: lines.length,
            categories: {
              Content: {
                count: lines.length,
                sample_lines: lines.filter(Boolean).slice(0, 3),
              },
            },
          },
        ],
      });
    }
    return {
      chunks,
      totalChunks: chunks.length,
      linesIncluded: text.split("\n").length,
      lineRange: options?.lineRange ?? null,
    };
  }

  async summarizeLines(lines, levels = 1) {
    const count = Array.isArray(lines) ? lines.length : 0;
    return {
      success: true,
      input_lines: count,
      summary: [
        {
          level: 0,
          total_lines: count,
          categories: {
            Content: {
              count,
              sample_lines: (lines ?? []).slice(0, 3),
            },
          },
        },
      ],
    };
  }
}

class NoopCliExecutor {
  async executeCommand() {
    throw new Error("CLI execution should not run in stubbed analyzer tests.");
  }
}

const normalizeNewlines = (text) => text.replace(/\r\n/g, "\n");

const calculateChunkCount = (text, limit) =>
  Math.max(1, Math.ceil(normalizeNewlines(text).length / limit));

function buildReplacementResponder(text, chunkLimit) {
  const normalized = normalizeNewlines(text);
  const uppercaseCount = (normalized.match(/SAMPSON/g) ?? []).length;
  const capitalizedCount = (normalized.match(/Sampson/g) ?? []).length;
  const rewritten = normalized.replace(/SAMPSON/g, "SIMPSON").replace(/Sampson/g, "Simpson");
  const observedChunks = calculateChunkCount(normalized, chunkLimit);
  return () =>
    JSON.stringify({
      operation: "replace-names",
      chunk_limit: chunkLimit,
      needs_more_context: false,
      missing_snippets: [],
      replacement_counts: {
        uppercase: uppercaseCount,
        capitalized: capitalizedCount,
      },
      rewritten_text: rewritten,
      observed_chunks: observedChunks,
    });
}

function buildPrinceResponder(text, chunkLimit) {
  const lines = normalizeNewlines(text).split("\n");
  const princeIndex = lines.findIndex((line) => line.trim().startsWith("PRINCE"));
  const exitIndex = lines.findIndex(
    (line, idx) => idx > princeIndex && line.startsWith("[All but"),
  );
  const speech =
    princeIndex >= 0
      ? lines
          .slice(princeIndex + 1, exitIndex > princeIndex ? exitIndex : undefined)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" ")
      : "";
  const description = [
    "Prince Escalus storms onto the scene to end the street brawl.",
    "He condemns the violence between Capulet and Montague, threatens death for future fights, and orders both lords to hear his judgment at Free-town.",
  ].join(" ");
  return () =>
    JSON.stringify({
      operation: "character-description",
      character: "PRINCE",
      chunk_limit: chunkLimit,
      needs_more_context: false,
      missing_snippets: [],
      description,
      evidence_excerpt: speech.slice(0, 320),
      observed_chunks: calculateChunkCount(text, chunkLimit),
    });
}

function buildProseResponder(text, chunkLimit) {
  const beats = [
    "The Chorus sets up Verona and the star-crossed lovers who will die to end their parents' feud.",
    "Capulet servants Sampson and Gregory banter and bait Montague men until a street fight erupts.",
    "Benvolio tries to separate the fighters, Tybalt inflames it, and citizens, Capulet, and Montague rush in.",
    "Prince Escalus halts the chaos, threatens death for further breaches of the peace, and summons Capulet and Montague to hear his judgment.",
    "After the crowd scatters, Montague confides that Romeo slips away before dawn, heartsick over unreturned love, and Benvolio vows to help him move on.",
  ];
  const prose = beats.join(" ");
  return () =>
    JSON.stringify({
      operation: "prose-rewrite",
      chunk_limit: chunkLimit,
      needs_more_context: false,
      missing_snippets: [],
      prose,
      observed_chunks: calculateChunkCount(text, chunkLimit),
    });
}

function createAnalyzerHarness(chunkLimit, responder) {
  const phi = new StubPhi(responder);
  const summarizer = new CharacterChunkSummarizer(chunkLimit);
  const cli = new NoopCliExecutor();
  const analyzer = new EfficientLogAnalyzer(phi, cli, summarizer, { devLogDir: null });
  return { analyzer, phi };
}

test("128-char chunk rewrite swaps every Sampson/SAMPSON with Simpson/SIMPSON through the analyzer", async () => {
  const chunkLimit = 128;
  const { analyzer, phi } = createAnalyzerHarness(
    chunkLimit,
    buildReplacementResponder(romeoText, chunkLimit),
  );
  const result = await analyzer.analyzeLogFile(romeoPath, "Rewrite Sampson names", {
    summaryLevels: 1,
    streamOutput: false,
    maxLinesPerChunk: chunkLimit,
  });
  assert.equal(phi.calls.length, 1);
  const analysis = JSON.parse(result.analysis);
  assert.equal(analysis.operation, "replace-names");
  assert.equal(analysis.chunk_limit, chunkLimit);
  assert.equal(analysis.observed_chunks, calculateChunkCount(romeoText, chunkLimit));
  const originalUpper = (romeoText.match(/SAMPSON/g) ?? []).length;
  const originalTitle = (romeoText.match(/Sampson/g) ?? []).length;
  assert.equal((analysis.rewritten_text.match(/SIMPSON/g) ?? []).length, originalUpper);
  assert.equal((analysis.rewritten_text.match(/Simpson/g) ?? []).length, originalTitle);
  assert.ok(!analysis.rewritten_text.includes("SAMPSON"));
  assert.ok(!analysis.rewritten_text.includes("Sampson"));
});

test("256-char chunk limit still yields a Prince Escalus profile", async () => {
  const chunkLimit = 256;
  const { analyzer, phi } = createAnalyzerHarness(
    chunkLimit,
    buildPrinceResponder(romeoText, chunkLimit),
  );
  const result = await analyzer.analyzeLogFile(romeoPath, "Describe PRINCE character", {
    summaryLevels: 1,
    streamOutput: false,
    maxLinesPerChunk: chunkLimit,
  });
  assert.equal(phi.calls.length, 1);
  const analysis = JSON.parse(result.analysis);
  assert.equal(analysis.operation, "character-description");
  assert.equal(analysis.character, "PRINCE");
  assert.equal(analysis.chunk_limit, chunkLimit);
  assert.equal(analysis.observed_chunks, calculateChunkCount(romeoText, chunkLimit));
  assert.match(analysis.description, /Prince Escalus/);
  assert.match(analysis.description, /threatens death/i);
  assert.ok(analysis.evidence_excerpt.includes("Rebellious subjects"));
});

test("512-char chunk limit produces a prose retelling of the opening act", async () => {
  const chunkLimit = 512;
  const { analyzer, phi } = createAnalyzerHarness(
    chunkLimit,
    buildProseResponder(romeoText, chunkLimit),
  );
  const result = await analyzer.analyzeLogFile(romeoPath, "Rewrite scene as prose", {
    summaryLevels: 1,
    streamOutput: false,
    maxLinesPerChunk: chunkLimit,
  });
  assert.equal(phi.calls.length, 1);
  const analysis = JSON.parse(result.analysis);
  assert.equal(analysis.operation, "prose-rewrite");
  assert.equal(analysis.chunk_limit, chunkLimit);
  assert.equal(analysis.observed_chunks, calculateChunkCount(romeoText, chunkLimit));
  assert.match(analysis.prose, /Chorus/);
  assert.match(analysis.prose, /Sampson and Gregory/);
  assert.match(analysis.prose, /Prince Escalus/);
  assert.match(analysis.prose, /Romeo/);
});
