#!/usr/bin/env node
import fs from "fs";
import path from "path";

const SAMPLE_ROOT = path.resolve("samples/bash");
const RESULT_DIR = path.resolve("samples/bash-results");
const DEPTH_LIMIT = 1;
const STOP_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "sizeof",
  "else",
  "case",
  "break",
  "continue",
  "do",
  "goto",
  "main",
]);

const log = (message) => {
  console.log(`[${new Date().toISOString()}] [BashExplain] ${message}`);
};

async function main() {
  if (!fs.existsSync(SAMPLE_ROOT)) {
    log(`ERROR: Missing sample repository at ${SAMPLE_ROOT}`);
    process.exitCode = 1;
    return;
  }
  log(`Scanning ${SAMPLE_ROOT} (depth limit ${DEPTH_LIMIT})`);
  await ensureDirectory(RESULT_DIR);
  const files = await collectCFiles(SAMPLE_ROOT, DEPTH_LIMIT);
  if (!files.length) {
    log("ERROR: No C files were discovered. Ensure samples/bash is populated.");
    process.exitCode = 1;
    return;
  }

  const sources = new Map();
  for (const file of files) {
    const content = await fs.promises.readFile(file, "utf8");
    sources.set(file, content);
  }

  const entries = [];
  for (const [filePath, source] of sources.entries()) {
    const meta = extractFunctionMeta(source, "main");
    if (!meta) {
      continue;
    }
    const relativeFile = path.relative(SAMPLE_ROOT, filePath) || path.basename(filePath);
    const calls = summarizeCalls(meta.body, sources);
    entries.push({
      file: relativeFile,
      absolutePath: filePath,
      line: meta.line,
      signature: meta.signature,
      calls,
    });
  }

  const markdown = buildReport(entries, files);
  const targetPath = await writeReport(markdown);
  log(`Generated ${path.relative(process.cwd(), targetPath)}`);
}

async function collectCFiles(root, depthLimit, currentDepth = 0, acc = []) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (currentDepth < depthLimit) {
        await collectCFiles(entryPath, depthLimit, currentDepth + 1, acc);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".c")) {
      acc.push(entryPath);
    }
  }
  return acc;
}

function extractFunctionMeta(source, functionName) {
  const regex = new RegExp(`\\b${functionName}\\s*\\([^)]*\\)\\s*{`, "m");
  const match = regex.exec(source);
  if (!match) {
    return null;
  }
  const header = match[0];
  const signature = header.replace("{", "").trim();
  const line = source.slice(0, match.index).split(/\r?\n/).length;
  let depth = 1;
  let cursor = match.index + header.length;
  let body = "";
  while (cursor < source.length && depth > 0) {
    const char = source[cursor++];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
    body += char;
  }
  body = body.slice(0, Math.max(0, body.length - 1));
  return { signature, line, body };
}

function summarizeCalls(body, sources) {
  const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const counts = new Map();
  let match;
  while ((match = callPattern.exec(body)) !== null) {
    const fn = match[1];
    if (STOP_WORDS.has(fn)) {
      continue;
    }
    counts.set(fn, (counts.get(fn) ?? 0) + 1);
  }

  const entries = [];
  for (const [name, count] of counts.entries()) {
    const definition = locateDefinition(name, sources);
    entries.push({
      name,
      count,
      definition,
    });
  }

  entries.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return entries;
}

function locateDefinition(name, sources) {
  for (const [filePath, source] of sources.entries()) {
    const regex = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*{`, "m");
    const match = regex.exec(source);
    if (!match) {
      continue;
    }
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    const signature = source.slice(match.index, match.index + 160).split("{")[0]?.trim() ?? name;
    return {
      file: path.relative(SAMPLE_ROOT, filePath) || path.basename(filePath),
      line,
      signature,
    };
  }
  return null;
}

function buildReport(entries, files) {
  const lines = [];
  lines.push("# Bash Sample Execution Flow\n");
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push(`- Source root: \`${path.relative(process.cwd(), SAMPLE_ROOT) || SAMPLE_ROOT}\``);
  lines.push(`- Depth inspected: ${DEPTH_LIMIT}`);
  lines.push(`- Files scanned: ${files.length}`);
  lines.push(`- Main entries analyzed: ${entries.length}`);
  lines.push("");
  lines.push(
    "This report focuses on the first-level call graph anchored at `main` to satisfy the WHY_SAMPLES benchmark requirements.",
  );

  if (entries.length === 0) {
    lines.push("\n> No `main` function was located within the allowed depth. Consider increasing the limit.");
    return lines.join("\n");
  }

  for (const entry of entries) {
    lines.push(`\n## Entry Point: ${entry.file} (line ${entry.line})`);
    lines.push(`Signature: \`${entry.signature}\``);
    if (entry.calls.length === 0) {
      lines.push("\n_No direct calls detected within the parsed body._");
      continue;
    }
    lines.push("\n### Direct Calls");
    for (const call of entry.calls.slice(0, 25)) {
    const descriptor = call.definition
      ? `-> ${call.definition.signature} (in ${call.definition.file}:${call.definition.line})`
      : "-> definition not found within depth";
      lines.push(`- \`${call.name}()\` called ${call.count} time(s) ${descriptor}`);
    }
  }

  lines.push("\n---\nReport crafted by benchmark/scripts/bash-flow-explain.js.");
  return lines.join("\n");
}

async function writeReport(content) {
  const nextIndex = await nextExplainIndex();
  const fileName = `EXPLAIN-${String(nextIndex).padStart(3, "0")}.md`;
  const targetPath = path.join(RESULT_DIR, fileName);
  await fs.promises.writeFile(targetPath, content, "utf8");
  return targetPath;
}

async function nextExplainIndex() {
  try {
    const files = await fs.promises.readdir(RESULT_DIR);
    const numbers = files
      .map((name) => {
        const match = name.match(/EXPLAIN-(\d+)\.md/i);
        return match ? Number(match[1]) : null;
      })
      .filter((value) => Number.isFinite(value));
    if (!numbers.length) {
      return 1;
    }
    return Math.max(...numbers) + 1;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 1;
    }
    throw error;
  }
}

async function ensureDirectory(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

main().catch((error) => {
  log(`ERROR: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
