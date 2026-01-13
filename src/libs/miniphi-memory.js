import fs from "fs";
import path from "path";
import { randomUUID, createHash } from "crypto";
import MemoryStoreBase from "./memory-store-base.js";

const DEFAULT_SEGMENT_SIZE = 2000; // characters per chunk to stay context-friendly

function findExistingMiniPhi(startDir) {
  let current = startDir;
  const { root } = path.parse(current);

  while (true) {
    const candidate = path.join(current, ".miniphi");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return null;
}

function detectProjectRoot(startDir) {
  let current = startDir;
  const { root } = path.parse(current);

  while (true) {
    if (fs.existsSync(path.join(current, "package.json")) || fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return startDir;
}

/**
 * Manages the hidden .miniphi directory used for persistent execution state, knowledge, and indexes.
 */
export default class MiniPhiMemory extends MemoryStoreBase {
  constructor(startDir = process.cwd()) {
    const resolvedStart = path.resolve(startDir);
    const existingBase = findExistingMiniPhi(resolvedStart);
    const projectRoot = existingBase
      ? path.dirname(existingBase)
      : detectProjectRoot(resolvedStart);
    const baseDir = existingBase ?? path.join(projectRoot, ".miniphi");
    super(baseDir, {
      ensureReadable: false,
      relativeOptions: {
        normalizeSlashes: true,
        alwaysRelative: true,
        fallbackToTarget: false,
      },
      slugifyOptions: { maxLength: 48, fallback: "note" },
    });

    this.startDir = resolvedStart;
    this.projectRoot = projectRoot;
    this.baseDir = baseDir;

    this.executionsDir = path.join(this.baseDir, "executions");
    this.indicesDir = path.join(this.baseDir, "indices");
    this.healthDir = path.join(this.baseDir, "health");
    this.historyDir = path.join(this.baseDir, "history");
    this.sessionsDir = path.join(this.baseDir, "prompt-sessions");
    this.researchDir = path.join(this.baseDir, "research");
    this.historyNotesDir = path.join(this.baseDir, "history-notes");
    this.promptExchangesDir = path.join(this.baseDir, "prompt-exchanges");
    this.promptDecompositionsDir = path.join(this.promptExchangesDir, "decompositions");
    this.promptStepJournalDir = path.join(this.promptExchangesDir, "stepwise");
    this.promptTemplatesDir = path.join(this.promptExchangesDir, "templates");
    this.helpersDir = path.join(this.baseDir, "helpers");
    this.helperVersionsDir = path.join(this.helpersDir, "versions");
    this.fixedReferencesDir = path.join(this.promptExchangesDir, "fixed-references");
    this.workspaceHintsFile = path.join(this.indicesDir, "workspace-hints.json");

    this.promptsFile = path.join(this.baseDir, "prompts.json");
    this.knowledgeFile = path.join(this.baseDir, "knowledge.json");
    this.todoFile = path.join(this.baseDir, "todo.json");
    this.rootIndexFile = path.join(this.baseDir, "index.json");
    this.executionsIndexFile = path.join(this.indicesDir, "executions-index.json");
    this.knowledgeIndexFile = path.join(this.indicesDir, "knowledge-index.json");
    this.resourceUsageFile = path.join(this.healthDir, "resource-usage.json");
    this.lmStudioStatusFile = path.join(this.healthDir, "lmstudio-status.json");
    this.promptSessionsIndexFile = path.join(this.indicesDir, "prompt-sessions-index.json");
    this.researchIndexFile = path.join(this.indicesDir, "research-index.json");
    this.historyNotesIndexFile = path.join(this.indicesDir, "history-notes-index.json");
    this.benchmarkHistoryFile = path.join(this.historyDir, "benchmarks.json");
    this.recomposeCacheDir = path.join(this.baseDir, "recompose-cache");
    this.recomposeNarrativesFile = path.join(this.recomposeCacheDir, "narratives.json");
    this.promptDecompositionIndexFile = path.join(
      this.promptDecompositionsDir,
      "index.json",
    );
    this.helperScriptsIndexFile = path.join(this.helpersDir, "index.json");
    this.commandLibraryFile = path.join(this.helpersDir, "command-library.json");
    this.promptStepJournalIndexFile = path.join(this.promptStepJournalDir, "index.json");
    this.promptTemplatesIndexFile = path.join(this.promptTemplatesDir, "index.json");
    this.fallbackCacheFile = path.join(this.indicesDir, "fallback-cache.json");
    this.promptCompositionsFile = path.join(this.indicesDir, "prompt-compositions.json");

    this.prepared = false;
    this.recomposeNarrativesCache = null;
  }

  /**
   * Ensures the .miniphi directory structure is present.
   */
  async prepare() {
    if (this.prepared) {
      return this.baseDir;
    }

    await fs.promises.mkdir(this.executionsDir, { recursive: true });
    await fs.promises.mkdir(this.indicesDir, { recursive: true });
    await fs.promises.mkdir(this.healthDir, { recursive: true });
    await fs.promises.mkdir(this.sessionsDir, { recursive: true });
    await fs.promises.mkdir(this.historyDir, { recursive: true });
    await fs.promises.mkdir(this.researchDir, { recursive: true });
    await fs.promises.mkdir(this.historyNotesDir, { recursive: true });
    await fs.promises.mkdir(this.recomposeCacheDir, { recursive: true });
    await fs.promises.mkdir(this.promptExchangesDir, { recursive: true });
    await fs.promises.mkdir(this.promptDecompositionsDir, { recursive: true });
    await fs.promises.mkdir(this.promptStepJournalDir, { recursive: true });
    await fs.promises.mkdir(this.promptTemplatesDir, { recursive: true });
    await fs.promises.mkdir(this.helpersDir, { recursive: true });
    await fs.promises.mkdir(this.helperVersionsDir, { recursive: true });
    await fs.promises.mkdir(this.fixedReferencesDir, { recursive: true });

    await this._ensureFile(this.promptsFile, { history: [] });
    await this._ensureFile(this.knowledgeFile, { entries: [] });
    await this._ensureFile(this.todoFile, { items: [] });
    await this._ensureFile(this.executionsIndexFile, { entries: [], byTask: {}, latest: null });
    await this._ensureFile(this.knowledgeIndexFile, { entries: [] });
    await this._ensureFile(this.resourceUsageFile, { entries: [] });
    await this._ensureFile(this.lmStudioStatusFile, { entries: [] });
    await this._ensureFile(this.promptSessionsIndexFile, { entries: [] });
    await this._ensureFile(this.researchIndexFile, { entries: [] });
    await this._ensureFile(this.historyNotesIndexFile, { entries: [] });
    await this._ensureFile(this.benchmarkHistoryFile, { entries: [] });
    await this._ensureFile(this.recomposeNarrativesFile, { entries: {}, order: [] });
    await this._ensureFile(this.promptDecompositionIndexFile, { entries: [] });
    await this._ensureFile(this.helperScriptsIndexFile, { entries: [] });
    await this._ensureFile(this.workspaceHintsFile, { entries: [] });
    await this._ensureFile(this.promptStepJournalIndexFile, { entries: [] });
    await this._ensureFile(this.promptTemplatesIndexFile, { entries: [] });
    await this._ensureFile(this.commandLibraryFile, { entries: [] });
    await this._ensureFile(this.fallbackCacheFile, { entries: [] });
    await this._ensureFile(this.promptCompositionsFile, { entries: [] });
    await this._ensureFile(this.rootIndexFile, {
      updatedAt: new Date().toISOString(),
      children: [
        { name: "executions", file: this._relative(this.executionsIndexFile) },
        { name: "knowledge", file: this._relative(this.knowledgeIndexFile) },
        { name: "prompts", file: this._relative(this.promptsFile) },
        { name: "todo", file: this._relative(this.todoFile) },
        { name: "health", file: this._relative(this.resourceUsageFile) },
        { name: "lmstudio-status", file: this._relative(this.lmStudioStatusFile) },
        { name: "prompt-sessions", file: this._relative(this.promptSessionsIndexFile) },
        { name: "research", file: this._relative(this.researchIndexFile) },
        { name: "history-notes", file: this._relative(this.historyNotesIndexFile) },
        { name: "benchmarks", file: this._relative(this.benchmarkHistoryFile) },
        { name: "prompt-decompositions", file: this._relative(this.promptDecompositionIndexFile) },
        { name: "helpers", file: this._relative(this.helperScriptsIndexFile) },
        { name: "workspace-hints", file: this._relative(this.workspaceHintsFile) },
        { name: "prompt-step-journals", file: this._relative(this.promptStepJournalIndexFile) },
        { name: "prompt-templates", file: this._relative(this.promptTemplatesIndexFile) },
        { name: "fallback-cache", file: this._relative(this.fallbackCacheFile) },
        { name: "prompt-compositions", file: this._relative(this.promptCompositionsFile) },
      ],
    });

    this.prepared = true;
    await this._updateRootIndex();
    return this.baseDir;
  }

  async recordFixedReferences(payload) {
    if (!payload?.references || payload.references.length === 0) {
      return null;
    }
    await this.prepare();
    const timestamp = new Date().toISOString();
    const entryId = randomUUID();
    const filePath = path.join(this.fixedReferencesDir, `${entryId}.json`);
    const entry = {
      id: entryId,
      promptId: payload.promptId ?? null,
      task: payload.task ?? null,
      cwd: payload.cwd ?? this.startDir,
      createdAt: timestamp,
      files: payload.references.map((ref) => ({
        label: ref.label ?? ref.relative ?? ref.path,
        path: ref.path,
        relative: ref.relative ?? null,
        bytes: ref.bytes ?? null,
        hash: ref.hash ?? null,
        status: ref.error ? "missing" : "ok",
        error: ref.error ?? null,
      })),
    };
    await this._writeJSON(filePath, entry);
    return { entry, path: filePath };
  }

  async recordLmStudioStatus(snapshot, options = undefined) {
    if (!snapshot) {
      return null;
    }
    await this.prepare();
    const timestamp = new Date().toISOString();
    const entry = {
      id: randomUUID(),
      recordedAt: timestamp,
      label: options?.label ?? null,
      baseUrl: snapshot.baseUrl ?? null,
      transport: snapshot.transport ?? null,
      status: snapshot.status ?? snapshot,
    };
    const history = await this._readJSON(this.lmStudioStatusFile, { entries: [] });
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const updated = [entry, ...entries].slice(0, 50);
    const payload = {
      entries: updated,
      latest: entry,
      updatedAt: timestamp,
    };
    await this._writeJSON(this.lmStudioStatusFile, payload);
    await this._updateRootIndex();
    return { entry, path: this.lmStudioStatusFile, relative: this._relative(this.lmStudioStatusFile) };
  }

 /**
   * Persists a single MiniPhi execution (run or analyze-file) and updates indexes/knowledge.
   * @param {{
   *   mode: "run" | "analyze-file",
   *   task: string,
   *   command?: string,
   *   filePath?: string,
   *   cwd?: string,
   *   summaryLevels?: number,
   *   contextLength?: number,
   *   promptId?: string,
   *   status?: string,
   *   stopReason?: string,
   *   error?: string,
   *   result: {
   *     prompt: string,
   *     analysis: string,
   *     compressedTokens: number,
   *     compressedContent?: string,
   *     linesAnalyzed: number
   *   }
   * }} payload
   */
  async persistExecution(payload) {
    if (!payload?.result) {
      return null;
    }

    await this.prepare();

    const timestamp = new Date().toISOString();
    const executionId = randomUUID();
    const executionDir = path.join(this.executionsDir, executionId);
    const segmentsDir = path.join(executionDir, "segments");
    await fs.promises.mkdir(segmentsDir, { recursive: true });

   const metadata = {
      id: executionId,
      mode: payload.mode,
      task: payload.task,
      command: payload.command ?? null,
      filePath: payload.filePath ?? null,
      cwd: payload.cwd ?? this.startDir,
      summaryLevels: payload.summaryLevels ?? null,
      contextLength: payload.contextLength ?? null,
      linesAnalyzed: payload.result.linesAnalyzed,
      compressedTokens: payload.result.compressedTokens,
      contextRequests: payload.result.contextRequests ?? [],
      missingSnippets: Array.isArray(payload.result.missingSnippets)
        ? payload.result.missingSnippets
        : [],
      needsMoreContext:
        typeof payload.result.needsMoreContext === "boolean"
          ? payload.result.needsMoreContext
          : null,
      resourceUsage: payload.resourceUsage ?? null,
      promptId: payload.promptId ?? null,
      createdAt: timestamp,
      truncationPlan: null,
      status: payload.status ?? "completed",
      stopReason: payload.stopReason ?? null,
      error: payload.error ?? null,
    };

    const promptFile = path.join(executionDir, "prompt.json");
    const analysisFile = path.join(executionDir, "analysis.json");
    const compressionFile = path.join(executionDir, "compression.json");
    const metadataFile = path.join(executionDir, "execution.json");
    const executionIndexFile = path.join(executionDir, "index.json");

    const segments = this._chunkContent(payload.result.compressedContent ?? "");
    await Promise.all(
      segments.map((segment, idx) => {
        const fileName = path.join(segmentsDir, `segment-${String(idx + 1).padStart(3, "0")}.json`);
        segment.file = this._relative(fileName);
        return this._writeJSON(fileName, segment);
      }),
    );

    const summary = this._synthesizeSummary(payload.result.analysis);

    await this._writeJSON(metadataFile, metadata);
    await this._writeJSON(promptFile, {
      task: payload.task,
      prompt: payload.result.prompt,
      contextLength: payload.contextLength ?? null,
      updatedAt: timestamp,
    });
    await this._writeJSON(analysisFile, {
      analysis: payload.result.analysis,
      summary,
      contextRequests: payload.result.contextRequests ?? [],
      missingSnippets: Array.isArray(payload.result.missingSnippets)
        ? payload.result.missingSnippets
        : [],
      needsMoreContext:
        typeof payload.result.needsMoreContext === "boolean"
          ? payload.result.needsMoreContext
          : null,
      updatedAt: timestamp,
    });
    await this._writeJSON(compressionFile, {
      tokens: payload.result.compressedTokens,
      segments: segments.map((segment) => ({
        id: segment.id,
        file: segment.file,
        span: [segment.startLine, segment.endLine],
        length: segment.length,
      })),
      updatedAt: timestamp,
    });
    let truncationPlanPath = null;
    const planPayload = payload.truncationPlan ?? payload.result?.truncationPlan ?? null;
    if (planPayload?.plan) {
      const planRecord = {
        executionId,
        createdAt: timestamp,
        task: planPayload.task ?? payload.task ?? null,
        mode: payload.mode,
        filePath: payload.filePath ?? null,
        command: payload.command ?? null,
        summary: planPayload.summary ?? null,
        nextSteps: Array.isArray(planPayload.nextSteps) ? planPayload.nextSteps : [],
        recommendedFixes: Array.isArray(planPayload.recommendedFixes)
          ? planPayload.recommendedFixes
          : [],
        plan: planPayload.plan,
        source: planPayload.source ?? null,
        schemaId: payload.result?.schemaId ?? null,
      };
      truncationPlanPath = path.join(executionDir, "truncation-plan.json");
      await this._writeJSON(truncationPlanPath, planRecord);
      metadata.truncationPlan = this._relative(truncationPlanPath);
    }

    await this._writeJSON(executionIndexFile, {
      id: executionId,
      createdAt: timestamp,
      files: {
        metadata: this._relative(metadataFile),
        prompt: this._relative(promptFile),
        analysis: this._relative(analysisFile),
        compression: this._relative(compressionFile),
        segments: segments.map((segment) => segment.file),
        truncationPlan: metadata.truncationPlan,
      },
    });

    await this._updatePromptsHistory(payload, executionId, timestamp, promptFile);
    await this._updateKnowledgeBase(payload, executionId, timestamp, summary);
    await this._updateTodoList(payload.result.analysis, executionId, timestamp);
    await this._updateExecutionIndex(executionId, metadata, executionIndexFile, payload.task);

    return { id: executionId, path: executionDir, truncationPlanPath };
  }

  /**
   * Records a failed or aborted execution without requiring analysis output.
   * @param {{
   *   mode: string,
   *   task?: string,
   *   command?: string,
   *   filePath?: string,
   *   cwd?: string,
   *   summaryLevels?: number,
   *   contextLength?: number,
   *   promptId?: string,
   *   resourceUsage?: Record<string, any> | null,
   *   status?: string,
   *   stopReason?: string | null,
   *   error?: string | null
   * }} payload
   */
  async persistExecutionStop(payload) {
    if (!payload) {
      return null;
    }
    await this.prepare();

    const timestamp = new Date().toISOString();
    const executionId = randomUUID();
    const executionDir = path.join(this.executionsDir, executionId);
    await fs.promises.mkdir(executionDir, { recursive: true });

    const metadata = {
      id: executionId,
      mode: payload.mode ?? "unknown",
      task: payload.task ?? null,
      command: payload.command ?? null,
      filePath: payload.filePath ?? null,
      cwd: payload.cwd ?? this.startDir,
      summaryLevels: payload.summaryLevels ?? null,
      contextLength: payload.contextLength ?? null,
      linesAnalyzed: null,
      compressedTokens: null,
      contextRequests: [],
      resourceUsage: payload.resourceUsage ?? null,
      promptId: payload.promptId ?? null,
      createdAt: timestamp,
      truncationPlan: null,
      status: payload.status ?? "failed",
      stopReason: payload.stopReason ?? null,
      error: payload.error ?? null,
    };

    const metadataFile = path.join(executionDir, "execution.json");
    const executionIndexFile = path.join(executionDir, "index.json");
    await this._writeJSON(metadataFile, metadata);
    await this._writeJSON(executionIndexFile, {
      id: executionId,
      createdAt: timestamp,
      files: {
        metadata: this._relative(metadataFile),
      },
    });

    await this._updateExecutionIndex(executionId, metadata, executionIndexFile, payload.task);
    return { id: executionId, path: executionDir };
  }

  async savePromptDecomposition(payload) {
    if (!payload?.plan) {
      return null;
    }
    await this.prepare();
    const planId = payload.planId ?? payload.plan?.plan_id ?? randomUUID();
    const timestamp = new Date().toISOString();
  const record = {
    id: planId,
    createdAt: timestamp,
    summary: payload.summary ?? payload.plan?.summary ?? null,
    outline: payload.outline ?? null,
    segments: Array.isArray(payload.segments) ? payload.segments : null,
    segmentBlock: payload.segmentBlock ?? null,
    recommendedTools: Array.isArray(payload.recommendedTools) ? payload.recommendedTools : null,
    recommendationsBlock: payload.recommendationsBlock ?? null,
    metadata: payload.metadata ?? null,
    plan: payload.plan,
  };
    const filePath = path.join(this.promptDecompositionsDir, `${planId}.json`);
    await this._writeJSON(filePath, record);
    await this._updatePromptDecompositionIndex({
      id: planId,
      createdAt: timestamp,
      summary: record.summary,
      file: this._relative(filePath),
      outline: record.outline ?? null,
      segmentBlock: record.segmentBlock ?? null,
      metadata: record.metadata ?? null,
    });
    return { id: planId, path: filePath };
  }

  async loadLatestPromptDecomposition(options = undefined) {
    const promptId = options?.promptId ?? options?.mainPromptId ?? null;
    const mode = options?.mode ?? null;
    await this.prepare();
    const index = await this._readJSON(this.promptDecompositionIndexFile, { entries: [] });
    const entries = Array.isArray(index.entries) ? index.entries : [];
    for (const entry of entries) {
      const metadata = entry?.metadata ?? {};
      if (promptId && metadata?.mainPromptId && metadata.mainPromptId !== promptId) {
        continue;
      }
      if (mode && metadata?.extra?.mode && metadata.extra.mode !== mode) {
        continue;
      }
      if (!entry?.file) {
        continue;
      }
      const targetPath = path.isAbsolute(entry.file)
        ? entry.file
        : path.join(this.baseDir, entry.file);
      const record = await this._readJSON(targetPath, null);
      if (record && record.plan) {
        return { ...record, path: targetPath };
      }
    }
    return null;
  }

  /**
   * Loads a summary of the tracked index files (executions, knowledge, prompts, etc.)
   * so downstream prompts can mention recent counts without re-reading the entire state.
   */
  async loadIndexSummaries(limit = 6) {
    await this.prepare();
    const root = await this._readJSON(this.rootIndexFile, { children: [] });
    const children = Array.isArray(root.children) ? root.children : [];
    const capped = children.slice(0, Math.max(0, Math.min(limit, children.length)));
    const entries = [];
    for (const child of capped) {
      if (!child?.file) {
        continue;
      }
      const targetPath = path.join(this.baseDir, child.file);
      const data = await this._readJSON(targetPath, null);
      const entryCount = Array.isArray(data?.entries) ? data.entries.length : null;
      const summary = typeof data?.summary === "string" ? data.summary.trim() : null;
      const updatedAt = data?.updatedAt ?? data?.recordedAt ?? null;
      entries.push({
        name: child.name ?? child.file,
        file: child.file,
        entries: entryCount,
        summary,
        updatedAt,
      });
    }
    return {
      updatedAt: root.updatedAt ?? null,
      entries,
    };
  }

  /**
   * Reads the benchmark history ledger so prompts can reference past benchmark digests.
   */
  async loadBenchmarkHistory(limit = 3) {
    await this.prepare();
    const history = await this._readJSON(this.benchmarkHistoryFile, { entries: [] });
    if (!Array.isArray(history?.entries)) {
      return [];
    }
    const capped = history.entries.slice(0, Math.max(0, Math.min(limit, history.entries.length)));
    return capped.map((entry) => ({
      id: entry.id ?? null,
      type: entry.type ?? "summary",
      analyzedAt: entry.digest?.analyzedAt ?? entry.recordedAt ?? null,
      directory: entry.digest?.directory ?? null,
      totalRuns: entry.digest?.totalRuns ?? null,
      warningRuns: entry.digest?.warningRuns ?? null,
      mismatchRuns: entry.digest?.mismatchRuns ?? null,
      artifacts: entry.artifacts ?? null,
    }));
  }

  async loadPromptTemplates(options = undefined) {
    await this.prepare();
    const index = await this._readJSON(this.promptTemplatesIndexFile, { entries: [] });
    if (!Array.isArray(index.entries) || index.entries.length === 0) {
      return [];
    }
    const limitRaw = Number(options?.limit ?? 4);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 4;
    const schemaFilter =
      typeof options?.schemaId === "string" && options.schemaId.trim().length > 0
        ? options.schemaId.trim().toLowerCase()
        : null;
    const cwdFilter = options?.cwd ? path.resolve(options.cwd) : null;
    const results = [];
    for (const entry of index.entries) {
      if (schemaFilter) {
        const entrySchema = typeof entry.schemaId === "string" ? entry.schemaId.toLowerCase() : "";
        if (entrySchema !== schemaFilter) {
          continue;
        }
      }
      const templatePath = path.isAbsolute(entry.file)
        ? entry.file
        : path.join(this.baseDir, entry.file);
      let templateData;
      try {
        templateData = await this._readJSON(templatePath, null);
      } catch {
        continue;
      }
      if (!templateData || typeof templateData !== "object" || !templateData.prompt) {
        continue;
      }
      const resolvedCwd = templateData.cwd ? path.resolve(templateData.cwd) : null;
      if (cwdFilter && resolvedCwd && resolvedCwd !== cwdFilter) {
        continue;
      }
      results.push({
        id: templateData.id ?? entry.id,
        label: entry.label ?? templateData.label ?? entry.id,
        schemaId: entry.schemaId ?? templateData.schemaId ?? null,
        baseline: entry.baseline ?? templateData.baseline ?? null,
        task: templateData.task ?? entry.task ?? null,
        prompt: templateData.prompt,
        metadata: templateData.metadata ?? null,
        createdAt: templateData.createdAt ?? null,
        cwd: resolvedCwd,
        path: templatePath,
        source: "local",
      });
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  async savePromptTemplateBaseline(payload) {
    if (!payload?.prompt) {
      throw new Error("savePromptTemplateBaseline requires a prompt payload.");
    }
    await this.prepare();
    const timestamp = new Date().toISOString();
    const entryId = payload.id ?? randomUUID();
    const record = {
      id: entryId,
      label: payload.label ?? null,
      baseline: payload.baseline ?? null,
      task: payload.task ?? null,
      schemaId: payload.schemaId ?? null,
      prompt: payload.prompt,
      metadata: payload.metadata ?? null,
      cwd: payload.cwd ?? this.startDir,
      createdAt: timestamp,
    };
    const filePath = path.join(this.promptTemplatesDir, `${entryId}.json`);
    await this._writeJSON(filePath, record);
    await this._updatePromptTemplateIndex({
      id: entryId,
      label: record.label,
      baseline: record.baseline,
      schemaId: record.schemaId,
      task: record.task,
      file: this._relative(filePath),
      createdAt: timestamp,
    });
    return { id: entryId, path: filePath };
  }

  async loadPromptSession(promptId) {
    if (!promptId) {
      return null;
    }
    await this.prepare();
    const safeId = this._sanitizeId(promptId);
    const sessionFile = path.join(this.sessionsDir, `${safeId}.json`);
    try {
      const data = await this._readJSON(sessionFile, null);
      if (data && Array.isArray(data.history)) {
        return data.history;
      }
    } catch {
      // ignore malformed sessions
    }
    return null;
  }

  async savePromptSession(promptId, history) {
    if (!promptId) {
      return;
    }
    await this.prepare();
    const safeId = this._sanitizeId(promptId);
    const sessionFile = path.join(this.sessionsDir, `${safeId}.json`);
    await this._writeJSON(sessionFile, {
      id: promptId,
      savedAt: new Date().toISOString(),
      history: Array.isArray(history) ? history : [],
    });
    const index = await this._readJSON(this.promptSessionsIndexFile, { entries: [] });
    const filtered = index.entries.filter((entry) => entry.id !== promptId);
    filtered.unshift({
      id: promptId,
      file: this._relative(sessionFile),
      updatedAt: new Date().toISOString(),
      size: Array.isArray(history) ? history.length : 0,
    });
    index.entries = filtered.slice(0, 200);
    await this._writeJSON(this.promptSessionsIndexFile, index);
    await this._updateRootIndex();
  }

  async recordCommandIdeas(payload) {
    if (!payload || !Array.isArray(payload.commands) || payload.commands.length === 0) {
      return [];
    }
    await this.prepare();
    const timestamp = new Date().toISOString();
    const data = await this._readJSON(this.commandLibraryFile, { entries: [] });
    if (payload.validationStatus === "invalid") {
      const retireSet = new Set(
        payload.commands
          .map((idea) => idea?.command?.toString().trim().toLowerCase())
          .filter(Boolean),
      );
      if (retireSet.size > 0) {
        data.entries = data.entries.filter(
          (entry) => !retireSet.has(entry.command?.toLowerCase() ?? ""),
        );
        await this._writeJSON(this.commandLibraryFile, data);
        await this._updateRootIndex();
      }
      return [];
    }
    const existingKeySet = new Set(
      data.entries.map((entry) => entry.command?.trim().toLowerCase()).filter(Boolean),
    );
    const additions = [];
    for (const idea of payload.commands) {
      const text = typeof idea?.command === "string" ? idea.command.trim() : "";
      if (!text) {
        continue;
      }
      const normalized = text.toLowerCase();
      if (existingKeySet.has(normalized)) {
        continue;
      }
      existingKeySet.add(normalized);
      const entry = {
        id: randomUUID(),
        command: text,
        description: typeof idea?.description === "string" ? idea.description.trim() : null,
        files: Array.isArray(idea?.files)
          ? idea.files.map((file) => file?.toString().trim()).filter(Boolean).slice(0, 8)
          : [],
        owner: typeof idea?.owner === "string" ? idea.owner.trim() : null,
        tags: Array.isArray(idea?.tags)
          ? idea.tags.map((tag) => tag?.toString().trim()).filter(Boolean).slice(0, 8)
          : [],
        executionId: payload.executionId ?? null,
        mode: payload.mode ?? null,
        task: payload.task ?? null,
        source: idea?.source ?? payload.source ?? "analysis",
        createdAt: timestamp,
        schemaId: idea?.schemaId ?? payload.schemaId ?? null,
        contextBudget: payload.contextBudget ?? null,
        status: payload.validationStatus ?? "ok",
      };
      additions.push(entry);
    }
    if (!additions.length) {
      return [];
    }
    data.entries = [...additions, ...data.entries].slice(0, 300);
    await this._writeJSON(this.commandLibraryFile, data);
    await this._updateRootIndex();
    return additions;
  }

  async saveWorkspaceHint(entry) {
    if (!entry) {
      return null;
    }
    await this.prepare();
    const timestamp = new Date().toISOString();
    const root = entry.root ? path.resolve(entry.root) : this.startDir;
    const index = await this._readJSON(this.workspaceHintsFile, { entries: [] });
    const filtered = index.entries.filter((item) => path.resolve(item.root ?? "") !== root);
    const normalized = {
      id: entry.id ?? this._slugify(root),
      root,
      summary: entry.summary ?? null,
      classification: entry.classification ?? null,
      hintBlock: entry.hintBlock ?? null,
      directives: entry.directives ?? null,
      manifestPreview: Array.isArray(entry.manifestPreview) ? entry.manifestPreview.slice(0, 12) : [],
      navigationSummary: entry.navigationSummary ?? null,
      navigationBlock: entry.navigationBlock ?? null,
      updatedAt: timestamp,
    };
    index.entries = [normalized, ...filtered].slice(0, 50);
    await this._writeJSON(this.workspaceHintsFile, index);
    await this._updateRootIndex();
    return normalized;
  }

  async loadWorkspaceHint(rootDir = undefined) {
    await this.prepare();
    const root = rootDir ? path.resolve(rootDir) : this.startDir;
    const index = await this._readJSON(this.workspaceHintsFile, { entries: [] });
    if (!Array.isArray(index.entries) || index.entries.length === 0) {
      return null;
    }
    const found = index.entries.find((item) => path.resolve(item.root ?? "") === root);
    return found ?? index.entries[0] ?? null;
  }

  async loadCommandLibrary(limit = 20) {
    await this.prepare();
    const data = await this._readJSON(this.commandLibraryFile, { entries: [] });
    if (!Array.isArray(data.entries) || data.entries.length === 0) {
      return [];
    }
    const maxEntries = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
    return data.entries.slice(0, maxEntries);
  }

  async recordPromptComposition(payload) {
    if (
      !payload ||
      (!payload.schemaId && !payload.command && !payload.task && !payload.mode)
    ) {
      return null;
    }
    await this.prepare();
    const timestamp = new Date().toISOString();
    const status = this._normalizeCompositionStatus(payload.status);
    const cache = await this._readJSON(this.promptCompositionsFile, { entries: [] });
    const entries = Array.isArray(cache.entries) ? cache.entries : [];
    const key = this._buildCompositionKey(payload);

    if (status === "invalid") {
      cache.entries = entries.filter((entry) => entry.key !== key);
      cache.updatedAt = timestamp;
      await this._writeJSON(this.promptCompositionsFile, cache);
      await this._updateRootIndex();
      return null;
    }

    const existingIndex = entries.findIndex((entry) => entry.key === key);
    const existing = existingIndex !== -1 ? entries[existingIndex] : null;
    const successIncrement = status === "ok" ? 1 : 0;
    const failureIncrement = status === "fallback" ? 1 : 0;
    const entry = {
      id: existing?.id ?? payload.id ?? randomUUID(),
      key,
      schemaId: payload.schemaId ?? existing?.schemaId ?? null,
      mode: payload.mode ?? existing?.mode ?? null,
      task: payload.task ?? existing?.task ?? null,
      command: payload.command ?? existing?.command ?? null,
      workspaceType: payload.workspaceType ?? existing?.workspaceType ?? null,
      contextBudget: Number.isFinite(payload.contextBudget)
        ? Number(payload.contextBudget)
        : existing?.contextBudget ?? null,
      promptLength: Number.isFinite(payload.promptLength)
        ? Number(payload.promptLength)
        : existing?.promptLength ?? null,
      compressedTokens: Number.isFinite(payload.compressedTokens)
        ? Number(payload.compressedTokens)
        : existing?.compressedTokens ?? null,
      fallbackReason: payload.fallbackReason ?? existing?.fallbackReason ?? null,
      source: payload.source ?? existing?.source ?? "runtime",
      executionId: payload.executionId ?? existing?.executionId ?? null,
      promptId: payload.promptId ?? existing?.promptId ?? null,
      planId: payload.planId ?? existing?.planId ?? null,
      notes: payload.notes ?? existing?.notes ?? null,
      status,
      firstSeenAt: existing?.firstSeenAt ?? timestamp,
      updatedAt: timestamp,
      successCount: (existing?.successCount ?? 0) + successIncrement,
      failureCount: (existing?.failureCount ?? 0) + failureIncrement,
    };

    const filtered = entries.filter((item) => item.key !== key);
    cache.entries = [entry, ...filtered].slice(0, 120);
    cache.updatedAt = timestamp;
    await this._writeJSON(this.promptCompositionsFile, cache);
    await this._updateRootIndex();
    return entry;
  }

  async loadPromptCompositions(options = undefined) {
    await this.prepare();
    const cache = await this._readJSON(this.promptCompositionsFile, { entries: [] });
    let entries = Array.isArray(cache.entries) ? cache.entries : [];
    const limit =
      Number.isFinite(Number(options?.limit)) && Number(options.limit) > 0
        ? Number(options.limit)
        : 12;
    const workspaceFilter =
      typeof options?.workspaceType === "string" && options.workspaceType.trim().length
        ? options.workspaceType.trim().toLowerCase()
        : null;
    const modeFilter =
      typeof options?.mode === "string" && options.mode.trim().length
        ? options.mode.trim().toLowerCase()
        : null;
    const includeFallback = Boolean(options?.includeFallback);
    const includeInvalid = Boolean(options?.includeInvalid);

    entries = entries.filter((entry) => {
      if (!entry) {
        return false;
      }
      if (!includeInvalid && entry.status === "invalid") {
        return false;
      }
      if (!includeFallback && entry.status === "fallback") {
        return false;
      }
      if (workspaceFilter) {
        const label = (entry.workspaceType ?? "").toLowerCase();
        if (label && label !== workspaceFilter) {
          return false;
        }
      }
      if (modeFilter) {
        const mode = (entry.mode ?? "").toLowerCase();
        if (mode && mode !== modeFilter) {
          return false;
        }
      }
      return true;
    });

    entries.sort((a, b) => {
      const aTime = Date.parse(a.updatedAt ?? a.firstSeenAt ?? 0) || 0;
      const bTime = Date.parse(b.updatedAt ?? b.firstSeenAt ?? 0) || 0;
      return bTime - aTime;
    });

    return entries.slice(0, limit);
  }

  async loadHelperScripts(options = undefined) {
    await this.prepare();
    const index = await this._readJSON(this.helperScriptsIndexFile, { entries: [] });
    if (!Array.isArray(index.entries) || index.entries.length === 0) {
      return [];
    }
    const limit =
      Number.isFinite(Number(options?.limit)) && Number(options?.limit) > 0
        ? Number(options.limit)
        : 12;
    const workspaceFilter =
      typeof options?.workspaceType === "string" && options.workspaceType.trim().length
        ? options.workspaceType.trim().toLowerCase()
        : null;
    const sourceFilter =
      typeof options?.source === "string" && options.source.trim().length
        ? options.source.trim().toLowerCase()
        : null;
    const search =
      typeof options?.search === "string" && options.search.trim().length
        ? options.search.trim().toLowerCase()
        : null;
    const entries = index.entries
      .filter((entry) => {
        if (!entry) {
          return false;
        }
        if (workspaceFilter) {
          const label = entry.workspaceType?.toLowerCase() ?? "";
          if (!label.includes(workspaceFilter)) {
            return false;
          }
        }
        if (sourceFilter) {
          const label = entry.source?.toLowerCase() ?? "";
          if (!label.includes(sourceFilter)) {
            return false;
          }
        }
        if (search && !this._matchesHelperSearch(entry, search)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const left = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
        const right = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
        return left - right;
      })
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        absolutePath: this._resolveHelperAbsolute(entry.path ?? null),
      }));
    return entries;
  }

  async loadHelperScript(identifier, options = undefined) {
    if (!identifier) {
      return null;
    }
    await this.prepare();
    const normalized =
      typeof identifier === "string" ? identifier.trim().toLowerCase() : String(identifier);
    const index = await this._readJSON(this.helperScriptsIndexFile, { entries: [] });
    if (!Array.isArray(index.entries) || index.entries.length === 0) {
      return null;
    }
    const entry =
      index.entries.find(
        (item) =>
          item?.id === identifier ||
          item?.id === normalized ||
          (typeof item?.name === "string" && item.name.toLowerCase() === normalized),
      ) ?? null;
    if (!entry) {
      return null;
    }
    const selection = this._selectHelperVersion(entry, options?.version);
    const resolvedPath = selection?.path ?? entry.path ?? null;
    const absolutePath = this._resolveHelperAbsolute(resolvedPath);
    return {
      entry,
      path: absolutePath,
      version: selection?.version ?? entry.version ?? null,
      relativePath: resolvedPath,
    };
  }

  async loadTruncationPlan(executionId) {
    if (!executionId) {
      return null;
    }
    await this.prepare();
    const safeId = this._sanitizeId(executionId);
    const planFile = path.join(this.executionsDir, safeId, "truncation-plan.json");
    try {
      return await this._readJSON(planFile, null);
    } catch {
      return null;
    }
  }

  async loadTruncationProgress(executionId) {
    if (!executionId) {
      return null;
    }
    await this.prepare();
    const safeId = this._sanitizeId(executionId);
    const progressFile = path.join(this.executionsDir, safeId, "truncation-progress.json");
    try {
      return await this._readJSON(progressFile, null);
    } catch {
      return null;
    }
  }

  async saveTruncationProgress(executionId, progress) {
    if (!executionId || !progress) {
      return null;
    }
    await this.prepare();
    const safeId = this._sanitizeId(executionId);
    const executionDir = path.join(this.executionsDir, safeId);
    await fs.promises.mkdir(executionDir, { recursive: true });
    const progressFile = path.join(executionDir, "truncation-progress.json");
    const payload = {
      executionId,
      ...progress,
      updatedAt: new Date().toISOString(),
    };
    await this._writeJSON(progressFile, payload);
    return { path: progressFile, relative: this._relative(progressFile) };
  }

  _sanitizeId(raw) {
    if (!raw) {
      return "";
    }
    return raw.replace(/[^A-Za-z0-9._-]/g, "_");
  }

  _normalizeHelperLanguage(language) {
    const normalized = (language ?? "").toString().trim().toLowerCase();
    if (normalized.startsWith("py")) {
      return "python";
    }
    if (normalized.startsWith("node") || normalized === "js" || normalized === "javascript") {
      return "node";
    }
    return "node";
  }

  _resolveHelperAbsolute(target) {
    if (!target) {
      return null;
    }
    return path.isAbsolute(target) ? target : path.join(this.baseDir, target);
  }

  _matchesHelperSearch(entry, needle) {
    if (!entry) {
      return false;
    }
    const haystack = [
      entry.name,
      entry.description,
      entry.notes,
      entry.language,
      entry.source,
      entry.workspaceType,
    ]
      .concat(
        Array.isArray(entry.tags) ? entry.tags : [],
        Array.isArray(entry.history) ? entry.history.map((record) => record.path) : [],
      )
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  }

  _selectHelperVersion(entry, requestedVersion) {
    if (!entry) {
      return { version: entry?.version ?? null, path: entry?.path ?? null };
    }
    const numericVersion = Number(requestedVersion);
    if (!Number.isFinite(numericVersion)) {
      return { version: entry.version ?? null, path: entry.path ?? null };
    }
    if (entry.version === numericVersion && entry.path) {
      return { version: entry.version, path: entry.path };
    }
    const history = Array.isArray(entry.history) ? entry.history : [];
    const match = history.find((record) => record.version === numericVersion);
    if (match?.path) {
      return { version: numericVersion, path: match.path };
    }
    return { version: entry.version ?? null, path: entry.path ?? null };
  }

  _chunkContent(content) {
    if (!content || !content.trim()) {
      return [];
    }

    const lines = content.split(/\r?\n/);
    const segments = [];
    let buffer = [];
    let charCount = 0;
    let startLine = 1;

    lines.forEach((line, index) => {
      const projected = charCount + line.length + 1;
      if (projected > DEFAULT_SEGMENT_SIZE && buffer.length) {
        segments.push(this._createSegment(segments.length + 1, startLine, buffer));
        buffer = [];
        charCount = 0;
        startLine = index + 1;
      }
      buffer.push(line);
      charCount += line.length + 1;
    });

    if (buffer.length) {
      segments.push(this._createSegment(segments.length + 1, startLine, buffer));
    }

    return segments;
  }

  _createSegment(id, startLine, buffer) {
    const text = buffer.join("\n");
    return {
      id,
      startLine,
      endLine: startLine + buffer.length - 1,
      length: text.length,
      text,
    };
  }

  _synthesizeSummary(analysis = "") {
    if (!analysis) {
      return "";
    }
    const sentences = analysis.replace(/\r/g, "").split(/(?<=[.!?])\s+/);
    return sentences.slice(0, 3).join(" ").trim();
  }

  async _updatePromptsHistory(payload, executionId, timestamp, promptFile) {
    const history = await this._readJSON(this.promptsFile, { history: [] });
    const entry = {
      executionId,
      task: payload.task,
      promptHash: this._hashText(payload.result.prompt ?? payload.task ?? ""),
      promptFile: this._relative(promptFile),
      promptId: payload.promptId ?? null,
      createdAt: timestamp,
    };

    history.history.unshift(entry);
    history.history = history.history.slice(0, 200);

    await this._writeJSON(this.promptsFile, history);
    await this._updateRootIndex();
  }

  async _updateKnowledgeBase(payload, executionId, timestamp, summary) {
    if (!payload.result.analysis) {
      return;
    }

    const knowledge = await this._readJSON(this.knowledgeFile, { entries: [] });
    const entry = {
      id: randomUUID(),
      executionId,
      task: payload.task,
      summary: summary || payload.result.analysis.slice(0, 500),
      createdAt: timestamp,
    };

    knowledge.entries.unshift(entry);
    knowledge.entries = knowledge.entries.slice(0, 200);
    await this._writeJSON(this.knowledgeFile, knowledge);

    await this._writeJSON(this.knowledgeIndexFile, {
      updatedAt: timestamp,
      entries: knowledge.entries.map((item) => ({
        id: item.id,
        executionId: item.executionId,
        task: item.task,
        summaryPreview: item.summary.slice(0, 160),
        createdAt: item.createdAt,
      })),
    });
    await this._updateRootIndex();
  }

  async _updateTodoList(analysis, executionId, timestamp) {
    const nextActions = this._extractNextActions(analysis);
    if (nextActions.length === 0) {
      return;
    }

    const todo = await this._readJSON(this.todoFile, { items: [] });
    const existingTexts = new Set(todo.items.map((item) => item.text.toLowerCase()));

    for (const action of nextActions) {
      if (existingTexts.has(action.toLowerCase())) {
        continue;
      }
      todo.items.push({
        id: randomUUID(),
        executionId,
        text: action,
        createdAt: timestamp,
        completed: false,
      });
      existingTexts.add(action.toLowerCase());
    }

    await this._writeJSON(this.todoFile, todo);
    await this._updateRootIndex();
  }

  async _updateExecutionIndex(executionId, metadata, executionIndexFile, task) {
    const index = await this._readJSON(this.executionsIndexFile, { entries: [], byTask: {}, latest: null });
    const entry = {
      id: executionId,
      task,
      mode: metadata.mode,
      createdAt: metadata.createdAt,
      linesAnalyzed: metadata.linesAnalyzed,
      compressedTokens: metadata.compressedTokens,
      status: metadata.status ?? null,
      stopReason: metadata.stopReason ?? null,
      path: this._relative(executionIndexFile),
    };

    index.entries.unshift(entry);
    index.entries = index.entries.slice(0, 200);

    const key = this._hashText(task ?? "unknown-task");
    const taskEntry = index.byTask[key] ?? { task, executions: [] };
    taskEntry.executions = [executionId, ...taskEntry.executions.filter((id) => id !== executionId)].slice(0, 20);
    index.byTask[key] = taskEntry;
    index.latest = entry;

    await this._writeJSON(this.executionsIndexFile, index);
    await this._updateRootIndex();
  }

  async _updatePromptDecompositionIndex(entry) {
    await this._upsertIndexEntry(this.promptDecompositionIndexFile, entry, {
      limit: 200,
    });
    await this._updateRootIndex();
  }

  async _updatePromptTemplateIndex(entry) {
    await this._upsertIndexEntry(this.promptTemplatesIndexFile, entry, {
      limit: 200,
    });
    await this._updateRootIndex();
  }

  async _updateHelperScriptsIndex(entry) {
    await this._upsertIndexEntry(this.helperScriptsIndexFile, entry, {
      limit: 200,
    });
    await this._updateRootIndex();
  }

  async _updateRootIndex() {
    const root = await this._readJSON(this.rootIndexFile, { children: [] });
    root.updatedAt = new Date().toISOString();
    root.children = [
      { name: "executions", file: this._relative(this.executionsIndexFile) },
      { name: "knowledge", file: this._relative(this.knowledgeIndexFile) },
      { name: "prompts", file: this._relative(this.promptsFile) },
      { name: "todo", file: this._relative(this.todoFile) },
      { name: "health", file: this._relative(this.resourceUsageFile) },
      { name: "lmstudio-status", file: this._relative(this.lmStudioStatusFile) },
      { name: "prompt-sessions", file: this._relative(this.promptSessionsIndexFile) },
      { name: "research", file: this._relative(this.researchIndexFile) },
      { name: "history-notes", file: this._relative(this.historyNotesIndexFile) },
      { name: "benchmarks", file: this._relative(this.benchmarkHistoryFile) },
      { name: "prompt-decompositions", file: this._relative(this.promptDecompositionIndexFile) },
      { name: "helpers", file: this._relative(this.helperScriptsIndexFile) },
      { name: "command-library", file: this._relative(this.commandLibraryFile) },
      { name: "prompt-step-journals", file: this._relative(this.promptStepJournalIndexFile) },
      { name: "prompt-templates", file: this._relative(this.promptTemplatesIndexFile) },
      { name: "workspace-hints", file: this._relative(this.workspaceHintsFile) },
      { name: "fallback-cache", file: this._relative(this.fallbackCacheFile) },
      { name: "prompt-compositions", file: this._relative(this.promptCompositionsFile) },
    ];
    await this._writeJSON(this.rootIndexFile, root);
  }

  async recordBenchmarkSummary(summary, options = {}) {
    if (!summary) {
      return;
    }
    await this.prepare();
    const history = await this._readJSON(this.benchmarkHistoryFile, { entries: [] });
    const digest = this._condenseBenchmarkSummary(summary);
    const entry = {
      id: randomUUID(),
      recordedAt: new Date().toISOString(),
      digest,
      artifacts: {
        summary: options.summaryPath ? this._relative(options.summaryPath) : null,
        markdown: options.markdownPath ? this._relative(options.markdownPath) : null,
        html: options.htmlPath ? this._relative(options.htmlPath) : null,
      },
      type: options.type ?? "summary",
    };
    history.entries.unshift(entry);
    history.entries = history.entries.slice(0, 200);
    await this._writeJSON(this.benchmarkHistoryFile, history);
    if (Array.isArray(options.todoItems) && options.todoItems.length) {
      await this.addTodoItems(options.todoItems, {
        source: entry.artifacts.summary ?? digest.directory,
      });
    }
    await this._updateRootIndex();
  }

  async recordHelperScript(script) {
    if (!script?.code) {
      return null;
    }
    await this.prepare();
    const timestamp = new Date().toISOString();
    const language = this._normalizeHelperLanguage(script.language);
    const slug = this._slugify(script.name ?? `helper-${language}`);
    // Use .cjs for Node helpers so they run as CommonJS even inside ESM projects.
    const ext = language === "python" ? ".py" : ".cjs";
    const index = await this._readJSON(this.helperScriptsIndexFile, { entries: [] });
    const existing =
      (script.id && index.entries.find((item) => item.id === script.id)) ||
      index.entries.find(
        (item) =>
          (item.name === slug || item.name === script.name) &&
          this._normalizeHelperLanguage(item.language) === language,
      ) ||
      null;
    const helperId = existing?.id ?? script.id ?? `${slug}-${language}`;
    const version = (existing?.version ?? 0) + 1;
    const versionDir = path.join(this.helperVersionsDir, helperId);
    await fs.promises.mkdir(versionDir, { recursive: true });
    const versionLabel = `v${String(version).padStart(4, "0")}`;
    const fileName = `${versionLabel}-${slug}${ext}`;
    const helperPath = path.join(versionDir, fileName);
    await fs.promises.writeFile(helperPath, (script.code ?? "").replace(/\r\n/g, "\n"), "utf8");

    let rollbackPath = existing?.rollbackPath ?? null;
    if (existing?.path) {
      const previousAbsolute = path.isAbsolute(existing.path)
        ? existing.path
        : path.join(this.baseDir, existing.path);
      try {
        const prevExists = await fs.promises
          .access(previousAbsolute, fs.constants.F_OK)
          .then(() => true)
          .catch(() => false);
        if (prevExists) {
          const rollbackName = `${versionLabel}-rollback-${path.basename(previousAbsolute)}`;
          const rollbackTarget = path.join(versionDir, rollbackName);
          await fs.promises.copyFile(previousAbsolute, rollbackTarget);
          rollbackPath = this._relative(rollbackTarget);
        }
      } catch {
        // ignore rollback copy failures
      }
    }

    const history = Array.isArray(existing?.history) ? existing.history.slice(0, 11) : [];
    history.unshift({
      version,
      path: this._relative(helperPath),
      savedAt: timestamp,
      codeHash: this._hashText(script.code ?? ""),
    });

    const entry = {
      id: helperId,
      name: script.name ?? existing?.name ?? slug,
      description: script.description ?? existing?.description ?? null,
      language,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      version,
      source: script.source ?? existing?.source ?? null,
      objective: script.objective ?? existing?.objective ?? null,
      workspaceType: script.workspaceType ?? existing?.workspaceType ?? null,
      path: this._relative(helperPath),
      previousPath: existing?.path ?? null,
      rollbackPath,
      history: history.slice(0, 12),
      notes: script.notes ?? existing?.notes ?? null,
      runs: Array.isArray(existing?.runs) ? existing.runs : [],
      lastRun: existing?.lastRun ?? null,
      stdinExample: script.stdin ?? existing?.stdinExample ?? null,
    };
    await this._updateHelperScriptsIndex(entry);
    return { entry, path: helperPath };
  }

  async recordHelperScriptRun(run) {
    if (!run?.id) {
      return null;
    }
    await this.prepare();
    const index = await this._readJSON(this.helperScriptsIndexFile, { entries: [] });
    const entryIndex = index.entries.findIndex((item) => item.id === run.id);
    if (entryIndex === -1) {
      return null;
    }
    const timestamp = run.ranAt ?? new Date().toISOString();
    const baseName = `${run.id}-${timestamp.replace(/[:.]/g, "-")}`;
    let stdoutPath = null;
    if (run.stdout && run.stdout.length) {
      stdoutPath = path.join(this.helpersDir, `${baseName}.stdout.log`);
      await fs.promises.writeFile(stdoutPath, run.stdout, "utf8");
    }
    let stderrPath = null;
    if (run.stderr && run.stderr.length) {
      stderrPath = path.join(this.helpersDir, `${baseName}.stderr.log`);
      await fs.promises.writeFile(stderrPath, run.stderr, "utf8");
    }
    const entry = index.entries[entryIndex];
    const runRecord = {
      ranAt: timestamp,
      exitCode: run.exitCode ?? 0,
      command: run.command ?? null,
      stdout: stdoutPath ? this._relative(stdoutPath) : null,
      stderr: stderrPath ? this._relative(stderrPath) : null,
      summary: run.summary ?? null,
      durationMs: run.durationMs ?? null,
      timeoutMs: run.timeoutMs ?? null,
      silenceTimeoutMs: run.silenceTimeoutMs ?? null,
      stdin: run.stdin ?? null,
      silenceExceeded: Boolean(run.silenceExceeded),
      version: entry.version ?? null,
    };
    entry.lastRun = runRecord;
    const previous = Array.isArray(entry.runs) ? entry.runs : [];
    entry.runs = [runRecord, ...previous].slice(0, 5);
    entry.updatedAt = timestamp;
    index.entries[entryIndex] = entry;
    index.updatedAt = new Date().toISOString();
    await this._writeJSON(this.helperScriptsIndexFile, index);
    await this._updateRootIndex();
    return runRecord;
  }

  async addTodoItems(items, { source } = {}) {
    if (!Array.isArray(items) || !items.length) {
      return;
    }
    await this.prepare();
    const todo = await this._readJSON(this.todoFile, { items: [] });
    const normalized = new Set(todo.items.map((item) => item.text.toLowerCase()));
    const now = new Date().toISOString();
    items.forEach((text) => {
      if (!text || normalized.has(text.toLowerCase())) {
        return;
      }
      todo.items.push({
        id: randomUUID(),
        text,
        createdAt: now,
        completed: false,
        source: source ?? null,
      });
      normalized.add(text.toLowerCase());
    });
    await this._writeJSON(this.todoFile, todo);
    await this._updateRootIndex();
  }

  async getCachedNarrative(hash) {
    if (!hash) {
      return null;
    }
    await this.prepare();
    const cache = await this._loadNarrativeCache();
    return cache.entries[hash] ?? null;
  }

  async storeCachedNarrative(hash, payload = {}) {
    if (!hash || !payload.document) {
      return;
    }
    await this.prepare();
    const cache = await this._loadNarrativeCache();
    cache.entries[hash] = {
      document: payload.document,
      relativePath: payload.relativePath ?? null,
      sample: payload.sample ?? null,
      updatedAt: new Date().toISOString(),
    };
    cache.order = cache.order.filter((item) => item !== hash);
    cache.order.unshift(hash);
    const LIMIT = 400;
    while (cache.order.length > LIMIT) {
      const removed = cache.order.pop();
      delete cache.entries[removed];
    }
    await this._writeJSON(this.recomposeNarrativesFile, cache);
    this.recomposeNarrativesCache = cache;
  }

  _condenseBenchmarkSummary(summary) {
    if (summary?.kind === "general-purpose") {
      return {
        analyzedAt: summary.analyzedAt ?? new Date().toISOString(),
        directory: summary.directory ?? "",
        totalRuns: summary.command ? 1 : 0,
        warningRuns: summary.command?.silenceExceeded ? 1 : 0,
        mismatchRuns: 0,
        kind: summary.kind,
        task: summary.task ?? null,
        templates: Array.isArray(summary.templates) ? summary.templates.length : 0,
      };
    }
    const directions = {};
    Object.entries(summary.directions ?? {}).forEach(([direction, details]) => {
      const phases = {};
      Object.entries(details.phases ?? {}).forEach(([phase, stats]) => {
        phases[phase] = {
          avg: Number(stats.averageMs ?? 0),
          min: Number(stats.minMs ?? 0),
          max: Number(stats.maxMs ?? 0),
          runs: stats.runs ?? 0,
        };
      });
      directions[direction] = {
        runs: details.runs ?? 0,
        warnings: details.totalWarnings ?? 0,
        mismatches: details.totalMismatches ?? 0,
        phases,
      };
    });
    return {
      analyzedAt: summary.analyzedAt ?? new Date().toISOString(),
      directory: summary.directory ?? "",
      totalRuns: summary.totalRuns ?? 0,
      warningRuns: summary.warningRuns?.length ?? 0,
      mismatchRuns: summary.mismatchRuns?.length ?? 0,
      directions,
    };
  }

  async _loadNarrativeCache() {
    if (this.recomposeNarrativesCache) {
      return this.recomposeNarrativesCache;
    }
    const cache = (await this._readJSON(this.recomposeNarrativesFile, { entries: {}, order: [] })) ?? {
      entries: {},
      order: [],
    };
    cache.entries = cache.entries ?? {};
    cache.order = Array.isArray(cache.order) ? cache.order : [];
    this.recomposeNarrativesCache = cache;
    return cache;
  }

  async saveResearchReport(report) {
    if (!report) {
      return null;
    }
    await this.prepare();
    const timestamp = report.savedAt ?? new Date().toISOString();
    const normalized = {
      ...report,
      id: report.id ?? randomUUID(),
      savedAt: timestamp,
    };
    const slug = this._slugify(normalized.query ?? "research");
    const baseName = `${timestamp.replace(/[:.]/g, "-")}-${slug}`;
    const jsonPath = path.join(this.researchDir, `${baseName}.json`);
    await this._writeJSON(jsonPath, normalized);
    await this._updateResearchIndex({
      id: normalized.id,
      query: normalized.query,
      provider: normalized.provider ?? "duckduckgo",
      savedAt: normalized.savedAt,
      results: normalized.results?.length ?? 0,
      file: this._relative(jsonPath),
    });
    return { path: jsonPath, id: normalized.id };
  }

  async saveHistoryNote(note, markdownContent) {
    if (!note) {
      return null;
    }
    await this.prepare();
    const timestamp = note.generatedAt ?? new Date().toISOString();
    const normalized = {
      ...note,
      id: note.id ?? randomUUID(),
      generatedAt: timestamp,
    };
    const slug = this._slugify(normalized.label ?? "history");
    const baseName = `${timestamp.replace(/[:.]/g, "-")}-${slug}`;
    const jsonPath = path.join(this.historyNotesDir, `${baseName}.json`);
    const markdownPath = markdownContent ? path.join(this.historyNotesDir, `${baseName}.md`) : null;
    await this._writeJSON(jsonPath, normalized);
    if (markdownPath) {
      await fs.promises.writeFile(markdownPath, markdownContent, "utf8");
    }
    await this._updateHistoryNotesIndex({
      id: normalized.id,
      generatedAt: normalized.generatedAt,
      changed: normalized.changedFiles?.length ?? 0,
      added: normalized.addedFiles?.length ?? 0,
      removed: normalized.removedFiles?.length ?? 0,
      file: this._relative(jsonPath),
      markdown: markdownPath ? this._relative(markdownPath) : null,
    });
    return { jsonPath, markdownPath, id: normalized.id };
  }

  async loadLatestHistoryNote() {
    await this.prepare();
    let files = [];
    try {
      files = await fs.promises.readdir(this.historyNotesDir);
    } catch {
      return null;
    }
    const jsonFiles = files.filter((file) => file.endsWith(".json")).sort();
    if (jsonFiles.length === 0) {
      return null;
    }
    const latest = jsonFiles[jsonFiles.length - 1];
    const fullPath = path.join(this.historyNotesDir, latest);
    const data = await this._readJSON(fullPath, null);
    if (!data) {
      return null;
    }
    return { data, path: fullPath };
  }

  async _updateResearchIndex(entry) {
    await this._upsertIndexEntry(this.researchIndexFile, entry, {
      limit: 200,
    });
    await this._updateRootIndex();
  }

  async _updateHistoryNotesIndex(entry) {
    await this._upsertIndexEntry(this.historyNotesIndexFile, entry, {
      limit: 200,
    });
    await this._updateRootIndex();
  }

  _hashText(text) {
    return createHash("sha1").update(text ?? "", "utf8").digest("hex");
  }

  _buildFallbackKey(datasetHash, promptJournalId = null) {
    const journal =
      typeof promptJournalId === "string" && promptJournalId.trim().length
        ? promptJournalId.trim().toLowerCase()
        : "none";
    return `${datasetHash || "unknown"}::${journal}`;
  }

  async loadFallbackSummary(criteria) {
    if (!criteria?.datasetHash) {
      return null;
    }
    await this.prepare();
    const key = this._buildFallbackKey(criteria.datasetHash, criteria.promptJournalId);
    const cache = await this._readJSON(this.fallbackCacheFile, { entries: [] });
    if (!Array.isArray(cache.entries) || cache.entries.length === 0) {
      return null;
    }
    const index = cache.entries.findIndex((entry) => entry?.key === key);
    if (index === -1) {
      return null;
    }
    const timestamp = new Date().toISOString();
    const entry = {
      ...cache.entries[index],
      hits: (cache.entries[index]?.hits ?? 0) + 1,
      lastUsedAt: timestamp,
    };
    cache.entries[index] = entry;
    cache.updatedAt = timestamp;
    await this._writeJSON(this.fallbackCacheFile, cache);
    await this._updateRootIndex();
    return entry;
  }

  async saveFallbackSummary(payload) {
    if (!payload?.datasetHash || !payload.analysis) {
      return null;
    }
    await this.prepare();
    const key = this._buildFallbackKey(payload.datasetHash, payload.promptJournalId);
    const timestamp = new Date().toISOString();
    const cache = await this._readJSON(this.fallbackCacheFile, { entries: [] });
    const existingEntries = Array.isArray(cache.entries) ? cache.entries : [];
    const filtered = existingEntries.filter((entry) => entry?.key !== key);
    const existing = existingEntries.find((entry) => entry?.key === key);
    const record = {
      id: existing?.id ?? randomUUID(),
      key,
      datasetHash: payload.datasetHash,
      promptJournalId: payload.promptJournalId ?? null,
      promptId: payload.promptId ?? null,
      promptLabel: payload.promptLabel ?? null,
      mode: payload.mode ?? null,
      command: payload.command ?? null,
      filePath: payload.filePath ?? null,
      task: payload.task ?? null,
      analysis: payload.analysis,
      truncationPlan: payload.truncationPlan ?? null,
      workspaceSummary: payload.workspaceSummary ?? null,
      reason: payload.reason ?? null,
      linesAnalyzed: payload.linesAnalyzed ?? null,
      compressedTokens: payload.compressedTokens ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastUsedAt: existing?.lastUsedAt ?? null,
      hits: existing?.hits ?? 0,
    };
    cache.entries = [record, ...filtered].slice(0, 50);
    cache.updatedAt = timestamp;
    await this._writeJSON(this.fallbackCacheFile, cache);
    await this._updateRootIndex();
    return record;
  }

  _extractNextActions(analysis = "") {
    if (!analysis.trim()) {
      return [];
    }

    const lines = analysis.split(/\r?\n/);
    const actions = [];
    let inNextSection = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      if (/^#+\s+.*next steps?/i.test(line) || /^#+\s+.*follow[-\s]?up/i.test(line)) {
        inNextSection = true;
        continue;
      }

      if (/^#+\s+/.test(line) && inNextSection) {
        inNextSection = false;
      }

      if (/^[-*]\s+/.test(line)) {
        const text = line.replace(/^[-*]\s+/, "");
        if (inNextSection || /(next|follow|todo|action)/i.test(text)) {
          actions.push(text);
        }
        continue;
      }

      if (inNextSection) {
        actions.push(line);
      }
    }

    return Array.from(new Set(actions)).slice(0, 10);
  }
}
