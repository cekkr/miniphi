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

function printHumanSummary(summary, verbose) {
  const mode = summary.dryRun ? "dry run" : "complete";
  console.log(
    `[MiniPhi] Stop-reason migration ${mode}: ${summary.targets.length} target${
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
  }
}

export async function handleMigrateStopReasonsCommand({ options, verbose }) {
  const rootHint = options["history-root"] ?? options.cwd ?? process.cwd();
  const dryRun = Boolean(options["dry-run"]);
  const includeGlobal = Boolean(options["include-global"]);

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
    const result = await migrateStopReasonArtifacts({ baseDir, dryRun });
    results.push(result);
  }

  const summary = {
    dryRun,
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
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHumanSummary(summary, verbose);
  }

  if (summary.totals.writeErrors > 0) {
    throw new Error(
      `Stop-reason migration completed with ${summary.totals.writeErrors} write error${
        summary.totals.writeErrors === 1 ? "" : "s"
      }.`,
    );
  }
}

