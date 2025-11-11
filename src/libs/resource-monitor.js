import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_THRESHOLDS = {
  memory: 90,
  cpu: 95,
  vram: 90,
};

const SAMPLE_HISTORY_LIMIT = 180; // keep roughly 15 minutes @5s cadence

export default class ResourceMonitor {
  /**
   * @param {{
   *   thresholds?: { memory?: number, cpu?: number, vram?: number },
   *   sampleInterval?: number,
   *   historyFile?: string,
   *   label?: string
   * }} [options]
   */
  constructor(options = undefined) {
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...(options?.thresholds ?? {}),
    };
    this.sampleInterval = Math.max(0, options?.sampleInterval ?? 5000);
    this.historyFile = options?.historyFile ?? null;
    this.sessionLabel = options?.label ?? "session";
    this.samples = [];
    this.sessionId = randomUUID();
    this.startedAt = null;
    this.timer = null;
    this.lastCpuSnapshot = null;
    this.samplingPromise = null;
  }

  setHistoryFile(filePath) {
    this.historyFile = filePath;
  }

  async start(label = undefined) {
    if (label) {
      this.sessionLabel = label;
    }
    if (this.startedAt) {
      return this.captureSample("session-restart");
    }
    this.samples = [];
    this.startedAt = new Date();
    await this.captureSample("session-start");
    if (this.sampleInterval > 0) {
      this.timer = setInterval(() => {
        this.captureSample("interval").catch(() => {
          // swallowing by design; monitor should not crash CLI
        });
      }, this.sampleInterval);
      this.timer.unref?.();
    }
    return this.getLatestSample();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.startedAt) {
      return null;
    }
    await this.captureSample("session-stop");
    const summary = this.#buildSummary();
    const persisted = await this.#persist(summary);
    this.startedAt = null;
    return { summary, persisted };
  }

  getLatestSample() {
    if (this.samples.length === 0) {
      return null;
    }
    return this.samples[this.samples.length - 1];
  }

  async captureSample(label = "manual") {
    if (this.samplingPromise) {
      return this.samplingPromise;
    }
    this.samplingPromise = (async () => {
      const [memory, cpu, vram] = await Promise.all([
        this.#readMemory(),
        this.#readCpu(),
        this.#readVram(),
      ]);
      const sample = {
        id: randomUUID(),
        label,
        timestamp: new Date().toISOString(),
        memory,
        cpu,
        vram,
      };
      sample.status = this.evaluateSample(sample);
      this.samples.push(sample);
      if (this.samples.length > SAMPLE_HISTORY_LIMIT) {
        this.samples.shift();
      }
      this.samplingPromise = null;
      return sample;
    })().catch((error) => {
      this.samplingPromise = null;
      throw error;
    });

    return this.samplingPromise;
  }

  evaluateSample(sample = undefined) {
    const target = sample ?? this.getLatestSample();
    if (!target) {
      return null;
    }
    return {
      memory: this.#evaluateMetric(target.memory.percent, this.thresholds.memory),
      cpu: this.#evaluateMetric(target.cpu.percent, this.thresholds.cpu),
      vram:
        typeof target.vram.percent === "number"
          ? this.#evaluateMetric(target.vram.percent, this.thresholds.vram)
          : { level: "unknown", percent: null },
    };
  }

  #evaluateMetric(value, threshold) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return { level: "unknown", percent: null };
    }
    const warningThreshold = threshold * 0.85;
    let level = "ok";
    if (value >= threshold) {
      level = "critical";
    } else if (value >= warningThreshold) {
      level = "warning";
    }
    return { level, percent: Number(value.toFixed(2)) };
  }

  #buildSummary() {
    const finishedAt = new Date().toISOString();
    return {
      id: this.sessionId,
      label: this.sessionLabel,
      startedAt: this.startedAt?.toISOString() ?? finishedAt,
      finishedAt,
      os: {
        platform: os.platform(),
        release: os.release(),
        totalMemoryBytes: os.totalmem(),
        logicalCores: os.cpus()?.length ?? 0,
      },
      thresholds: this.thresholds,
      sampleCount: this.samples.length,
      stats: this.#computeStats(),
      warnings: this.#collectWarnings(),
      recentSamples: this.samples.slice(-20),
    };
  }

  #computeStats() {
    const reducer = (key) => {
      const values = this.samples
        .map((sample) => sample[key]?.percent)
        .filter((value) => typeof value === "number" && !Number.isNaN(value));
      if (values.length === 0) {
        return { min: null, max: null, avg: null, latest: null };
      }
      const latest = values[values.length - 1];
      const sum = values.reduce((acc, value) => acc + value, 0);
      return {
        min: Number(Math.min(...values).toFixed(2)),
        max: Number(Math.max(...values).toFixed(2)),
        avg: Number((sum / values.length).toFixed(2)),
        latest: Number(latest.toFixed(2)),
      };
    };

    return {
      memory: reducer("memory"),
      cpu: reducer("cpu"),
      vram: reducer("vram"),
    };
  }

  #collectWarnings() {
    const warnings = [];
    const stats = this.#computeStats();

    if (stats.memory.max !== null && stats.memory.max >= this.thresholds.memory) {
      warnings.push(
        `Memory usage peaked at ${stats.memory.max}% (limit ${this.thresholds.memory}%).`,
      );
    }

    if (stats.cpu.max !== null && stats.cpu.max >= this.thresholds.cpu) {
      warnings.push(`CPU usage peaked at ${stats.cpu.max}% (limit ${this.thresholds.cpu}%).`);
    }

    if (stats.vram.max === null) {
      warnings.push("VRAM usage could not be determined on this host.");
    } else if (stats.vram.max >= this.thresholds.vram) {
      warnings.push(`VRAM usage peaked at ${stats.vram.max}% (limit ${this.thresholds.vram}%).`);
    }

    return warnings;
  }

  async #persist(summary) {
    if (!this.historyFile) {
      return null;
    }
    const historyDir = path.dirname(this.historyFile);
    await fs.promises.mkdir(historyDir, { recursive: true });
    const current = await this.#readJSON(this.historyFile, { entries: [] });
    const entry = {
      ...summary,
      recentSamples: summary.recentSamples,
    };
    current.entries.unshift(entry);
    current.entries = current.entries.slice(0, 50);
    await fs.promises.writeFile(this.historyFile, JSON.stringify(current, null, 2), "utf8");
    return { path: this.historyFile, entry };
  }

  async #readJSON(file, fallback) {
    try {
      const raw = await fs.promises.readFile(file, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
  }

  async #readMemory() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return {
      totalBytes,
      freeBytes,
      usedBytes,
      percent: Number(percent.toFixed(2)),
    };
  }

  async #readCpu() {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) {
      return { percent: 0, logicalCores: 0 };
    }

    const aggregate = cpus.reduce(
      (acc, cpu) => {
        const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
        return {
          idle: acc.idle + cpu.times.idle,
          total: acc.total + total,
        };
      },
      { idle: 0, total: 0 },
    );

    let percent = 0;
    if (this.lastCpuSnapshot) {
      const idleDiff = aggregate.idle - this.lastCpuSnapshot.idle;
      const totalDiff = aggregate.total - this.lastCpuSnapshot.total;
      percent = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
    } else {
      const loadAvg = os.loadavg?.()[0] ?? 0;
      percent = cpus.length > 0 ? (loadAvg / cpus.length) * 100 : 0;
    }
    this.lastCpuSnapshot = aggregate;
    return {
      percent: Number(Math.max(0, Math.min(100, percent)).toFixed(2)),
      logicalCores: cpus.length,
    };
  }

  async #readVram() {
    const strategies = [
      () => this.#queryNvidiaSmi(),
      () => this.#queryWindowsAdapters(),
      () => this.#queryMacSystemProfiler(),
    ];

    for (const strategy of strategies) {
      try {
        const result = await strategy();
        if (result) {
          return result;
        }
      } catch {
        // try next strategy
      }
    }

    return {
      adapters: [],
      totalMB: null,
      usedMB: null,
      percent: null,
      strategy: "unavailable",
    };
  }

  async #queryNvidiaSmi() {
    const stdout = await this.#safeExec("nvidia-smi", [
      "--query-gpu=memory.total,memory.used",
      "--format=csv,noheader,nounits",
    ]);
    if (!stdout) {
      return null;
    }

    const adapters = stdout
      .split(/\r?\n/)
      .map((line, idx) => {
        const [totalStr, usedStr] = line.split(",");
        const totalMB = Number(totalStr?.trim() ?? 0);
        const usedMB = Number(usedStr?.trim() ?? 0);
        if (!Number.isFinite(totalMB) || totalMB <= 0) {
          return null;
        }
        return {
          name: `GPU ${idx}`,
          totalMB,
          usedMB,
          percent: Number(((usedMB / totalMB) * 100).toFixed(2)),
        };
      })
      .filter(Boolean);

    if (adapters.length === 0) {
      return null;
    }

    const totalMB = adapters.reduce((acc, gpu) => acc + gpu.totalMB, 0);
    const usedMB = adapters.reduce((acc, gpu) => acc + gpu.usedMB, 0);
    return {
      adapters,
      totalMB,
      usedMB,
      percent: Number(((usedMB / totalMB) * 100).toFixed(2)),
      strategy: "nvidia-smi",
    };
  }

  async #queryWindowsAdapters() {
    if (os.platform() !== "win32") {
      return null;
    }
    const stdout = await this.#safeExec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json",
    ]);
    if (!stdout) {
      return null;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }
    const adaptersArray = Array.isArray(parsed) ? parsed : [parsed];
    const adapters = adaptersArray
      .map((adapter) => {
        const totalBytes = adapter.AdapterRAM ?? adapter.AdapterRam ?? 0;
        if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
          return null;
        }
        return {
          name: adapter.Name ?? "GPU",
          totalMB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
          usedMB: null,
          percent: null,
        };
      })
      .filter(Boolean);

    if (adapters.length === 0) {
      return null;
    }

    const totalMB = adapters.reduce((acc, gpu) => acc + gpu.totalMB, 0);
    return {
      adapters,
      totalMB,
      usedMB: null,
      percent: null,
      strategy: "win32-cim",
    };
  }

  async #queryMacSystemProfiler() {
    if (os.platform() !== "darwin") {
      return null;
    }
    const stdout = await this.#safeExec("system_profiler", ["SPDisplaysDataType", "-json"]);
    if (!stdout) {
      return null;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }
    const displays = parsed.SPDisplaysDataType ?? [];
    const adapters = displays
      .map((gpu) => {
        const name = gpu.sppci_model ?? gpu._name ?? "GPU";
        const raw = gpu.spdisplays_vram ?? gpu.spdisplays_vram_shared ?? "";
        const totalMB = this.#parseVramString(raw);
        if (!totalMB) {
          return null;
        }
        return { name, totalMB, usedMB: null, percent: null };
      })
      .filter(Boolean);

    if (adapters.length === 0) {
      return null;
    }

    const totalMB = adapters.reduce((acc, gpu) => acc + gpu.totalMB, 0);
    return {
      adapters,
      totalMB,
      usedMB: null,
      percent: null,
      strategy: "system-profiler",
    };
  }

  #parseVramString(raw) {
    if (!raw || typeof raw !== "string") {
      return null;
    }
    const match = raw.match(/([\d.]+)\s*(GB|MB)/i);
    if (!match) {
      return null;
    }
    const value = Number(match[1]);
    if (!Number.isFinite(value)) {
      return null;
    }
    const unit = match[2].toUpperCase();
    return unit === "GB" ? value * 1024 : value;
  }

  async #safeExec(command, args, options = undefined) {
    try {
      const { stdout } = await execFileAsync(command, args, {
        timeout: 4000,
        windowsHide: true,
        ...(options ?? {}),
      });
      return stdout?.trim() ?? "";
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      return null;
    }
  }
}
