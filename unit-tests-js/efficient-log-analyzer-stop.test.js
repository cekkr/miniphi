import test from "node:test";
import assert from "node:assert/strict";
import EfficientLogAnalyzer from "../src/libs/efficient-log-analyzer.js";

class FakeCli {
  constructor(outputs = ["ok"]) {
    this.outputs = outputs;
    this.calls = 0;
  }

  async executeCommand(_command, options = undefined) {
    this.calls += 1;
    for (const chunk of this.outputs) {
      if (options?.onStdout) {
        options.onStdout(`${chunk}\n`);
      }
    }
    return { code: 0 };
  }
}

class FakePhi {
  constructor() {
    this.promptTimeoutMs = null;
    this.chatCalls = 0;
  }

  setPromptTimeout(ms) {
    this.promptTimeoutMs = ms;
  }

  setNoTokenTimeout(ms) {
    this.noTokenTimeoutMs = ms;
  }

  async getContextWindow() {
    return 4096;
  }

  async chatStream() {
    this.chatCalls += 1;
    throw new Error("chatStream should not be called for session timeout");
  }
}

class FakeSummarizer {
  async summarizeLines(lines) {
    return { raw: lines.join("\n") };
  }

  async summarizeFile() {
    return { chunks: [], linesIncluded: 0 };
  }
}

test("analyzeCommandOutput reports session-timeout stop reason without Phi call", async () => {
  const phi = new FakePhi();
  const cli = new FakeCli(["first output"]);
  const summarizer = new FakeSummarizer();
  const analyzer = new EfficientLogAnalyzer(phi, cli, summarizer);

  const result = await analyzer.analyzeCommandOutput("echo first", "session timeout test", {
    streamOutput: false,
    sessionDeadline: Date.now() - 1000,
    timeout: 1000,
  });

  assert.equal(result.analysisDiagnostics.stopReason, "session-timeout");
  assert.equal(result.analysisDiagnostics.stopReasonCode, "session-timeout");
  assert.equal(result.analysisDiagnostics.fallbackReason, "session-timeout");
  assert.ok(result.analysis && typeof result.analysis === "string");
  assert.equal(phi.chatCalls, 0);
  assert.ok(cli.calls >= 1);
});

test("analyzeDatasetLines reports invalid-response stop reason on non-JSON output", async () => {
  class FakeInvalidPhi {
    constructor() {
      this.chatCalls = 0;
    }

    setPromptTimeout() {}

    setNoTokenTimeout() {}

    async getContextWindow() {
      return 4096;
    }

    async chatStream(_prompt, onToken) {
      this.chatCalls += 1;
      if (onToken) {
        onToken("not-json");
      }
    }
  }

  const phi = new FakeInvalidPhi();
  const cli = new FakeCli(["ok"]);
  const summarizer = new FakeSummarizer();
  const analyzer = new EfficientLogAnalyzer(phi, cli, summarizer);

  const result = await analyzer.analyzeDatasetLines(["line one", "line two"], "invalid json", {
    streamOutput: false,
  });

  assert.equal(result.analysisDiagnostics.stopReason, "invalid-response");
  assert.equal(result.analysisDiagnostics.stopReasonCode, "invalid-response");
  assert.ok(result.analysisDiagnostics.stopReasonDetail);
  assert.ok(result.analysis && typeof result.analysis === "string");
  assert.ok(phi.chatCalls >= 2);
});
