import fs from "fs";
import path from "path";

export async function writeJsonFile(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function upsertIndexEntry(indexPath, entry, options = undefined) {
  if (!indexPath) {
    return null;
  }
  const fallback =
    options?.fallback && typeof options.fallback === "object"
      ? options.fallback
      : { entries: [] };
  const index = (await readJsonFile(indexPath, fallback)) ?? fallback;
  const entries = Array.isArray(index.entries) ? index.entries : [];
  const idKey = typeof options?.idKey === "string" && options.idKey.trim() ? options.idKey : "id";
  const entryId = entry && Object.prototype.hasOwnProperty.call(entry, idKey) ? entry[idKey] : null;
  const filtered = entryId
    ? entries.filter((item) => item && item[idKey] !== entryId)
    : entries.slice();
  if (entry) {
    filtered.unshift(entry);
  }
  const limitRaw = Number(options?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200;
  index.entries = filtered.slice(0, limit);
  if (options?.setUpdatedAt !== false) {
    index.updatedAt = options?.updatedAt ?? new Date().toISOString();
  }
  await writeJsonFile(indexPath, index);
  return index;
}

export async function ensureJsonFile(filePath, defaultValue, options = undefined) {
  const ensureReadable = Boolean(options?.ensureReadable);
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch {
    await writeJsonFile(filePath, defaultValue);
    return;
  }
  if (!ensureReadable) {
    return;
  }
  try {
    await fs.promises.readFile(filePath, "utf8");
  } catch {
    await writeJsonFile(filePath, defaultValue);
  }
}

export function relativePath(baseDir, target, options = undefined) {
  if (!target) {
    return target;
  }
  const normalizeSlashes = Boolean(options?.normalizeSlashes);
  const alwaysRelative = Boolean(options?.alwaysRelative);
  const fallbackToTarget = options?.fallbackToTarget !== false;
  const shouldRelativize = alwaysRelative || path.isAbsolute(target);
  let output = shouldRelativize ? path.relative(baseDir ?? "", target) : target;
  if (!output && fallbackToTarget) {
    output = target;
  }
  if (normalizeSlashes) {
    output = output.replace(/\\/g, "/");
  }
  return output;
}

export function slugifyId(text, options = undefined) {
  const fallback =
    typeof options?.fallback === "string" && options.fallback.trim().length
      ? options.fallback.trim()
      : "entry";
  const maxLength = Number.isFinite(options?.maxLength)
    ? Math.max(1, Math.floor(options.maxLength))
    : 64;
  const normalized = (text ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, maxLength) || fallback;
}

export function normalizeCompositionStatus(status) {
  if (!status && status !== 0) {
    return "ok";
  }
  const normalized = status.toString().trim().toLowerCase();
  if (normalized === "invalid" || normalized === "retire" || normalized === "remove") {
    return "invalid";
  }
  if (normalized === "fallback" || normalized === "degraded") {
    return "fallback";
  }
  return "ok";
}

export function buildCompositionKey(payload) {
  const schema =
    typeof payload?.schemaId === "string" ? payload.schemaId.trim().toLowerCase() : "none";
  const mode =
    typeof payload?.mode === "string" ? payload.mode.trim().toLowerCase() : "unknown";
  const commandText =
    typeof payload?.command === "string" && payload.command.trim().length
      ? payload.command.trim().toLowerCase()
      : typeof payload?.task === "string" && payload.task.trim().length
        ? payload.task.trim().toLowerCase()
        : "objective";
  const workspace =
    typeof payload?.workspaceType === "string" && payload.workspaceType.trim().length
      ? payload.workspaceType.trim().toLowerCase()
      : "any";
  return [schema || "none", mode || "unknown", commandText, workspace].join("::");
}
