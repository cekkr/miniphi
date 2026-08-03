import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

/**
 * Return the real Wikipedia JSON shards in a stable order. Finder/Archive
 * AppleDouble files (`._*.json`) are metadata, not dataset shards, and are
 * deliberately excluded.
 */
export async function listWikipediaJsonFiles(datasetPath) {
  const resolvedPath = path.resolve(String(datasetPath ?? ""));
  const entries = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".json") &&
        !entry.name.startsWith("._"),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!files.length) {
    throw new Error(`No Wikipedia JSON shards found under ${resolvedPath}.`);
  }
  return { datasetPath: resolvedPath, files };
}

/**
 * Stream one top-level JSON array without loading the shard into memory.
 * Structural JSON bytes are ASCII, so scanning the raw Buffer is safe even
 * when a UTF-8 code point straddles two chunks. The yielded nextByteOffset is
 * immediately after the closing `}` and is therefore a safe resume point.
 */
export async function* streamWikipediaShard(
  filePath,
  {
    startByteOffset = 0,
    startArticleOrdinal = 0,
    maxArticleBytes = DEFAULT_MAX_ARTICLE_BYTES,
    highWaterMark = DEFAULT_HIGH_WATER_MARK,
  } = {},
) {
  const resolvedPath = path.resolve(filePath);
  const safeStart = Math.max(0, Math.floor(Number(startByteOffset) || 0));
  const safeMaxBytes = positiveInteger(maxArticleBytes, DEFAULT_MAX_ARTICLE_BYTES);
  const stream = fs.createReadStream(resolvedPath, {
    start: safeStart,
    highWaterMark: positiveInteger(highWaterMark, DEFAULT_HIGH_WATER_MARK),
  });

  let absoluteChunkStart = safeStart;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStartOffset = null;
  let objectByteLength = 0;
  let objectParts = [];
  let discarded = false;
  let articleOrdinal = Math.max(0, Math.floor(Number(startArticleOrdinal) || 0));

  try {
    for await (const chunk of stream) {
      let segmentStart = depth > 0 && !discarded ? 0 : -1;

      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index];
        if (depth === 0) {
          if (byte !== 0x7b) {
            continue;
          }
          depth = 1;
          inString = false;
          escaped = false;
          objectStartOffset = absoluteChunkStart + index;
          objectByteLength = 1;
          objectParts = [];
          discarded = false;
          segmentStart = index;
          continue;
        }

        objectByteLength += 1;
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (byte === 0x5c) {
            escaped = true;
          } else if (byte === 0x22) {
            inString = false;
          }
        } else if (byte === 0x22) {
          inString = true;
        } else if (byte === 0x7b) {
          depth += 1;
        } else if (byte === 0x7d) {
          depth -= 1;
        }

        if (!discarded && objectByteLength > safeMaxBytes) {
          discarded = true;
          objectParts = [];
          segmentStart = -1;
        }

        if (depth !== 0) {
          continue;
        }

        const nextByteOffset = absoluteChunkStart + index + 1;
        const currentOrdinal = articleOrdinal;
        articleOrdinal += 1;
        let article = null;
        let error = null;

        if (discarded) {
          error = `article-too-large:${objectByteLength}`;
        } else {
          objectParts.push(chunk.subarray(segmentStart, index + 1));
          try {
            article = JSON.parse(Buffer.concat(objectParts).toString("utf8"));
          } catch (parseError) {
            error = `invalid-json:${parseError instanceof Error ? parseError.message : String(parseError)}`;
          }
        }

        yield {
          article,
          error,
          articleOrdinal: currentOrdinal,
          byteOffset: objectStartOffset,
          nextByteOffset,
          byteLength: objectByteLength,
        };

        inString = false;
        escaped = false;
        objectStartOffset = null;
        objectByteLength = 0;
        objectParts = [];
        discarded = false;
        segmentStart = -1;
      }

      if (depth > 0 && !discarded && segmentStart >= 0) {
        objectParts.push(chunk.subarray(segmentStart));
      }
      absoluteChunkStart += chunk.length;
    }

    if (depth > 0) {
      yield {
        article: null,
        error: "truncated-json-object",
        articleOrdinal,
        byteOffset: objectStartOffset,
        nextByteOffset: absoluteChunkStart,
        byteLength: objectByteLength,
      };
    }
  } finally {
    stream.destroy();
  }
}

/**
 * Stream all shards, optionally resuming from a checkpoint position.
 */
export async function* streamWikipediaArticles(
  datasetPath,
  {
    position = null,
    maxArticleBytes = DEFAULT_MAX_ARTICLE_BYTES,
    highWaterMark = DEFAULT_HIGH_WATER_MARK,
  } = {},
) {
  const inventory = await listWikipediaJsonFiles(datasetPath);
  let startFileIndex = 0;
  if (position?.fileName) {
    startFileIndex = inventory.files.indexOf(position.fileName);
    if (startFileIndex < 0) {
      throw new Error(
        `Checkpoint shard ${position.fileName} is not present under ${inventory.datasetPath}.`,
      );
    }
  }

  for (let fileIndex = startFileIndex; fileIndex < inventory.files.length; fileIndex += 1) {
    const fileName = inventory.files[fileIndex];
    const isResumeFile = fileIndex === startFileIndex && position?.fileName === fileName;
    const startByteOffset = isResumeFile ? position?.nextByteOffset ?? 0 : 0;
    const startArticleOrdinal = isResumeFile ? position?.nextArticleOrdinal ?? 0 : 0;
    const filePath = path.join(inventory.datasetPath, fileName);
    for await (const item of streamWikipediaShard(filePath, {
      startByteOffset,
      startArticleOrdinal,
      maxArticleBytes,
      highWaterMark,
    })) {
      yield {
        ...item,
        datasetPath: inventory.datasetPath,
        fileName,
        filePath,
        fileIndex,
        fileCount: inventory.files.length,
      };
    }
  }
}

/**
 * Byte offset of the first record boundary at or after `fromOffset`.
 *
 * A raw newline can never occur inside a JSON string (it has to be escaped),
 * so the first `\n` at or after a random seek is guaranteed to sit outside any
 * string value. Resuming the shard scanner there is therefore safe: its
 * depth-0 search for `{` cannot mistake a brace inside an article's text for a
 * record start.
 */
export async function findRecordBoundary(filePath, fromOffset, { window = 1024 * 1024 } = {}) {
  const handle = await fsPromises.open(path.resolve(filePath), "r");
  try {
    const { size } = await handle.stat();
    let position = Math.max(0, Math.min(Math.floor(Number(fromOffset) || 0), Math.max(0, size - 1)));
    const buffer = Buffer.alloc(positiveInteger(window, 1024 * 1024));
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) {
        return null;
      }
      const index = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (index >= 0) {
        return position + index + 1;
      }
      position += bytesRead;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Draw articles from random positions across the whole dump instead of walking
 * it front to back.
 *
 * Sequential ingestion makes an unrepresentative knowledge base: consecutive
 * records in one shard share subject matter and provenance, so retrieval gets
 * tested against a topically clustered store. Seeking to random offsets in
 * randomly chosen shards spreads the sample over the corpus, which is what a
 * memory benchmark needs in order to mean anything.
 */
export async function sampleRandomWikipediaArticles(
  datasetPath,
  {
    count = 100,
    rng = Math.random,
    maxArticleBytes = DEFAULT_MAX_ARTICLE_BYTES,
    minTextChars = 200,
    maxAttemptsPerArticle = 6,
  } = {},
) {
  const inventory = await listWikipediaJsonFiles(datasetPath);
  const sizes = new Map();
  for (const fileName of inventory.files) {
    try {
      const stat = await fsPromises.stat(path.join(inventory.datasetPath, fileName));
      sizes.set(fileName, stat.size);
    } catch {
      // A shard that cannot be stat'ed is simply not drawn from.
    }
  }
  const usable = inventory.files.filter((fileName) => (sizes.get(fileName) ?? 0) > 4096);
  if (!usable.length) {
    throw new Error(`No readable Wikipedia shards under ${inventory.datasetPath}.`);
  }

  const seenIds = new Set();
  const sampled = [];
  let attempts = 0;
  const attemptCap = Math.max(1, count) * Math.max(1, maxAttemptsPerArticle);
  while (sampled.length < count && attempts < attemptCap) {
    attempts += 1;
    const fileName = usable[Math.floor(rng() * usable.length) % usable.length];
    const size = sizes.get(fileName) ?? 0;
    const filePath = path.join(inventory.datasetPath, fileName);
    const seekTo = Math.floor(rng() * Math.max(1, size - 2048));
    const boundary = await findRecordBoundary(filePath, seekTo);
    if (boundary === null) {
      continue;
    }
    let picked = null;
    for await (const item of streamWikipediaShard(filePath, {
      startByteOffset: boundary,
      maxArticleBytes,
    })) {
      if (item.error || !item.article) {
        continue;
      }
      const title = typeof item.article.title === "string" ? item.article.title.trim() : "";
      const text = typeof item.article.text === "string" ? item.article.text.trim() : "";
      if (!title || text.length < minTextChars) {
        continue;
      }
      const key = `${fileName}#${item.article.id ?? item.byteOffset}`;
      if (seenIds.has(key)) {
        break;
      }
      seenIds.add(key);
      picked = {
        ...item,
        datasetPath: inventory.datasetPath,
        fileName,
        filePath,
        seekOffset: seekTo,
      };
      break;
    }
    if (picked) {
      sampled.push(picked);
    }
  }
  return { datasetPath: inventory.datasetPath, articles: sampled, attempts };
}

export { DEFAULT_MAX_ARTICLE_BYTES };
