import fs from "fs";
import path from "path";
import { randomUUID, createHash } from "crypto";

const DEFAULT_SEGMENT_SIZE = 2000; // characters per chunk to stay context-friendly

/**
 * Manages the hidden .miniphi directory used for persistent execution state, knowledge, and indexes.
 */
export default class MiniPhiMemory {
  constructor(startDir = process.cwd()) {
    this.startDir = path.resolve(startDir);
    const existingBase = this.#findExistingMiniPhi(this.startDir);
    if (existingBase) {
      this.projectRoot = path.dirname(existingBase);
      this.baseDir = existingBase;
    } else {
      this.projectRoot = this.#detectProjectRoot(this.startDir);
      this.baseDir = path.join(this.projectRoot, ".miniphi");
    }

    this.executionsDir = path.join(this.baseDir, "executions");
    this.indicesDir = path.join(this.baseDir, "indices");
    this.healthDir = path.join(this.baseDir, "health");
    this.historyDir = path.join(this.baseDir, "history");
    this.sessionsDir = path.join(this.baseDir, "prompt-sessions");
    this.researchDir = path.join(this.baseDir, "research");
    this.historyNotesDir = path.join(this.baseDir, "history-notes");
    this.promptExchangesDir = path.join(this.baseDir, "prompt-exchanges");
    this.promptDecompositionsDir = path.join(this.promptExchangesDir, "decompositions");
    this.helpersDir = path.join(this.baseDir, "helpers");
    this.fixedReferencesDir = path.join(this.promptExchangesDir, "fixed-references");

    this.promptsFile = path.join(this.baseDir, "prompts.json");
    this.knowledgeFile = path.join(this.baseDir, "knowledge.json");
    this.todoFile = path.join(this.baseDir, "todo.json");
    this.rootIndexFile = path.join(this.baseDir, "index.json");
    this.executionsIndexFile = path.join(this.indicesDir, "executions-index.json");
    this.knowledgeIndexFile = path.join(this.indicesDir, "knowledge-index.json");
    this.resourceUsageFile = path.join(this.healthDir, "resource-usage.json");
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
    await fs.promises.mkdir(this.helpersDir, { recursive: true });
    await fs.promises.mkdir(this.fixedReferencesDir, { recursive: true });

    await this.#ensureFile(this.promptsFile, { history: [] });
    await this.#ensureFile(this.knowledgeFile, { entries: [] });
    await this.#ensureFile(this.todoFile, { items: [] });
    await this.#ensureFile(this.executionsIndexFile, { entries: [], byTask: {}, latest: null });
    await this.#ensureFile(this.knowledgeIndexFile, { entries: [] });
    await this.#ensureFile(this.resourceUsageFile, { entries: [] });
    await this.#ensureFile(this.promptSessionsIndexFile, { entries: [] });
    await this.#ensureFile(this.researchIndexFile, { entries: [] });
    await this.#ensureFile(this.historyNotesIndexFile, { entries: [] });
    await this.#ensureFile(this.benchmarkHistoryFile, { entries: [] });
    await this.#ensureFile(this.recomposeNarrativesFile, { entries: {}, order: [] });
    await this.#ensureFile(this.promptDecompositionIndexFile, { entries: [] });
    await this.#ensureFile(this.helperScriptsIndexFile, { entries: [] });
    await this.#ensureFile(this.rootIndexFile, {
      updatedAt: new Date().toISOString(),
      children: [
        { name: "executions", file: this.#relative(this.executionsIndexFile) },
        { name: "knowledge", file: this.#relative(this.knowledgeIndexFile) },
        { name: "prompts", file: this.#relative(this.promptsFile) },
        { name: "todo", file: this.#relative(this.todoFile) },
        { name: "health", file: this.#relative(this.resourceUsageFile) },
        { name: "prompt-sessions", file: this.#relative(this.promptSessionsIndexFile) },
        { name: "research", file: this.#relative(this.researchIndexFile) },
        { name: "history-notes", file: this.#relative(this.historyNotesIndexFile) },
        { name: "benchmarks", file: this.#relative(this.benchmarkHistoryFile) },
        { name: "prompt-decompositions", file: this.#relative(this.promptDecompositionIndexFile) },
        { name: "helpers", file: this.#relative(this.helperScriptsIndexFile) },
      ],
    });

    this.prepared = true;
    await this.#updateRootIndex();
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
    await this.#writeJSON(filePath, entry);
    return { entry, path: filePath };
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
      resourceUsage: payload.resourceUsage ?? null,
      promptId: payload.promptId ?? null,
      createdAt: timestamp,
    };

    const promptFile = path.join(executionDir, "prompt.json");
    const analysisFile = path.join(executionDir, "analysis.json");
    const compressionFile = path.join(executionDir, "compression.json");
    const metadataFile = path.join(executionDir, "execution.json");
    const executionIndexFile = path.join(executionDir, "index.json");

    const segments = this.#chunkContent(payload.result.compressedContent ?? "");
    await Promise.all(
      segments.map((segment, idx) => {
        const fileName = path.join(segmentsDir, `segment-${String(idx + 1).padStart(3, "0")}.json`);
        segment.file = this.#relative(fileName);
        return this.#writeJSON(fileName, segment);
      }),
    );

    const summary = this.#synthesizeSummary(payload.result.analysis);

    await this.#writeJSON(metadataFile, metadata);
    await this.#writeJSON(promptFile, {
      task: payload.task,
      prompt: payload.result.prompt,
      contextLength: payload.contextLength ?? null,
      updatedAt: timestamp,
    });
    await this.#writeJSON(analysisFile, {
      analysis: payload.result.analysis,
      summary,
      updatedAt: timestamp,
    });
    await this.#writeJSON(compressionFile, {
      tokens: payload.result.compressedTokens,
      segments: segments.map((segment) => ({
        id: segment.id,
        file: segment.file,
        span: [segment.startLine, segment.endLine],
        length: segment.length,
      })),
      updatedAt: timestamp,
    });
    await this.#writeJSON(executionIndexFile, {
      id: executionId,
      createdAt: timestamp,
      files: {
        metadata: this.#relative(metadataFile),
        prompt: this.#relative(promptFile),
        analysis: this.#relative(analysisFile),
        compression: this.#relative(compressionFile),
        segments: segments.map((segment) => segment.file),
      },
    });

    await this.#updatePromptsHistory(payload, executionId, timestamp, promptFile);
    await this.#updateKnowledgeBase(payload, executionId, timestamp, summary);
    await this.#updateTodoList(payload.result.analysis, executionId, timestamp);
    await this.#updateExecutionIndex(executionId, metadata, executionIndexFile, payload.task);

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
      metadata: payload.metadata ?? null,
      plan: payload.plan,
    };
    const filePath = path.join(this.promptDecompositionsDir, `${planId}.json`);
    await this.#writeJSON(filePath, record);
    await this.#updatePromptDecompositionIndex({
      id: planId,
      createdAt: timestamp,
      summary: record.summary,
      file: this.#relative(filePath),
      outline: record.outline ?? null,
      metadata: record.metadata ?? null,
    });
    return { id: planId, path: filePath };
  }

  async loadPromptSession(promptId) {
    if (!promptId) {
      return null;
    }
    await this.prepare();
    const safeId = this.#sanitizeId(promptId);
    const sessionFile = path.join(this.sessionsDir, `${safeId}.json`);
    try {
      const data = await this.#readJSON(sessionFile, null);
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
    const safeId = this.#sanitizeId(promptId);
    const sessionFile = path.join(this.sessionsDir, `${safeId}.json`);
    await this.#writeJSON(sessionFile, {
      id: promptId,
      savedAt: new Date().toISOString(),
      history: Array.isArray(history) ? history : [],
    });
    const index = await this.#readJSON(this.promptSessionsIndexFile, { entries: [] });
    const filtered = index.entries.filter((entry) => entry.id !== promptId);
    filtered.unshift({
      id: promptId,
      file: this.#relative(sessionFile),
      updatedAt: new Date().toISOString(),
      size: Array.isArray(history) ? history.length : 0,
    });
    index.entries = filtered.slice(0, 200);
    await this.#writeJSON(this.promptSessionsIndexFile, index);
    await this.#updateRootIndex();
  }

  #findExistingMiniPhi(startDir) {
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

  #detectProjectRoot(startDir) {
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

  #sanitizeId(raw) {
    if (!raw) {
      return "";
    }
    return raw.replace(/[^A-Za-z0-9._-]/g, "_");
  }

  #normalizeHelperLanguage(language) {
    const normalized = (language ?? "").toString().trim().toLowerCase();
    if (normalized.startsWith("py")) {
      return "python";
    }
    if (normalized.startsWith("node") || normalized === "js" || normalized === "javascript") {
      return "node";
    }
    return "node";
  }

  async #ensureFile(filePath, defaultValue) {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
    } catch {
      await this.#writeJSON(filePath, defaultValue);
    }
  }

  async #writeJSON(filePath, data) {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async #readJSON(filePath, fallback) {
    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      return JSON.parse(content);
    } catch {
      return fallback;
    }
  }

  #relative(target) {
    return path.relative(this.baseDir, target).replace(/\\/g, "/");
  }

  #chunkContent(content) {
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
        segments.push(this.#createSegment(segments.length + 1, startLine, buffer));
        buffer = [];
        charCount = 0;
        startLine = index + 1;
      }
      buffer.push(line);
      charCount += line.length + 1;
    });

    if (buffer.length) {
      segments.push(this.#createSegment(segments.length + 1, startLine, buffer));
    }

    return segments;
  }

  #createSegment(id, startLine, buffer) {
    const text = buffer.join("\n");
    return {
      id,
      startLine,
      endLine: startLine + buffer.length - 1,
      length: text.length,
      text,
    };
  }

  #synthesizeSummary(analysis = "") {
    if (!analysis) {
      return "";
    }
    const sentences = analysis.replace(/\r/g, "").split(/(?<=[.!?])\s+/);
    return sentences.slice(0, 3).join(" ").trim();
  }

  async #updatePromptsHistory(payload, executionId, timestamp, promptFile) {
    const history = await this.#readJSON(this.promptsFile, { history: [] });
    const entry = {
      executionId,
      task: payload.task,
      promptHash: this.#hashText(payload.result.prompt ?? payload.task ?? ""),
      promptFile: this.#relative(promptFile),
      promptId: payload.promptId ?? null,
      createdAt: timestamp,
    };

    history.history.unshift(entry);
    history.history = history.history.slice(0, 200);

    await this.#writeJSON(this.promptsFile, history);
    await this.#updateRootIndex();
  }

  async #updateKnowledgeBase(payload, executionId, timestamp, summary) {
    if (!payload.result.analysis) {
      return;
    }

    const knowledge = await this.#readJSON(this.knowledgeFile, { entries: [] });
    const entry = {
      id: randomUUID(),
      executionId,
      task: payload.task,
      summary: summary || payload.result.analysis.slice(0, 500),
      createdAt: timestamp,
    };

    knowledge.entries.unshift(entry);
    knowledge.entries = knowledge.entries.slice(0, 200);
    await this.#writeJSON(this.knowledgeFile, knowledge);

    await this.#writeJSON(this.knowledgeIndexFile, {
      updatedAt: timestamp,
      entries: knowledge.entries.map((item) => ({
        id: item.id,
        executionId: item.executionId,
        task: item.task,
        summaryPreview: item.summary.slice(0, 160),
        createdAt: item.createdAt,
      })),
    });
    await this.#updateRootIndex();
  }

  async #updateTodoList(analysis, executionId, timestamp) {
    const nextActions = this.#extractNextActions(analysis);
    if (nextActions.length === 0) {
      return;
    }

    const todo = await this.#readJSON(this.todoFile, { items: [] });
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

    await this.#writeJSON(this.todoFile, todo);
    await this.#updateRootIndex();
  }

  async #updateExecutionIndex(executionId, metadata, executionIndexFile, task) {
    const index = await this.#readJSON(this.executionsIndexFile, { entries: [], byTask: {}, latest: null });
    const entry = {
      id: executionId,
      task,
      mode: metadata.mode,
      createdAt: metadata.createdAt,
      linesAnalyzed: metadata.linesAnalyzed,
      compressedTokens: metadata.compressedTokens,
      path: this.#relative(executionIndexFile),
    };

    index.entries.unshift(entry);
    index.entries = index.entries.slice(0, 200);

    const key = this.#hashText(task ?? "unknown-task");
    const taskEntry = index.byTask[key] ?? { task, executions: [] };
    taskEntry.executions = [executionId, ...taskEntry.executions.filter((id) => id !== executionId)].slice(0, 20);
    index.byTask[key] = taskEntry;
    index.latest = entry;

    await this.#writeJSON(this.executionsIndexFile, index);
    await this.#updateRootIndex();
  }

  async #updatePromptDecompositionIndex(entry) {
    const index = await this.#readJSON(this.promptDecompositionIndexFile, { entries: [] });
    const filtered = index.entries.filter((item) => item.id !== entry.id);
    index.entries = [entry, ...filtered].slice(0, 200);
    index.updatedAt = new Date().toISOString();
    await this.#writeJSON(this.promptDecompositionIndexFile, index);
    await this.#updateRootIndex();
  }

  async #updateHelperScriptsIndex(entry) {
    const index = await this.#readJSON(this.helperScriptsIndexFile, { entries: [] });
    const filtered = index.entries.filter((item) => item.id !== entry.id);
    index.entries = [entry, ...filtered].slice(0, 200);
    index.updatedAt = new Date().toISOString();
    await this.#writeJSON(this.helperScriptsIndexFile, index);
    await this.#updateRootIndex();
  }

  async #updateRootIndex() {
    const root = await this.#readJSON(this.rootIndexFile, { children: [] });
    root.updatedAt = new Date().toISOString();
    root.children = [
      { name: "executions", file: this.#relative(this.executionsIndexFile) },
      { name: "knowledge", file: this.#relative(this.knowledgeIndexFile) },
      { name: "prompts", file: this.#relative(this.promptsFile) },
      { name: "todo", file: this.#relative(this.todoFile) },
      { name: "health", file: this.#relative(this.resourceUsageFile) },
      { name: "prompt-sessions", file: this.#relative(this.promptSessionsIndexFile) },
      { name: "research", file: this.#relative(this.researchIndexFile) },
      { name: "history-notes", file: this.#relative(this.historyNotesIndexFile) },
      { name: "prompt-decompositions", file: this.#relative(this.promptDecompositionIndexFile) },
      { name: "helpers", file: this.#relative(this.helperScriptsIndexFile) },
    ];
    await this.#writeJSON(this.rootIndexFile, root);
  }

  async recordBenchmarkSummary(summary, options = {}) {
    if (!summary) {
      return;
    }
    await this.prepare();
    const history = await this.#readJSON(this.benchmarkHistoryFile, { entries: [] });
    const digest = this.#condenseBenchmarkSummary(summary);
    const entry = {
      id: randomUUID(),
      recordedAt: new Date().toISOString(),
      digest,
      artifacts: {
        summary: options.summaryPath ? this.#relative(options.summaryPath) : null,
        markdown: options.markdownPath ? this.#relative(options.markdownPath) : null,
        html: options.htmlPath ? this.#relative(options.htmlPath) : null,
      },
      type: options.type ?? "summary",
    };
    history.entries.unshift(entry);
    history.entries = history.entries.slice(0, 200);
    await this.#writeJSON(this.benchmarkHistoryFile, history);
    if (Array.isArray(options.todoItems) && options.todoItems.length) {
      await this.addTodoItems(options.todoItems, {
        source: entry.artifacts.summary ?? digest.directory,
      });
    }
    await this.#updateRootIndex();
  }

  async recordHelperScript(script) {
    if (!script?.code) {
      return null;
    }
    await this.prepare();
    const timestamp = new Date().toISOString();
    const language = this.#normalizeHelperLanguage(script.language);
    const slug = this.#slugify(script.name ?? `helper-${language}`);
    const ext = language === "python" ? ".py" : ".js";
    const fileName = `${timestamp.replace(/[:.]/g, "-")}-${slug}${ext}`;
    const helperPath = path.join(this.helpersDir, fileName);
    await fs.promises.writeFile(helperPath, (script.code ?? "").replace(/\r\n/g, "\n"), "utf8");
    const entry = {
      id: script.id ?? randomUUID(),
      name: script.name ?? slug,
      description: script.description ?? null,
      language,
      createdAt: timestamp,
      source: script.source ?? null,
      objective: script.objective ?? null,
      workspaceType: script.workspaceType ?? null,
      path: this.#relative(helperPath),
      notes: script.notes ?? null,
      runs: [],
    };
    await this.#updateHelperScriptsIndex(entry);
    return { entry, path: helperPath };
  }

  async recordHelperScriptRun(run) {
    if (!run?.id) {
      return null;
    }
    await this.prepare();
    const index = await this.#readJSON(this.helperScriptsIndexFile, { entries: [] });
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
      stdout: stdoutPath ? this.#relative(stdoutPath) : null,
      stderr: stderrPath ? this.#relative(stderrPath) : null,
      summary: run.summary ?? null,
    };
    entry.lastRun = runRecord;
    const previous = Array.isArray(entry.runs) ? entry.runs : [];
    entry.runs = [runRecord, ...previous].slice(0, 5);
    index.entries[entryIndex] = entry;
    index.updatedAt = new Date().toISOString();
    await this.#writeJSON(this.helperScriptsIndexFile, index);
    await this.#updateRootIndex();
    return runRecord;
  }

  async addTodoItems(items, { source } = {}) {
    if (!Array.isArray(items) || !items.length) {
      return;
    }
    await this.prepare();
    const todo = await this.#readJSON(this.todoFile, { items: [] });
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
    await this.#writeJSON(this.todoFile, todo);
    await this.#updateRootIndex();
  }

  async getCachedNarrative(hash) {
    if (!hash) {
      return null;
    }
    await this.prepare();
    const cache = await this.#loadNarrativeCache();
    return cache.entries[hash] ?? null;
  }

  async storeCachedNarrative(hash, payload = {}) {
    if (!hash || !payload.document) {
      return;
    }
    await this.prepare();
    const cache = await this.#loadNarrativeCache();
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
    await this.#writeJSON(this.recomposeNarrativesFile, cache);
    this.recomposeNarrativesCache = cache;
  }

  #condenseBenchmarkSummary(summary) {
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

  async #loadNarrativeCache() {
    if (this.recomposeNarrativesCache) {
      return this.recomposeNarrativesCache;
    }
    const cache = (await this.#readJSON(this.recomposeNarrativesFile, { entries: {}, order: [] })) ?? {
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
    const slug = this.#slugify(normalized.query ?? "research");
    const baseName = `${timestamp.replace(/[:.]/g, "-")}-${slug}`;
    const jsonPath = path.join(this.researchDir, `${baseName}.json`);
    await this.#writeJSON(jsonPath, normalized);
    await this.#updateResearchIndex({
      id: normalized.id,
      query: normalized.query,
      provider: normalized.provider ?? "duckduckgo",
      savedAt: normalized.savedAt,
      results: normalized.results?.length ?? 0,
      file: this.#relative(jsonPath),
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
    const slug = this.#slugify(normalized.label ?? "history");
    const baseName = `${timestamp.replace(/[:.]/g, "-")}-${slug}`;
    const jsonPath = path.join(this.historyNotesDir, `${baseName}.json`);
    const markdownPath = markdownContent ? path.join(this.historyNotesDir, `${baseName}.md`) : null;
    await this.#writeJSON(jsonPath, normalized);
    if (markdownPath) {
      await fs.promises.writeFile(markdownPath, markdownContent, "utf8");
    }
    await this.#updateHistoryNotesIndex({
      id: normalized.id,
      generatedAt: normalized.generatedAt,
      changed: normalized.changedFiles?.length ?? 0,
      added: normalized.addedFiles?.length ?? 0,
      removed: normalized.removedFiles?.length ?? 0,
      file: this.#relative(jsonPath),
      markdown: markdownPath ? this.#relative(markdownPath) : null,
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
    const data = await this.#readJSON(fullPath, null);
    if (!data) {
      return null;
    }
    return { data, path: fullPath };
  }

  async #updateResearchIndex(entry) {
    const index = await this.#readJSON(this.researchIndexFile, { entries: [] });
    const filtered = index.entries.filter((item) => item.id !== entry.id);
    index.entries = [entry, ...filtered].slice(0, 200);
    index.updatedAt = new Date().toISOString();
    await this.#writeJSON(this.researchIndexFile, index);
    await this.#updateRootIndex();
  }

  async #updateHistoryNotesIndex(entry) {
    const index = await this.#readJSON(this.historyNotesIndexFile, { entries: [] });
    const filtered = index.entries.filter((item) => item.id !== entry.id);
    index.entries = [entry, ...filtered].slice(0, 200);
    index.updatedAt = new Date().toISOString();
    await this.#writeJSON(this.historyNotesIndexFile, index);
    await this.#updateRootIndex();
  }

  #hashText(text) {
    return createHash("sha1").update(text ?? "", "utf8").digest("hex");
  }

  #slugify(text) {
    const normalized = (text ?? "")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized.slice(0, 48) || "note";
  }

  #extractNextActions(analysis = "") {
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
