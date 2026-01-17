import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const MIN_LMSTUDIO_REQUEST_TIMEOUT_MS = 300000;

function stripTrailingSlashes(value) {
  return String(value ?? "").replace(/\/+$/g, "");
}

function sanitizeSchemaName(name) {
  if (!name) {
    return "miniphi-series";
  }
  const normalized = String(name)
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized ? normalized.slice(0, 48) : "miniphi-series";
}

function parseNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a finite number (received: ${String(value)})`);
  }
  return numeric;
}

function hashText(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureWithinRoot(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(candidatePath);
  if (resolved === resolvedRoot) {
    return resolved;
  }
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error(`Refusing to operate outside sandbox root: ${resolved}`);
  }
  return resolved;
}

function printUsage() {
  const lines = [
    "LM Studio JSON series runner (multi-step, applies edits in a sandbox copy).",
    "",
    "Usage:",
    "  node scripts/lmstudio-json-series.js",
    "  node scripts/lmstudio-json-series.js --workspace samples/get-started/code",
    '  node scripts/lmstudio-json-series.js --task "Make DEFAULT_TOOLS platform-aware"',
    "",
    "Options:",
    "  --base-url <url>       LM Studio REST base URL (default: LMSTUDIO_REST_URL or http://127.0.0.1:1234)",
    "  --model <id>           Model id (default: MINIPHI_LMSTUDIO_MODEL or mistralai/devstral-small-2-2512)",
    "  --system-file <path>   System prompt file (default: docs/models/devstrall/defaultSystemPrompt.txt)",
    "  --workspace <path>     Workspace directory to copy into the sandbox (default: samples/get-started/code)",
    "  --task <text>          Objective (default: make Python tool detection platform aware)",
    "  --max-tokens <n>       max_tokens (default: 1800)",
    "  --temperature <n>      temperature (default: 0)",
    "  --iterations <n>       Max fix iterations when tests fail (default: 2)",
    "  --dry-run              Do not write files or run commands (prints plan JSON only)",
    "  --keep                 Keep the sandbox directory (default: delete when done)",
    "  --verbose              Print extra diagnostics",
    "  -h, --help             Show help",
    "",
    "Environment overrides:",
    "  LMSTUDIO_REST_URL, MINIPHI_LMSTUDIO_MODEL",
  ];
  console.log(lines.join("\n"));
}

async function fetchJson(url, payload, timeoutMs = MIN_LMSTUDIO_REQUEST_TIMEOUT_MS) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() is not available. Use Node.js 18+.");
  }
  const effectiveTimeoutMs = Math.max(
    Number(timeoutMs) || MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
    MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const message =
        parsed?.error?.message ??
        parsed?.error ??
        (text ? text.slice(0, 600) : "") ??
        `HTTP ${res.status}`;
      const error = new Error(`LM Studio request failed (${res.status} ${res.statusText}): ${message}`);
      error.status = res.status;
      error.body = parsed ?? text;
      throw error;
    }
    if (parsed === null) {
      throw new Error(`LM Studio returned non-JSON payload: ${text.slice(0, 600)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function createChatCompletion({ baseUrl, payload }) {
  const url = `${stripTrailingSlashes(baseUrl)}/api/v0/chat/completions`;
  return fetchJson(url, payload);
}

function parseArgs(argv) {
  const options = {
    help: false,
    verbose: false,
    dryRun: false,
    keep: false,
    baseUrl: stripTrailingSlashes(process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234"),
    model: process.env.MINIPHI_LMSTUDIO_MODEL ?? "mistralai/devstral-small-2-2512",
    systemFile: path.join("docs", "models", "devstrall", "defaultSystemPrompt.txt"),
    workspace: path.join("samples", "get-started", "code"),
    task:
      "Edit src/system-info.js so DEFAULT_TOOLS is platform-aware: on Windows use python/py (not python3), on non-Windows keep python3. Keep the exported function APIs stable and avoid adding dependencies.",
    maxTokens: 1800,
    temperature: 0,
    iterations: 2,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }
    if (arg === "--base-url") {
      options.baseUrl = stripTrailingSlashes(argv[++i]);
      continue;
    }
    if (arg === "--model") {
      options.model = argv[++i];
      continue;
    }
    if (arg === "--system-file") {
      options.systemFile = argv[++i];
      continue;
    }
    if (arg === "--workspace") {
      options.workspace = argv[++i];
      continue;
    }
    if (arg === "--task") {
      options.task = argv[++i];
      continue;
    }
    if (arg === "--max-tokens") {
      options.maxTokens = parseNumber(argv[++i], "--max-tokens");
      continue;
    }
    if (arg === "--temperature") {
      options.temperature = parseNumber(argv[++i], "--temperature");
      continue;
    }
    if (arg === "--iterations") {
      options.iterations = Math.max(1, Math.floor(parseNumber(argv[++i], "--iterations")));
      continue;
    }
  }

  return options;
}

async function readTextFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content.replace(/\r\n/g, "\n");
}

async function snapshotFiles(rootDir, relativePaths) {
  const snapshots = [];
  for (const rel of relativePaths) {
    const resolved = ensureWithinRoot(rootDir, path.join(rootDir, rel));
    const content = await readTextFile(resolved);
    snapshots.push({
      path: rel,
      sha256: hashText(content),
      bytes: Buffer.byteLength(content, "utf8"),
      content,
    });
  }
  return snapshots;
}

function normalizeFileOperation(operation) {
  if (!operation || typeof operation !== "object") {
    return null;
  }
  const action = typeof operation.action === "string" ? operation.action.trim().toLowerCase() : "";
  const opPath = typeof operation.path === "string" ? operation.path.trim() : "";
  const content =
    typeof operation.content === "string" ? operation.content.replace(/\r\n/g, "\n") : null;
  const reason = typeof operation.reason === "string" ? operation.reason.trim() : null;
  if (!action || !opPath) {
    return null;
  }
  if (!["create", "update", "delete"].includes(action)) {
    return null;
  }
  return {
    action,
    path: opPath.replace(/^[./\\]+/, "").replace(/\\/g, "/"),
    content,
    reason,
  };
}

async function applyFileOperations(rootDir, operations, options = undefined) {
  const dryRun = Boolean(options?.dryRun);
  const maxTotalBytes = Number.isFinite(Number(options?.maxTotalBytes))
    ? Number(options.maxTotalBytes)
    : 20000;

  let totalBytes = 0;
  const applied = [];

  for (const op of operations) {
    const normalized = normalizeFileOperation(op);
    if (!normalized) {
      continue;
    }
    const target = ensureWithinRoot(rootDir, path.join(rootDir, normalized.path));
    if (normalized.action === "delete") {
      applied.push({ ...normalized, resolvedPath: target, bytesWritten: 0, skipped: false });
      if (!dryRun) {
        await fs.rm(target, { force: true });
      }
      continue;
    }
    if (normalized.content === null) {
      throw new Error(`Missing content for ${normalized.action} ${normalized.path}`);
    }

    let existing = null;
    try {
      existing = await readTextFile(target);
    } catch {
      existing = null;
    }
    if (existing !== null && existing === normalized.content) {
      applied.push({
        ...normalized,
        resolvedPath: target,
        bytesWritten: 0,
        skipped: true,
        skipReason: "no-op",
      });
      continue;
    }
    const bytes = Buffer.byteLength(normalized.content, "utf8");
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Refusing to write >${maxTotalBytes} bytes (received ${totalBytes}).`);
    }
    applied.push({ ...normalized, resolvedPath: target, bytesWritten: bytes, skipped: false });
    if (!dryRun) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, normalized.content, "utf8");
    }
  }

  return applied;
}

function isAllowedVerificationCommand(command) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) {
    return false;
  }
  const allowlist = [
    /^npm\s+test$/i,
    /^npm\s+run\s+test$/i,
    /^npm\s+run\s+smoke$/i,
    /^node\s+src\/tests\/smoke\.js$/i,
    /^node\s+src\/index\.js\s+--smoke$/i,
  ];
  return allowlist.some((re) => re.test(trimmed));
}

async function runCommand(command, cwd, timeoutMs = 240000) {
  const normalized = String(command ?? "").trim();
  if (!normalized) {
    throw new Error("Command is required.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(normalized, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timeout after ${timeoutMs}ms: ${normalized}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: normalized,
        exitCode: typeof code === "number" ? code : -1,
        stdout,
        stderr,
      });
    });
  });
}

function buildEditPlanSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "goal",
      "file_operations",
      "verification_commands",
      "needs_more_context",
      "questions",
    ],
    properties: {
      goal: { type: "string" },
      file_operations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "path"],
          properties: {
            action: { type: "string", enum: ["create", "update", "delete"] },
            path: { type: "string" },
            content: { type: ["string", "null"] },
            reason: { type: ["string", "null"] },
          },
        },
      },
      verification_commands: { type: "array", items: { type: "string" }, default: [] },
      notes: { type: ["string", "null"] },
      needs_more_context: { type: "boolean" },
      questions: { type: "array", items: { type: "string" }, default: [] },
    },
  };
}

function buildFinalReportSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tests_passed", "summary", "next_actions", "needs_more_context", "questions"],
    properties: {
      tests_passed: { type: "boolean" },
      summary: { type: "string" },
      next_actions: { type: "array", items: { type: "string" }, default: [] },
      needs_more_context: { type: "boolean" },
      questions: { type: "array", items: { type: "string" }, default: [] },
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const workspaceDir = path.resolve(options.workspace);
  const systemPath = path.resolve(options.systemFile);
  const systemPrompt = await fs.readFile(systemPath, "utf8");

  const runRoot = path.join(process.cwd(), ".miniphi", "sandboxes", "lmstudio-json-series");
  const runDir = path.join(runRoot, formatTimestamp());
  const sandboxDir = path.join(runDir, "workspace");

  if (!options.dryRun) {
    await fs.mkdir(runDir, { recursive: true });
    await fs.cp(workspaceDir, sandboxDir, { recursive: true });
  }

  console.log(`[lmstudio-json-series] workspace=${path.relative(process.cwd(), workspaceDir)}`);
  console.log(`[lmstudio-json-series] sandbox=${path.relative(process.cwd(), sandboxDir)}`);
  console.log(`[lmstudio-json-series] model=${options.model}`);
  console.log(`[lmstudio-json-series] system=${path.relative(process.cwd(), systemPath)}`);

  const allowedFiles = ["src/system-info.js"];
  const maxTotalBytes = 20000;

  const messages = [{ role: "system", content: systemPrompt }];

  let lastRun = null;
  let lastPlan = null;
  let appliedOps = [];

  for (let attempt = 1; attempt <= options.iterations; attempt += 1) {
    const rootForSnapshot = options.dryRun ? workspaceDir : sandboxDir;
    const fileSnapshots = await snapshotFiles(rootForSnapshot, allowedFiles);
    const promptBody = {
      step: attempt === 1 ? "edit-plan" : "fix-plan",
      attempt,
      objective: options.task,
      platform: process.platform,
      workspace_root: rootForSnapshot,
      constraints: {
        allowed_paths: allowedFiles,
        max_total_written_bytes: maxTotalBytes,
        max_file_operations: 3,
        keep_api_stable: true,
      },
      files: fileSnapshots.map((snap) => ({
        path: snap.path,
        sha256: snap.sha256,
        content: snap.content,
      })),
      previous: lastRun
        ? {
            command: lastRun.command,
            exitCode: lastRun.exitCode,
            stdout: lastRun.stdout.slice(0, 8000),
            stderr: lastRun.stderr.slice(0, 8000),
          }
        : null,
    };

    messages.push({ role: "user", content: JSON.stringify(promptBody, null, 2) });

    const schemaName = sanitizeSchemaName("miniphi-edit-plan");
    const completion = await createChatCompletion({
      baseUrl: options.baseUrl,
      payload: {
        model: options.model,
        stream: false,
        max_tokens: Math.max(-1, Math.floor(options.maxTokens)),
        temperature: options.temperature,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            schema: buildEditPlanSchema(),
          },
        },
        messages,
      },
    });

    const content = completion?.choices?.[0]?.message?.content ?? "";
    if (options.verbose) {
      console.log("\n=== RAW ASSISTANT CONTENT (edit plan) ===\n");
      console.log(content);
    }

    const plan = JSON.parse(String(content).trim());
    lastPlan = plan;
    messages.push({ role: "assistant", content: JSON.stringify(plan) });

    console.log(`\n[lmstudio-json-series] Step ${attempt}: ${plan.goal}`);

    if (plan.needs_more_context) {
      console.warn("[lmstudio-json-series] Model requested more context:");
      (plan.questions ?? []).forEach((q) => console.warn(`- ${q}`));
      break;
    }

    const operations = Array.isArray(plan.file_operations) ? plan.file_operations : [];
    const verificationCommands = Array.isArray(plan.verification_commands)
      ? plan.verification_commands
      : [];

    if (options.dryRun) {
      console.log("\n=== EDIT PLAN (JSON) ===\n");
      console.log(JSON.stringify(plan, null, 2));
      console.log("\n[lmstudio-json-series] Dry run enabled; skipping apply/test + final report.");
      return;
    }

    appliedOps = await applyFileOperations(sandboxDir, operations, {
      dryRun: options.dryRun,
      maxTotalBytes,
    });

    if (appliedOps.length === 0) {
      console.warn("[lmstudio-json-series] No file operations proposed; stopping.");
      lastRun = {
        command: "(no-op plan)",
        exitCode: 1,
        stdout: "",
        stderr: "Model returned an empty file_operations array.",
      };
      continue;
    }

    const executedOps = appliedOps.filter((op) => !op.skipped);
    if (executedOps.length === 0) {
      console.warn("[lmstudio-json-series] File operations were all no-ops; retrying.");
      lastRun = {
        command: "(no-op plan)",
        exitCode: 1,
        stdout: "",
        stderr: "Model returned file content identical to the current files.",
      };
      continue;
    }

    console.log("[lmstudio-json-series] Applied file operations:");
    executedOps.forEach((op) => {
      console.log(`- ${op.action} ${op.path}${op.reason ? ` (${op.reason})` : ""}`);
    });

    const candidateCommands = verificationCommands.filter(isAllowedVerificationCommand);
    const commandsToRun = candidateCommands.length ? candidateCommands : ["npm test"];

    const commandToRun = commandsToRun[0];
    console.log(`[lmstudio-json-series] Running verification: ${commandToRun}`);
    lastRun = await runCommand(commandToRun, sandboxDir);
    console.log(`[lmstudio-json-series] exitCode=${lastRun.exitCode}`);

    if (lastRun.exitCode === 0) {
      break;
    }
  }

  const finalSchemaName = sanitizeSchemaName("miniphi-final-report");
  const testsPassedFact = Boolean(lastRun && lastRun.exitCode === 0);
  const finalPrompt = {
    step: "final-report",
    objective: options.task,
    platform: process.platform,
    sandbox_root: options.dryRun ? workspaceDir : sandboxDir,
    tests_passed_fact: testsPassedFact,
    last_plan: lastPlan ?? null,
    applied_file_operations: appliedOps.map((op) => ({
      action: op.action,
      path: op.path,
      bytesWritten: op.bytesWritten ?? 0,
      reason: op.reason ?? null,
    })),
    verification: lastRun
      ? {
          command: lastRun.command,
          exitCode: lastRun.exitCode,
          stdout: lastRun.stdout.slice(0, 12000),
          stderr: lastRun.stderr.slice(0, 12000),
        }
      : null,
  };

  messages.push({ role: "user", content: JSON.stringify(finalPrompt, null, 2) });

  const finalCompletion = await createChatCompletion({
    baseUrl: options.baseUrl,
    payload: {
      model: options.model,
      stream: false,
      max_tokens: Math.max(-1, Math.floor(options.maxTokens)),
      temperature: options.temperature,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: finalSchemaName,
          schema: buildFinalReportSchema(),
        },
      },
      messages,
    },
  });

  const finalContent = finalCompletion?.choices?.[0]?.message?.content ?? "";
  const finalReport = JSON.parse(String(finalContent).trim());
  if (finalReport.tests_passed !== testsPassedFact) {
    console.warn(
      `[lmstudio-json-series] Model returned tests_passed=${finalReport.tests_passed}, but runner exit code implies ${testsPassedFact}.`,
    );
    finalReport.tests_passed = testsPassedFact;
  }

  console.log("\n=== FINAL REPORT (JSON) ===\n");
  console.log(JSON.stringify(finalReport, null, 2));

  if (!options.keep && !options.dryRun) {
    try {
      await fs.rm(runDir, { recursive: true, force: true });
    } catch (error) {
      if (options.verbose) {
        console.warn(
          `[lmstudio-json-series] Unable to delete sandbox: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  } else if (!options.dryRun) {
    console.log(`\n[lmstudio-json-series] Sandbox retained at: ${runDir}`);
  }

  if (!finalReport.tests_passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[lmstudio-json-series] ${message}`);
  if (error?.body) {
    console.error("Error body:");
    try {
      console.error(JSON.stringify(error.body, null, 2));
    } catch {
      console.error(String(error.body));
    }
  }
  process.exitCode = 1;
});
