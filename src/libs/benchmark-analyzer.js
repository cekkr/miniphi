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
    await fs.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    this.#printSummary(summary, summaryPath);

    return summary;
  }

  #printSummary(summary, summaryPath) {
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
    console.log(`[MiniPhi][Benchmark][Analyze] Summary saved to ${summaryPath}`);
  }
}
