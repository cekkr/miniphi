import fs from "fs";
import path from "path";
import MiniPhiMemory from "./miniphi-memory.js";

const formatNumber = (value) => Number(value || 0).toFixed(2);

export default class BenchmarkAnalyzer {
  constructor(options = {}) {
    this.memory = options.memory ?? new MiniPhiMemory(process.cwd());
  }

  async analyzeDirectory(targetDir) {
    if (!targetDir) {
      throw new Error("Benchmark analyzer requires a target directory.");
    }
    const resolved = path.resolve(targetDir);
    const runs = await this.#loadRuns(resolved);
    const summary = this.#summarizeRuns(runs, resolved);
    const artifacts = await this.#writeSummaryArtifacts(resolved, summary);
    await this.#recordHistory(summary, { ...artifacts, type: "summary" });
    this.#printSummary(summary, artifacts);
    return summary;
  }

  async compareDirectories(baselineDir, candidateDir) {
    if (!baselineDir || !candidateDir) {
      throw new Error("benchmark analyze --compare requires both --path/--baseline and --compare directories.");
    }
    const baselineResolved = path.resolve(baselineDir);
    const candidateResolved = path.resolve(candidateDir);
    const baseline = this.#summarizeRuns(await this.#loadRuns(baselineResolved), baselineResolved);
    const candidate = this.#summarizeRuns(await this.#loadRuns(candidateResolved), candidateResolved);
    const comparison = this.#buildComparisonSummary(baseline, candidate);
    const artifacts = await this.#writeComparisonArtifacts(candidateResolved, comparison);
    await this.#recordHistory(comparison, { ...artifacts, type: "comparison" });
    this.#printComparison(comparison, artifacts);
    return comparison;
  }

  async #loadRuns(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const jsonFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(directory, entry.name));
    if (!jsonFiles.length) {
      throw new Error(`No JSON reports found under ${directory}`);
    }
    const runs = [];
    for (const filePath of jsonFiles) {
      try {
        const raw = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
        runs.push({ filePath, data: raw });
      } catch (error) {
        console.warn(
          `[MiniPhi][Benchmark][Analyze] Skipping ${filePath}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (!runs.length) {
      throw new Error(`Unable to parse any JSON reports under ${directory}`);
    }
    runs.sort((a, b) => {
      const aTime = Date.parse(a.data.generatedAt ?? 0);
      const bTime = Date.parse(b.data.generatedAt ?? 0);
      return aTime - bTime;
    });
    return runs;
  }

  #summarizeRuns(runs, directory) {
    const summary = {
      analyzedAt: new Date().toISOString(),
      directory,
      totalRuns: runs.length,
      sampleDirs: Array.from(new Set(runs.map((run) => run.data.sampleDir).filter(Boolean))).sort(),
      directions: {},
      warningRuns: [],
      mismatchRuns: [],
      runs: runs.map((run) => ({
        file: run.filePath,
        direction: run.data.direction,
        generatedAt: run.data.generatedAt ?? null,
      })),
    };
    for (const { filePath, data } of runs) {
      const direction = data.direction ?? "unknown";
      const bucket = summary.directions[direction] ?? {
        runs: 0,
        phases: {},
        totalWarnings: 0,
        warningRuns: 0,
        totalMismatches: 0,
        mismatchRuns: 0,
        warningBuckets: {},
      };
      bucket.runs += 1;
      for (const step of data.steps ?? []) {
        const phaseStats = bucket.phases[step.phase] ?? { durations: [] };
        phaseStats.durations.push(Number(step.durationMs || 0));
        bucket.phases[step.phase] = phaseStats;
        if (step.phase === "markdown-to-code" && Array.isArray(step.warnings) && step.warnings.length) {
          bucket.totalWarnings += step.warnings.length;
          bucket.warningRuns += 1;
          step.warnings.forEach((warning) => {
            const reason = warning?.reason ?? "unknown warning";
            bucket.warningBuckets[reason] = (bucket.warningBuckets[reason] ?? 0) + 1;
          });
          summary.warningRuns.push({
            file: filePath,
            count: step.warnings.length,
            sampleWarnings: step.warnings.slice(0, 3),
          });
        }
        if (step.phase === "comparison") {
          const mismatchCount = (step.mismatches ?? []).length + (step.missing ?? []).length + (step.extras ?? []).length;
          if (mismatchCount > 0) {
            bucket.totalMismatches += mismatchCount;
            bucket.mismatchRuns += 1;
            summary.mismatchRuns.push({
              file: filePath,
              mismatches: step.mismatches ?? [],
              missing: step.missing ?? [],
              extras: step.extras ?? [],
            });
          }
        }
      }
      summary.directions[direction] = bucket;
    }
    const normalized = {};
    for (const [direction, bucket] of Object.entries(summary.directions)) {
      const phases = {};
      for (const [phase, stats] of Object.entries(bucket.phases)) {
        const durations = stats.durations;
        const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;
        const sorted = [...durations].sort((a, b) => a - b);
        phases[phase] = {
          averageMs: Number(average.toFixed(2)),
          minMs: sorted[0],
          maxMs: sorted[sorted.length - 1],
          runs: durations.length,
        };
      }
      normalized[direction] = {
        runs: bucket.runs,
        phases,
        warningRuns: bucket.warningRuns,
        totalWarnings: bucket.totalWarnings,
        warningBuckets: bucket.warningBuckets,
        mismatchRuns: bucket.mismatchRuns,
        totalMismatches: bucket.totalMismatches,
      };
    }
    summary.directions = normalized;
    return summary;
  }

  async #writeSummaryArtifacts(directory, summary) {
    const summaryPath = path.join(directory, "SUMMARY.json");
    const markdownPath = path.join(directory, "SUMMARY.md");
    const htmlPath = path.join(directory, "SUMMARY.html");
    await fs.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    await fs.promises.writeFile(markdownPath, this.#renderMarkdown(summary), "utf8");
    await fs.promises.writeFile(htmlPath, this.#renderHtml(summary), "utf8");
    return { summaryPath, markdownPath, htmlPath };
  }

  async #writeComparisonArtifacts(directory, comparison) {
    const jsonPath = path.join(directory, "SUMMARY-COMPARE.json");
    const markdownPath = path.join(directory, "SUMMARY-COMPARE.md");
    await fs.promises.writeFile(jsonPath, JSON.stringify(comparison, null, 2), "utf8");
    await fs.promises.writeFile(markdownPath, this.#renderComparisonMarkdown(comparison), "utf8");
    return { summaryPath: jsonPath, markdownPath, htmlPath: null };
  }

  async #recordHistory(summary, artifacts) {
    if (!this.memory) {
      return;
    }
    await this.memory.prepare();
    const todoItems = this.#buildTodoItems(summary);
    await this.memory.recordBenchmarkSummary(summary, {
      summaryPath: artifacts.summaryPath,
      markdownPath: artifacts.markdownPath,
      htmlPath: artifacts.htmlPath,
      todoItems,
      type: artifacts.type,
    });
  }

  #buildTodoItems(summary) {
    if (!summary) {
      return [];
    }
    if (summary.type === "comparison") {
      const todos = [];
      Object.entries(summary.directionDeltas ?? {}).forEach(([direction, details]) => {
        if (details.warningDelta > 0) {
          todos.push(`${direction}: warnings increased by ${details.warningDelta}`);
        }
        if (details.mismatchDelta > 0) {
          todos.push(`${direction}: mismatches increased by ${details.mismatchDelta}`);
        }
      });
      return todos;
    }
    const todos = [];
    summary.warningRuns.forEach((warning) => {
      todos.push(`${path.basename(warning.file)} emitted ${warning.count} warnings`);
    });
    summary.mismatchRuns.forEach((mismatch) => {
      todos.push(`${path.basename(mismatch.file)} has ${mismatch.mismatches.length} mismatches`);
    });
    return todos;
  }

  #buildComparisonSummary(baseline, candidate) {
    const comparison = {
      type: "comparison",
      analyzedAt: new Date().toISOString(),
      baselineDir: baseline.directory,
      candidateDir: candidate.directory,
      directionDeltas: {},
      warningRuns: {
        baseline: baseline.warningRuns.length,
        candidate: candidate.warningRuns.length,
      },
      mismatchRuns: {
        baseline: baseline.mismatchRuns.length,
        candidate: candidate.mismatchRuns.length,
      },
    };
    const directions = new Set([
      ...Object.keys(baseline.directions),
      ...Object.keys(candidate.directions),
    ]);
    directions.forEach((direction) => {
      const base = baseline.directions[direction] ?? {
        runs: 0,
        phases: {},
        warningBuckets: {},
        totalWarnings: 0,
        totalMismatches: 0,
      };
      const cand = candidate.directions[direction] ?? {
        runs: 0,
        phases: {},
        warningBuckets: {},
        totalWarnings: 0,
        totalMismatches: 0,
      };
      const phaseNames = new Set([...Object.keys(base.phases), ...Object.keys(cand.phases)]);
      const phaseDeltas = [];
      phaseNames.forEach((phase) => {
        const baseStats = base.phases[phase];
        const candStats = cand.phases[phase];
        if (!baseStats && !candStats) {
          return;
        }
        phaseDeltas.push({
          phase,
          baselineAvg: baseStats ? formatNumber(baseStats.averageMs) : "n/a",
          candidateAvg: candStats ? formatNumber(candStats.averageMs) : "n/a",
          deltaMs:
            baseStats && candStats ? formatNumber(candStats.averageMs - baseStats.averageMs) : "n/a",
        });
      });
      const bucketNames = new Set([
        ...Object.keys(base.warningBuckets ?? {}),
        ...Object.keys(cand.warningBuckets ?? {}),
      ]);
      const warningBuckets = [];
      bucketNames.forEach((name) => {
        const baselineCount = base.warningBuckets?.[name] ?? 0;
        const candidateCount = cand.warningBuckets?.[name] ?? 0;
        warningBuckets.push({
          reason: name,
          baseline: baselineCount,
          candidate: candidateCount,
          delta: candidateCount - baselineCount,
        });
      });
      comparison.directionDeltas[direction] = {
        baselineRuns: base.runs,
        candidateRuns: cand.runs,
        phaseDeltas,
        warningDelta: cand.totalWarnings - base.totalWarnings,
        mismatchDelta: cand.totalMismatches - base.totalMismatches,
        warningBuckets,
      };
    });
    return comparison;
  }

  #renderComparisonMarkdown(comparison) {
    const lines = [
      "# Benchmark Comparison",
      `- Baseline: ${comparison.baselineDir}`,
      `- Candidate: ${comparison.candidateDir}`,
      `- Generated: ${comparison.analyzedAt}`,
      "",
    ];
    Object.entries(comparison.directionDeltas).forEach(([direction, details]) => {
      lines.push(`## ${direction}`);
      lines.push(
        `Runs baseline ${details.baselineRuns} vs candidate ${details.candidateRuns} | warnings Δ ${details.warningDelta} | mismatches Δ ${details.mismatchDelta}`,
      );
      if (details.phaseDeltas.length) {
        lines.push("");
        lines.push("| Phase | Baseline Avg (ms) | Candidate Avg (ms) | Δ (ms) |");
        lines.push("| --- | ---: | ---: | ---: |");
        details.phaseDeltas.forEach((delta) => {
          lines.push(
            `| ${delta.phase} | ${delta.baselineAvg} | ${delta.candidateAvg} | ${delta.deltaMs} |`,
          );
        });
      }
      if (details.warningBuckets.length) {
        lines.push("");
        lines.push("Warning buckets:");
        details.warningBuckets.forEach((bucket) => {
          lines.push(
            `- ${bucket.reason}: baseline ${bucket.baseline}, candidate ${bucket.candidate} (Δ ${bucket.delta})`,
          );
        });
      }
      lines.push("");
    });
    return `${lines.join("\n").trim()}\n`;
  }

  #renderMarkdown(summary) {
    const lines = [
      "# Benchmark Summary",
      `- Directory: ${summary.directory}`,
      `- Analyzed At: ${summary.analyzedAt}`,
      `- Total Runs: ${summary.totalRuns}`,
      `- Sample Directories: ${summary.sampleDirs.join(", ") || "n/a"}`,
      "",
    ];
    Object.entries(summary.directions).forEach(([direction, details]) => {
      lines.push(`## ${direction}`);
      lines.push(
        `Runs: ${details.runs}, warnings ${details.totalWarnings} (${details.warningRuns} runs), mismatches ${details.totalMismatches} (${details.mismatchRuns} runs)`,
      );
      const phaseEntries = Object.entries(details.phases);
      if (phaseEntries.length) {
        lines.push("");
        lines.push("| Phase | Avg (ms) | Min (ms) | Max (ms) | Samples |");
        lines.push("| --- | ---: | ---: | ---: | ---: |");
        phaseEntries.forEach(([phase, stats]) => {
          lines.push(
            `| ${phase} | ${formatNumber(stats.averageMs)} | ${formatNumber(stats.minMs)} | ${formatNumber(stats.maxMs)} | ${stats.runs} |`,
          );
        });
        lines.push("");
      }
    });
    if (summary.warningRuns.length) {
      lines.push("## Warning Runs");
      summary.warningRuns.forEach((warning) => {
        const sample =
          warning.sampleWarnings?.map((item) => item?.reason ?? "").filter(Boolean).join("; ") || "n/a";
        lines.push(`- ${warning.file} (${warning.count} warnings) – sample: ${sample}`);
      });
      lines.push("");
    }
    if (summary.mismatchRuns.length) {
      lines.push("## Mismatch Runs");
      summary.mismatchRuns.forEach((item) => {
        lines.push(
          `- ${item.file}: mismatches ${item.mismatches.length}, missing ${item.missing.length}, extras ${item.extras.length}`,
        );
      });
      lines.push("");
    }
    return `${lines.join("\n").trim()}\n`;
  }

  #renderHtml(summary) {
    const escape = (value) =>
      String(value ?? "").replace(/[&<>"']/g, (char) => {
        switch (char) {
          case "&":
            return "&amp;";
          case "<":
            return "&lt;";
          case ">":
            return "&gt;";
          case '"':
            return "&quot;";
          case "'":
            return "&#39;";
          default:
            return char;
        }
      });
    const directionSections = Object.entries(summary.directions)
      .map(([direction, details]) => {
        const rows = Object.entries(details.phases)
          .map(
            ([phase, stats]) =>
              `<tr><td>${escape(phase)}</td><td>${formatNumber(stats.averageMs)}</td><td>${formatNumber(
                stats.minMs,
              )}</td><td>${formatNumber(stats.maxMs)}</td><td>${stats.runs}</td></tr>`,
          )
          .join("");
        const table = rows
          ? `<table><thead><tr><th>Phase</th><th>Avg (ms)</th><th>Min (ms)</th><th>Max (ms)</th><th>Samples</th></tr></thead><tbody>${rows}</tbody></table>`
          : "<p>No phase data.</p>";
        return `<section><h2>${escape(direction)}</h2><p>Runs: ${details.runs}, warnings ${details.totalWarnings} (${details.warningRuns} runs), mismatches ${details.totalMismatches} (${details.mismatchRuns} runs)</p>${table}</section>`;
      })
      .join("\n");
    const warningList = summary.warningRuns.length
      ? `<section><h2>Warning Runs</h2><ul>${summary.warningRuns
          .map(
            (warning) =>
              `<li><strong>${escape(warning.file)}</strong>: ${warning.count} warnings (sample: ${escape(
                JSON.stringify(warning.sampleWarnings ?? []),
              )})</li>`,
          )
          .join("")}</ul></section>`
      : "";
    const mismatchList = summary.mismatchRuns.length
      ? `<section><h2>Mismatch Runs</h2><ul>${summary.mismatchRuns
          .map(
            (item) =>
              `<li><strong>${escape(item.file)}</strong>: mismatches ${item.mismatches.length}, missing ${item.missing.length}, extras ${item.extras.length}</li>`,
          )
          .join("")}</ul></section>`
      : "";
    return [
      "<!DOCTYPE html>",
      "<html>",
      "<head>",
      '<meta charset="utf-8" />',
      "<title>Benchmark Summary</title>",
      "<style>",
      "body { font-family: Arial, sans-serif; padding: 24px; }",
      "table { border-collapse: collapse; margin-top: 8px; width: 100%; }",
      "th, td { border: 1px solid #ddd; padding: 4px 8px; text-align: right; }",
      "th:first-child, td:first-child { text-align: left; }",
      "section { margin-bottom: 24px; }",
      "</style>",
      "</head>",
      "<body>",
      `<h1>Benchmark Summary</h1>`,
      `<p><strong>Directory:</strong> ${escape(summary.directory)}</p>`,
      `<p><strong>Analyzed:</strong> ${escape(summary.analyzedAt)}</p>`,
      `<p><strong>Total Runs:</strong> ${summary.totalRuns}</p>`,
      `<p><strong>Sample Directories:</strong> ${escape(summary.sampleDirs.join(", ") || "n/a")}</p>`,
      directionSections || "<p>No direction stats.</p>",
      warningList,
      mismatchList,
      "</body>",
      "</html>",
    ].join("\n");
  }

  #printSummary(summary, artifacts) {
    console.log(`[MiniPhi][Benchmark][Analyze] ${summary.totalRuns} runs analyzed under ${summary.directory}`);
    Object.entries(summary.directions).forEach(([direction, details]) => {
      console.log(
        `[MiniPhi][Benchmark][Analyze] ${direction}: ${details.runs} runs, warnings ${details.totalWarnings} (${details.warningRuns} runs), mismatches ${details.totalMismatches} (${details.mismatchRuns} runs)`,
      );
      Object.entries(details.phases).forEach(([phase, stats]) => {
        console.log(
          `  -> ${phase}: avg ${formatNumber(stats.averageMs)} ms, min ${stats.minMs} ms, max ${stats.maxMs} ms across ${stats.runs} samples`,
        );
      });
    });
    if (summary.warningRuns.length) {
      console.log("[MiniPhi][Benchmark][Analyze] Warning spikes:");
      summary.warningRuns.forEach((warning) => {
        console.log(
          `  - ${warning.file}: ${warning.count} warnings (sample: ${JSON.stringify(warning.sampleWarnings)})`,
        );
      });
    }
    if (summary.mismatchRuns.length) {
      console.log("[MiniPhi][Benchmark][Analyze] Mismatch detections:");
      summary.mismatchRuns.forEach((item) => {
        console.log(
          `  - ${item.file}: mismatches ${item.mismatches.length}, missing ${item.missing.length}, extras ${item.extras.length}`,
        );
      });
    }
    const relJson = path.relative(process.cwd(), artifacts.summaryPath) || artifacts.summaryPath;
    const relMarkdown = path.relative(process.cwd(), artifacts.markdownPath) || artifacts.markdownPath;
    const relHtml = artifacts.htmlPath ? path.relative(process.cwd(), artifacts.htmlPath) || artifacts.htmlPath : null;
    console.log(`[MiniPhi][Benchmark][Analyze] JSON summary saved to ${relJson}`);
    console.log(`[MiniPhi][Benchmark][Analyze] Markdown summary saved to ${relMarkdown}`);
    if (relHtml) {
      console.log(`[MiniPhi][Benchmark][Analyze] HTML summary saved to ${relHtml}`);
    }
  }

  #printComparison(comparison, artifacts) {
    console.log(
      `[MiniPhi][Benchmark][Analyze] Compared ${comparison.candidateDir} against baseline ${comparison.baselineDir}`,
    );
    Object.entries(comparison.directionDeltas).forEach(([direction, details]) => {
      console.log(
        `[MiniPhi][Benchmark][Analyze] ${direction}: warnings Δ ${details.warningDelta}, mismatches Δ ${details.mismatchDelta}`,
      );
      details.phaseDeltas.forEach((delta) => {
        console.log(
          `  -> ${delta.phase}: baseline ${delta.baselineAvg} ms vs candidate ${delta.candidateAvg} ms (Δ ${delta.deltaMs})`,
        );
      });
    });
    const relJson = path.relative(process.cwd(), artifacts.summaryPath) || artifacts.summaryPath;
    const relMarkdown = path.relative(process.cwd(), artifacts.markdownPath) || artifacts.markdownPath;
    console.log(`[MiniPhi][Benchmark][Analyze] Comparison JSON saved to ${relJson}`);
    console.log(`[MiniPhi][Benchmark][Analyze] Comparison Markdown saved to ${relMarkdown}`);
  }
}
