function describeTruncationChunk(chunk) {
  if (!chunk) {
    return "chunk";
  }
  const parts = [chunk.goal ?? chunk.label ?? chunk.id ?? "chunk"];
  if (chunk.startLine || chunk.endLine) {
    const start = chunk.startLine ?? "?";
    const end = chunk.endLine ?? "end";
    parts.push(`lines ${start}-${end}`);
  }
  if (chunk.context) {
    parts.push(chunk.context);
  }
  return parts.join(" | ");
}

function sortTruncationChunks(planRecord) {
  const chunks = planRecord?.plan?.chunkingPlan;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }
  return [...chunks].sort((a, b) => {
    const pa = Number.isFinite(a.priority) ? a.priority : Number.isFinite(a.index) ? a.index + 1 : Infinity;
    const pb = Number.isFinite(b.priority) ? b.priority : Number.isFinite(b.index) ? b.index + 1 : Infinity;
    if (pa === pb) {
      return (a.index ?? 0) - (b.index ?? 0);
    }
    return pa - pb;
  });
}

function selectTruncationChunk(planRecord, selector = null) {
  const chunks = planRecord?.plan?.chunkingPlan;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return null;
  }
  const sorted = sortTruncationChunks(planRecord);
  const defaultChunk = sorted[0];
  if (!selector) {
    return defaultChunk;
  }
  const normalized = selector.toString().trim();
  if (!normalized) {
    return defaultChunk;
  }
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) {
    const priorityMatch = chunks.find(
      (chunk) => Number.isFinite(chunk.priority) && chunk.priority === numeric,
    );
    if (priorityMatch) {
      return priorityMatch;
    }
    const indexMatch = sorted[numeric - 1];
    if (indexMatch) {
      return indexMatch;
    }
  }
  const lowered = normalized.toLowerCase();
  const textMatch = chunks.find((chunk) => {
    const goal = (chunk.goal ?? chunk.label ?? "").toLowerCase();
    return goal.includes(lowered);
  });
  return textMatch ?? defaultChunk;
}

function buildLineRangeFromChunk(chunk) {
  if (!chunk) {
    return null;
  }
  const startLine = Number.isFinite(chunk.startLine) ? chunk.startLine : null;
  const endLine = Number.isFinite(chunk.endLine) ? chunk.endLine : null;
  if (startLine || endLine) {
    return { startLine, endLine };
  }
  return null;
}

function buildTruncationChunkKey(chunk) {
  if (!chunk) {
    return null;
  }
  if (chunk.id && typeof chunk.id === "string") {
    return chunk.id;
  }
  const goal = chunk.goal ?? chunk.label ?? null;
  const range =
    Number.isFinite(chunk.startLine) || Number.isFinite(chunk.endLine)
      ? `${Number.isFinite(chunk.startLine) ? chunk.startLine : "?"}-${Number.isFinite(chunk.endLine) ? chunk.endLine : "?"}`
      : null;
  const normalizedGoal = goal ? goal.toString().trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") : null;
  return [normalizedGoal ?? "chunk", range].filter(Boolean).join("@");
}

function ensureTruncationProgressEntry(progress, chunkKey, chunk) {
  if (!progress || !chunkKey) {
    return null;
  }
  if (!progress.chunks || typeof progress.chunks !== "object") {
    progress.chunks = {};
  }
  if (!progress.chunks[chunkKey]) {
    progress.chunks[chunkKey] = {
      key: chunkKey,
      label: chunk?.goal ?? chunk?.label ?? chunk?.id ?? chunkKey,
      range:
        Number.isFinite(chunk?.startLine) || Number.isFinite(chunk?.endLine)
          ? {
              startLine: Number.isFinite(chunk?.startLine) ? chunk.startLine : null,
              endLine: Number.isFinite(chunk?.endLine) ? chunk.endLine : null,
            }
          : null,
      helpers: [],
      completedAt: null,
      lastHelperAt: null,
      lastRunAt: null,
    };
  }
  return progress.chunks[chunkKey];
}

function isTruncationChunkCompleted(progress, chunkKey) {
  if (!progress || !chunkKey || !progress.chunks) {
    return false;
  }
  return Boolean(progress.chunks[chunkKey]?.completedAt);
}

function findNextIncompleteChunk(planRecord, progress, skipKey = null) {
  const ordered = sortTruncationChunks(planRecord);
  for (const chunk of ordered) {
    const key = buildTruncationChunkKey(chunk);
    if (skipKey && key === skipKey) {
      continue;
    }
    if (!key || !isTruncationChunkCompleted(progress, key)) {
      return chunk;
    }
  }
  return null;
}

function computeTruncationProgress(planRecord, progress) {
  const ordered = sortTruncationChunks(planRecord);
  if (!ordered.length) {
    return { total: 0, completed: 0 };
  }
  let completed = 0;
  for (const chunk of ordered) {
    const key = buildTruncationChunkKey(chunk);
    if (key && isTruncationChunkCompleted(progress, key)) {
      completed += 1;
    }
  }
  return { total: ordered.length, completed };
}

async function persistTruncationProgressSafe(memory, executionId, progress) {
  if (!memory || !executionId || !progress) {
    return;
  }
  progress.executionId = executionId;
  try {
    await memory.saveTruncationProgress(executionId, progress);
  } catch (error) {
    console.warn(
      `[MiniPhi] Unable to save truncation progress for ${executionId}: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

export {
  buildLineRangeFromChunk,
  buildTruncationChunkKey,
  computeTruncationProgress,
  describeTruncationChunk,
  ensureTruncationProgressEntry,
  findNextIncompleteChunk,
  isTruncationChunkCompleted,
  persistTruncationProgressSafe,
  selectTruncationChunk,
  sortTruncationChunks,
};
