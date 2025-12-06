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
    const summary = this._buildSummary();
    const persisted = await this._persist(summary);
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
        this._readMemory(),
        this._readCpu(),
        this._readVram(),
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
      memory: this._evaluateMetric(target.memory.percent, this.thresholds.memory),
      cpu: this._evaluateMetric(target.cpu.percent, this.thresholds.cpu),
      vram:
        typeof target.vram.percent === "number"
          ? this._evaluateMetric(target.vram.percent, this.thresholds.vram)
          : { level: "unknown", percent: null },
    };
  }

  _evaluateMetric(value, threshold) {
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

  _buildSummary() {
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
      stats: this._computeStats(),
      warnings: this._collectWarnings(),
      recentSamples: this.samples.slice(-20),
    };
  }

  _computeStats() {
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

  _collectWarnings() {
    const warnings = [];
    const stats = this._computeStats();
    let lastVramSample = null;
    for (let idx = this.samples.length - 1; idx >= 0; idx -= 1) {
      const sample = this.samples[idx];
      if (sample?.vram) {
        lastVramSample = sample.vram;
        break;
      }
    }

    if (stats.memory.max !== null && stats.memory.max >= this.thresholds.memory) {
      warnings.push(
        `Memory usage peaked at ${stats.memory.max}% (limit ${this.thresholds.memory}%).`,
      );
    }

    if (stats.cpu.max !== null && stats.cpu.max >= this.thresholds.cpu) {
      warnings.push(`CPU usage peaked at ${stats.cpu.max}% (limit ${this.thresholds.cpu}%).`);
    }

    if (stats.vram.max === null) {
      if (lastVramSample?.strategy === "dxdiag") {
        warnings.push("VRAM capacity detected via dxdiag but live usage counters were unavailable.");
      } else {
        warnings.push("VRAM usage could not be determined on this host.");
      }
    } else if (stats.vram.max >= this.thresholds.vram) {
      warnings.push(`VRAM usage peaked at ${stats.vram.max}% (limit ${this.thresholds.vram}%).`);
    }

    return warnings;
  }

  async _persist(summary) {
    if (!this.historyFile) {
      return null;
    }
    const historyDir = path.dirname(this.historyFile);
    await fs.promises.mkdir(historyDir, { recursive: true });
    const current = await this._readJSON(this.historyFile, { entries: [] });
    const entry = {
      ...summary,
      recentSamples: summary.recentSamples,
    };
    current.entries.unshift(entry);
    current.entries = current.entries.slice(0, 50);
    await fs.promises.writeFile(this.historyFile, JSON.stringify(current, null, 2), "utf8");
    return { path: this.historyFile, entry };
  }

  async _readJSON(file, fallback) {
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

  async _readMemory() {
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

  async _readCpu() {
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

  async _readVram() {
    const strategies = [
      () => this._queryNvidiaSmi(),
      () => this._queryWindowsAdapters(),
      () => this._queryWindowsDxDiag(),
      () => this._queryMacSystemProfiler(),
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

  async _queryNvidiaSmi() {
    const stdout = await this._safeExec("nvidia-smi", [
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

  async _queryWindowsAdapters() {
    if (os.platform() !== "win32") {
      return null;
    }
    const usageSamples = await this._queryWindowsAdapterUsage();
    const usageMap = new Map(
      usageSamples.map((entry) => [this._normalizeAdapterKey(entry.name), entry]),
    );
    const stdout = await this._safeExec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json",
    ]);
    if (!stdout) {
      return this._buildUsageOnlyVramSnapshot(usageSamples);
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
        const totalMB = Number((totalBytes / (1024 * 1024)).toFixed(2));
        const usage = usageMap.get(this._normalizeAdapterKey(adapter.Name ?? adapter.name ?? ""));
        const usedMB =
          usage && Number.isFinite(usage.usedMB) ? Number(usage.usedMB.toFixed(2)) : null;
        const percent =
          usedMB !== null && Number.isFinite(totalMB) && totalMB > 0
            ? Number(((usedMB / totalMB) * 100).toFixed(2))
            : usage?.percent ?? null;
        return {
          name: adapter.Name ?? "GPU",
          totalMB,
          usedMB,
          percent,
        };
      })
      .filter(Boolean);

    if (adapters.length === 0) {
      const usageFallback = this._buildUsageOnlyVramSnapshot(usageSamples);
      if (usageFallback) {
        return usageFallback;
      }
      return null;
    }

    const totalMB = adapters.reduce((acc, gpu) => acc + gpu.totalMB, 0);
    const usedMB = adapters.reduce(
      (acc, gpu) => acc + (Number.isFinite(gpu.usedMB) ? gpu.usedMB : 0),
      0,
    );
    return {
      adapters,
      totalMB,
      usedMB: usedMB > 0 ? Number(usedMB.toFixed(2)) : null,
      percent:
        usedMB > 0 && totalMB > 0 ? Number(((usedMB / totalMB) * 100).toFixed(2)) : null,
      strategy: "win32-cim",
    };
  }

  async _queryWindowsDxDiag() {
    if (os.platform() !== "win32") {
      return null;
    }
    let tempDir;
    try {
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "miniphi-dxdiag-"));
    } catch {
      tempDir = null;
    }
    if (!tempDir) {
      return null;
    }
    const outputFile = path.join(tempDir, "dxdiag.txt");
    try {
      const ran = await this._safeExec("dxdiag.exe", ["/t", outputFile], {
        timeout: 15000,
        windowsHide: true,
      });
      if (ran === null) {
        return null;
      }
      let raw = null;
      try {
        const buffer = await fs.promises.readFile(outputFile);
        raw = buffer.toString("utf16le");
      } catch {
        try {
          raw = await fs.promises.readFile(outputFile, "utf8");
        } catch {
          raw = null;
        }
      }
      if (!raw) {
        return null;
      }
      const adapters = this._parseDxDiagAdapters(raw);
      if (!adapters.length) {
        return null;
      }
      const totalMB = adapters.reduce((acc, gpu) => acc + gpu.totalMB, 0);
      return {
        adapters,
        totalMB,
        usedMB: null,
        percent: null,
        strategy: "dxdiag",
      };
    } catch {
      return null;
    } finally {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  }

  async _queryMacSystemProfiler() {
    if (os.platform() !== "darwin") {
      return null;
    }
    const stdout = await this._safeExec("system_profiler", ["SPDisplaysDataType", "-json"]);
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
        const totalMB = this._parseVramString(raw);
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

  _parseVramString(raw) {
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

  async _queryWindowsAdapterUsage() {
    if (os.platform() !== "win32") {
      return [];
    }
    const stdout = await this._safeExec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$usage = Get-Counter '\\\\GPU Adapter Memory(*)\\\\Dedicated Usage' -ErrorAction SilentlyContinue; $limit = Get-Counter '\\\\GPU Adapter Memory(*)\\\\Dedicated Limit' -ErrorAction SilentlyContinue; $limitMap = @{}; if ($limit) { $limit.CounterSamples | ForEach-Object { $limitMap[$_.InstanceName] = $_.CookedValue } } $results = @(); if ($usage) { foreach ($sample in $usage.CounterSamples) { $limitVal = $limitMap[$sample.InstanceName]; $results += [pscustomobject]@{ Name = $sample.InstanceName; DedicatedUsageBytes = $sample.CookedValue; DedicatedLimitBytes = $limitVal } } } $results | ConvertTo-Json -Compress",
    ]);
    if (!stdout) {
      return [];
    }
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return [];
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((entry) => {
        const usedBytes = Number(entry.DedicatedUsageBytes ?? entry.dedicatedUsageBytes ?? 0);
        const limitBytes = Number(entry.DedicatedLimitBytes ?? entry.dedicatedLimitBytes ?? 0);
        const usedMB = Number.isFinite(usedBytes)
          ? Number((usedBytes / (1024 * 1024)).toFixed(2))
          : null;
        const limitMB =
          Number.isFinite(limitBytes) && limitBytes > 0
            ? Number((limitBytes / (1024 * 1024)).toFixed(2))
            : null;
        const percent =
          limitMB && usedMB !== null ? Number(((usedMB / limitMB) * 100).toFixed(2)) : null;
        return {
          name: entry.Name ?? entry.InstanceName ?? "GPU",
          usedMB,
          limitMB,
          percent,
        };
      })
      .filter(Boolean);
  }

  _buildUsageOnlyVramSnapshot(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
      return null;
    }
    const adapters = samples
      .map((entry, idx) => {
        if (!Number.isFinite(entry.limitMB) || entry.limitMB <= 0) {
          return null;
        }
        const totalMB = Number(entry.limitMB.toFixed(2));
        const usedMB =
          typeof entry.usedMB === "number" ? Number(entry.usedMB.toFixed(2)) : null;
        const percent =
          typeof entry.percent === "number"
            ? Number(entry.percent.toFixed(2))
            : usedMB !== null
              ? Number(((usedMB / totalMB) * 100).toFixed(2))
              : null;
        return {
          name: entry.name ?? `GPU ${idx}`,
          totalMB,
          usedMB,
          percent,
        };
      })
      .filter(Boolean);
    if (adapters.length === 0) {
      return null;
    }
    const totalMB = adapters.reduce((acc, gpu) => acc + gpu.totalMB, 0);
    const usedMB = adapters.reduce(
      (acc, gpu) => acc + (typeof gpu.usedMB === "number" ? gpu.usedMB : 0),
      0,
    );
    return {
      adapters,
      totalMB,
      usedMB: Number(usedMB.toFixed(2)),
      percent: totalMB > 0 ? Number(((usedMB / totalMB) * 100).toFixed(2)) : null,
      strategy: "win32-counters",
    };
  }

  _parseDxDiagAdapters(raw) {
    if (!raw || typeof raw !== "string") {
      return [];
    }
    const adapters = [];
    let current = null;
    const flush = () => {
      if (!current || !current.name) {
        return;
      }
      const totalMB = current.dedicatedMB ?? current.displayMB ?? null;
      if (!Number.isFinite(totalMB) || totalMB <= 0) {
        return;
      }
      adapters.push({
        name: current.name,
        totalMB: Number(totalMB.toFixed(2)),
        usedMB: null,
        percent: null,
      });
    };
    const lines = raw.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (/^card name:/i.test(line)) {
        flush();
        current = { name: line.split(":")[1]?.trim() || "GPU" };
        continue;
      }
      if (!current) {
        continue;
      }
      if (/^display memory:/i.test(line)) {
        current.displayMB = this._extractMegabytesFromLine(line);
        continue;
      }
      if (/^dedicated memory:/i.test(line)) {
        current.dedicatedMB = this._extractMegabytesFromLine(line);
        continue;
      }
      if (/^shared memory:/i.test(line)) {
        current.sharedMB = this._extractMegabytesFromLine(line);
        continue;
      }
    }
    flush();
    return adapters;
  }

  _extractMegabytesFromLine(line) {
    const match = line.match(/([\d.,]+)\s*(MB|GB)/i);
    if (!match) {
      return null;
    }
    const value = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      return null;
    }
    const unit = match[2].toUpperCase();
    return unit === "GB" ? value * 1024 : value;
  }

  _normalizeAdapterKey(name) {
    if (!name || typeof name !== "string") {
      return "";
    }
    return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  }

  async _safeExec(command, args, options = undefined) {
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
