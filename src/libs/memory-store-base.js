import {
  buildCompositionKey,
  ensureJsonFile,
  normalizeCompositionStatus,
  upsertIndexEntry,
  readJsonFile,
  relativePath,
  slugifyId,
  writeJsonFile,
} from "./memory-store-utils.js";

export default class MemoryStoreBase {
  constructor(baseDir, options = undefined) {
    this.baseDir = baseDir;
    this.ensureReadable = Boolean(options?.ensureReadable);
    this.relativeOptions = options?.relativeOptions ?? null;
    this.slugifyOptions = options?.slugifyOptions ?? null;
  }

  async _ensureFile(filePath, defaultValue) {
    await ensureJsonFile(filePath, defaultValue, {
      ensureReadable: this.ensureReadable,
    });
  }

  async _writeJSON(filePath, data) {
    await writeJsonFile(filePath, data);
  }

  async _readJSON(filePath, fallback = null) {
    return readJsonFile(filePath, fallback);
  }

  async _upsertIndexEntry(filePath, entry, options = undefined) {
    return upsertIndexEntry(filePath, entry, options);
  }

  _relative(target) {
    return relativePath(this.baseDir, target, this.relativeOptions ?? undefined);
  }

  _slugify(text) {
    return slugifyId(text, this.slugifyOptions ?? undefined);
  }

  _normalizeCompositionStatus(status) {
    return normalizeCompositionStatus(status);
  }

  _buildCompositionKey(payload) {
    return buildCompositionKey(payload);
  }
}
