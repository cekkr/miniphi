import fs from "fs";
import path from "path";
import RecomposeTester from "./recompose-tester.js";

const DEFAULT_SAMPLE = path.join("samples", "recompose", "hello-flow");
const DEFAULT_BENCHMARK_ROOT = path.join("samples", "benchmark", "recompose");

const pad2 = (value) => value.toString().padStart(2, "0");

export default class RecomposeBenchmarkRunner {
  constructor(options = {}) {
    this.sampleDir = path.resolve(options.sampleDir ?? DEFAULT_SAMPLE);
    this.benchmarkRoot = path.resolve(options.benchmarkRoot ?? DEFAULT_BENCHMARK_ROOT);
    this.tester = options.tester ?? new RecomposeTester(options.testerOptions);
    this.lastOutputDir = null;
  }

  static formatTimestamp(date = new Date()) {
    const day = pad2(date.getDate());
    const month = pad2(date.getMonth() + 1);
    const year = date.getFullYear().toString().slice(-2);
    const minutes = pad2(date.getMinutes());
    const hours = pad2(date.getHours());
    return `${day}-${month}-${year}_${minutes}-${hours}`;
  }

  static formatRunLabel(prefix, index) {
    return `${prefix}-${index.toString().padStart(3, "0")}`;
  }

  async runSeries({
    directions = ["roundtrip"],
    repeat = 1,
    clean = false,
    timestamp = undefined,
    runPrefix = "RUN",
    planRuns = null,
  } = {}) {
    const runQueue = Array.isArray(planRuns) && planRuns.length
      ? planRuns.map((entry, index) => this.#normalizePlanDescriptor(entry, { defaultClean: clean, defaultPrefix: runPrefix, index }))
      : this.#buildDirectionalQueue(directions, repeat, { clean, runPrefix });
    if (runQueue.length === 0) {
      throw new Error("At least one benchmark run is required.");
    }
    const effectiveTimestamp = timestamp ?? RecomposeBenchmarkRunner.formatTimestamp();
    const outputDir = path.join(this.benchmarkRoot, effectiveTimestamp);
    await fs.promises.mkdir(outputDir, { recursive: true });
    this.lastOutputDir = outputDir;

    const results = [];
    let counter = 0;
    for (const descriptor of runQueue) {
      counter += 1;
      const labelFallback = RecomposeBenchmarkRunner.formatRunLabel(descriptor.runPrefix ?? runPrefix, counter);
      const runLabel = this.#sanitizeLabel(descriptor.runLabel) || labelFallback;
      const reportPath = path.join(outputDir, `${runLabel}.json`);
      const logPath = path.join(outputDir, `${runLabel}.log`);
      const report = await this.tester.run({
        sampleDir: this.sampleDir,
        direction: descriptor.direction,
        clean: descriptor.clean,
        sessionLabel: runLabel,
      });
      const promptLogCopyPath = typeof this.tester.exportPromptLog === "function"
        ? await this.tester.exportPromptLog({
          targetDir: outputDir,
          fileName: `${runLabel}.prompts.log`,
          label: runLabel,
        })
        : await this.#copyPromptLog(report.promptLog, outputDir, runLabel);
      if (promptLogCopyPath) {
        report.promptLogExport = this.#relativePath(promptLogCopyPath);
      }
      await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
      const logLines = this.#buildLogLines({
        runLabel,
        direction: descriptor.direction,
        report,
        reportPath,
        logPath,
        promptLogPath: promptLogCopyPath,
      });
      await fs.promises.writeFile(logPath, `${logLines.join("\n")}\n`, "utf8");
      logLines.forEach((line) => console.log(line));
      results.push({
        direction: descriptor.direction,
        runLabel,
        reportPath,
        logPath,
        promptLogPath: promptLogCopyPath,
        report,
      });
    }

    return {
      timestamp: effectiveTimestamp,
      outputDir,
      runs: results,
    };
  }

  #buildLogLines({ runLabel, direction, report, reportPath, logPath, promptLogPath }) {
    const lines = [`[MiniPhi][Benchmark] ${runLabel} direction=${direction}`];
    for (const step of report.steps ?? []) {
      lines.push(this.#formatStep(step));
      if (step.phase === "markdown-to-code" && Array.isArray(step.warnings) && step.warnings.length) {
        const sampleWarnings = step.warnings.slice(0, 5);
        sampleWarnings.forEach((warning) => {
          lines.push(`[MiniPhi][Benchmark][Warn] ${warning.path}: ${warning.reason}`);
        });
        if (step.warnings.length > sampleWarnings.length) {
          lines.push(
            `[MiniPhi][Benchmark][Warn] ...${step.warnings.length - sampleWarnings.length} additional warnings omitted`,
          );
        }
      }
    }
    const relReport = this.#relativePath(reportPath);
    const relLog = this.#relativePath(logPath);
    lines.push(`[MiniPhi][Benchmark] Report saved to ${relReport}`);
    lines.push(`[MiniPhi][Benchmark] Log saved to ${relLog}`);
    if (promptLogPath) {
      lines.push(`[MiniPhi][Benchmark] Prompt log saved to ${this.#relativePath(promptLogPath)}`);
    }
    return lines;
  }

  #formatStep(step) {
    if (!step?.phase) {
      return "[MiniPhi][Benchmark] Unknown step";
    }
    switch (step.phase) {
      case "code-to-markdown":
        return `[MiniPhi][Recompose] code→md: ${step.converted}/${step.discovered} files converted in ${step.durationMs} ms (skipped ${step.skipped})`;
      case "markdown-to-code":
        return `[MiniPhi][Recompose] md→code: ${step.converted}/${step.processed} markdown files restored in ${step.durationMs} ms (warnings: ${step.warnings?.length ?? 0})`;
      case "comparison":
        return `[MiniPhi][Recompose] compare: ${step.matches} matches, ${(step.mismatches ?? []).length} mismatches, ${(step.missing ?? []).length} missing, ${(step.extras ?? []).length} extra files (took ${step.durationMs} ms)`;
      default:
        return `[MiniPhi][Benchmark] ${step.phase} phase completed in ${step.durationMs ?? 0} ms`;
    }
  }

  #relativePath(targetPath) {
    if (!targetPath) {
      return "";
    }
    const relative = path.relative(process.cwd(), targetPath);
    return relative || targetPath;
  }

  async #copyPromptLog(promptLog, outputDir, runLabel) {
    if (!promptLog) {
      return null;
    }
    const sourcePath = path.isAbsolute(promptLog) ? promptLog : path.resolve(process.cwd(), promptLog);
    try {
      await fs.promises.access(sourcePath, fs.constants.F_OK);
    } catch {
      return null;
    }
    const safeLabel = this.#sanitizeLabel(runLabel) || "RUN";
    const targetPath = path.join(outputDir, `${safeLabel}.prompts.log`);
    await fs.promises.copyFile(sourcePath, targetPath);
    return targetPath;
  }

  #buildDirectionalQueue(directions, repeat, { clean, runPrefix }) {
    if (!Array.isArray(directions) || directions.length === 0) {
      throw new Error("At least one direction is required for a benchmark run.");
    }
    const sanitizedDirections = directions.map((direction) => (typeof direction === "string" ? direction.toLowerCase().trim() : "")).filter(Boolean);
    if (sanitizedDirections.length === 0) {
      throw new Error("Directions resolved to an empty list after trimming.");
    }
    const cycles = Math.max(1, Number(repeat) || 1);
    const queue = [];
    for (let i = 0; i < cycles; i += 1) {
      sanitizedDirections.forEach((direction) => {
        queue.push({
          direction,
          clean: Boolean(clean),
          runPrefix,
        });
      });
    }
    return queue;
  }

  #normalizePlanDescriptor(entry, { defaultClean, defaultPrefix, index }) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Plan entry ${index ?? 0} is not an object.`);
    }
    const direction = typeof entry.direction === "string" ? entry.direction.toLowerCase().trim() : null;
    if (!direction) {
      throw new Error(`Plan entry ${index ?? 0} is missing a direction.`);
    }
    return {
      direction,
      clean: this.#normalizeClean(entry.clean, defaultClean),
      runPrefix: entry.runPrefix ?? defaultPrefix ?? "RUN",
      runLabel: entry.runLabel ?? entry.label ?? null,
    };
  }

  #normalizeClean(value, fallback) {
    if (value === undefined || value === null) {
      return Boolean(fallback);
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["false", "off", "none", "no"].includes(normalized)) {
        return false;
      }
      return true;
    }
    return Boolean(value);
  }

  #sanitizeLabel(label) {
    if (!label || typeof label !== "string") {
      return null;
    }
    const trimmed = label.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.replace(/[^\w.-]+/g, "-");
  }
}
