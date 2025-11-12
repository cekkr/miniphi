#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { Language, Parser } from "web-tree-sitter";

const SAMPLE_ROOT = path.resolve("samples/bash");
const RESULT_DIR = path.resolve("samples/bash-results");
const MIRROR_DIR = path.resolve(".miniphi/benchmarks/bash");
const DEPTH_LIMIT = 1;
const FLOW_DEPTH = 2;
const MAX_CALLS_PER_FUNCTION = 80;
const MAX_FLOW_STEPS = 40;
const RESERVED_CALL_NAMES = new Set([
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
  "defined",
  "USE_VAR",
]);

const FOCUS_FUNCTIONS = [
  {
    file: "shell.c",
    function: "main",
    label: "Shell startup (`shell.c::main`)",
  },
  {
    file: "eval.c",
    function: "reader_loop",
    label: "Reader loop (`eval.c::reader_loop`)",
  },
  {
    file: "execute_cmd.c",
    function: "execute_command_internal",
    label: "Executor core (`execute_cmd.c::execute_command_internal`)",
  },
];

const LANGUAGE_WASM = path.resolve("node_modules/tree-sitter-c/tree-sitter-c.wasm");
const RUNTIME_WASM = path.resolve("node_modules/web-tree-sitter/tree-sitter.wasm");
let parserInstance = null;

async function ensureParser() {
  if (parserInstance) {
    return parserInstance;
  }
  if (!fs.existsSync(LANGUAGE_WASM)) {
    throw new Error(`Missing tree-sitter-c language wasm at ${LANGUAGE_WASM}`);
  }
  if (!fs.existsSync(RUNTIME_WASM)) {
    throw new Error(`Missing web-tree-sitter runtime wasm at ${RUNTIME_WASM}`);
  }
  await Parser.init({
    locateFile(scriptName, scriptDir) {
      if (scriptName === "tree-sitter.wasm") {
        return RUNTIME_WASM;
      }
      return path.join(scriptDir, scriptName);
    },
  });
  const language = await Language.load(LANGUAGE_WASM);
  const parser = new Parser();
  parser.setLanguage(language);
  parserInstance = parser;
  return parserInstance;
}

const log = (message) => {
  console.log(`[${new Date().toISOString()}] [BashExplain] ${message}`);
};

async function main() {
  const parser = await ensureParser();
  if (!fs.existsSync(SAMPLE_ROOT)) {
    log(`ERROR: Missing sample repository at ${SAMPLE_ROOT}`);
    process.exitCode = 1;
    return;
  }

  log(`Scanning ${SAMPLE_ROOT} (depth limit ${DEPTH_LIMIT})`);
  await ensureDirectory(RESULT_DIR);
  const files = await collectCFiles(SAMPLE_ROOT, DEPTH_LIMIT);
  if (files.length === 0) {
    log("ERROR: No C files were discovered. Ensure samples/bash is populated.");
    process.exitCode = 1;
    return;
  }

  const sources = new Map();
  for (const file of files) {
    const content = await fs.promises.readFile(file, "utf8");
    sources.set(file, content);
  }

  const functionIndex = buildFunctionIndex(parser, files, sources);
  applyFallbackTargets(functionIndex, sources, FOCUS_FUNCTIONS);
  const mainEntries = dedupeFunctions(functionIndex.functionsByName.get("main") ?? []);
  const shellMain = selectFunction(functionIndex.functionsByName, "main", "shell.c");
  const focusFlows = [];

  for (const focus of FOCUS_FUNCTIONS) {
    const meta = selectFunction(functionIndex.functionsByName, focus.function, focus.file);
    if (!meta) {
      continue;
    }
    const flow = expandFlow(meta, functionIndex.functionsByName, {
      maxDepth: focus.function === "main" ? FLOW_DEPTH : FLOW_DEPTH - 1,
      maxSteps: MAX_FLOW_STEPS,
    });
    if (flow) {
      focusFlows.push({ focus, flow });
    }
  }

  const markdown = buildReport({
    files,
    sources,
    functionIndex,
    mainEntries,
    shellMainFlow: focusFlows.find((f) => f.focus.function === "main")?.flow ?? null,
    focusFlows: focusFlows.filter((f) => f.focus.function !== "main"),
  });

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

function buildFunctionIndex(parser, files, sources) {
  const functionsByName = new Map();
  const functionsByFile = new Map();
  let totalFunctions = 0;

  for (const absolutePath of files) {
    const source = sources.get(absolutePath) ?? "";
    const relative = toPosix(path.relative(SAMPLE_ROOT, absolutePath) || path.basename(absolutePath));
    const tree = parser.parse(source);
    const functions = extractFunctionsFromTree(tree.rootNode, source, absolutePath, relative);
    functionsByFile.set(relative, functions);
    for (const meta of functions) {
      totalFunctions += 1;
      if (!functionsByName.has(meta.name)) {
        functionsByName.set(meta.name, []);
      }
      functionsByName.get(meta.name).push(meta);
    }
  }

  return { functionsByName, functionsByFile, totalFunctions };
}

function extractFunctionsFromTree(root, source, absolutePath, relative) {
  const functions = [];
  const visit = (node) => {
    if (node.type === "function_definition") {
      const meta = buildFunctionMeta(node, source, absolutePath, relative);
      if (meta) {
        functions.push(meta);
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(root);
  return functions;
}

function buildFunctionMeta(node, source, absolutePath, relative) {
  const declarator = node.childForFieldName("declarator");
  const nameNode = findIdentifierNode(declarator);
  const bodyNode = node.childForFieldName("body");
  if (!nameNode || !bodyNode) {
    return null;
  }

  const signature = sanitizeSignature(source.slice(node.startIndex, bodyNode.startIndex));
  const bodyText = source.slice(bodyNode.startIndex, bodyNode.endIndex);
  const calls = collectOrderedCalls(bodyNode, source).slice(0, MAX_CALLS_PER_FUNCTION);
  return {
    id: `${relative}::${nameNode.text}`,
    name: nameNode.text,
    file: relative,
    absolutePath,
    line: node.startPosition.row + 1,
    signature,
    bodyLines: bodyText.split(/\r?\n/).length,
    calls,
  };
}

function findIdentifierNode(node) {
  if (!node) {
    return null;
  }
  if (node.type === "identifier") {
    return node;
  }
  for (const child of node.namedChildren) {
    const result = findIdentifierNode(child);
    if (result) {
      return result;
    }
  }
  return null;
}

function collectOrderedCalls(bodyNode, source) {
  const calls = [];
  const stack = [bodyNode];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === "call_expression") {
      const fnNode = node.child(0);
      const symbol = extractCallSymbol(fnNode);
      const snippet = sanitizeSnippet(source.slice(node.startIndex, node.endIndex));
      calls.push({
        symbol,
        snippet,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
      });
    }
    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      stack.push(node.namedChild(i));
    }
  }
  calls.sort((a, b) => a.line - b.line || a.column - b.column);
  return calls;
}

function extractCallSymbol(node) {
  if (!node) {
    return null;
  }
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "qualified_identifier" || node.type === "scoped_identifier") {
    return node.text.replace(/\s+/g, "");
  }
  if (node.type === "parenthesized_expression" && node.namedChildCount > 0) {
    return extractCallSymbol(node.namedChild(0));
  }
  return null;
}

function sanitizeSignature(signature) {
  return signature.replace(/\s+/g, " ").replace(/\s*\(\s*/g, "(").trim();
}

function sanitizeSnippet(snippet) {
  const text = snippet.replace(/\s+/g, " ").trim();
  if (text.length <= 180) {
    return text;
  }
  return `${text.slice(0, 177)}...`;
}

function selectFunction(functionsByName, functionName, relativeFile) {
  const bucket = functionsByName.get(functionName);
  if (!bucket || bucket.length === 0) {
    return null;
  }
  if (relativeFile) {
    const normalized = toPosix(relativeFile);
    const match = bucket.find((meta) => meta.file === normalized || meta.file.endsWith(`/${normalized}`));
    if (match) {
      return match;
    }
  }
  return bucket[0];
}

function expandFlow(meta, functionsByName, options, depth = 0, active = null) {
  if (!meta) {
    return null;
  }
  const tracker = active ?? new Set();
  if (tracker.has(meta.id)) {
    return null;
  }
  tracker.add(meta.id);
  const steps = [];
  const maxDepth = options.maxDepth ?? FLOW_DEPTH;
  const maxSteps = options.maxSteps ?? MAX_FLOW_STEPS;

  for (const call of meta.calls.slice(0, maxSteps)) {
    const entry = {
      call,
      callee: null,
      nested: null,
      recursive: false,
    };
    if (call.symbol) {
      const callee = chooseBestCallee(call.symbol, meta.file, functionsByName);
      entry.callee = callee;
      if (callee && depth < maxDepth) {
        if (!tracker.has(callee.id)) {
          entry.nested = expandFlow(callee, functionsByName, options, depth + 1, tracker);
        } else {
          entry.recursive = true;
        }
      }
    }
    steps.push(entry);
  }

  tracker.delete(meta.id);
  return { meta, steps };
}

function chooseBestCallee(symbol, fromFile, functionsByName) {
  const candidates = functionsByName.get(symbol);
  if (!candidates || candidates.length === 0) {
    return null;
  }
  const sameFile = candidates.find((meta) => meta.file === fromFile);
  if (sameFile) {
    return sameFile;
  }
  return candidates[0];
}

function buildReport(context) {
  const { files, functionIndex, mainEntries, shellMainFlow, focusFlows } = context;
  const lines = [];
  lines.push("# Bash Sample Execution Flow\n");
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push(`- Source root: \`${path.relative(process.cwd(), SAMPLE_ROOT) || SAMPLE_ROOT}\``);
  lines.push(`- Depth inspected: ${DEPTH_LIMIT}`);
  lines.push(`- Files scanned: ${files.length}`);
  lines.push(`- Functions indexed: ${functionIndex.totalFunctions}`);
  lines.push(
    "- Method: tree-sitter AST traversal to preserve ordered call flows and inline expansions (depth ≤ 2).",
  );

  if (shellMainFlow) {
    renderFlowSection(lines, "Shell startup flow", shellMainFlow, {
      intro:
        "Ordered walkthrough of `shell.c::main`. Each step lists the original call site, the callee location (when known), and expands one level deeper to show how execution fans out.",
    });
  } else {
    lines.push(
      "\n## Shell startup flow\nUnable to locate `shell.c::main` within the scanned depth. Increase the search depth or verify the Bash sources.",
    );
  }

  if (focusFlows.length) {
    lines.push("\n---\n## Core execution pivots");
    for (const { focus, flow } of focusFlows) {
      renderFlowSection(lines, focus.label, flow, {
        intro: "Call trace captured with depth-limited expansion to show downstream dispatch order.",
      });
    }
  }

  renderOtherMainSummaries(lines, mainEntries, shellMainFlow?.meta?.file);
  appendMethodology(lines);

  lines.push("\n---\nReport crafted by benchmark/scripts/bash-flow-explain.js.");
  return lines.join("\n");
}

function renderFlowSection(lines, title, flow, options = {}) {
  lines.push(`\n## ${title}`);
  lines.push(`- File: \`${flow.meta.file}\``);
  lines.push(`- Line: ${flow.meta.line}`);
  lines.push(`- Signature: \`${flow.meta.signature}\``);
  lines.push(`- Body length: ${flow.meta.bodyLines} line(s)`);
  if (options.intro) {
    lines.push(`- ${options.intro}`);
  }
  if (!flow.steps.length) {
    lines.push("\n_No direct call expressions detected inside this body._");
    return;
  }
  lines.push("\n### Ordered call trace");
  renderFlowSteps(lines, flow.steps, flow.meta.file, 0);
}

function renderFlowSteps(lines, steps, parentFile, depth) {
  const indent = "  ".repeat(depth);
  steps.forEach((step, index) => {
    const label = depth === 0 ? `${index + 1}.` : "-";
    const callLabel = formatCallLabel(step.call);
    const origin = `${parentFile}:${step.call.line}`;
    const destination = step.callee
      ? `defined in \`${step.callee.file}:${step.callee.line}\``
      : "definition outside current scan";
    const recursiveNote = step.recursive ? " (recursive call prevented)" : "";
    lines.push(`${indent}${label} ${callLabel} @ ${origin} → ${destination}${recursiveNote}`);
    if (step.call.snippet && step.call.snippet !== callLabel) {
      lines.push(`${indent}   ↳ ${step.call.snippet}`);
    }
    if (step.nested) {
      lines.push(
        `${indent}   ↪ expands into \`${step.nested.meta.name}()\` (${step.nested.meta.file}:${step.nested.meta.line})`,
      );
      renderFlowSteps(lines, step.nested.steps, step.nested.meta.file, depth + 1);
    }
  });
}

function formatCallLabel(call) {
  if (call.symbol) {
    return `\`${call.symbol}()\``;
  }
  if (call.snippet) {
    const fragment = call.snippet.length > 60 ? `${call.snippet.slice(0, 57)}...` : call.snippet;
    return `\`${fragment}\``;
  }
  return "`<expression>`";
}

function renderOtherMainSummaries(lines, mainEntries, primaryFile) {
  const others = mainEntries.filter((meta) => (primaryFile ? meta.file !== primaryFile : true));
  if (!others.length) {
    return;
  }
  lines.push("\n---\n## Additional entry programs");
  for (const meta of others) {
    const highlights = meta.calls.slice(0, 5).map((call) => call.symbol ?? call.snippet);
    const summary = highlights.length ? highlights.join(", ") : "no direct calls captured";
    lines.push(`- \`${meta.file}:${meta.line}\` → ${summary}`);
  }
}

function appendMethodology(lines) {
  lines.push("\n---\n## Methodology & next steps");
  lines.push(
    "- AST-guided traversal keeps statements ordered, so startup, reader, and executor flows retain the real control-path.",
  );
  lines.push(
    "- Depth is currently limited to two hops to avoid combinatorial explosion; bump FLOW_DEPTH for deeper recursion once compression strategies mature.",
  );
  lines.push(
    "- Attach `.miniphi/benchmarks` mirrors to reuse this breakdown inside orchestrated reasoning tasks without rescanning 5K+ line files.",
  );
  lines.push(
    "- Future enhancement: annotate each call with surrounding comments to add semantic context (e.g., why traps or job control toggles occur).",
  );
}

function applyFallbackTargets(functionIndex, sources, targets) {
  for (const target of targets) {
    const normalized = toPosix(target.file);
    const hasMatch =
      functionIndex.functionsByName.get(target.function)?.some(
        (meta) => meta.file === normalized || meta.file.endsWith(`/${normalized}`),
      ) ?? false;
    if (hasMatch) {
      continue;
    }
    const absolutePath = path.resolve(SAMPLE_ROOT, target.file);
    const source = sources.get(absolutePath);
    if (!source) {
      continue;
    }
    const fallback = extractFunctionFallback(source, target.function);
    if (!fallback) {
      continue;
    }
    const calls = collectCallsFromRawSource(source, fallback.bodyStartIndex, fallback.bodyEndIndex);
    const meta = {
      id: `${normalized}::${target.function}`,
      name: target.function,
      file: normalized,
      absolutePath,
      line: fallback.line,
      signature: sanitizeSignature(fallback.signature),
      bodyLines: fallback.body.split(/\r?\n/).length,
      calls,
    };
    if (!functionIndex.functionsByName.has(meta.name)) {
      functionIndex.functionsByName.set(meta.name, []);
    }
    functionIndex.functionsByName.get(meta.name).push(meta);
    const fileBucket = functionIndex.functionsByFile.get(normalized) ?? [];
    fileBucket.push(meta);
    functionIndex.functionsByFile.set(normalized, fileBucket);
    functionIndex.totalFunctions += 1;
  }
}

function extractFunctionFallback(source, functionName) {
  const commentRanges = computeCommentRanges(source);
  const regex = new RegExp(
    `^\\s*(?:[A-Za-z_][A-Za-z0-9_\\s\\*]*\\s+)?${functionName}\\s*\\([^;{]*\\)`,
    "gm",
  );
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (isWithinRanges(match.index, commentRanges)) {
      continue;
    }
    let cursor = match.index + match[0].length;
    while (cursor < source.length && /\s/.test(source[cursor])) {
      cursor += 1;
    }
    if (source[cursor] === ";") {
      continue;
    }
    while (cursor < source.length && source[cursor] !== "{") {
      cursor += 1;
    }
    if (cursor >= source.length) {
      continue;
    }
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    let depth = 1;
    let index = cursor + 1;
    let inString = null;
    let bodyEndIndex = index;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (inString) {
        if (char === inString && source[index - 1] !== "\\") {
          inString = null;
        }
      } else if (char === '"' || char === "'") {
        inString = char;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          bodyEndIndex = index;
          break;
        }
      }
      index += 1;
    }
    const bodyStartIndex = cursor + 1;
    const body = source.slice(bodyStartIndex, bodyEndIndex);
    const cleanedSignature = match[0].replace(/^\s*#.*$/gm, "").trim() || match[0];
    return {
      signature: cleanedSignature,
      line,
      body,
      bodyStartIndex,
      bodyEndIndex,
    };
  }
  return null;
}

function collectCallsFromRawSource(source, startIndex, endIndex) {
  const fragment = source.slice(startIndex, endIndex);
  const calls = [];
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;
  while ((match = regex.exec(fragment)) !== null) {
    const symbol = match[1];
    if (RESERVED_CALL_NAMES.has(symbol) || !/[a-z]/.test(symbol)) {
      continue;
    }
    const localOffset = match.index;
    const absoluteOffset = startIndex + localOffset;
    const snippet = sanitizeSnippet(extractRawCallSnippet(fragment, localOffset));
    const line = source.slice(0, absoluteOffset).split(/\r?\n/).length;
    const lastNewline = fragment.lastIndexOf("\n", localOffset);
    const column = lastNewline === -1 ? localOffset + 1 : localOffset - lastNewline;
    calls.push({
      symbol,
      snippet,
      line,
      column,
    });
    if (calls.length >= MAX_CALLS_PER_FUNCTION) {
      break;
    }
  }
  return calls;
}

function extractRawCallSnippet(fragment, offset) {
  let i = offset;
  while (i < fragment.length && /\s/.test(fragment[i])) {
    i += 1;
  }
  while (i < fragment.length && /[A-Za-z0-9_\->\.]/.test(fragment[i])) {
    i += 1;
  }
  if (fragment[i] !== "(") {
    return fragment.slice(offset, Math.min(offset + 80, fragment.length));
  }
  let depth = 0;
  let end = i;
  while (end < fragment.length) {
    const char = fragment[end];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
    end += 1;
  }
  while (end < fragment.length && /\s/.test(fragment[end])) {
    if (fragment[end] === "\n") {
      break;
    }
    end += 1;
  }
  if (end < fragment.length && fragment[end] === ";") {
    end += 1;
  }
  return fragment.slice(offset, Math.min(end, fragment.length));
}

function computeCommentRanges(source) {
  const ranges = [];
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let blockStart = -1;
  let lineStart = -1;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (inBlock) {
      if (char === "*" && next === "/") {
        ranges.push({ start: blockStart, end: i + 2 });
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inLine) {
      if (char === "\n") {
        ranges.push({ start: lineStart, end: i });
        inLine = false;
      }
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      blockStart = i;
      i += 2;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      lineStart = i;
      i += 2;
      continue;
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
  return ranges.some((range) => index >= range.start && index < range.end);
}

function dedupeFunctions(functions) {
  const seen = new Set();
  const result = [];
  for (const meta of functions) {
    const key = `${meta.file}:${meta.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(meta);
  }
  return result;
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

function toPosix(input) {
  return input.split(path.sep).join("/");
}

main().catch((error) => {
  log(`ERROR: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
