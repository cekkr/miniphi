import fs from "fs";
import path from "path";
import { buildStopReasonInfo } from "./lmstudio-error-utils.js";

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function assignIfPresent(target, key, value, stats) {
  if (!hasOwn(target, key)) {
    return false;
  }
  const nextValue = value ?? null;
  if (target[key] === nextValue) {
    return false;
  }
  target[key] = nextValue;
  stats.fieldsUpdated += 1;
  return true;
}

function normalizeStopReasonObject(target, stats) {
  const hasCamel =
    hasOwn(target, "stopReason") ||
    hasOwn(target, "stopReasonCode") ||
    hasOwn(target, "stopReasonDetail");
  const hasSnake =
    hasOwn(target, "stop_reason") ||
    hasOwn(target, "stop_reason_code") ||
    hasOwn(target, "stop_reason_detail");
  const hasReasonKeys =
    hasOwn(target, "reason") || hasOwn(target, "reasonCode") || hasOwn(target, "reasonDetail");
  const normalizeReasonTuple =
    hasReasonKeys &&
    (hasCamel || hasSnake || hasOwn(target, "reasonCode") || hasOwn(target, "reasonDetail"));

  if (!hasCamel && !hasSnake && !normalizeReasonTuple) {
    return false;
  }

  const rawReason =
    normalizeText(hasCamel ? target.stopReason : null) ??
    normalizeText(hasSnake ? target.stop_reason : null) ??
    normalizeText(normalizeReasonTuple ? target.reason : null);
  const rawCode =
    normalizeText(hasCamel ? target.stopReasonCode : null) ??
    normalizeText(hasSnake ? target.stop_reason_code : null) ??
    normalizeText(normalizeReasonTuple ? target.reasonCode : null);
  const rawDetail =
    normalizeText(hasCamel ? target.stopReasonDetail : null) ??
    normalizeText(hasSnake ? target.stop_reason_detail : null) ??
    normalizeText(normalizeReasonTuple ? target.reasonDetail : null);
  const rawError =
    normalizeText(typeof target.error === "string" ? target.error : null) ??
    normalizeText(typeof target.message === "string" ? target.message : null);

  if (!rawReason && !rawCode && !rawDetail && !rawError) {
    return false;
  }

  const stopInfo = buildStopReasonInfo({
    error: rawError ?? rawDetail,
    fallbackReason: rawReason,
    fallbackCode: rawCode,
    fallbackDetail: rawDetail,
  });
  const normalizedReason = normalizeText(stopInfo.reason);
  const normalizedCode = normalizeText(stopInfo.code);
  const normalizedDetail = normalizeText(stopInfo.detail);

  let changed = false;
  if (hasCamel) {
    changed = assignIfPresent(target, "stopReason", normalizedReason, stats) || changed;
    changed = assignIfPresent(target, "stopReasonCode", normalizedCode, stats) || changed;
    changed = assignIfPresent(target, "stopReasonDetail", normalizedDetail, stats) || changed;
  }
  if (hasSnake) {
    changed = assignIfPresent(target, "stop_reason", normalizedReason, stats) || changed;
    changed = assignIfPresent(target, "stop_reason_code", normalizedCode, stats) || changed;
    changed = assignIfPresent(target, "stop_reason_detail", normalizedDetail, stats) || changed;
  }
  if (normalizeReasonTuple) {
    changed = assignIfPresent(target, "reason", normalizedReason, stats) || changed;
    changed = assignIfPresent(target, "reasonCode", normalizedCode, stats) || changed;
    changed = assignIfPresent(target, "reasonDetail", normalizedDetail, stats) || changed;
  }

  if (changed) {
    stats.objectsUpdated += 1;
  }
  return changed;
}

function normalizeValue(value, stats) {
  let changed = false;
  if (Array.isArray(value)) {
    for (const entry of value) {
      changed = normalizeValue(entry, stats) || changed;
    }
    return changed;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    changed = normalizeValue(value[key], stats) || changed;
  }
  changed = normalizeStopReasonObject(value, stats) || changed;
  return changed;
}

async function collectJsonFiles(rootDir) {
  const files = [];
  const stack = [path.resolve(rootDir)];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

export async function migrateStopReasonArtifacts(options = {}) {
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : null;
  if (!baseDir) {
    throw new Error("migrateStopReasonArtifacts requires a baseDir.");
  }
  const dryRun = Boolean(options.dryRun);
  const failFastOnParseError = Boolean(options.failFastOnParseError);
  const files = await collectJsonFiles(baseDir);
  const result = {
    baseDir,
    dryRun,
    filesScanned: 0,
    filesChanged: 0,
    objectsUpdated: 0,
    fieldsUpdated: 0,
    parseErrors: 0,
    readErrors: 0,
    writeErrors: 0,
    changedFiles: [],
    parseErrorFiles: [],
  };

  for (const filePath of files) {
    result.filesScanned += 1;
    const relativePath = path.relative(baseDir, filePath).replace(/\\/g, "/");
    let raw = "";
    try {
      raw = await fs.promises.readFile(filePath, "utf8");
    } catch {
      result.readErrors += 1;
      continue;
    }
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      result.parseErrors += 1;
      result.parseErrorFiles.push(relativePath);
      if (failFastOnParseError) {
        break;
      }
      continue;
    }

    const fileStats = { objectsUpdated: 0, fieldsUpdated: 0 };
    const fileChanged = normalizeValue(payload, fileStats);
    if (!fileChanged) {
      continue;
    }

    result.filesChanged += 1;
    result.objectsUpdated += fileStats.objectsUpdated;
    result.fieldsUpdated += fileStats.fieldsUpdated;
    result.changedFiles.push(relativePath);

    if (dryRun) {
      continue;
    }
    try {
      await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      result.writeErrors += 1;
    }
  }

  return result;
}
