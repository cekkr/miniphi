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

    this.promptsFile = path.join(this.baseDir, "prompts.json");
    this.knowledgeFile = path.join(this.baseDir, "knowledge.json");
    this.todoFile = path.join(this.baseDir, "todo.json");
    this.rootIndexFile = path.join(this.baseDir, "index.json");
    this.executionsIndexFile = path.join(this.indicesDir, "executions-index.json");
    this.knowledgeIndexFile = path.join(this.indicesDir, "knowledge-index.json");

    this.prepared = false;
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

    await this.#ensureFile(this.promptsFile, { history: [] });
    await this.#ensureFile(this.knowledgeFile, { entries: [] });
    await this.#ensureFile(this.todoFile, { items: [] });
    await this.#ensureFile(this.executionsIndexFile, { entries: [], byTask: {}, latest: null });
    await this.#ensureFile(this.knowledgeIndexFile, { entries: [] });
    await this.#ensureFile(this.rootIndexFile, {
      updatedAt: new Date().toISOString(),
      children: [
        { name: "executions", file: this.#relative(this.executionsIndexFile) },
        { name: "knowledge", file: this.#relative(this.knowledgeIndexFile) },
        { name: "prompts", file: this.#relative(this.promptsFile) },
        { name: "todo", file: this.#relative(this.todoFile) },
      ],
    });

    this.prepared = true;
    return this.baseDir;
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

  async #updateRootIndex() {
    const root = await this.#readJSON(this.rootIndexFile, { children: [] });
    root.updatedAt = new Date().toISOString();
    root.children = [
      { name: "executions", file: this.#relative(this.executionsIndexFile) },
      { name: "knowledge", file: this.#relative(this.knowledgeIndexFile) },
      { name: "prompts", file: this.#relative(this.promptsFile) },
      { name: "todo", file: this.#relative(this.todoFile) },
    ];
    await this.#writeJSON(this.rootIndexFile, root);
  }

  #hashText(text) {
    return createHash("sha1").update(text ?? "", "utf8").digest("hex");
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
