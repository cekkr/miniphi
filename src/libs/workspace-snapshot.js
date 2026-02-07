import fs from "fs";
import path from "path";
import {
  buildWorkspaceHintBlock,
  collectManifestSummary,
  readReadmeSnippet,
  buildPromptTemplateBlock,
  buildPromptCompositionBlock,
} from "./workspace-context-utils.js";
import { scanWorkspace } from "./workspace-scanner.js";
import {
  extractLmStudioContextLength,
  extractLmStudioGpu,
  extractLmStudioModel,
} from "./lmstudio-status-utils.js";

function formatCommandLibraryBlock(entries, limit = 6) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }
  const capped = entries.slice(0, Math.max(1, limit));
  const lines = ["Command library recommendations:"];
  for (const entry of capped) {
    const parts = [`- ${entry.command}`];
    if (entry.description) {
      parts.push(entry.description);
    }
    const meta = [];
    if (Array.isArray(entry.files) && entry.files.length) {
      meta.push(`files: ${entry.files.slice(0, 2).join(", ")}`);
    }
    if (Array.isArray(entry.tags) && entry.tags.length) {
      meta.push(`tags: ${entry.tags.join(", ")}`);
    }
    if (entry.owner) {
      meta.push(`owner: ${entry.owner}`);
    }
    const schemaLabel =
      typeof entry.schemaId === "string" && entry.schemaId.trim().length
        ? `schema: ${entry.schemaId.trim()}`
        : null;
    if (schemaLabel) {
      meta.push(schemaLabel);
    }
    const ctxBudget = Number(entry.contextBudget ?? entry.contextTokens);
    if (Number.isFinite(ctxBudget) && ctxBudget > 0) {
      meta.push(`ctx<=${Math.round(ctxBudget)}`);
    }
    if (entry.workspaceType) {
      meta.push(`workspace: ${entry.workspaceType}`);
    }
    if (entry.source) {
      meta.push(`source: ${entry.source}`);
    }
    if (entry.catalog) {
      meta.push(`library: ${entry.catalog}`);
    }
    if (meta.length) {
      parts.push(`(${meta.join(" | ")})`);
    }
    lines.push(parts.join(" "));
  }
  if (entries.length > capped.length) {
    lines.push(
      `- ... ${entries.length - capped.length} more stored command${
        entries.length - capped.length === 1 ? "" : "s"
      }`,
    );
  }
  return lines.join("\n");
}

function mergeHintBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return null;
  }
  const seen = new Set();
  const merged = [];
  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const sections = String(block)
      .split(/\n{2,}/)
      .map((section) => section.trim())
      .filter(Boolean);
    for (const section of sections) {
      if (seen.has(section)) {
        continue;
      }
      seen.add(section);
      merged.push(section);
    }
  }
  return merged.length ? merged.join("\n\n") : null;
}

function buildWorkspaceFileIndex(workspaceContext) {
  const manifest = Array.isArray(workspaceContext?.manifestPreview)
    ? workspaceContext.manifestPreview
    : [];
  const files = new Set();
  const basenames = new Set();
  for (const entry of manifest) {
    const filePath = typeof entry?.path === "string" ? entry.path.replace(/\\/g, "/") : "";
    if (!filePath) {
      continue;
    }
    files.add(filePath.toLowerCase());
    basenames.add(path.basename(filePath).toLowerCase());
  }
  const root =
    typeof workspaceContext?.root === "string" && workspaceContext.root.trim().length
      ? path.resolve(workspaceContext.root)
      : null;
  const hasPackageJson =
    files.has("package.json") || (root ? fs.existsSync(path.join(root, "package.json")) : false);
  return {
    root,
    files,
    basenames,
    hasPackageJson,
    stats: workspaceContext?.stats ?? null,
  };
}

function commandMentionsWorkspaceFile(command, fileIndex) {
  if (!command || !fileIndex?.basenames?.size) {
    return false;
  }
  const normalized = command.toLowerCase();
  for (const basename of fileIndex.basenames) {
    if (basename && normalized.includes(basename)) {
      return true;
    }
  }
  return false;
}

function entryMatchesWorkspaceFiles(entryFiles, fileIndex) {
  if (!Array.isArray(entryFiles) || entryFiles.length === 0) {
    return false;
  }
  for (const file of entryFiles) {
    if (typeof file !== "string") {
      continue;
    }
    const trimmed = file.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = trimmed.replace(/\\/g, "/");
    if (fileIndex?.files?.has(normalized.toLowerCase())) {
      return true;
    }
    const basename = path.basename(normalized).toLowerCase();
    if (fileIndex?.basenames?.has(basename)) {
      return true;
    }
    if (fileIndex?.root) {
      const absolute = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(fileIndex.root, trimmed);
      if (absolute.startsWith(fileIndex.root) && fs.existsSync(absolute)) {
        return true;
      }
    }
  }
  return false;
}

function isGenericCommandAllowed(command, fileIndex) {
  if (!command) {
    return false;
  }
  const normalized = command.trim().toLowerCase();
  const hasCode = Number(fileIndex?.stats?.codeFiles ?? 0) > 0;
  const usesNode =
    normalized.startsWith("npm ") ||
    normalized.startsWith("pnpm ") ||
    normalized.startsWith("yarn ") ||
    normalized.startsWith("node ") ||
    normalized.startsWith("bun ");
  if (usesNode && (fileIndex?.hasPackageJson || hasCode)) {
    return true;
  }
  return false;
}

async function attachCommandLibraryToWorkspace(
  workspaceContext,
  memory,
  globalMemory,
  options = undefined,
) {
  if (!memory && !globalMemory) {
    return workspaceContext;
  }
  if (
    Array.isArray(workspaceContext?.commandLibraryEntries) &&
    workspaceContext.commandLibraryEntries.length
  ) {
    return workspaceContext;
  }
  const fileIndex = buildWorkspaceFileIndex(workspaceContext);
  const limit =
    Number.isFinite(Number(options?.limit)) && Number(options.limit) > 0
      ? Number(options.limit)
      : 6;
  let localEntries = [];
  if (memory) {
    try {
      localEntries = await memory.loadCommandLibrary(limit);
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] Unable to load command library: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  let globalEntries = [];
  if (globalMemory?.loadCommandLibrary) {
    try {
      globalEntries = await globalMemory.loadCommandLibrary(limit);
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] Unable to load global command library: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  if (!localEntries.length && !globalEntries.length) {
    return workspaceContext;
  }
  const merged = [];
  const seen = new Set();
  const addEntries = (entries, origin) => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      const commandText = typeof entry?.command === "string" ? entry.command.trim() : "";
      if (!commandText) {
        continue;
      }
      if (origin === "global") {
        const mode = typeof options?.mode === "string" ? options.mode.trim() : "";
        if (mode && entry?.mode && entry.mode !== mode) {
          continue;
        }
        const schemaId = typeof options?.schemaId === "string" ? options.schemaId.trim() : "";
        if (schemaId && entry?.schemaId && entry.schemaId !== schemaId) {
          continue;
        }
        const matchesFiles = entryMatchesWorkspaceFiles(entry?.files, fileIndex);
        const mentionsFile = commandMentionsWorkspaceFile(commandText, fileIndex);
        if (!matchesFiles && !mentionsFile && !isGenericCommandAllowed(commandText, fileIndex)) {
          continue;
        }
      }
      const key = commandText.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push({
        ...entry,
        command: commandText,
        catalog: origin,
      });
      if (merged.length >= limit) {
        break;
      }
    }
  };
  addEntries(localEntries, "project");
  addEntries(globalEntries, "global");
  if (!merged.length) {
    return workspaceContext;
  }
  const block = formatCommandLibraryBlock(merged, limit);
  return {
    ...(workspaceContext ?? {}),
    commandLibraryEntries: merged,
    commandLibraryBlock: block,
    commandLibrarySources: {
      project: localEntries.length,
      global: globalEntries.length,
      merged: merged.length,
    },
  };
}

async function attachPromptCompositionsToWorkspace(
  workspaceContext,
  memory,
  globalMemory,
  options = undefined,
) {
  if (!memory && !globalMemory) {
    return workspaceContext;
  }
  if (
    Array.isArray(workspaceContext?.compositionEntries) &&
    workspaceContext.compositionEntries.length
  ) {
    return workspaceContext;
  }
  const limit =
    Number.isFinite(Number(options?.limit)) && Number(options.limit) > 0
      ? Number(options.limit)
      : 6;
  const workspaceType =
    workspaceContext?.classification?.label ?? workspaceContext?.classification?.domain ?? null;
  const filters = {
    limit,
    workspaceType,
    includeFallback: Boolean(options?.includeFallback),
  };
  const dedupeKey = (entry) => {
    if (!entry) return null;
    if (typeof entry.key === "string") {
      return entry.key;
    }
    const schema = typeof entry.schemaId === "string" ? entry.schemaId.trim().toLowerCase() : "none";
    const mode = typeof entry.mode === "string" ? entry.mode.trim().toLowerCase() : "unknown";
    const command =
      typeof entry.command === "string" && entry.command.trim().length
        ? entry.command.trim().toLowerCase()
        : typeof entry.task === "string" && entry.task.trim().length
          ? entry.task.trim().toLowerCase()
          : "objective";
    const workspaceLabel =
      typeof entry.workspaceType === "string" && entry.workspaceType.trim().length
        ? entry.workspaceType.trim().toLowerCase()
        : "any";
    return [schema, mode, command, workspaceLabel].join("::");
  };
  const merged = [];
  const seen = new Set();
  const addEntries = (entries, source) => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      const key = dedupeKey(entry);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push({ ...entry, source });
      if (merged.length >= limit) {
        break;
      }
    }
  };
  let localEntries = [];
  let globalEntries = [];
  if (memory?.loadPromptCompositions) {
    try {
      localEntries = await memory.loadPromptCompositions(filters);
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] Unable to load prompt compositions: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  if (globalMemory?.loadPromptCompositions) {
    try {
      globalEntries = await globalMemory.loadPromptCompositions(filters);
    } catch (error) {
      if (options?.verbose) {
        console.warn(
          `[MiniPhi] Unable to load global prompt compositions: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  addEntries(localEntries, "project");
  addEntries(globalEntries, "global");
  if (!merged.length) {
    return workspaceContext;
  }
  const block = buildPromptCompositionBlock(merged, { limit });
  return {
    ...(workspaceContext ?? {}),
    compositionEntries: merged,
    compositionBlock: block,
    compositionSources: {
      project: localEntries.length,
      global: globalEntries.length,
      merged: merged.length,
    },
  };
}

async function recordCompositionSnapshot(payload, memory, globalMemory, options = undefined) {
  if (!payload) {
    return;
  }
  const verbose = Boolean(options?.verbose);
  if (memory?.recordPromptComposition) {
    try {
      await memory.recordPromptComposition(payload);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to store prompt composition: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }
  if (globalMemory?.recordPromptComposition) {
    try {
      await globalMemory.recordPromptComposition({ ...payload, source: payload.source ?? "project" });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to store global prompt composition: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
}

async function recordLmStudioStatusSnapshot(restClient, memory, options = undefined) {
  if (!restClient || !memory) {
    return null;
  }
  try {
    const status = await restClient.getStatus();
    const snapshot = {
      status: status ?? null,
      baseUrl: restClient.baseUrl ?? null,
      transport: options?.transport ?? "rest",
    };
    const record = await memory.recordLmStudioStatus(snapshot, { label: options?.label ?? null });
    if (options?.verbose) {
      const model = extractLmStudioModel(status);
      const contextLength = extractLmStudioContextLength(status);
      const gpu = extractLmStudioGpu(status);
      const relPath = record?.path ? path.relative(process.cwd(), record.path) : null;
      console.log(
        `[MiniPhi] LM Studio status: model=${model ?? "unknown"} ctx=${
          contextLength ?? "?"
        } gpu=${gpu ?? "?"}`,
      );
      if (record?.path) {
        console.log(
          `[MiniPhi] LM Studio status snapshot stored at ${
            relPath && !relPath.startsWith("..") ? relPath : record.path
          }`,
        );
      }
    }
    return record;
  } catch (error) {
    if (options?.verbose) {
      console.warn(
        `[MiniPhi] LM Studio status check failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    return null;
  }
}

async function generateWorkspaceSnapshot({
  rootDir,
  workspaceProfiler,
  capabilityInventory,
  verbose = false,
  navigator = null,
  objective = null,
  executeHelper = true,
  memory = null,
  globalMemory = null,
  indexLimit = 6,
  benchmarkLimit = 3,
  mode = null,
  schemaId = null,
  focusPath = null,
  promptId = null,
  promptJournalId = null,
  sessionDeadline = null,
  emitFeatureDisableNotice = null,
}) {
  let scanResult = null;
  try {
    scanResult = await scanWorkspace(rootDir, {
      ignoredDirs: workspaceProfiler?.ignoredDirs ?? undefined,
    });
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Workspace scan failed for ${rootDir}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  let profile;
  try {
    profile = workspaceProfiler.describe(rootDir, { scanResult });
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Workspace profiling failed for ${rootDir}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return null;
  }

  const manifestResult = await collectManifestSummary(rootDir, {
    limit: 10,
    scanResult,
  }).catch((error) => {
    if (verbose) {
      console.warn(
        `[MiniPhi] Workspace manifest scan failed for ${rootDir}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return { files: [], manifest: [] };
  });
  const readmeSnippet = await readReadmeSnippet({
    candidates: [
      path.join(rootDir, "README.md"),
      path.join(rootDir, "README.md.md"),
      path.join(rootDir, "docs", "README.md"),
    ],
  }).catch(() => null);
  const hintBlock = buildWorkspaceHintBlock(manifestResult.files, rootDir, readmeSnippet, {
    limit: 8,
  });
  const planDirectives = profile?.directives ?? null;
  const hasHintBlock = Boolean(hintBlock && hintBlock.trim());
  let cachedHint = null;
  if (memory?.loadWorkspaceHint) {
    try {
      cachedHint = await memory.loadWorkspaceHint(rootDir);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Workspace hint cache read failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  const cachedHintBlock = !hasHintBlock ? cachedHint?.hintBlock ?? null : null;
  const cachedDirectives =
    !planDirectives && cachedHint?.directives
      ? `Cached directives: ${cachedHint.directives}`
      : null;
  const mergedHintBlock = mergeHintBlocks([
    hintBlock,
    planDirectives ? `Workspace directives: ${planDirectives}` : null,
    cachedHintBlock,
    cachedDirectives,
  ]);

  let capabilities = null;
  try {
    capabilities = await capabilityInventory.describe(rootDir);
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi] Capability inventory failed for ${rootDir}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  let workspaceSnapshot = {
    ...profile,
    manifestPreview: manifestResult.manifest,
    readmeSnippet,
    hintBlock: mergedHintBlock || null,
    planDirectives,
    capabilitySummary: capabilities?.summary ?? null,
    capabilityDetails: capabilities?.details ?? null,
    cachedHints: cachedHint,
  };

  const promptTemplates = [];
  const templateKeys = new Set();
  const registerTemplates = (entries, sourceLabel) => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      if (!entry) {
        continue;
      }
      const keyBase = entry.id ?? entry.path ?? entry.label ?? entry.schemaId ?? sourceLabel;
      const key = `${keyBase}::${entry.source ?? sourceLabel}`;
      if (templateKeys.has(key)) {
        continue;
      }
      templateKeys.add(key);
      const previewSource = typeof entry.prompt === "string" ? entry.prompt : null;
      const preview =
        previewSource && previewSource.length > 320
          ? `${previewSource.slice(0, 320)}...`
          : previewSource;
      promptTemplates.push({
        id: entry.id ?? keyBase,
        label: entry.label ?? entry.schemaId ?? keyBase,
        schemaId: entry.schemaId ?? null,
        baseline: entry.baseline ?? null,
        task: entry.task ?? null,
        createdAt: entry.createdAt ?? null,
        workspaceType: entry.workspaceType ?? profile?.classification?.label ?? null,
        path: entry.path ?? null,
        source: entry.source ?? sourceLabel,
        preview,
      });
      if (promptTemplates.length >= 8) {
        break;
      }
    }
  };
  if (memory?.loadPromptTemplates) {
    try {
      const localTemplates = await memory.loadPromptTemplates({
        cwd: rootDir,
        limit: 5,
      });
      registerTemplates(localTemplates, "local");
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load local prompt templates: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  if (globalMemory?.loadPromptTemplates) {
    try {
      const globalTemplates = await globalMemory.loadPromptTemplates({
        workspaceType: profile?.classification?.label ?? profile?.classification?.domain ?? null,
        limit: 4,
      });
      registerTemplates(globalTemplates, "global");
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load global prompt templates: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  const promptTemplateBlock =
    promptTemplates.length > 0 ? buildPromptTemplateBlock(promptTemplates) : null;
  workspaceSnapshot.promptTemplates = promptTemplates;
  workspaceSnapshot.promptTemplateBlock = promptTemplateBlock;

  workspaceSnapshot = await attachCommandLibraryToWorkspace(
    workspaceSnapshot,
    memory,
    globalMemory,
    { limit: 8, verbose, mode, schemaId },
  );
  workspaceSnapshot = await attachPromptCompositionsToWorkspace(
    workspaceSnapshot,
    memory,
    globalMemory,
    { limit: 8, verbose },
  );

  let indexSummary = null;
  let benchmarkHistory = null;
  if (memory) {
    try {
      indexSummary = await memory.loadIndexSummaries(indexLimit);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load .miniphi index summaries: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
    try {
      benchmarkHistory = await memory.loadBenchmarkHistory(benchmarkLimit);
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to load benchmark history: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  let navigationHints = null;
  if (navigator) {
    try {
      navigationHints = await navigator.generateNavigationHints({
        workspace: workspaceSnapshot,
        capabilities,
        objective,
        cwd: rootDir,
        executeHelper,
        focusPath,
        promptId,
        promptJournalId,
        sessionDeadline,
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Navigation advisor failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (typeof navigator.consumeDisableNotice === "function") {
      const notice = navigator.consumeDisableNotice();
      if (notice && typeof emitFeatureDisableNotice === "function") {
        emitFeatureDisableNotice("Navigation advisor", notice);
      }
    }
  }

  if (memory?.saveWorkspaceHint) {
    try {
      await memory.saveWorkspaceHint({
        root: rootDir,
        summary: workspaceSnapshot.summary ?? null,
        classification: workspaceSnapshot.classification ?? null,
        hintBlock: workspaceSnapshot.hintBlock ?? null,
        directives: workspaceSnapshot.planDirectives ?? null,
        manifestPreview: workspaceSnapshot.manifestPreview ?? null,
        navigationSummary: navigationHints?.summary ?? null,
        navigationBlock: navigationHints?.block ?? null,
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi] Unable to persist workspace hint cache: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  return {
    ...workspaceSnapshot,
    navigationSummary: navigationHints?.summary ?? null,
    navigationBlock: navigationHints?.block ?? null,
    helperScript: navigationHints?.helper ?? null,
    navigationHints,
    indexSummary,
    benchmarkHistory,
  };
}

export {
  attachCommandLibraryToWorkspace,
  attachPromptCompositionsToWorkspace,
  generateWorkspaceSnapshot,
  recordCompositionSnapshot,
  recordLmStudioStatusSnapshot,
};
