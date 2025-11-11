import { spawn } from "child_process";
import os from "os";
import path from "path";

/**
 * Cross-platform command executor that streams stdout/stderr and normalizes shell nuances.
 */
export default class CliExecutor {
  constructor(options = undefined) {
    this.isWindows = os.platform() === "win32";
    this.shell = options?.shell ?? (this.isWindows ? "cmd.exe" : "/bin/bash");
    this.shellArg = options?.shellArg ?? (this.isWindows ? "/c" : "-c");
  }

  /**
   * Execute a command and stream output via callbacks.
   * @param {string} command
   * @param {{
   *   cwd?: string,
   *   timeout?: number,
   *   maxBuffer?: number,
   *   encoding?: BufferEncoding,
   *   env?: NodeJS.ProcessEnv,
   *   onStdout?: (chunk: string) => void,
   *   onStderr?: (chunk: string) => void,
   *   onProgress?: (info: { type: "stdout" | "stderr", data: string, lineCount?: number, bytesRead: number }) => void,
   *   captureOutput?: boolean
   * }} [options]
   */
  async executeCommand(command, options = undefined) {
    const {
      cwd = process.cwd(),
      timeout = 30000,
      maxBuffer = 10 * 1024 * 1024,
      encoding = "utf-8",
      env = process.env,
      onStdout = undefined,
      onStderr = undefined,
      onProgress = undefined,
      captureOutput = true,
    } = options ?? {};

    const normalizedCmd = this.normalizeCommand(command);

    return new Promise((resolve, reject) => {
      const child = spawn(this.shell, [this.shellArg, normalizedCmd], {
        cwd,
        env,
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let lineCount = 0;
      let completed = false;

      const finalize = (error, code) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeoutHandle);
        if (error) {
          reject(error);
          return;
        }
        const result = {
          code,
          success: code === 0,
          stdout: captureOutput ? stdout : "",
          stderr: captureOutput ? stderr : "",
          lineCount,
        };
        if (code === 0) {
          resolve(result);
        } else {
          reject(
            new Error(
              `Command "${command}" exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
            ),
          );
        }
      };

      const timeoutHandle =
        timeout > 0
          ? setTimeout(() => {
              child.kill(this.isWindows ? undefined : "SIGTERM");
              finalize(new Error(`Command timeout after ${timeout}ms`));
            }, timeout)
          : null;

      child.stdout?.on("data", (data) => {
        const text = data.toString(encoding);
        stdoutBytes += data.length;

        if (captureOutput) {
          stdout += text;
          if (stdout.length > maxBuffer) {
            child.kill();
            finalize(new Error("stdout exceeded maxBuffer limit"));
            return;
          }
        }

        lineCount += (text.match(/\n/g) || []).length;
        onStdout?.(text);
        onProgress?.({ type: "stdout", data: text, lineCount, bytesRead: stdoutBytes });
      });

      child.stderr?.on("data", (data) => {
        const text = data.toString(encoding);
        stderrBytes += data.length;

        if (captureOutput) {
          stderr += text;
          if (stderr.length > maxBuffer) {
            child.kill();
            finalize(new Error("stderr exceeded maxBuffer limit"));
            return;
          }
        }

        onStderr?.(text);
        onProgress?.({ type: "stderr", data: text, bytesRead: stderrBytes });
      });

      child.on("close", (code) => finalize(null, code ?? 0));
      child.on("error", (error) => {
        if (error.code === "ENOENT") {
          error.message = `Shell "${this.shell}" not found.`;
        }
        finalize(error);
      });
    });
  }

  /**
   * Normalize a command string for the current platform.
   */
  normalizeCommand(command) {
    if (this.isWindows) {
      return command.replace(/~/g, process.env.USERPROFILE ?? "").replace(/\//g, "\\");
    }
    return command.replace(/~/g, process.env.HOME ?? "").replace(/\\\\/g, "/");
  }

  /**
   * Run a pipe-separated set of commands (platform agnostic).
   * @param {string[]} commands
   * @param {object} [options]
   */
  async executePipeline(commands, options = undefined) {
    const pipeline = commands.join(this.isWindows ? " | " : " | ");
    return this.executeCommand(pipeline, options);
  }

  /**
   * Execute a command and redirect all output into a file.
   * @param {string} command
   * @param {string} outputFile
   * @param {object} [options]
   */
  async executeToFile(command, outputFile, options = undefined) {
    const target = this.isWindows ? outputFile : outputFile;
    const redirected = `${command} > "${path.resolve(target)}" 2>&1`;
    return this.executeCommand(redirected, options);
  }
}
