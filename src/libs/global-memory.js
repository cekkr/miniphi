import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_DIR_NAME = ".miniphi";

function nowIso() {
  return new Date().toISOString();
}

export default class GlobalMiniPhiMemory {
  constructor(options = undefined) {
    const homeDir = options?.homeDir ?? os.homedir();
    this.baseDir = path.join(homeDir, DEFAULT_DIR_NAME);
    this.configDir = path.join(this.baseDir, "config");
    this.promptsDir = path.join(this.baseDir, "prompts");
    this.promptTemplatesDir = path.join(this.promptsDir, "templates");
    this.metricsDir = path.join(this.baseDir, "metrics");
    this.preferencesDir = path.join(this.baseDir, "preferences");
    this.helpersDir = path.join(this.baseDir, "helpers");
    this.helperVersionsDir = path.join(this.helpersDir, "versions");
    this.commandLibraryFile = path.join(this.helpersDir, "command-library.json");
    this.helperIndexFile = path.join(this.helpersDir, "index.json");
    this.promptTemplateIndexFile = path.join(this.promptTemplatesDir, "index.json");
    this.promptDbPath = path.join(this.promptsDir, "miniphi-prompts.db");
    this.systemProfileFile = path.join(this.configDir, "system-profile.json");
    this.commandPolicyFile = path.join(this.preferencesDir, "command-policy.json");
    this.prepared = false;
  }

  async prepare() {
    if (this.prepared) {
      return this.baseDir;
    }
    await Promise.all([
      fs.promises.mkdir(this.configDir, { recursive: true }),
      fs.promises.mkdir(this.promptsDir, { recursive: true }),
      fs.promises.mkdir(this.promptTemplatesDir, { recursive: true }),
      fs.promises.mkdir(this.metricsDir, { recursive: true }),
      fs.promises.mkdir(this.preferencesDir, { recursive: true }),
      fs.promises.mkdir(this.helpersDir, { recursive: true }),
      fs.promises.mkdir(this.helperVersionsDir, { recursive: true }),
    ]);
    await Promise.all([
      this._ensureFile(this.commandLibraryFile, { entries: [] }),
      this._ensureFile(this.helperIndexFile, { entries: [] }),
      this._ensureFile(this.promptTemplateIndexFile, { entries: [] }),
    ]);
    await this._writeSystemProfile();
    this.prepared = true;
    return this.baseDir;
  }

  async _writeSystemProfile() {
    const profile = {
      updatedAt: nowIso(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? 0,
      memoryGB: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
      nodeVersion: process.version,
      env: {
        shell: process.env.SHELL ?? null,
        terminal: process.env.TERM ?? null,
      },
      versions: process.versions,
    };
    await fs.promises.writeFile(this.systemProfileFile, JSON.stringify(profile, null, 2), "utf8");
  }

  async recordHelperSnapshot(payload) {
    if (!payload?.sourcePath) {
      return null;
    }
    await this.prepare();
    const timestamp = nowIso();
    const slug = this._slugify(payload.name ?? path.basename(payload.sourcePath, path.extname(payload.sourcePath)));
    const ext = path.extname(payload.sourcePath) || ".txt";
    const index = await this._readJSON(this.helperIndexFile, { entries: [] });
    const existing =
      (payload.id && index.entries.find((item) => item.id === payload.id)) ||
      index.entries.find((item) => item.name === (payload.name ?? slug)) ||
      null;
    const helperId = existing?.id ?? payload.id ?? slug;
    const version = (existing?.version ?? 0) + 1;
    const versionDir = path.join(this.helperVersionsDir, helperId);
    await fs.promises.mkdir(versionDir, { recursive: true });
    const versionLabel = `v${String(version).padStart(4, "0")}`;
    const fileName = `${versionLabel}-${slug}${ext}`;
    const destination = path.join(versionDir, fileName);
    await fs.promises.copyFile(payload.sourcePath, destination);

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

    const history = Array.isArray(existing?.history) ? existing.history.slice(0, 9) : [];
    history.unshift({
      version,
      path: this._relative(destination),
      storedAt: timestamp,
    });

    const entry = {
      id: helperId,
      name: payload.name ?? slug,
      description: payload.description ?? existing?.description ?? null,
      workspaceType: payload.workspaceType ?? existing?.workspaceType ?? null,
      storedAt: existing?.storedAt ?? timestamp,
      updatedAt: timestamp,
      path: this._relative(destination),
      previousPath: existing?.path ?? null,
      rollbackPath,
      version,
      history: history.slice(0, 12),
      source: payload.source ?? existing?.source ?? "project",
      originalPath: this._relative(payload.sourcePath),
    };
    const filtered = index.entries.filter((item) => item.id !== entry.id);
    index.entries = [entry, ...filtered].slice(0, 200);
    await this._writeJSON(this.helperIndexFile, index);
    return entry;
  }

  async recordPromptTemplateBaseline(payload) {
    if (!payload?.sourcePath) {
      return null;
    }
    await this.prepare();
    const timestamp = nowIso();
    const normalizedId =
      payload.id ??
      this._slugify(payload.label ?? path.basename(payload.sourcePath, path.extname(payload.sourcePath)));
    const index = await this._readJSON(this.promptTemplateIndexFile, { entries: [] });
    const existing = index.entries.find((entry) => entry.id === normalizedId) ?? null;
    const version = (existing?.version ?? 0) + 1;
    const versionDir = path.join(this.promptTemplatesDir, normalizedId);
    await fs.promises.mkdir(versionDir, { recursive: true });
    const versionLabel = `v${String(version).padStart(4, "0")}`;
    const fileName = `${versionLabel}-${normalizedId}.json`;
    const destination = path.join(versionDir, fileName);
    await fs.promises.copyFile(payload.sourcePath, destination);
    const entry = {
      id: normalizedId,
      label: payload.label ?? existing?.label ?? normalizedId,
      schemaId: payload.schemaId ?? existing?.schemaId ?? null,
      baseline: payload.baseline ?? existing?.baseline ?? null,
      objective: payload.objective ?? existing?.objective ?? null,
      workspaceType: payload.workspaceType ?? existing?.workspaceType ?? null,
      path: this._relative(destination),
      version,
      source: payload.source ?? existing?.source ?? "project",
      updatedAt: timestamp,
    };
    const filtered = index.entries.filter((item) => item.id !== normalizedId);
    index.entries = [entry, ...filtered].slice(0, 200);
    await this._writeJSON(this.promptTemplateIndexFile, index);
    return entry;
  }

  async loadPromptTemplates(options = undefined) {
    await this.prepare();
    const index = await this._readJSON(this.promptTemplateIndexFile, { entries: [] });
    if (!Array.isArray(index.entries) || index.entries.length === 0) {
      return [];
    }
    const limitRaw = Number(options?.limit ?? 4);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 4;
    const schemaFilter =
      typeof options?.schemaId === "string" && options.schemaId.trim().length > 0
        ? options.schemaId.trim().toLowerCase()
        : null;
    const workspaceFilter =
      typeof options?.workspaceType === "string" && options.workspaceType.trim().length > 0
        ? options.workspaceType.trim().toLowerCase()
        : null;
    const results = [];
    for (const entry of index.entries) {
      if (schemaFilter) {
        const entrySchema = typeof entry.schemaId === "string" ? entry.schemaId.toLowerCase() : "";
        if (entrySchema !== schemaFilter) {
          continue;
        }
      }
      if (workspaceFilter) {
        const entryWorkspace =
          typeof entry.workspaceType === "string" ? entry.workspaceType.toLowerCase() : "";
        if (entryWorkspace && entryWorkspace !== workspaceFilter) {
          continue;
        }
      }
      const absolutePath = path.isAbsolute(entry.path)
        ? entry.path
        : path.join(this.baseDir, entry.path);
      let templateData;
      try {
        templateData = await this._readJSON(absolutePath, null);
      } catch {
        continue;
      }
      if (!templateData || typeof templateData !== "object" || !templateData.prompt) {
        continue;
      }
      results.push({
        id: entry.id,
        label: entry.label ?? templateData.label ?? entry.id,
        schemaId: entry.schemaId ?? templateData.schemaId ?? null,
        baseline: entry.baseline ?? templateData.baseline ?? null,
        task: templateData.task ?? entry.objective ?? null,
        prompt: templateData.prompt,
        metadata: templateData.metadata ?? null,
        createdAt: templateData.createdAt ?? entry.updatedAt ?? null,
        path: absolutePath,
        source: entry.source ?? "global",
        workspaceType: entry.workspaceType ?? null,
      });
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  async recordCommandIdeas(payload) {
    if (!payload || !Array.isArray(payload.commands) || payload.commands.length === 0) {
      return [];
    }
    await this.prepare();
    const timestamp = nowIso();
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
      }
      return [];
    }
    const existing = new Set(
      data.entries.map((entry) => entry.command?.trim().toLowerCase()).filter(Boolean),
    );
    const additions = [];
    for (const idea of payload.commands) {
      const cmd = typeof idea?.command === "string" ? idea.command.trim() : "";
      if (!cmd || existing.has(cmd.toLowerCase())) {
        continue;
      }
      existing.add(cmd.toLowerCase());
      additions.push({
        id: idea.id ?? this._slugify(cmd),
        command: cmd,
        description: typeof idea?.description === "string" ? idea.description.trim() : null,
        schemaId: idea.schemaId ?? payload.schemaId ?? null,
        contextBudget: payload.contextBudget ?? null,
        source: idea.source ?? payload.source ?? "analysis",
        createdAt: timestamp,
        status: payload.validationStatus ?? "ok",
      });
    }
    if (!additions.length) {
      return [];
    }
    data.entries = [...additions, ...data.entries].slice(0, 300);
    await this._writeJSON(this.commandLibraryFile, data);
    return additions;
  }

  async loadCommandPolicy() {
    try {
      const raw = await fs.promises.readFile(this.commandPolicyFile, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async saveCommandPolicy(policyPayload) {
    if (!policyPayload) {
      return null;
    }
    const payload = {
      ...policyPayload,
      updatedAt: policyPayload.updatedAt ?? nowIso(),
    };
    await fs.promises.mkdir(this.preferencesDir, { recursive: true });
    await fs.promises.writeFile(
      this.commandPolicyFile,
      JSON.stringify(payload, null, 2),
      "utf8",
    );
    return payload;
  }

  async _ensureFile(filePath, defaultContent) {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
    } catch {
      await fs.promises.writeFile(filePath, JSON.stringify(defaultContent, null, 2), "utf8");
      return;
    }
    try {
      await fs.promises.readFile(filePath, "utf8");
    } catch {
      await fs.promises.writeFile(filePath, JSON.stringify(defaultContent, null, 2), "utf8");
    }
  }

  async _readJSON(filePath, fallback = null) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async _writeJSON(filePath, data) {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  _relative(target) {
    return path.isAbsolute(target) ? path.relative(this.baseDir, target) || target : target;
  }

  _slugify(text) {
    return (text ?? "")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "entry";
  }
}
