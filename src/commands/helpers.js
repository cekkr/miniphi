import fs from "fs";
import path from "path";
import CliExecutor from "../libs/cli-executor.js";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import { parseNumericSetting } from "../libs/cli-utils.js";

function summarizeHelperOutput(stdout, stderr) {
  const parts = [];
  if (stdout && stdout.trim()) {
    parts.push(`stdout ${truncateHelperSnippet(stdout)}`);
  }
  if (stderr && stderr.trim()) {
    parts.push(`stderr ${truncateHelperSnippet(stderr)}`);
  }
  return parts.length ? parts.join(" | ") : null;
}

function truncateHelperSnippet(text, limit = 220) {
  const normalized = (text ?? "").toString().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

export async function handleHelpersCommand({ options, verbose }) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const memory = new MiniPhiMemory(cwd);
  await memory.prepare();
  const limit =
    parseNumericSetting(options.limit, "--limit") ??
    parseNumericSetting(options.count, "--count") ??
    12;
  const workspaceType =
    typeof options["workspace-type"] === "string" && options["workspace-type"].trim().length
      ? options["workspace-type"].trim()
      : null;
  const sourceFilter =
    typeof options.source === "string" && options.source.trim().length
      ? options.source.trim()
      : null;
  const search =
    typeof options.search === "string" && options.search.trim().length
      ? options.search.trim()
      : null;
  let helpers = [];
  try {
    helpers = await memory.loadHelperScripts({
      limit,
      workspaceType,
      source: sourceFilter,
      search,
    });
  } catch (error) {
    console.warn(
      `[MiniPhi][Helpers] Unable to load helper index: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
  const runTargetRaw =
    typeof options.run === "string" && options.run.trim()
      ? options.run.trim()
      : typeof options.id === "string" && options.id.trim()
        ? options.id.trim()
        : null;
  const helperVersion = parseNumericSetting(options.version, "--version");
  const helperTimeout =
    parseNumericSetting(options["helper-timeout"], "--helper-timeout") ?? 60000;
  const helperSilence =
    parseNumericSetting(options["helper-silence-timeout"], "--helper-silence-timeout") ?? 15000;
  const helperCwd = options["helper-cwd"] ? path.resolve(options["helper-cwd"]) : cwd;
  const stdinLiteral = typeof options.stdin === "string" && options.stdin.length ? options.stdin : null;
  const stdinFilePath =
    typeof options["stdin-file"] === "string" && options["stdin-file"].trim()
      ? path.resolve(options["stdin-file"].trim())
      : null;
  let stdinFromFile = null;
  if (stdinFilePath) {
    try {
      stdinFromFile = await fs.promises.readFile(stdinFilePath, "utf8");
    } catch (error) {
      throw new Error(
        `Unable to read --stdin-file ${stdinFilePath}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  const stdinPayload =
    [stdinFromFile, stdinLiteral].filter((value) => typeof value === "string" && value.length).join("\n") ||
    null;

  if (options.json) {
    console.log(JSON.stringify(helpers, null, 2));
  } else if (helpers.length) {
    console.log(
      `[MiniPhi][Helpers] Showing ${helpers.length} helper${
        helpers.length === 1 ? "" : "s"
      } (cwd: ${cwd})`,
    );
    helpers.forEach((helper, idx) => {
      const versionLabel =
        helper.version !== undefined && helper.version !== null
          ? `v${String(helper.version).padStart(4, "0")}`
          : "v?";
      console.log(`\n${idx + 1}. ${helper.name ?? helper.id} [${versionLabel}] (${helper.id})`);
      const metaParts = [`lang: ${helper.language ?? "node"}`];
      if (helper.source) metaParts.push(`source: ${helper.source}`);
      if (helper.workspaceType) metaParts.push(`workspace: ${helper.workspaceType}`);
      if (helper.updatedAt) metaParts.push(`updated: ${helper.updatedAt}`);
      console.log(`   ${metaParts.join(" | ")}`);
      if (helper.description) {
        console.log(`   ${helper.description}`);
      }
      if (helper.lastRun?.summary) {
        console.log(`   last run: ${helper.lastRun.summary}`);
      }
      if (helper.absolutePath && verbose) {
        const rel = path.relative(process.cwd(), helper.absolutePath) || helper.absolutePath;
        console.log(`   path: ${rel}`);
      }
    });
  } else {
    console.log("[MiniPhi][Helpers] No helpers recorded for this workspace yet.");
    if (verbose) {
      console.log(
        `[MiniPhi][Helpers] Index stored at ${
          path.relative(process.cwd(), memory.helperScriptsIndexFile) || memory.helperScriptsIndexFile
        }`,
      );
    }
  }

  if (!runTargetRaw) {
    return;
  }

  const helperRecord = await memory.loadHelperScript(runTargetRaw, { version: helperVersion });
  if (!helperRecord) {
    throw new Error(`Helper "${runTargetRaw}" not found in ${cwd}.`);
  }
  if (!helperRecord.path) {
    throw new Error(
      `Helper "${helperRecord.entry.name ?? helperRecord.entry.id}" does not have a saved file path.`,
    );
  }
  const runner = helperRecord.entry.language === "python" ? "python" : "node";
  const command = `${runner} "${helperRecord.path}"`;
  if (verbose) {
    console.log(
      `[MiniPhi][Helpers] Running ${helperRecord.entry.name ?? helperRecord.entry.id} (${command})`,
    );
  }
  const cli = new CliExecutor();
  let execution;
  const startedAt = Date.now();
  try {
    const result = await cli.executeCommand(command, {
      cwd: helperCwd,
      timeout: helperTimeout,
      maxSilenceMs: helperSilence,
      stdin: stdinPayload,
      captureOutput: true,
      onStdout: (text) => process.stdout.write(text),
      onStderr: (text) => process.stderr.write(text),
    });
    execution = {
      command,
      exitCode: result.code ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: result.durationMs ?? Date.now() - startedAt,
      silenceExceeded: Boolean(result.silenceExceeded),
    };
  } catch (error) {
    execution = {
      command,
      exitCode: typeof error.code === "number" ? error.code : -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? (error instanceof Error ? error.message : String(error)),
      durationMs: error.durationMs ?? Date.now() - startedAt,
      silenceExceeded: Boolean(error.silenceExceeded),
    };
  }
  const summary = summarizeHelperOutput(execution.stdout, execution.stderr);
  const runRecord = await memory.recordHelperScriptRun({
    id: helperRecord.entry.id,
    command: execution.command ?? command,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    summary,
    durationMs: execution.durationMs,
    timeoutMs: helperTimeout,
    silenceTimeoutMs: helperSilence,
    stdin: stdinPayload,
    silenceExceeded: execution.silenceExceeded,
  });
  const stdoutAbs =
    runRecord?.stdout && verbose ? path.resolve(memory.baseDir, runRecord.stdout) : null;
  const stderrAbs =
    runRecord?.stderr && verbose ? path.resolve(memory.baseDir, runRecord.stderr) : null;
  const relStdout =
    stdoutAbs && (path.relative(process.cwd(), stdoutAbs) || stdoutAbs).replace(/\\/g, "/");
  const relStderr =
    stderrAbs && (path.relative(process.cwd(), stderrAbs) || stderrAbs).replace(/\\/g, "/");
  console.log(
    `[MiniPhi][Helpers] ${helperRecord.entry.name ?? helperRecord.entry.id} exited with ${
      execution.exitCode
    }${execution.silenceExceeded ? " (terminated for silence)" : ""} in ${
      execution.durationMs ?? Date.now() - startedAt
    } ms`,
  );
  if (summary) {
    console.log(`[MiniPhi][Helpers] summary: ${summary}`);
  }
  if (relStdout) {
    console.log(`[MiniPhi][Helpers] stdout log: ${relStdout}`);
  }
  if (relStderr) {
    console.log(`[MiniPhi][Helpers] stderr log: ${relStderr}`);
  }
}
