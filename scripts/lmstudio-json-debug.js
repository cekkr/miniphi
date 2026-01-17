import fs from "node:fs/promises";
import path from "node:path";

const MIN_LMSTUDIO_REQUEST_TIMEOUT_MS = 300000;

function stripTrailingSlashes(value) {
  return String(value ?? "").replace(/\/+$/g, "");
}

function sanitizeSchemaName(name) {
  if (!name) {
    return "miniphi-debug";
  }
  const normalized = String(name)
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized ? normalized.slice(0, 48) : "miniphi-debug";
}

function parseNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a finite number (received: ${String(value)})`);
  }
  return numeric;
}

function printUsage() {
  const lines = [
    "LM Studio JSON debug runner (prints raw completion + parsed JSON).",
    "",
    "Usage:",
    '  node scripts/lmstudio-json-debug.js --prompt "Return {\\\"a\\\":1}"',
    '  node scripts/lmstudio-json-debug.js --prompt-file docs/models/devstrall/conversationAboutJsonAutomation.json',
    "  node scripts/lmstudio-json-debug.js --schema-file docs/prompts/log-analysis.schema.json",
    "",
    "Options:",
    "  --base-url <url>       LM Studio REST base URL (default: LMSTUDIO_REST_URL or http://127.0.0.1:1234)",
    "  --model <id>           Model id (default: MINIPHI_LMSTUDIO_MODEL or mistralai/devstral-small-2-2512)",
    "  --system-file <path>   System prompt file (default: docs/models/devstrall/defaultSystemPrompt.txt)",
    "  --prompt <text>        User prompt text (or pass trailing args as the prompt)",
    "  --prompt-file <path>   Read user prompt text from a file",
    "  --schema-file <path>   JSON schema file used for response_format=json_schema (optional)",
    "  --schema-name <name>   response_format.json_schema.name (optional)",
    "  --max-tokens <n>       max_tokens (default: 900)",
    "  --temperature <n>      temperature (default: 0)",
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

function parseArgs(argv) {
  const options = {
    help: false,
    baseUrl: stripTrailingSlashes(process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234"),
    model: process.env.MINIPHI_LMSTUDIO_MODEL ?? "mistralai/devstral-small-2-2512",
    systemFile: path.join("docs", "models", "devstrall", "defaultSystemPrompt.txt"),
    prompt: null,
    promptFile: null,
    schemaFile: null,
    schemaName: null,
    maxTokens: 900,
    temperature: 0,
  };

  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
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
    if (arg === "--prompt") {
      options.prompt = argv[++i];
      continue;
    }
    if (arg === "--prompt-file") {
      options.promptFile = argv[++i];
      continue;
    }
    if (arg === "--schema-file") {
      options.schemaFile = argv[++i];
      continue;
    }
    if (arg === "--schema-name") {
      options.schemaName = argv[++i];
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
    positionals.push(arg);
  }

  if (options.prompt && options.promptFile) {
    throw new Error("Pass only one of --prompt or --prompt-file.");
  }
  if (!options.prompt && !options.promptFile && positionals.length > 0) {
    options.prompt = positionals.join(" ");
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const systemPath = path.resolve(options.systemFile);
  const systemPrompt = await fs.readFile(systemPath, "utf8");

  let userPrompt = options.prompt;
  if (!userPrompt && options.promptFile) {
    userPrompt = await fs.readFile(path.resolve(options.promptFile), "utf8");
  }
  if (!userPrompt || !userPrompt.trim()) {
    userPrompt = [
      "I want to automate the discovery + refactor planning for a large C++ repository.",
      "Produce a plan that tells an external script exactly what to list/read next (directories + files) and which safe commands to run.",
      "Assume the script will run on Windows PowerShell, and that the project may have CMake + third-party folders.",
      "Keep requests minimal but sufficient to propose a new directory/class structure.",
    ].join("\n");
  }

  let schema = null;
  if (options.schemaFile) {
    const raw = await fs.readFile(path.resolve(options.schemaFile), "utf8");
    schema = JSON.parse(raw);
  }
  if (!schema) {
    schema = {
      type: "object",
      additionalProperties: false,
      required: [
        "goal",
        "directory_requests",
        "file_requests",
        "next_commands",
        "needs_more_context",
      ],
      properties: {
        goal: { type: "string" },
        directory_requests: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "depth", "reason", "include_globs", "exclude_globs"],
            properties: {
              path: { type: "string" },
              depth: { type: "integer" },
              reason: { type: "string" },
              include_globs: { type: "array", items: { type: "string" } },
              exclude_globs: { type: "array", items: { type: "string" } },
            },
          },
        },
        file_requests: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "reason"],
            properties: {
              path: { type: "string" },
              reason: { type: "string" },
              excerpt_hint: { type: ["string", "null"] },
            },
          },
        },
        next_commands: { type: "array", items: { type: "string" } },
        questions: { type: "array", items: { type: "string" }, default: [] },
        needs_more_context: { type: "boolean" },
      },
    };
  }

  const schemaName = sanitizeSchemaName(options.schemaName ?? "miniphi-debug");
  const payload = {
    model: options.model,
    stream: false,
    max_tokens: Math.max(-1, Math.floor(options.maxTokens)),
    temperature: options.temperature,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        schema,
      },
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  const url = `${stripTrailingSlashes(options.baseUrl)}/api/v0/chat/completions`;
  console.log(`[lmstudio-json-debug] POST ${url}`);
  console.log(`[lmstudio-json-debug] model=${options.model} schema=${schemaName}`);
  console.log(`[lmstudio-json-debug] system=${path.relative(process.cwd(), systemPath)}`);

  const completion = await fetchJson(url, payload);
  console.log("\n=== RAW COMPLETION (LM Studio JSON) ===\n");
  console.log(JSON.stringify(completion, null, 2));

  const content = completion?.choices?.[0]?.message?.content ?? "";
  console.log("\n=== RAW ASSISTANT CONTENT (choices[0].message.content) ===\n");
  console.log(content);

  console.log("\n=== PARSED JSON (from assistant content) ===\n");
  try {
    const parsed = JSON.parse(String(content).trim());
    console.log(JSON.stringify(parsed, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to parse assistant content as JSON: ${message}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[lmstudio-json-debug] ${message}`);
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
