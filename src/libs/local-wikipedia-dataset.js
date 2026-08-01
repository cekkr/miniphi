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

export { DEFAULT_MAX_ARTICLE_BYTES };
