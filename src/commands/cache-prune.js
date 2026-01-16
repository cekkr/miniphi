import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import { pruneMiniPhiCache } from "../libs/cache-pruner.js";

function resolveRetention(options, configData) {
  const configRetention = configData?.retention ?? {};
  const cliRetention = {
    executions: options["retain-executions"],
    promptExchanges: options["retain-prompt-exchanges"],
    promptJournals: options["retain-prompt-journals"],
    promptSessions: options["retain-prompt-sessions"],
    promptDecompositions: options["retain-prompt-decompositions"],
    promptTemplates: options["retain-prompt-templates"],
    historyNotes: options["retain-history-notes"],
    research: options["retain-research"],
  };
  return {
    executions: cliRetention.executions ?? configRetention.executions,
    promptExchanges: cliRetention.promptExchanges ?? configRetention.promptExchanges,
    promptJournals: cliRetention.promptJournals ?? configRetention.promptJournals,
    promptSessions: cliRetention.promptSessions ?? configRetention.promptSessions,
    promptDecompositions:
      cliRetention.promptDecompositions ?? configRetention.promptDecompositions,
    promptTemplates: cliRetention.promptTemplates ?? configRetention.promptTemplates,
    historyNotes:
      cliRetention.historyNotes ?? configRetention.historyNotes ?? configRetention.history,
    research: cliRetention.research ?? configRetention.research,
  };
}

function formatRetentionLabel(value) {
  if (value === null || value === undefined) {
    return "auto";
  }
  return value.toString();
}

export async function handleCachePruneCommand(context) {
  const { options, verbose, configData } = context;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const memory = new MiniPhiMemory(cwd);
  const retention = resolveRetention(options, configData);
  const dryRun = Boolean(options["dry-run"]);
  const result = await pruneMiniPhiCache(memory, { retention, dryRun });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const relBase = path.relative(process.cwd(), result.baseDir) || result.baseDir;
  const modeLabel = dryRun ? "dry run" : "complete";
  console.log(`[MiniPhi] Cache prune ${modeLabel} (${relBase})`);
  for (const entry of result.results) {
    if (entry.skipped) {
      console.log(
        `[MiniPhi] ${entry.label}: skipped (${entry.reason ?? "disabled"})`,
      );
      continue;
    }
    console.log(
      `[MiniPhi] ${entry.label}: kept ${entry.keptEntries}/${entry.totalEntries}, removed ${entry.removedEntries} entries (${entry.removedTargets} paths), retention ${formatRetentionLabel(entry.keep)}`,
    );
  }
  if (verbose && result.summary) {
    console.log(
      `[MiniPhi] Cache prune summary: removed ${result.summary.removedEntries} entries (${result.summary.removedTargets} paths), skipped ${result.summary.skippedTargets}, errors ${result.summary.errors}`,
    );
  }
}
