import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";

const PYTHON_CANDIDATES = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];

export default class PythonLogSummarizer {
  constructor(pythonScriptPath = undefined) {
    this.scriptPath = pythonScriptPath
      ? path.resolve(pythonScriptPath)
      : path.resolve(process.cwd(), "log_summarizer.py");
  }

  async summarizeLines(lines, levels = 3) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return { success: true, input_lines: 0, summary: [] };
    }
    this._ensureScriptExists();
    const child = await this._spawnPythonProcess();

    const payload = JSON.stringify({ lines, levels });
    let stdout = "";
    let stderr = "";

    return new Promise((resolve, reject) => {
      child.stdout?.on("data", (data) => {
        stdout += data.toString("utf-8");
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString("utf-8");
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Python summarizer exited with code ${code}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (result.success === false) {
            reject(new Error(result.error ?? "Unknown summarizer error"));
            return;
          }
          resolve(result);
        } catch (error) {
          reject(new Error(`Unable to parse summarizer output: ${error instanceof Error ? error.message : error}`));
        }
      });

      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  async summarizeFile(filePath, options = undefined) {
    const { maxLinesPerChunk = 1000, recursionLevels = 3, lineRange = null } = options ?? {};
    const summaries = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let buffer = [];
    let linesIncluded = 0;
    let currentLine = 0;
    const startLine = Number.isFinite(lineRange?.startLine)
      ? Math.max(1, Math.floor(lineRange.startLine))
      : null;
    const endLine = Number.isFinite(lineRange?.endLine)
      ? Math.max(startLine ?? 1, Math.floor(lineRange.endLine))
      : null;
    let rangeCompleted = false;

    return new Promise((resolve, reject) => {
      const flushChunk = () => {
        if (buffer.length === 0) {
          return Promise.resolve();
        }
        const chunk = buffer;
        buffer = [];
        return this.summarizeLines(chunk, recursionLevels).then((summary) => {
          summaries.push(summary);
        });
      };

      rl.on("line", (line) => {
        if (rangeCompleted) {
          return;
        }
        currentLine += 1;
        if (startLine && currentLine < startLine) {
          return;
        }
        if (endLine && currentLine > endLine) {
          rangeCompleted = true;
          rl.close();
          stream.destroy();
          return;
        }
        buffer.push(line);
        linesIncluded += 1;
        if (buffer.length >= maxLinesPerChunk) {
          rl.pause();
          flushChunk()
            .then(() => rl.resume())
            .catch((error) => {
              rl.close();
              reject(error);
            });
        }
      });

      rl.on("close", () => {
        flushChunk()
          .then(() =>
            resolve({
              chunks: summaries,
              totalChunks: summaries.length,
              linesIncluded,
              lineRange:
                startLine || endLine
                  ? {
                      startLine: startLine ?? null,
                      endLine: endLine ?? null,
                    }
                  : null,
            }),
          )
          .catch(reject);
      });

      rl.on("error", reject);
      stream.on("error", reject);
    });
  }

  _ensureScriptExists() {
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`Python summarizer script not found at ${this.scriptPath}`);
    }
  }

  _spawnPythonProcess() {
    return new Promise((resolve, reject) => {
      const tryLaunch = (index) => {
        if (index >= PYTHON_CANDIDATES.length) {
          reject(new Error("Unable to locate a Python interpreter (tried python3, python, py)."));
          return;
        }
        const cmd = PYTHON_CANDIDATES[index];
        let resolved = false;
        let child;
        try {
          child = spawn(cmd, [this.scriptPath]);
        } catch (error) {
          if (error.code === "ENOENT") {
            tryLaunch(index + 1);
          } else {
            reject(error);
          }
          return;
        }

        const handleError = (error) => {
          if (resolved) {
            reject(error);
            return;
          }
          if (error.code === "ENOENT") {
            tryLaunch(index + 1);
          } else {
            reject(error);
          }
        };

        child.once("spawn", () => {
          resolved = true;
          child.off("error", handleError);
          resolve(child);
        });

        child.once("error", handleError);
      };

      tryLaunch(0);
    });
  }
}
