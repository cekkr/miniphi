import fs from "fs";
import path from "path";

const DEFAULT_LIMITS = {
  executions: 200,
  promptExchanges: 200,
  promptJournals: 200,
  promptSessions: 200,
  promptDecompositions: 200,
  promptTemplates: 200,
  historyNotes: 200,
  research: 200,
};

function normalizeLimit(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (value === false) {
    return null;
  }
  const text = value.toString().trim().toLowerCase();
  if (text === "auto") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolvePath(baseDir, candidate) {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.join(baseDir, trimmed);
}

function isSafeTarget(baseDir, target) {
  if (!target) {
    return false;
  }
  const relative = path.relative(baseDir, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeTarget(target, { baseDir, dryRun }) {
  if (!target || !isSafeTarget(baseDir, target)) {
    return false;
  }
  if (dryRun) {
    return true;
  }
  await fs.promises.rm(target, { recursive: true, force: true });
  return true;
}

async function pruneIndexEntries(memory, config) {
  const { indexFile, label, keep, resolveTargets, updateIndex, dryRun } = config;
  const baseDir = memory.baseDir;
  const index = await memory._readJSON(indexFile, null);
  if (!index || !Array.isArray(index.entries)) {
    return {
      label,
      keep,
      totalEntries: 0,
      keptEntries: 0,
      removedEntries: 0,
      removedTargets: 0,
      skippedTargets: 0,
      errors: 0,
      skipped: true,
      reason: "index missing or invalid",
    };
  }
  const entries = index.entries;
  const totalEntries = entries.length;
  if (keep === null) {
    return {
      label,
      keep,
      totalEntries,
      keptEntries: totalEntries,
      removedEntries: 0,
      removedTargets: 0,
      skippedTargets: 0,
      errors: 0,
      skipped: true,
      reason: "retention disabled",
    };
  }
  if (keep >= totalEntries) {
    return {
      label,
      keep,
      totalEntries,
      keptEntries: totalEntries,
      removedEntries: 0,
      removedTargets: 0,
      skippedTargets: 0,
      errors: 0,
      skipped: false,
    };
  }
  const keptEntries = entries.slice(0, keep);
  const removedEntries = entries.slice(keep);
  const targets = [];
  for (const entry of removedEntries) {
    const resolved = resolveTargets(entry);
    if (Array.isArray(resolved)) {
      for (const candidate of resolved) {
        const absolute = resolvePath(baseDir, candidate);
        if (absolute) {
          targets.push(absolute);
        }
      }
    }
  }
  const uniqueTargets = Array.from(new Set(targets));
  let removedTargets = 0;
  let skippedTargets = 0;
  let errors = 0;
  for (const target of uniqueTargets) {
    try {
      const removed = await removeTarget(target, { baseDir, dryRun });
      if (removed) {
        removedTargets += 1;
      } else {
        skippedTargets += 1;
      }
    } catch {
      errors += 1;
    }
  }
  if (!dryRun) {
    index.entries = keptEntries;
    if (typeof updateIndex === "function") {
      updateIndex(index, keptEntries);
    }
    index.updatedAt = new Date().toISOString();
    await memory._writeJSON(indexFile, index);
  }
  return {
    label,
    keep,
    totalEntries,
    keptEntries: keptEntries.length,
    removedEntries: removedEntries.length,
    removedTargets,
    skippedTargets,
    errors,
    skipped: false,
  };
}

export async function pruneMiniPhiCache(memory, options = {}) {
  if (!memory) {
    throw new Error("Cache prune requires a MiniPhiMemory instance.");
  }
  await memory.prepare();
  const retention = options.retention ?? {};
  const dryRun = Boolean(options.dryRun);
  const limits = {
    executions: normalizeLimit(retention.executions, DEFAULT_LIMITS.executions),
    promptExchanges: normalizeLimit(retention.promptExchanges, DEFAULT_LIMITS.promptExchanges),
    promptJournals: normalizeLimit(retention.promptJournals, DEFAULT_LIMITS.promptJournals),
    promptSessions: normalizeLimit(retention.promptSessions, DEFAULT_LIMITS.promptSessions),
    promptDecompositions: normalizeLimit(
      retention.promptDecompositions,
      DEFAULT_LIMITS.promptDecompositions,
    ),
    promptTemplates: normalizeLimit(retention.promptTemplates, DEFAULT_LIMITS.promptTemplates),
    historyNotes: normalizeLimit(retention.historyNotes, DEFAULT_LIMITS.historyNotes),
    research: normalizeLimit(retention.research, DEFAULT_LIMITS.research),
  };

  const results = [];
  results.push(
    await pruneIndexEntries(memory, {
      label: "executions",
      indexFile: memory.executionsIndexFile,
      keep: limits.executions,
      resolveTargets: (entry) => {
        const entryPath = entry?.path ?? entry?.file ?? null;
        if (!entryPath) {
          return [];
        }
        const folder = path.dirname(entryPath);
        return folder ? [folder] : [];
      },
      updateIndex: (index, keptEntries) => {
        const keptIds = new Set(keptEntries.map((entry) => entry?.id).filter(Boolean));
        const byTask = index.byTask ?? {};
        const updated = {};
        for (const [key, value] of Object.entries(byTask)) {
          const execIds = Array.isArray(value?.executions)
            ? value.executions.filter((id) => keptIds.has(id))
            : [];
          if (execIds.length) {
            updated[key] = { ...(value ?? {}), executions: execIds };
          }
        }
        index.byTask = updated;
        index.latest = keptEntries[0] ?? null;
      },
      dryRun,
    }),
  );
  results.push(
    await pruneIndexEntries(memory, {
      label: "prompt-exchanges",
      indexFile: path.join(memory.promptExchangesDir, "index.json"),
      keep: limits.promptExchanges,
      resolveTargets: (entry) => [entry?.file ?? null],
      dryRun,
    }),
  );
  results.push(
    await pruneIndexEntries(memory, {
      label: "prompt-journals",
      indexFile: memory.promptStepJournalIndexFile,
      keep: limits.promptJournals,
      resolveTargets: (entry) => {
        const entryPath = entry?.file ?? null;
        if (!entryPath) {
          return [];
        }
        const folder = path.dirname(entryPath);
        return folder ? [folder] : [];
      },
      dryRun,
    }),
  );
  results.push(
    await pruneIndexEntries(memory, {
      label: "prompt-sessions",
      indexFile: memory.promptSessionsIndexFile,
      keep: limits.promptSessions,
      resolveTargets: (entry) => [entry?.file ?? null],
      dryRun,
    }),
  );
  results.push(
    await pruneIndexEntries(memory, {
      label: "prompt-decompositions",
      indexFile: memory.promptDecompositionIndexFile,
      keep: limits.promptDecompositions,
      resolveTargets: (entry) => [entry?.file ?? null],
      dryRun,
    }),
  );
  results.push(
    await pruneIndexEntries(memory, {
      label: "prompt-templates",
      indexFile: memory.promptTemplatesIndexFile,
      keep: limits.promptTemplates,
      resolveTargets: (entry) => [entry?.file ?? null],
      dryRun,
    }),
  );
  results.push(
    await pruneIndexEntries(memory, {
      label: "history-notes",
      indexFile: memory.historyNotesIndexFile,
      keep: limits.historyNotes,
      resolveTargets: (entry) => [entry?.file ?? null, entry?.markdown ?? null],
      dryRun,
    }),
  );
  results.push(
    await pruneIndexEntries(memory, {
      label: "research",
      indexFile: memory.researchIndexFile,
      keep: limits.research,
      resolveTargets: (entry) => [entry?.file ?? null],
      dryRun,
    }),
  );

  const summary = results.reduce(
    (acc, entry) => {
      acc.totalEntries += entry.totalEntries ?? 0;
      acc.removedEntries += entry.removedEntries ?? 0;
      acc.removedTargets += entry.removedTargets ?? 0;
      acc.skippedTargets += entry.skippedTargets ?? 0;
      acc.errors += entry.errors ?? 0;
      return acc;
    },
    {
      totalEntries: 0,
      removedEntries: 0,
      removedTargets: 0,
      skippedTargets: 0,
      errors: 0,
    },
  );

  return {
    baseDir: memory.baseDir,
    dryRun,
    retention: limits,
    summary,
    results,
  };
}
