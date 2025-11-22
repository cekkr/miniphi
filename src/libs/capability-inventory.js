import fs from "fs";
import path from "path";

const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_MINIPHI_COMMANDS = ["run", "analyze-file", "web-research", "history-notes", "recompose", "benchmark"];

export default class CapabilityInventory {
  constructor(options = undefined) {
    this.maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  }

  async describe(rootDir = process.cwd()) {
    const root = path.resolve(rootDir);
    const [packageScripts, scriptFiles, binTools] = await Promise.all([
      this._readPackageScripts(root),
      this._listScriptsDirectory(root),
      this._listNodeBin(root),
    ]);
    const capabilities = {
      packageScripts,
      scriptFiles,
      binTools,
      miniPhiCommands: DEFAULT_MINIPHI_COMMANDS,
      osCommands: this._detectOsCommands(),
    };
    return {
      summary: this._formatSummary(capabilities),
      details: capabilities,
    };
  }

  async _readPackageScripts(root) {
    const packagePath = path.join(root, "package.json");
    try {
      const raw = await fs.promises.readFile(packagePath, "utf8");
      const parsed = JSON.parse(raw);
      const scripts = parsed?.scripts ?? {};
      return Object.entries(scripts)
        .slice(0, this.maxItems)
        .map(([name, command]) => ({
          name,
          command,
        }));
    } catch {
      return [];
    }
  }

  async _listScriptsDirectory(root) {
    const scriptsDir = path.join(root, "scripts");
    try {
      const stats = await fs.promises.stat(scriptsDir);
      if (!stats.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }
    try {
      const files = await fs.promises.readdir(scriptsDir);
      return files
        .filter((file) => !file.startsWith("."))
        .slice(0, this.maxItems)
        .map((file) => path.join("scripts", file).replace(/\\/g, "/"));
    } catch {
      return [];
    }
  }

  async _listNodeBin(root) {
    const binDir = path.join(root, "node_modules", ".bin");
    try {
      const stats = await fs.promises.stat(binDir);
      if (!stats.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }
    try {
      const entries = await fs.promises.readdir(binDir);
      return entries
        .filter((entry) => !entry.startsWith("."))
        .slice(0, this.maxItems)
        .map((entry) => entry.replace(/\\/g, "/"));
    } catch {
      return [];
    }
  }

  _detectOsCommands() {
    if (process.platform === "win32") {
      return ["powershell.exe", "cmd.exe", "python", "node"];
    }
    if (process.platform === "darwin") {
      return ["zsh", "bash", "python3", "node"];
    }
    return ["bash", "sh", "python3", "node"];
  }

  _formatSummary(capabilities) {
    const lines = [];
    if (capabilities.packageScripts.length) {
      const entries = capabilities.packageScripts
        .map((script) => script.name)
        .slice(0, this.maxItems)
        .join(", ");
      lines.push(`Package scripts: ${entries}`);
    }
    if (capabilities.scriptFiles.length) {
      lines.push(`scripts/: ${capabilities.scriptFiles.join(", ")}`);
    }
    if (capabilities.binTools.length) {
      lines.push(`node_modules/.bin: ${capabilities.binTools.join(", ")}`);
    }
    if (capabilities.osCommands.length) {
      lines.push(`Shell commands: ${capabilities.osCommands.join(", ")}`);
    }
    lines.push(`MiniPhi helpers: ${capabilities.miniPhiCommands.join(", ")}`);
    return lines.join("\n");
  }
}
