import fs from "fs";
import os from "os";
import path from "path";
import { migrateStopReasonArtifacts } from "../libs/stop-reason-migrator.js";

async function directoryExists(targetPath) {
  if (!targetPath) {
    return false;
  }
  try {
    const stats = await fs.promises.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function findNearestMiniPhiDir(startDir) {
  let current = path.resolve(startDir);
  const { root } = path.parse(current);
  while (true) {
    const candidate = path.join(current, ".miniphi");
    if (await directoryExists(candidate)) {
      return candidate;
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return null;
}

function toRelativeOrAbsolute(targetPath) {
  const relative = path.relative(process.cwd(), targetPath);
  return relative && !relative.startsWith("..") ? relative : targetPath;
}

function buildParseErrorReportEntries(targets) {
  const entries = [];
  for (const target of targets) {
    for (const file of target.parseErrorFiles ?? []) {
      const absolutePath = path.join(target.baseDir, file);
      entries.push(toRelativeOrAbsolute(absolutePath));
    }
  }
  return entries;
}

function printHumanSummary(summary, verbose, parseErrorReport) {
  const mode = summary.dryRun ? "dry run" : "complete";
  console.log(
    `[MiniPhi] Stop-reason/prompt-exchange migration ${mode}: ${summary.targets.length} target${
      summary.targets.length === 1 ? "" : "s"
    }, ${summary.totals.filesChanged}/${summary.totals.filesScanned} JSON files updated.`,
  );
  for (const target of summary.targets) {
    const label = toRelativeOrAbsolute(target.baseDir);
    console.log(
      `[MiniPhi] ${label}: changed ${target.filesChanged}/${target.filesScanned} files, objects ${target.objectsUpdated}, fields ${target.fieldsUpdated}, parse errors ${target.parseErrors}, write errors ${target.writeErrors}.`,
    );
    if (verbose && target.changedFiles.length) {
      for (const file of target.changedFiles.slice(0, 25)) {
        console.log(`[MiniPhi]   - ${file}`);
      }
      if (target.changedFiles.length > 25) {
        console.log(
          `[MiniPhi]   ... ${target.changedFiles.length - 25} more changed file${
            target.changedFiles.length - 25 === 1 ? "" : "s"
          }`,
        );
      }
    }
    if (parseErrorReport && target.parseErrorFiles.length) {
      console.log(`[MiniPhi] ${label}: malformed JSON files (${target.parseErrorFiles.length}):`);
      for (const file of target.parseErrorFiles) {
        console.log(`[MiniPhi]   - ${toRelativeOrAbsolute(path.join(target.baseDir, file))}`);
      }
    }
  }
}

export async function handleMigrateStopReasonsCommand({ options, verbose }) {
  const rootHint = options["history-root"] ?? options.cwd ?? process.cwd();
  const dryRun = Boolean(options["dry-run"]);
  const includeGlobal = Boolean(options["include-global"]);
  const strict = Boolean(options.strict);
  const parseErrorReport = Boolean(options["parse-error-report"]);

  const targets = [];
  const localDir = await findNearestMiniPhiDir(path.resolve(rootHint));
  if (localDir) {
    targets.push(localDir);
  }
  if (includeGlobal) {
    const globalDir = path.join(os.homedir(), ".miniphi");
    if ((await directoryExists(globalDir)) && !targets.includes(globalDir)) {
      targets.push(globalDir);
    }
  }

  if (!targets.length) {
    throw new Error(
      `No .miniphi directory found starting from ${path.resolve(rootHint)}. Provide --history-root <path> or run from a project with existing artifacts.`,
    );
  }

  const results = [];
  for (const baseDir of targets) {
    const result = await migrateStopReasonArtifacts({
      baseDir,
      dryRun,
      failFastOnParseError: strict,
    });
    results.push(result);
    if (strict && result.parseErrors > 0) {
      break;
    }
  }

  const parseErrorFiles = buildParseErrorReportEntries(results);
  const summary = {
    dryRun,
    strict,
    targets: results,
    totals: {
      filesScanned: results.reduce((sum, entry) => sum + entry.filesScanned, 0),
      filesChanged: results.reduce((sum, entry) => sum + entry.filesChanged, 0),
      objectsUpdated: results.reduce((sum, entry) => sum + entry.objectsUpdated, 0),
      fieldsUpdated: results.reduce((sum, entry) => sum + entry.fieldsUpdated, 0),
      parseErrors: results.reduce((sum, entry) => sum + entry.parseErrors, 0),
      readErrors: results.reduce((sum, entry) => sum + entry.readErrors, 0),
      writeErrors: results.reduce((sum, entry) => sum + entry.writeErrors, 0),
    },
    parseErrorFiles: parseErrorReport ? parseErrorFiles : undefined,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHumanSummary(summary, verbose, parseErrorReport);
    if (parseErrorReport && !parseErrorFiles.length) {
      console.log("[MiniPhi] No malformed JSON files detected.");
    }
  }

  if (summary.totals.writeErrors > 0) {
    throw new Error(
      `Stop-reason migration completed with ${summary.totals.writeErrors} write error${
        summary.totals.writeErrors === 1 ? "" : "s"
      }.`,
    );
  }
  if (strict && summary.totals.parseErrors > 0) {
    throw new Error(
      `Stop-reason migration strict mode failed: encountered ${summary.totals.parseErrors} JSON parse error${
        summary.totals.parseErrors === 1 ? "" : "s"
      }.`,
    );
  }
}
