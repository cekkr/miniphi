#!/usr/bin/env node
import fs from "fs";
import path from "path";
import process from "process";
import Phi4Handler from "../../src/libs/lms-phi4.js";
import LMStudioManager from "../../src/libs/lmstudio-api.js";
import PromptRecorder from "../../src/libs/prompt-recorder.js";

const SAMPLE_ROOT = path.resolve("samples/bash");
const BENCHMARK_SUITE_DIR = path.resolve("samples/benchmark/bash");
const RESULT_DIR = path.join(BENCHMARK_SUITE_DIR, buildTimestampLabel());
const MIRROR_DIR = path.resolve(".miniphi/benchmarks/bash");
const MAX_DEPTH = 1;
const MAX_FILE_COUNT = 6;
const SNIPPET_LINES = 80;
const CONTEXT_LIMIT = 1800;
const BENCHMARK_WORKSPACE = path.resolve(".miniphi/benchmarks");

async function main() {
  console.log(`[RecursivePrompt] Source root: ${SAMPLE_ROOT}`);
  await ensureDirectory(BENCHMARK_SUITE_DIR);
  await ensureDirectory(RESULT_DIR);
  await ensureDirectory(MIRROR_DIR);
  await ensureDirectory(BENCHMARK_WORKSPACE);

  await pingLmStudioRest();

  const directoryTree = await buildDirectoryTree(SAMPLE_ROOT, MAX_DEPTH);
  const files = await collectSourceFiles(SAMPLE_ROOT, MAX_DEPTH);
  if (!files.length) {
    console.error("[RecursivePrompt] No C files discovered within depth limit.");
    process.exitCode = 1;
    return;
  }
  const selectedFiles = files.slice(0, MAX_FILE_COUNT);
  const snippets = await Promise.all(selectedFiles.map((file) => readSnippet(file.absolute)));

  const manager = new LMStudioManager();
  const phi4 = new Phi4Handler(manager);
  const promptRecorder = new PromptRecorder(BENCHMARK_WORKSPACE);
  await promptRecorder.prepare();
  phi4.setPromptRecorder(promptRecorder);
  const stats = [];
  const transcripts = [];
  const insightLog = [];
  let finalResponse = "";
  const mainPromptId = `bench-bash-${Date.now().toString(36)}`;

  try {
    await phi4.load();
    const overviewPrompt = buildOverviewPrompt(directoryTree, selectedFiles);
    const overview = await runPromptStage(
      phi4,
      "directory-overview",
      overviewPrompt,
      stats,
      transcripts,
      {
        scope: "sub",
        label: "directory-overview",
        mainPromptId,
        metadata: { stage: "directory-overview" },
      },
    );
    insightLog.push({ label: "overview", summary: summarizeForContext(overview) });

    for (let i = 0; i < selectedFiles.length; i += 1) {
      const file = selectedFiles[i];
      const snippet = snippets[i];
      const insightContext = buildInsightContext(insightLog, CONTEXT_LIMIT);
      const prompt = buildFilePrompt(file, snippet, insightContext);
      const label = `file:${file.relative}`;
      const response = await runPromptStage(phi4, label, prompt, stats, transcripts, {
        scope: "sub",
        label,
        mainPromptId,
        metadata: {
          stage: "file-analysis",
          file: file.relative,
        },
      });
      insightLog.push({ label: file.relative, summary: summarizeForContext(response) });
    }

    const synthesisContext = buildInsightContext(insightLog, CONTEXT_LIMIT * 1.5);
    const synthesisPrompt = buildSynthesisPrompt(directoryTree, synthesisContext);
    finalResponse = await runPromptStage(phi4, "synthesis", synthesisPrompt, stats, transcripts, {
      scope: "sub",
      label: "synthesis",
      mainPromptId,
      metadata: { stage: "synthesis" },
    });
  } catch (error) {
    console.error(`[RecursivePrompt] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    try {
      await phi4.eject();
    } catch {
      // ignore unload errors
    }
  }

  const report = buildReport({
    directoryTree,
    selectedFiles,
    stats,
    transcripts,
    finalResponse,
  });

  try {
    const { fileName, targetPath } = await writeReport(report);
    console.log(`[RecursivePrompt] Report saved to ${path.relative(process.cwd(), targetPath)}`);
    await mirrorReport(report, fileName);
  } catch (error) {
    console.error(`[RecursivePrompt] Unable to persist report: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

async function runPromptStage(phi4, label, prompt, stats, transcripts, traceContext = undefined) {
  console.log(`\n[RecursivePrompt] Stage "${label}"`);
  const started = Date.now();
  let transcript = "";
  try {
    const response = await phi4.chatStream(
      prompt,
      (token) => {
        transcript += token;
        process.stdout.write(token);
      },
      undefined,
      (err) => {
        throw new Error(err);
      },
      traceContext,
    );
    const finished = Date.now();
    const entry = {
      stage: label,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      promptChars: prompt.length,
      responseChars: response.length,
    };
    stats.push(entry);
    transcripts.push({
      stage: label,
      prompt: prompt.slice(0, 4000),
      response,
    });
    process.stdout.write("\n");
    return response;
  } catch (error) {
    const finished = Date.now();
    stats.push({
      stage: label,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      promptChars: prompt.length,
      responseChars: transcript.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function pingLmStudioRest() {
  if (typeof fetch !== "function") {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch("http://127.0.0.1:1234/api/v0/models", {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[RecursivePrompt] LM Studio REST ping failed: HTTP ${response.status}`);
    } else {
      console.log("[RecursivePrompt] LM Studio REST API reachable at http://127.0.0.1:1234.");
    }
  } catch (error) {
    console.warn(
      `[RecursivePrompt] Unable to reach LM Studio REST API: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function buildDirectoryTree(root, depthLimit, currentDepth = 0, prefix = "") {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const connector = prefix ? "├─" : "";
    const line = `${prefix}${connector}${entry.name}`;
    lines.push(line);
    if (entry.isDirectory() && currentDepth < depthLimit) {
      const childPrefix = prefix + (connector ? "│  " : "   ");
      const childLines = await buildDirectoryTree(
        path.join(root, entry.name),
        depthLimit,
        currentDepth + 1,
        childPrefix,
      );
      lines.push(...childLines);
    }
  }
  return lines.join("\n");
}

async function collectSourceFiles(root, depthLimit, currentDepth = 0, acc = []) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (currentDepth < depthLimit) {
        await collectSourceFiles(entryPath, depthLimit, currentDepth + 1, acc);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".c")) {
      acc.push({
        absolute: entryPath,
        relative: path.relative(SAMPLE_ROOT, entryPath) || entry.name,
      });
    }
  }
  return acc;
}

async function readSnippet(filePath) {
  const content = await fs.promises.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/).slice(0, SNIPPET_LINES);
  return lines.join("\n");
}

function buildOverviewPrompt(tree, files) {
  const fileList = files.map((file, idx) => `${idx + 1}. ${file.relative}`).join("\n");
  return `You are analyzing the Bash sample repository to prepare a narrative walkthrough of its structure.
Start by describing the directory layout (depth ≤ 1) and highlight the files queued for deeper inspection.

Directory tree (depth ≤ 1):
\`\`\`
${tree}
\`\`\`

Focus files:
${fileList}

Deliver a multi-section Markdown response with:
- A table that captures key subdirectories.
- A short paragraph on the purpose of this sample repository for MiniPhi testing.
- A preview of what each focus file likely implements based on its name & location.
`;
}

function buildFilePrompt(file, snippet, insightContext) {
  const contextBlock = insightContext
    ? `Recent insights:\n${insightContext}\n\nUse the above as reusable knowledge.\n`
    : "";
  return `${contextBlock}We are recursively building a descriptive dossier for Bash sources.
Analyze the following file and explain how it supports the shell startup + execution pipeline.

File: ${file.relative}

Snippet (first ${SNIPPET_LINES} lines):
\`\`\`c
${snippet}
\`\`\`

Tasks:
1. Summarize the primary responsibilities of this file.
2. Describe how its functions interplay with previously analyzed components.
3. Suggest follow-up files (by name) that should be inspected next at depth 1.

Respond with a long-form Markdown section that includes subsections for overview, call flow context, and follow-up cues.`;
}

function buildSynthesisPrompt(tree, insightContext) {
  return `We collected layered insights about the Bash sample repository with a focus on startup and execution code.
Combine the prior findings into a single AI-style walkthrough that:
- Begins with the directory tree context shown below.
- Threads together the relationships surfaced in earlier stages.
- Ends with a TODO list to continue recursive exploration.

Directory tree:
\`\`\`
${tree}
\`\`\`

Condensed insights:
\`\`\`
${insightContext}
\`\`\`

Produce an extended Markdown report with narrative tone, explicit references to file names, and numbered TODOs.`;
}

function summarizeForContext(text, limit = 320) {
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}…`;
}

function buildInsightContext(insights, maxChars) {
  if (!insights.length) {
    return "";
  }
  const chunks = [];
  for (let i = Math.max(0, insights.length - 6); i < insights.length; i += 1) {
    const entry = insights[i];
    chunks.push(`- ${entry.label}: ${entry.summary}`);
  }
  const joined = chunks.join("\n");
  if (joined.length <= maxChars) {
    return joined;
  }
  const start = joined.length - maxChars;
  return joined.slice(start);
}

function buildReport({ directoryTree, selectedFiles, stats, transcripts, finalResponse }) {
  const timestamp = new Date().toISOString();
  const statsLines = stats.map((entry) => {
    const duration = (entry.durationMs / 1000).toFixed(1);
    return `| ${entry.stage} | ${entry.promptChars} | ${entry.responseChars ?? 0} | ${duration}s | ${entry.error ?? "-"} |`;
  });

  const transcriptSections = transcripts
    .map((entry) => {
      const promptPreview = entry.prompt.length > 800 ? `${entry.prompt.slice(0, 800)}…` : entry.prompt;
      return `### Stage: ${entry.stage}

**Prompt preview**
\`\`\`
${promptPreview}
\`\`\`

**Response**
\n${entry.response}\n`;
    })
    .join("\n---\n");

  const filesList = selectedFiles.map((file) => `- ${file.relative}`).join("\n");

  return `# Bash Recursive Prompt Report

- Generated at: ${timestamp}
- Source root: \`${path.relative(process.cwd(), SAMPLE_ROOT) || SAMPLE_ROOT}\`
- Directory depth: ${MAX_DEPTH}
- Focus files (${selectedFiles.length}):
${filesList}

## Directory Tree (depth ≤ ${MAX_DEPTH})
\`\`\`
${directoryTree}
\`\`\`

## Prompt Statistics
| Stage | Prompt chars | Response chars | Duration | Notes |
| --- | --- | --- | --- | --- |
${statsLines.join("\n")}

## Stage Transcripts
${transcriptSections}

## Final Synthesis
${finalResponse}

---
Report generated by benchmark/scripts/bash-recursive-prompts.js.`;
}

async function writeReport(content) {
  const index = await nextRecursiveIndex();
  const fileName = `RECURSIVE-${String(index).padStart(3, "0")}.md`;
  const targetPath = path.join(RESULT_DIR, fileName);
  await fs.promises.writeFile(targetPath, content, "utf8");
  return { fileName, targetPath };
}

async function nextRecursiveIndex() {
  const runDirs = await listBenchmarkRunDirs();
  const numbers = [];
  for (const dir of runDirs) {
    const files = await fs.promises.readdir(dir);
    files.forEach((name) => {
      const match = name.match(/RECURSIVE-(\d+)\.md/i);
      if (match) {
        numbers.push(Number(match[1]));
      }
    });
  }
  if (!numbers.length) {
    return 1;
  }
  return Math.max(...numbers) + 1;
}

async function ensureDirectory(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function mirrorReport(content, fileName) {
  try {
    const targetPath = path.join(MIRROR_DIR, fileName);
    await fs.promises.writeFile(targetPath, content, "utf8");
    console.log(`[RecursivePrompt] Mirrored report to ${path.relative(process.cwd(), targetPath)}`);
  } catch (error) {
    console.warn(
      `[RecursivePrompt] Unable to mirror report into .miniphi workspace: ${error instanceof Error ? error.message : error}`,
    );
  }
}

main().catch((error) => {
  console.error(`[RecursivePrompt] Unexpected failure: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});

function buildTimestampLabel(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = String(date.getFullYear()).slice(-2);
  const minutes = pad(date.getMinutes());
  const hours = pad(date.getHours());
  return `${day}-${month}-${year}_${minutes}-${hours}`;
}

async function listBenchmarkRunDirs() {
  try {
    const entries = await fs.promises.readdir(BENCHMARK_SUITE_DIR, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(BENCHMARK_SUITE_DIR, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
