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
    this.metricsDir = path.join(this.baseDir, "metrics");
    this.preferencesDir = path.join(this.baseDir, "preferences");
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
      fs.promises.mkdir(this.metricsDir, { recursive: true }),
      fs.promises.mkdir(this.preferencesDir, { recursive: true }),
    ]);
    await this.#writeSystemProfile();
    this.prepared = true;
    return this.baseDir;
  }

  async #writeSystemProfile() {
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
}
