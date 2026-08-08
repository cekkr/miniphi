import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildCompleteReferenceSentences,
  normalizeReferenceSentences,
} from "./context-reference-memory.js";
import { contentWords, questionCues } from "./cheetah-memory-layers.js";

/**
 * The `.miniphi`-backed half of MiniPhi's graph memory.
 *
 * `CheetahContextEngine` mirrors the *current* session's layered graph into a
 * Cheetah database so recall can boost the nodes that matter this turn. That
 * store is authoritative-by-mirror, per-machine (`cheetah_data/` is a binary
 * table directory next to the server), and it only ever knows what this process
 * put there. Two consequences kept biting:
 *
 *   1. Everything MiniPhi already wrote under `.miniphi/` — previous sessions'
 *      decisions, applied edits, validation outcomes, research reports, the
 *      operator's own notes — was invisible to recall unless it was re-mirrored
 *      into the database, which means paying a graph write for information that
 *      is *already durable on disk*.
 *   2. Anything worth remembering across machines had to live in a Cheetah data
 *      directory that does not travel with the project.
 *
 * This module serves that corpus directly out of `.miniphi/memory/`, in
 * process, with no TCP hop and no graph write: plain JSONL records plus
 * markdown notes, ranked by a deterministic IDF-weighted cue overlap and
 * returned in the *same* reference-candidate shape `CheetahContextEngine.recall()`
 * produces, so `ContextReferenceComposer` selects from one merged pool and the
 * model grounds by id exactly as before.
 *
 * Design rules that are load-bearing:
 *
 * - **Nothing here is ever mirrored into Cheetah.** Candidate ids carry the
 *   `local:` prefix and name no graph node (`sourceNodeId` stays null), so the
 *   selection-boost path cannot mistake one for a live context node and the
 *   mirror has nothing to pick up.
 * - **The derived index is disposable.** `index.json` is a cache keyed by file
 *   size + mtime; deleting it costs one rescan, never a fact. The records and
 *   the notes are the only durable state, and both are human-readable so they
 *   can be copied, synced, or committed to reach another device.
 * - **Recall is deterministic and model-free**, like `cheetah-memory-layers`:
 *   it is a ranking over stored sentences, not a second inference call.
 */

export const LOCAL_MEMORY_SCHEMA_VERSION = "local-context-memory@v1";
export const LOCAL_MEMORY_DIRNAME = "memory";

const RECORDS_FILE = "records.jsonl";
const INDEX_FILE = "index.json";
const NOTES_DIRNAME = "notes";

const DEFAULT_MAX_RECORDS = 4000;
const DEFAULT_MAX_CANDIDATES = 12;
const DEFAULT_MAX_REFERENCES_PER_RECORD = 8;
const DEFAULT_MAX_TEXT_CHARS = 4000;
const DEFAULT_MIN_SCORE = 0.08;
const DEFAULT_HARVEST_SESSIONS = 12;

const KINDS = new Set([
  "note",
  "decision",
  "outcome",
  "recap",
  "mission",
  "research",
  "validation",
  "reference",
]);

const nowIso = () => new Date().toISOString();

const toPositiveInteger = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
};

const clamp01 = (value, fallback = 0.5) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, numeric));
};

const normalizeText = (value, maxChars = DEFAULT_MAX_TEXT_CHARS) =>
  String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxChars);

const normalizeKind = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return KINDS.has(normalized) ? normalized : "note";
};

const normalizeTags = (tags) => {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .slice(0, 48);
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    out.push(tag);
    if (out.length >= 12) {
      break;
    }
  }
  return out;
};

const recordId = (parts) =>
  `lm_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 20)}`;

/**
 * A deliberately small suffix stripper, applied identically to what is stored
 * and what is asked. Without it an agent seed ("which files did the session
 * *change*?") misses the sentence saying the session "*changed* these files" —
 * the most common way a real query failed against this corpus. It is not a
 * linguistic stemmer and does not try to be: over-stemming costs a little
 * precision across a few thousand records, under-stemming costs the answer.
 */
export function lightStem(word) {
  let stem = word;
  // Stripping has to repeat, not fire once: "rendering" loses "ing" to become
  // "render", which is exactly the form the one-pass version left alone, so the
  // two spellings would still not meet.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = stem;
    for (const suffix of ["ingly", "edly", "ing", "ies", "ied", "ers", "er", "ed", "es", "s"]) {
      if (stem.length - suffix.length >= 3 && stem.endsWith(suffix)) {
        stem = stem.slice(0, -suffix.length);
        if (suffix === "ies" || suffix === "ied") {
          stem = `${stem}y`;
        }
        break;
      }
    }
    if (stem === before) {
      break;
    }
  }
  // The silent `e` has to go too, or the pair this whole function exists for
  // still misses: "changed" strips to "chang" while "change" would stay whole.
  while (stem.length >= 4 && stem.endsWith("e")) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

const stemAll = (words) => words.map(lightStem);

/** A record's searchable surface: title, tags and every reference sentence. */
const recordTerms = (record) => {
  const bag = [record.title ?? "", ...(record.tags ?? [])];
  for (const reference of record.references ?? []) {
    bag.push(reference.text ?? "");
  }
  return stemAll(contentWords(bag.join("\n")));
};

/**
 * A durable, portable, project-local memory served straight from `.miniphi/`.
 *
 * Lifecycle: `prepare()` once (loads records + derived index), `refresh()` to
 * pick up artifacts written since the last scan, `recall()` per prompt,
 * `remember()` whenever the run learns something worth surviving the session.
 */
export default class LocalContextMemory {
  constructor(options = undefined) {
    const baseDir =
      typeof options?.baseDir === "string" && options.baseDir.trim()
        ? path.resolve(options.baseDir.trim())
        : path.resolve(process.cwd(), ".miniphi");
    this.baseDir = baseDir;
    this.memoryDir = path.join(baseDir, LOCAL_MEMORY_DIRNAME);
    this.recordsPath = path.join(this.memoryDir, RECORDS_FILE);
    this.indexPath = path.join(this.memoryDir, INDEX_FILE);
    this.notesDir = path.join(this.memoryDir, NOTES_DIRNAME);
    this.projectId =
      typeof options?.projectId === "string" && options.projectId.trim()
        ? options.projectId.trim()
        : null;
    this.sessionId =
      typeof options?.sessionId === "string" && options.sessionId.trim()
        ? options.sessionId.trim()
        : null;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.maxRecords = toPositiveInteger(options?.maxRecords, DEFAULT_MAX_RECORDS);
    this.maxCandidates = toPositiveInteger(options?.maxCandidates, DEFAULT_MAX_CANDIDATES);
    this.maxReferencesPerRecord = toPositiveInteger(
      options?.maxReferencesPerRecord,
      DEFAULT_MAX_REFERENCES_PER_RECORD,
    );
    this.minScore = Number.isFinite(options?.minScore)
      ? Math.max(0, Number(options.minScore))
      : DEFAULT_MIN_SCORE;
    this.harvestSessions = toPositiveInteger(
      options?.harvestSessions,
      DEFAULT_HARVEST_SESSIONS,
    );
    /** @type {Map<string, object>} */
    this._records = new Map();
    /** @type {Map<string, {size:number,mtimeMs:number,recordIds:string[]}>} */
    this._sources = new Map();
    /** @type {Map<string, string[]>} derived per-record term list */
    this._terms = new Map();
    /** @type {Map<string, number>} document frequency per term */
    this._documentFrequency = new Map();
    this._prepared = false;
    this._dirty = false;
    this._stats = {
      engine: "local",
      schemaVersion: LOCAL_MEMORY_SCHEMA_VERSION,
      records: 0,
      harvested: 0,
      remembered: 0,
      queries: 0,
      candidates: 0,
      lastError: null,
    };
  }

  _log(message) {
    if (this.logger) {
      this.logger(`[LocalContextMemory] ${message}`);
    }
  }

  async prepare() {
    if (this._prepared) {
      return this;
    }
    await fs.promises.mkdir(this.notesDir, { recursive: true });
    await this._loadRecords();
    await this._loadSourceIndex();
    this._rebuildDerived();
    this._prepared = true;
    return this;
  }

  async _loadRecords() {
    let raw = "";
    try {
      raw = await fs.promises.readFile(this.recordsPath, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // A half-written last line (interrupted run) must not lose the file.
        continue;
      }
      const normalized = this._normalizeRecord(parsed);
      if (normalized) {
        this._records.set(normalized.id, normalized);
      }
    }
  }

  async _loadSourceIndex() {
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.promises.readFile(this.indexPath, "utf8"));
    } catch {
      return;
    }
    if (parsed?.schemaVersion !== LOCAL_MEMORY_SCHEMA_VERSION) {
      // A schema change invalidates only the cache; the records survive and the
      // next refresh re-derives every source.
      return;
    }
    for (const [key, value] of Object.entries(parsed?.sources ?? {})) {
      if (!value || typeof value !== "object") {
        continue;
      }
      this._sources.set(key, {
        size: Number(value.size) || 0,
        mtimeMs: Number(value.mtimeMs) || 0,
        recordIds: Array.isArray(value.recordIds)
          ? value.recordIds.filter((id) => typeof id === "string")
          : [],
      });
    }
  }

  /**
   * One shape for every entry point. A harvester supplies raw `text`, a caller
   * of `remember()` may supply either, and a record read back from disk already
   * carries `references` — all three land on the same bounded, complete
   * sentences Cheetah would have stored, so a locally-served candidate and a
   * graph-served one read identically to the model.
   */
  _normalizeRecord(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const title = normalizeText(raw.title, 200);
    const source = normalizeText(raw.source, 200) || "miniphi";
    const existing = normalizeReferenceSentences(raw.references, {
      label: title || "memory",
      source,
    });
    const references = (
      existing.length
        ? existing
        : buildCompleteReferenceSentences({
            text: normalizeText(raw.text),
            label: title || "memory",
            source,
            maxReferences: this.maxReferencesPerRecord,
            // Everything this store holds is authored prose — notes, decisions,
            // recaps — and markdown notes are hard-wrapped. Without unwrapping,
            // every sentence that spans a wrap is stored as two half-sentences.
            unwrapProse: true,
          })
    ).slice(0, this.maxReferencesPerRecord);
    if (!references.length) {
      return null;
    }
    const id =
      typeof raw.id === "string" && /^lm_[a-f0-9]{20}$/.test(raw.id)
        ? raw.id
        : recordId([title, references.map((reference) => reference.text).join("")]);
    return {
      id,
      schemaVersion: LOCAL_MEMORY_SCHEMA_VERSION,
      kind: normalizeKind(raw.kind),
      title: title || "memory",
      tags: normalizeTags(raw.tags),
      references,
      source: normalizeText(raw.source, 200) || "miniphi",
      sessionId: normalizeText(raw.sessionId, 120) || null,
      projectId: normalizeText(raw.projectId, 120) || null,
      importance: clamp01(raw.importance, 0.6),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
    };
  }

  _rebuildDerived() {
    this._terms.clear();
    this._documentFrequency.clear();
    for (const record of this._records.values()) {
      const terms = recordTerms(record);
      this._terms.set(record.id, terms);
      for (const term of new Set(terms)) {
        this._documentFrequency.set(term, (this._documentFrequency.get(term) ?? 0) + 1);
      }
    }
    this._stats.records = this._records.size;
  }

  /** Adds (or refreshes) one memory that outlives this session. */
  async remember(entry = undefined) {
    await this.prepare();
    const record = this._normalizeRecord({
      ...entry,
      sessionId: entry?.sessionId ?? this.sessionId,
      projectId: entry?.projectId ?? this.projectId,
      createdAt: entry?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    });
    if (!record) {
      return null;
    }
    const existing = this._records.get(record.id);
    if (existing) {
      // Same content, seen again: keep the first sighting's provenance and only
      // refresh recency/importance so a repeated fact does not multiply.
      existing.updatedAt = record.updatedAt;
      existing.importance = Math.max(existing.importance, record.importance);
      existing.tags = normalizeTags([...existing.tags, ...record.tags]);
      this._dirty = true;
      this._rebuildDerived();
      await this.flush();
      return existing;
    }
    this._records.set(record.id, record);
    this._stats.remembered += 1;
    this._dirty = true;
    this._rebuildDerived();
    await this.flush();
    return record;
  }

  async rememberMany(entries) {
    const out = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const record = await this.remember(entry);
      if (record) {
        out.push(record);
      }
    }
    return out;
  }

  async forget(id) {
    await this.prepare();
    if (!this._records.delete(id)) {
      return false;
    }
    this._dirty = true;
    this._rebuildDerived();
    await this.flush();
    return true;
  }

  /**
   * Scans `.miniphi/` for artifacts written since the last refresh and turns the
   * durable parts into records. Cheap by construction: a source whose size and
   * mtime are unchanged is skipped without being read.
   */
  async refresh({ force = false } = {}) {
    await this.prepare();
    const started = Date.now();
    let harvested = 0;
    const seenSources = new Set();
    for (const source of await this._collectSources()) {
      seenSources.add(source.key);
      const cached = this._sources.get(source.key);
      if (
        !force &&
        cached &&
        cached.size === source.size &&
        cached.mtimeMs === source.mtimeMs
      ) {
        continue;
      }
      let entries = [];
      try {
        entries = await source.read();
      } catch (error) {
        this._stats.lastError = error instanceof Error ? error.message : String(error);
        this._log(`failed to harvest ${source.key}: ${this._stats.lastError}`);
        continue;
      }
      // A re-read replaces whatever this source contributed last time, so an
      // edited note does not leave its previous wording behind as a ghost.
      // Records written through `remember()` are never listed in a source's
      // `recordIds`, so this cannot reach them.
      for (const staleId of cached?.recordIds ?? []) {
        this._records.delete(staleId);
      }
      const recordIds = [];
      for (const entry of entries) {
        const record = this._normalizeRecord({
          ...entry,
          projectId: entry.projectId ?? this.projectId,
          createdAt: entry.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        });
        if (!record) {
          continue;
        }
        this._records.set(record.id, record);
        recordIds.push(record.id);
        harvested += 1;
      }
      this._sources.set(source.key, {
        size: source.size,
        mtimeMs: source.mtimeMs,
        recordIds,
      });
      this._dirty = true;
    }
    // A source that disappeared takes its records with it.
    for (const [key, cached] of [...this._sources.entries()]) {
      if (seenSources.has(key)) {
        continue;
      }
      for (const staleId of cached.recordIds ?? []) {
        this._records.delete(staleId);
      }
      this._sources.delete(key);
      this._dirty = true;
    }
    if (this._dirty) {
      this._trim();
      this._rebuildDerived();
      await this.flush();
    }
    this._stats.harvested += harvested;
    return {
      ok: true,
      harvested,
      records: this._records.size,
      sources: this._sources.size,
      elapsedMs: Date.now() - started,
    };
  }

  /** Oldest, least important records go first when the corpus outgrows the cap. */
  _trim() {
    if (this._records.size <= this.maxRecords) {
      return;
    }
    const ordered = [...this._records.values()].sort(
      (left, right) =>
        right.importance - left.importance ||
        String(right.updatedAt).localeCompare(String(left.updatedAt)),
    );
    this._records = new Map(
      ordered.slice(0, this.maxRecords).map((record) => [record.id, record]),
    );
  }

  async flush() {
    if (!this._dirty) {
      return false;
    }
    await fs.promises.mkdir(this.memoryDir, { recursive: true });
    const lines = [...this._records.values()]
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map((record) => JSON.stringify(record));
    const tempPath = `${this.recordsPath}.tmp`;
    await fs.promises.writeFile(tempPath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
    await fs.promises.rename(tempPath, this.recordsPath);
    await fs.promises.writeFile(
      this.indexPath,
      JSON.stringify(
        {
          schemaVersion: LOCAL_MEMORY_SCHEMA_VERSION,
          updatedAt: nowIso(),
          records: this._records.size,
          sources: Object.fromEntries(this._sources),
        },
        null,
        2,
      ),
      "utf8",
    );
    this._dirty = false;
    return true;
  }

  /**
   * Ranks stored references against a free-text seed. Returns Cheetah-shaped
   * reference candidates so the caller can merge them into one selection pool.
   */
  recall({ text = "", tags = [], limit = undefined, excludeSessionId = null } = {}) {
    const started = Date.now();
    const max = toPositiveInteger(limit, this.maxCandidates);
    const seedText = normalizeText(text, 6000);
    // `questionCues` adds the capitalized runs (library names, file paths,
    // product names) that `contentWords` alone lowercases into the same bag as
    // ordinary prose — they are the highest-signal part of an agent seed.
    const cues = questionCues(seedText);
    const queryTerms = new Set(
      stemAll([
        ...contentWords(seedText),
        ...(cues?.phrases ?? []).flatMap((phrase) => contentWords(phrase)),
      ]),
    );
    const wantedTags = new Set(normalizeTags(tags));
    if (!queryTerms.size && !wantedTags.size) {
      return {
        ok: true,
        engine: "local",
        referenceCandidates: [],
        matched: 0,
        scanned: this._records.size,
        elapsedMs: Date.now() - started,
      };
    }
    const totalDocs = Math.max(1, this._records.size);
    const scored = [];
    for (const record of this._records.values()) {
      if (excludeSessionId && record.sessionId === excludeSessionId) {
        // The live session's own graph is already in the prompt; re-serving it
        // from disk would just spend budget on a duplicate.
        continue;
      }
      const terms = this._terms.get(record.id) ?? [];
      if (!terms.length) {
        continue;
      }
      const unique = new Set(terms);
      let overlap = 0;
      for (const term of unique) {
        if (!queryTerms.has(term)) {
          continue;
        }
        const df = this._documentFrequency.get(term) ?? 1;
        overlap += Math.log(1 + totalDocs / df);
      }
      if (!overlap && !wantedTags.size) {
        continue;
      }
      const tagHits = record.tags.filter((tag) => wantedTags.has(tag)).length;
      // Normalizing by the query size keeps a long record from outranking a
      // precise one purely because it mentions more words.
      const normalized = overlap / Math.max(1, Math.log(1 + queryTerms.size) * 2);
      const score = normalized + tagHits * 0.4 + record.importance * 0.15;
      if (score < this.minScore) {
        continue;
      }
      scored.push({ record, score });
    }
    scored.sort(
      (left, right) =>
        right.score - left.score ||
        String(right.record.updatedAt).localeCompare(String(left.record.updatedAt)) ||
        left.record.id.localeCompare(right.record.id),
    );

    const referenceCandidates = [];
    const seenText = new Set();
    for (const { record, score } of scored) {
      // A record matches as a whole, but only some of its sentences answer the
      // seed. Emitting them in storage order means a four-sentence recap can
      // spend the whole candidate budget on its title line and never surface
      // the file list that actually matched.
      const ranked = [...record.references]
        .map((reference) => ({
          reference,
          hits: new Set(stemAll(contentWords(reference.text))).size
            ? [...new Set(stemAll(contentWords(reference.text)))].filter((term) =>
                queryTerms.has(term),
              ).length
            : 0,
        }))
        .sort(
          (left, right) =>
            right.hits - left.hits ||
            (left.reference.ordinal ?? 0) - (right.reference.ordinal ?? 0),
        );
      for (const { reference } of ranked) {
        if (referenceCandidates.length >= max) {
          break;
        }
        const text = reference.text.trim();
        if (!text || seenText.has(text)) {
          continue;
        }
        seenText.add(text);
        referenceCandidates.push({
          // `local:` is what keeps this out of the graph-node boost path: it
          // names a stored sentence, never a live ContextGraph node.
          id: `local:${record.id}:${reference.id}`,
          referenceId: reference.id,
          text,
          sourceNodeId: null,
          origin: "local",
          recordId: record.id,
          kind: record.kind,
          source: reference.source || record.source,
          ordinal: reference.ordinal ?? 0,
          score,
          novelty: 0,
          distance: 0,
          sourceCount: 1,
        });
      }
      if (referenceCandidates.length >= max) {
        break;
      }
    }
    this._stats.queries += 1;
    this._stats.candidates += referenceCandidates.length;
    return {
      ok: true,
      engine: "local",
      referenceCandidates,
      matched: scored.length,
      scanned: this._records.size,
      elapsedMs: Date.now() - started,
    };
  }

  stats() {
    return {
      ...this._stats,
      records: this._records.size,
      sources: this._sources.size,
      memoryDir: this.memoryDir,
      projectId: this.projectId,
    };
  }

  // ---------------------------------------------------------------------------
  // Harvesters. Each one turns an artifact MiniPhi already writes into records,
  // so nothing has to be persisted twice to become recallable.
  // ---------------------------------------------------------------------------

  async _collectSources() {
    const sources = [];
    const push = async (absolutePath, read) => {
      let stat = null;
      try {
        stat = await fs.promises.stat(absolutePath);
      } catch {
        return;
      }
      if (!stat.isFile()) {
        return;
      }
      sources.push({
        key: path.relative(this.baseDir, absolutePath).split(path.sep).join("/"),
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        read: () => read(absolutePath),
      });
    };

    for (const noteFile of await this._listDir(this.notesDir)) {
      if (!/\.(md|markdown|txt)$/i.test(noteFile)) {
        continue;
      }
      await push(path.join(this.notesDir, noteFile), (target) => this._readNote(target));
    }

    const sessionsDir = path.join(this.baseDir, "agent-sessions");
    const sessionDirs = (await this._listDir(sessionsDir)).sort().slice(-this.harvestSessions);
    for (const sessionDir of sessionDirs) {
      await push(path.join(sessionsDir, sessionDir, "context-graph.json"), (target) =>
        this._readContextGraph(target, sessionDir),
      );
      await push(path.join(sessionsDir, sessionDir, "result.json"), (target) =>
        this._readResult(target, sessionDir),
      );
    }
    return sources;
  }

  async _listDir(dir) {
    try {
      return await fs.promises.readdir(dir);
    } catch {
      return [];
    }
  }

  /**
   * Operator- or agent-authored markdown. An optional `---`-fenced front matter
   * block supplies title/tags/kind; without it the first heading is the title.
   */
  async _readNote(absolutePath) {
    const raw = await fs.promises.readFile(absolutePath, "utf8");
    const relative = path.relative(this.baseDir, absolutePath).split(path.sep).join("/");
    let body = raw;
    let meta = {};
    const frontMatter = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    if (frontMatter) {
      body = raw.slice(frontMatter[0].length);
      for (const line of frontMatter[1].split("\n")) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (!match) {
          continue;
        }
        meta[match[1].trim().toLowerCase()] = match[2].trim();
      }
    }
    const headingTitle = body.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
    const title =
      meta.title ||
      headingTitle ||
      path.basename(absolutePath).replace(/\.(md|markdown|txt)$/i, "");
    const tags = normalizeTags(
      String(meta.tags ?? "")
        .split(/[,\s]+/)
        .filter(Boolean),
    );
    // One record per `##` section keeps a long note from collapsing into a
    // single blob whose sentences all score identically.
    const sections = [];
    let current = { heading: title, lines: [] };
    for (const line of body.split("\n")) {
      const heading = line.match(/^\s*#{2,3}\s+(.+)$/);
      if (heading) {
        if (current.lines.join("\n").trim()) {
          sections.push(current);
        }
        current = { heading: heading[1].trim(), lines: [] };
        continue;
      }
      current.lines.push(line);
    }
    if (current.lines.join("\n").trim()) {
      sections.push(current);
    }
    return sections.map((section) => ({
      kind: normalizeKind(meta.kind ?? "note"),
      title: section.heading === title ? title : `${title} — ${section.heading}`,
      text: section.lines.join("\n"),
      tags,
      source: relative,
      importance: clamp01(meta.importance, 0.75),
    }));
  }

  /**
   * A previous session's layered graph. Only the layers that carry conclusions
   * are harvested — `evidence`/`scratch` are this-run working state and would
   * flood the corpus with tool output that is already on disk.
   */
  async _readContextGraph(absolutePath, sessionDir) {
    const parsed = JSON.parse(await fs.promises.readFile(absolutePath, "utf8"));
    const relative = path.relative(this.baseDir, absolutePath).split(path.sep).join("/");
    const nodes = Array.isArray(parsed?.nodes)
      ? parsed.nodes
      : Array.isArray(parsed?.graph?.nodes)
        ? parsed.graph.nodes
        : [];
    const keepLayers = new Set(["plan", "contract"]);
    const keepKinds = new Set(["model-note", "decision", "outcome", "subtask-outcome"]);
    // Two node kinds look durable and are not:
    //
    // `mission` is the operator's task, which the *current* run already holds
    //   verbatim in its own mission node. Re-serving a previous run's copy is a
    //   long, highly topical duplicate that outranks the actual conclusions —
    //   measured on this corpus, it won "how did the previous session end?".
    // `validation` is a snapshot of one turn's issue set. It is stale the moment
    //   the next edit lands ("nothing exists there yet" survived into a run
    //   where the app was half-built), and the session recap already records the
    //   outcome that mattered.
    const dropKinds = new Set(["mission", "validation"]);
    const out = [];
    for (const node of nodes) {
      if (!node || node.state === "dropped" || dropKinds.has(node.kind)) {
        continue;
      }
      if (!keepLayers.has(node.layer) && !keepKinds.has(node.kind)) {
        continue;
      }
      const text = normalizeText(node.text ?? node.digest);
      if (!text || text.length < 24) {
        continue;
      }
      out.push({
        kind: node.layer === "plan" ? "decision" : "note",
        title: `${sessionDir}: ${normalizeText(node.label, 120) || node.layer}`,
        text,
        tags: ["session", node.layer].filter(Boolean),
        source: relative,
        sessionId: sessionDir,
        importance: clamp01(node.importance, 0.6),
      });
      if (out.length >= 60) {
        break;
      }
    }
    return out;
  }

  /** The session's own verdict: what it did, how it stopped, what it changed. */
  async _readResult(absolutePath, sessionDir) {
    const parsed = JSON.parse(await fs.promises.readFile(absolutePath, "utf8"));
    const relative = path.relative(this.baseDir, absolutePath).split(path.sep).join("/");
    const task = normalizeText(parsed?.task, 600);
    const summary = normalizeText(parsed?.summary ?? parsed?.analysis, 1200);
    const stopReason = normalizeText(parsed?.stopReason ?? parsed?.stop_reason, 120);
    const files = (Array.isArray(parsed?.appliedEdits) ? parsed.appliedEdits : [])
      .map((edit) => normalizeText(edit?.path ?? edit?.file, 200))
      .filter(Boolean);
    const lines = [
      task ? `Session ${sessionDir} worked on this task: ${task}` : "",
      summary ? `Its final summary was: ${summary}` : "",
      stopReason ? `It stopped with reason ${stopReason}.` : "",
      files.length
        ? `It changed these files: ${[...new Set(files)].slice(0, 20).join(", ")}.`
        : "",
    ].filter(Boolean);
    if (!lines.length) {
      return [];
    }
    return [
      {
        kind: "recap",
        title: `${sessionDir}: session recap`,
        text: lines.join("\n"),
        tags: ["recap", "session"],
        source: relative,
        sessionId: sessionDir,
        importance: 0.8,
      },
    ];
  }
}

/**
 * Resolves the opt-in configuration. Local memory is *on* by default: it costs
 * one directory scan and no network, and a project with an empty
 * `.miniphi/memory/` simply recalls nothing.
 */
export function resolveLocalMemoryConfig(configData = undefined, env = process.env) {
  const context =
    configData?.context && typeof configData.context === "object" ? configData.context : {};
  const local =
    context.localMemory && typeof context.localMemory === "object" ? context.localMemory : {};
  const rawEnabled = env.MINIPHI_LOCAL_MEMORY ?? local.enabled;
  const enabled =
    rawEnabled === undefined || rawEnabled === null
      ? true
      : !["0", "false", "no", "off", "disabled"].includes(String(rawEnabled).trim().toLowerCase());
  return {
    enabled,
    maxCandidates: toPositiveInteger(
      env.MINIPHI_LOCAL_MEMORY_CANDIDATES ?? local.maxCandidates,
      DEFAULT_MAX_CANDIDATES,
    ),
    maxRecords: toPositiveInteger(local.maxRecords, DEFAULT_MAX_RECORDS),
    harvestSessions: toPositiveInteger(local.harvestSessions, DEFAULT_HARVEST_SESSIONS),
    minScore: Number.isFinite(local.minScore) ? Number(local.minScore) : DEFAULT_MIN_SCORE,
  };
}

/**
 * Builds a prepared, refreshed store. Returns null when disabled so callers can
 * treat "no local memory" the same way they treat "no Cheetah".
 */
export async function createLocalContextMemory({
  baseDir,
  configData = undefined,
  env = process.env,
  sessionId = null,
  projectId = null,
  logger = null,
} = {}) {
  const config = resolveLocalMemoryConfig(configData, env);
  if (!config.enabled || !baseDir) {
    return null;
  }
  const memory = new LocalContextMemory({
    baseDir,
    sessionId,
    projectId,
    logger,
    maxCandidates: config.maxCandidates,
    maxRecords: config.maxRecords,
    harvestSessions: config.harvestSessions,
    minScore: config.minScore,
  });
  await memory.prepare();
  await memory.refresh();
  return memory;
}
