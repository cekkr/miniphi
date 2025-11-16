import fs from "fs";
import path from "path";

const formatNumber = (value) => Number(value || 0).toFixed(2);

export default class BenchmarkAnalyzer {
  async analyzeDirectory(targetDir) {
    if (!targetDir) {
      throw new Error("Benchmark analyzer requires a target directory.");
    }
    const resolved = path.resolve(targetDir);
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    const jsonFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(resolved, entry.name));

    if (jsonFiles.length === 0) {
      throw new Error(`No JSON reports found under ${resolved}`);
    }

    const rawRuns = [];
    for (const filePath of jsonFiles) {
      try {
        const data = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
        rawRuns.push({ filePath, data });
      } catch (error) {
        console.warn(`[MiniPhi][Benchmark][Analyze] Skipping ${filePath}: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (rawRuns.length === 0) {
      throw new Error(`Unable to parse any JSON reports under ${resolved}`);
    }

    rawRuns.sort((a, b) => {
      const aTime = Date.parse(a.data.generatedAt ?? 0);
      const bTime = Date.parse(b.data.generatedAt ?? 0);
      return aTime - bTime;
    });

    const summary = {
      analyzedAt: new Date().toISOString(),
      directory: resolved,
      totalRuns: rawRuns.length,
      sampleDirs: Array.from(new Set(rawRuns.map((run) => run.data.sampleDir).filter(Boolean))).sort(),
      directions: {},
      warningRuns: [],
      mismatchRuns: [],
      runs: rawRuns.map((run) => ({
        file: run.filePath,
        direction: run.data.direction,
        generatedAt: run.data.generatedAt ?? null,
      })),
    };

    for (const { filePath, data } of rawRuns) {
      const direction = data.direction ?? "unknown";
      const directionBucket = summary.directions[direction] ?? {
        runs: 0,
        phases: {},
        totalWarnings: 0,
        warningRuns: 0,
        totalMismatches: 0,
        mismatchRuns: 0,
      };
      directionBucket.runs += 1;
      for (const step of data.steps ?? []) {
        const phaseStats = directionBucket.phases[step.phase] ?? { durations: [] };
        phaseStats.durations.push(Number(step.durationMs || 0));
        directionBucket.phases[step.phase] = phaseStats;

        if (step.phase === "markdown-to-code" && Array.isArray(step.warnings) && step.warnings.length) {
          directionBucket.totalWarnings += step.warnings.length;
          directionBucket.warningRuns += 1;
          summary.warningRuns.push({
            file: filePath,
            count: step.warnings.length,
            sampleWarnings: step.warnings.slice(0, 3),
          });
        }
        if (step.phase === "comparison") {
          const mismatchCount = (step.mismatches ?? []).length + (step.missing ?? []).length + (step.extras ?? []).length;
          if (mismatchCount > 0) {
            directionBucket.totalMismatches += mismatchCount;
            directionBucket.mismatchRuns += 1;
            summary.mismatchRuns.push({
              file: filePath,
              mismatches: step.mismatches ?? [],
              missing: step.missing ?? [],
              extras: step.extras ?? [],
            });
          }
        }
      }
      summary.directions[direction] = directionBucket;
    }

    const normalizedDirections = {};
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
      normalizedDirections[direction] = {
        runs: bucket.runs,
        phases,
        warningRuns: bucket.warningRuns,
        totalWarnings: bucket.totalWarnings,
        mismatchRuns: bucket.mismatchRuns,
        totalMismatches: bucket.totalMismatches,
      };
    }
    summary.directions = normalizedDirections;

    const summaryPath = path.join(resolved, "SUMMARY.json");
    const markdownPath = path.join(resolved, "SUMMARY.md");
    const htmlPath = path.join(resolved, "SUMMARY.html");
    await fs.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    await fs.promises.writeFile(markdownPath, this.#renderMarkdown(summary), "utf8");
    await fs.promises.writeFile(htmlPath, this.#renderHtml(summary), "utf8");

    this.#printSummary(summary, summaryPath, markdownPath, htmlPath);

    return summary;
  }

  #renderMarkdown(summary) {
    const lines = [];
    lines.push("# Benchmark Summary");
    lines.push("");
    lines.push(`- Directory: ${summary.directory}`);
    lines.push(`- Analyzed At: ${summary.analyzedAt}`);
    lines.push(`- Total Runs: ${summary.totalRuns}`);
    lines.push(`- Sample Directories: ${summary.sampleDirs.length ? summary.sampleDirs.join(", ") : "n/a"}`);
    lines.push("");
    const directionEntries = Object.entries(summary.directions);
    if (directionEntries.length === 0) {
      lines.push("No direction stats found.");
    } else {
      directionEntries.forEach(([direction, details]) => {
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
            lines.push(`| ${phase} | ${formatNumber(stats.averageMs)} | ${formatNumber(stats.minMs)} | ${formatNumber(stats.maxMs)} | ${stats.runs} |`);
          });
        }
        lines.push("");
      });
    }
    if (summary.warningRuns.length) {
      lines.push("## Warning Runs");
      summary.warningRuns.forEach((warning) => {
        const sample = warning.sampleWarnings?.map((item) => item?.reason ?? "").filter(Boolean).join("; ") || "n/a";
        lines.push(`- ${warning.file} (${warning.count} warnings) — sample: ${sample}`);
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
    const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => {
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
              `<tr><td>${escape(phase)}</td><td>${formatNumber(stats.averageMs)}</td><td>${formatNumber(stats.minMs)}</td><td>${formatNumber(stats.maxMs)}</td><td>${stats.runs}</td></tr>`,
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

  #printSummary(summary, summaryPath, markdownPath, htmlPath) {
    console.log(`[MiniPhi][Benchmark][Analyze] ${summary.totalRuns} runs analyzed under ${summary.directory}`);
    Object.entries(summary.directions).forEach(([direction, details]) => {
      console.log(
        `[MiniPhi][Benchmark][Analyze] ${direction}: ${details.runs} runs, warnings ${details.totalWarnings} (${details.warningRuns} runs), mismatches ${details.totalMismatches} (${details.mismatchRuns} runs)`,
      );
      Object.entries(details.phases).forEach(([phase, stats]) => {
        console.log(
          `  ↳ ${phase}: avg ${formatNumber(stats.averageMs)} ms, min ${stats.minMs} ms, max ${stats.maxMs} ms across ${stats.runs} samples`,
        );
      });
    });
    if (summary.warningRuns.length) {
      console.log("[MiniPhi][Benchmark][Analyze] Warning spikes:");
      summary.warningRuns.forEach((warning) => {
        console.log(`  - ${warning.file}: ${warning.count} warnings (sample: ${JSON.stringify(warning.sampleWarnings)})`);
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
    const relJson = path.relative(process.cwd(), summaryPath) || summaryPath;
    const relMarkdown = path.relative(process.cwd(), markdownPath) || markdownPath;
    const relHtml = path.relative(process.cwd(), htmlPath) || htmlPath;
    console.log(`[MiniPhi][Benchmark][Analyze] JSON summary saved to ${relJson}`);
    console.log(`[MiniPhi][Benchmark][Analyze] Markdown summary saved to ${relMarkdown}`);
    console.log(`[MiniPhi][Benchmark][Analyze] HTML summary saved to ${relHtml}`);
  }
}
