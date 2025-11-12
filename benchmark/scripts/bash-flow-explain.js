#!/usr/bin/env node
import fs from "fs";
import path from "path";

const SAMPLE_ROOT = path.resolve("samples/bash");
const RESULT_DIR = path.resolve("samples/bash-results");
const MIRROR_DIR = path.resolve(".miniphi/benchmarks/bash");
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
const FOCUS_FUNCTIONS = [
  {
    file: "shell.c",
    function: "main",
    label: "shell.c::main (entry pipeline)",
  },
  {
    file: "eval.c",
    function: "reader_loop",
    label: "eval.c::reader_loop (command dispatcher)",
  },
  {
    file: "execute_cmd.c",
    function: "execute_command_internal",
    label: "execute_cmd.c::execute_command_internal (executor core)",
  },
];

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

  const markdown = buildReport(entries, files, sources);
  const { fileName, targetPath } = await writeReport(markdown);
  log(`Generated ${path.relative(process.cwd(), targetPath)}`);
  await mirrorReport(markdown, fileName);
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
  const commentRanges = computeCommentRanges(source);
  const regex = new RegExp(
    `^\\s*(?:[A-Za-z_][A-Za-z0-9_\\s\\*]*\\s+)?${functionName}\\s*\\([^)]*\\)`,
    "gm",
  );
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (isWithinRanges(match.index, commentRanges)) {
      continue;
    }
    const signature = match[0].trim();
    let cursor = match.index + match[0].length;
    while (cursor < source.length && source[cursor] !== "{") {
      cursor += 1;
    }
    if (cursor >= source.length) {
      return null;
    }
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    let depth = 1;
    let index = cursor + 1;
    let body = "";
    while (index < source.length && depth > 0) {
      const char = source[index++];
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
  return null;
}

function computeCommentRanges(source) {
  const ranges = [];
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let inString = null;
  let blockStart = -1;
  let lineStart = -1;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      if (char === "\\" && i + 1 < source.length) {
        i += 2;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      i += 1;
      continue;
    }
    if (!inBlock && !inLine && (char === '"' || char === "'")) {
      inString = char;
      i += 1;
      continue;
    }
    if (!inBlock && !inLine && char === "/" && next === "*") {
      inBlock = true;
      blockStart = i;
      i += 2;
      continue;
    }
    if (inBlock && char === "*" && next === "/") {
      ranges.push({ start: blockStart, end: i + 2 });
      inBlock = false;
      i += 2;
      continue;
    }
    if (!inBlock && !inLine && char === "/" && next === "/") {
      inLine = true;
      lineStart = i;
      i += 2;
      continue;
    }
    if (inLine && char === "\n") {
      ranges.push({ start: lineStart, end: i });
      inLine = false;
    }
    i += 1;
  }
  if (inBlock) {
    ranges.push({ start: blockStart, end: source.length });
  }
  if (inLine) {
    ranges.push({ start: lineStart, end: source.length });
  }
  return ranges;
}

function isWithinRanges(index, ranges) {
  for (const range of ranges) {
    if (index >= range.start && index < range.end) {
      return true;
    }
  }
  return false;
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

function buildReport(entries, files, sources) {
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

  appendAggregatedInsights(lines, entries);
  appendFocusSections(lines, sources);

  lines.push("\n---\nReport crafted by benchmark/scripts/bash-flow-explain.js.");
  return lines.join("\n");
}

function appendAggregatedInsights(lines, entries) {
  if (!entries.length) {
    return;
  }
  lines.push("\n---\n## Global Observations");
  const aggregated = new Map();
  const unresolved = new Map();
  for (const entry of entries) {
    for (const call of entry.calls) {
      aggregated.set(call.name, (aggregated.get(call.name) ?? 0) + call.count);
      if (!call.definition) {
        unresolved.set(call.name, (unresolved.get(call.name) ?? 0) + call.count);
      }
    }
  }
  const topGlobal = [...aggregated.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10);
  lines.push("\n**Top call targets across depth-1 scan**");
  for (const [name, count] of topGlobal) {
    const unresolvedMark = unresolved.has(name) ? " _(definition outside depth)_" : "";
    lines.push(`- \`${name}()\`: ${count} hits${unresolvedMark}`);
  }
  if (unresolved.size) {
    const frequentUnknown = [...unresolved.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5);
    lines.push("\n**Follow-up candidates (missing definitions within depth limit)**");
    for (const [name, count] of frequentUnknown) {
      lines.push(`- \`${name}()\`: ${count} reference(s) without a local definition`);
    }
  }
}

function appendFocusSections(lines, sources) {
  const sections = [];
  for (const focus of FOCUS_FUNCTIONS) {
    const filePath = path.join(SAMPLE_ROOT, focus.file);
    const source = sources.get(filePath);
    if (!source) {
      continue;
    }
    const meta = extractFunctionMeta(source, focus.function);
    if (!meta) {
      continue;
    }
    const callSummary = summarizeCalls(meta.body, sources);
    sections.push({
      ...focus,
      signature: meta.signature,
      line: meta.line,
      callSummary,
      bodyLines: meta.body.split(/\r?\n/).length,
      highlights: deriveHighlights(meta.body, focus.function),
    });
  }

  if (!sections.length) {
    return;
  }

  lines.push("\n---\n## Focus Functions (depth ≤ 1)");
  for (const section of sections) {
    lines.push(`\n### ${section.label}`);
    lines.push(`- File: \`${section.file}\` (line ${section.line})`);
    lines.push(`- Signature: \`${section.signature}\``);
    lines.push(`- Body length: ${section.bodyLines} line(s)`);
    if (section.highlights.length) {
      lines.push("- Highlights:");
      for (const note of section.highlights) {
        lines.push(`  - ${note}`);
      }
    }
    if (section.callSummary.length === 0) {
      lines.push("\n_No additional direct calls detected within focus body._");
      continue;
    }
    lines.push("\n**Direct call activity (top 15)**");
    for (const call of section.callSummary.slice(0, 15)) {
      const descriptor = call.definition
        ? `→ ${call.definition.signature} (${call.definition.file}:${call.definition.line})`
        : "→ definition not found within depth";
      lines.push(`- \`${call.name}()\` × ${call.count} ${descriptor}`);
    }
  }
}

function deriveHighlights(body, functionName = "") {
  const notes = [];
  if (/setjmp/.test(body)) {
    notes.push("Protects execution with `setjmp`/`longjmp` for error recovery.");
  }
  if (functionName !== "reader_loop" && /reader_loop/.test(body)) {
    notes.push("Transfers control to `reader_loop()` to consume parsed commands.");
  }
  if (functionName !== "execute_command_internal" && /execute_command_internal/.test(body)) {
    notes.push("Delegates complex dispatch to `execute_command_internal()`.");
  }
  if (/do_redirections/.test(body)) {
    notes.push("Performs redirect setup via `do_redirections()` before exec paths.");
  }
  if (/run_pending_traps/.test(body)) {
    notes.push("Ensures pending traps run before continuing execution.");
  }
  if (/run_startup_files/.test(body)) {
    notes.push("Handles interactive/login startup files prior to main loop.");
  }
  if (/with_input_from_string/.test(body)) {
    notes.push("Supports `-c` string execution paths via `with_input_from_string()`.");
  }
  return notes.length ? notes : ["No heuristically-detected highlights within focus window."];
}

async function writeReport(content) {
  const nextIndex = await nextExplainIndex();
  const fileName = `EXPLAIN-${String(nextIndex).padStart(3, "0")}.md`;
  const targetPath = path.join(RESULT_DIR, fileName);
  await fs.promises.writeFile(targetPath, content, "utf8");
  return { targetPath, fileName };
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

async function mirrorReport(content, fileName) {
  try {
    await ensureDirectory(MIRROR_DIR);
    const targetPath = path.join(MIRROR_DIR, fileName);
    await fs.promises.writeFile(targetPath, content, "utf8");
    log(`Mirrored report to ${path.relative(process.cwd(), targetPath)}`);
  } catch (error) {
    log(
      `WARN: Unable to mirror EXPLAIN output into .miniphi workspace: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

main().catch((error) => {
  log(`ERROR: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
