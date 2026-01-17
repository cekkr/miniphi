import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import { parseStrictJson } from "../src/libs/core-utils.js";
import {
  applyPromptTemplate,
  buildOptionHintBlock,
  mergeOptionSets,
  resolveOptionSelections,
} from "../src/libs/prompt-chain-utils.js";

const MIN_LMSTUDIO_REQUEST_TIMEOUT_MS = 300000;

function stripTrailingSlashes(value) {
  return String(value ?? "").replace(/\/+$/g, "");
}

function sanitizeSchemaName(name) {
  if (!name) {
    return "prompt-chain";
  }
  const normalized = String(name)
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized ? normalized.slice(0, 48) : "prompt-chain";
}

function parseNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} must be a finite number (received: ${String(value)})`);
  }
  return numeric;
}

function parseSelection(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const equals = trimmed.indexOf("=");
  if (equals === -1) {
    throw new Error(`Selections must use set=value (received "${trimmed}").`);
  }
  const setId = trimmed.slice(0, equals).trim();
  const optionId = trimmed.slice(equals + 1).trim();
  if (!setId || !optionId) {
    throw new Error(`Selections must use set=value (received "${trimmed}").`);
  }
  return { setId, optionId };
}

function printUsage() {
  const lines = [
    "Prompt chain composer (builds JSON-only prompts + LM Studio payloads).",
    "",
    "Usage:",
    "  node scripts/prompt-composer.js",
    "  node scripts/prompt-composer.js --step compose --select focus=options --prompt-out prompt.json",
    "  node scripts/prompt-composer.js --send --response-file .miniphi/prompt-chain/response.json",
    "",
    "Options:",
    "  --chain <path>          Prompt chain definition (default: samples/prompt-chain/chain.json)",
    "  --step <id|index>       Chain step id (or 1-based index) to run",
    "  --select <set=option>   Override option selection (repeatable)",
    "  --selected-file <path>  JSON file with persisted selections",
    "  --learned-file <path>   JSON file with learned option sets",
    "  --system-file <path>    LM Studio system prompt file",
    "  --no-system-file        Skip loading a system prompt file",
    "  --base-url <url>        LM Studio REST base URL (default: LMSTUDIO_REST_URL or http://127.0.0.1:1234)",
    "  --model <id>            LM Studio model id",
    "  --max-tokens <n>        max_tokens override",
    "  --temperature <n>       temperature override",
    "  --output <path>         Write LM Studio payload JSON to a file",
    "  --prompt-out <path>     Write rendered user prompt JSON to a file",
    "  --response-file <path>  Write raw LM Studio response JSON when --send is set",
    "  --write-selected        Persist resolved selections to --selected-file",
    "  --send                  Send the prompt to LM Studio",
    "  --timeout-ms <n>        LM Studio request timeout (default: 300000, clamped >= 300000)",
    "  --watch                 Recompose on chain/template/selection changes",
    "  -h, --help              Show help",
  ];
  console.log(lines.join("\n"));
}

function parseArgs(argv) {
  const options = {
    help: false,
    chain: path.join("samples", "prompt-chain", "chain.json"),
    step: null,
    selections: [],
    selectedFile: null,
    learnedFile: null,
    systemFile: path.join("docs", "models", "devstrall", "defaultSystemPrompt.txt"),
    noSystemFile: false,
    baseUrl: stripTrailingSlashes(process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234"),
    model: process.env.MINIPHI_LMSTUDIO_MODEL ?? null,
    maxTokens: null,
    temperature: null,
    output: null,
    promptOut: null,
    responseFile: null,
    writeSelected: false,
    send: false,
    timeoutMs: MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
    watch: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--chain") {
      options.chain = argv[++i];
      continue;
    }
    if (arg === "--step") {
      options.step = argv[++i];
      continue;
    }
    if (arg === "--select") {
      options.selections.push(argv[++i]);
      continue;
    }
    if (arg === "--selected-file") {
      options.selectedFile = argv[++i];
      continue;
    }
    if (arg === "--learned-file") {
      options.learnedFile = argv[++i];
      continue;
    }
    if (arg === "--system-file") {
      options.systemFile = argv[++i];
      continue;
    }
    if (arg === "--no-system-file") {
      options.noSystemFile = true;
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
    if (arg === "--max-tokens") {
      options.maxTokens = parseNumber(argv[++i], "--max-tokens");
      continue;
    }
    if (arg === "--temperature") {
      options.temperature = parseNumber(argv[++i], "--temperature");
      continue;
    }
    if (arg === "--output") {
      options.output = argv[++i];
      continue;
    }
    if (arg === "--prompt-out") {
      options.promptOut = argv[++i];
      continue;
    }
    if (arg === "--response-file") {
      options.responseFile = argv[++i];
      continue;
    }
    if (arg === "--write-selected") {
      options.writeSelected = true;
      continue;
    }
    if (arg === "--send") {
      options.send = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Math.max(
        parseNumber(argv[++i], "--timeout-ms"),
        MIN_LMSTUDIO_REQUEST_TIMEOUT_MS,
      );
      continue;
    }
    if (arg === "--watch") {
      options.watch = true;
      continue;
    }
  }

  return options;
}

async function fetchJson(url, payload, timeoutMs) {
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

function resolveChainPath(chainDir, candidate) {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  return path.resolve(chainDir, candidate);
}

async function readJsonFile(filePath, { required }) {
  if (!filePath) {
    return null;
  }
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (!required && error?.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Unable to read JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveStep(chain, stepId) {
  const steps = Array.isArray(chain?.steps) ? chain.steps : [];
  if (!steps.length) {
    throw new Error("Prompt chain has no steps.");
  }
  if (!stepId) {
    return steps[0];
  }
  const byId = steps.find((entry) => entry?.id === stepId);
  if (byId) {
    return byId;
  }
  const numeric = Number(stepId);
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= steps.length) {
    return steps[numeric - 1];
  }
  throw new Error(`Unable to resolve step "${stepId}".`);
}

function buildTemplateContext({
  schemaId,
  schema,
  chain,
  step,
  instructions,
  optionSets,
  selections,
  optionHints,
  context,
}) {
  const safe = (value) => (typeof value === "string" ? value : "");
  const stepObjective = safe(step?.objective ?? chain?.objective);
  const chainName = safe(chain?.name ?? "");
  const chainDescription = safe(chain?.description ?? "");
  const stepId = safe(step?.id ?? "");
  const stepTitle = safe(step?.title ?? "");
  const normalizedInstructions = safe(instructions);
  const normalizedContext =
    context && typeof context === "object" && !Array.isArray(context) ? context : {};

  return {
    schema_id: schemaId,
    schema_id_json: JSON.stringify(schemaId),
    schema,
    schema_json: JSON.stringify(schema, null, 2),
    chain_name: chainName,
    chain_name_json: JSON.stringify(chainName),
    chain_description: chainDescription,
    chain_description_json: JSON.stringify(chainDescription),
    step_id: stepId,
    step_id_json: JSON.stringify(stepId),
    step_title: stepTitle,
    step_title_json: JSON.stringify(stepTitle),
    step_objective: stepObjective,
    step_objective_json: JSON.stringify(stepObjective),
    instructions: normalizedInstructions,
    instructions_json: JSON.stringify(normalizedInstructions),
    option_sets: optionSets,
    option_sets_json: JSON.stringify(optionSets, null, 2),
    selected_options: selections,
    selected_options_json: JSON.stringify(selections, null, 2),
    option_hints: optionHints,
    option_hints_json: JSON.stringify(optionHints ?? ""),
    context: normalizedContext,
    context_json: JSON.stringify(normalizedContext, null, 2),
  };
}

function buildDefaultPrompt({
  schemaId,
  schema,
  chain,
  step,
  instructions,
  optionSets,
  selections,
  optionHints,
  context,
}) {
  const chainName = typeof chain?.name === "string" ? chain.name : null;
  const chainDescription = typeof chain?.description === "string" ? chain.description : null;
  const stepId = typeof step?.id === "string" ? step.id : "step-1";
  const stepTitle = typeof step?.title === "string" ? step.title : "Prompt step";
  const stepObjective =
    typeof step?.objective === "string"
      ? step.objective
      : typeof chain?.objective === "string"
        ? chain.objective
        : "";
  const mergedContext =
    context && typeof context === "object" && !Array.isArray(context) ? context : {};

  return {
    schema_id: schemaId,
    schema,
    chain: {
      name: chainName,
      description: chainDescription,
    },
    step: {
      id: stepId,
      title: stepTitle,
      objective: stepObjective,
    },
    instructions,
    options: {
      sets: optionSets,
      selected: selections,
      hints: optionHints,
    },
    context: mergedContext,
  };
}

async function resolveSystemPrompt(options, chain) {
  const parts = [];
  if (!options.noSystemFile && options.systemFile) {
    const systemPath = path.resolve(options.systemFile);
    const systemText = await fsp.readFile(systemPath, "utf8");
    parts.push(systemText);
  }
  if (typeof chain?.system_prompt === "string" && chain.system_prompt.trim()) {
    parts.push(chain.system_prompt.trim());
  }
  if (!parts.length) {
    return "";
  }
  return parts.join("\n\n");
}

function collectTemplateSource(chain, step, chainDir) {
  const templateFile =
    step?.template_file ??
    step?.templateFile ??
    chain?.template_file ??
    chain?.templateFile ??
    null;
  if (templateFile) {
    const resolved = resolveChainPath(chainDir, templateFile);
    return { type: "file", value: resolved };
  }
  const inline =
    step?.prompt_template ??
    step?.promptTemplate ??
    chain?.prompt_template ??
    chain?.promptTemplate ??
    null;
  if (typeof inline === "string" && inline.trim()) {
    return { type: "inline", value: inline };
  }
  return null;
}

async function renderPrompt({
  schemaId,
  schema,
  chain,
  step,
  instructions,
  optionSets,
  selections,
  optionHints,
  context,
  chainDir,
}) {
  const templateSource = collectTemplateSource(chain, step, chainDir);
  if (!templateSource) {
    return buildDefaultPrompt({
      schemaId,
      schema,
      chain,
      step,
      instructions,
      optionSets,
      selections,
      optionHints,
      context,
    });
  }

  let templateText = null;
  if (templateSource.type === "file") {
    templateText = await fsp.readFile(templateSource.value, "utf8");
  } else {
    templateText = templateSource.value;
  }

  const contextPayload = buildTemplateContext({
    schemaId,
    schema,
    chain,
    step,
    instructions,
    optionSets,
    selections,
    optionHints,
    context,
  });
  const rendered = applyPromptTemplate(templateText, contextPayload);
  const parsed = parseStrictJson(rendered);
  if (!parsed || (typeof parsed !== "object" && !Array.isArray(parsed))) {
    throw new Error("Prompt template must render valid JSON.");
  }
  return parsed;
}

function collectWatchFiles(chainPath, chainDir, chain, step, selectedFile, learnedFile) {
  const watchTargets = new Set();
  watchTargets.add(chainPath);
  if (selectedFile) watchTargets.add(selectedFile);
  if (learnedFile) watchTargets.add(learnedFile);
  const templateSource = collectTemplateSource(chain, step, chainDir);
  if (templateSource?.type === "file") {
    watchTargets.add(templateSource.value);
  }
  return Array.from(watchTargets)
    .filter((filePath) => Boolean(filePath))
    .filter((filePath) => fs.existsSync(filePath));
}

async function runOnce(options) {
  const chainPath = path.resolve(options.chain);
  const chainDir = path.dirname(chainPath);
  const chain = await readJsonFile(chainPath, { required: true });
  const step = resolveStep(chain, options.step);

  const schemaId =
    typeof step?.schema_id === "string"
      ? step.schema_id
      : typeof chain?.schema_id === "string"
        ? chain.schema_id
        : null;
  if (!schemaId) {
    throw new Error("Prompt chain is missing schema_id.");
  }

  const registry = new PromptSchemaRegistry();
  const schemaEntry = registry.getSchema(schemaId);
  if (!schemaEntry) {
    throw new Error(`Schema "${schemaId}" not found under docs/prompts.`);
  }
  const schema = schemaEntry.definition;

  const defaultLearned =
    typeof chain?.learned_options_file === "string"
      ? resolveChainPath(chainDir, chain.learned_options_file)
      : path.join(chainDir, "learned-options.json");
  const learnedPath = options.learnedFile
    ? path.resolve(options.learnedFile)
    : defaultLearned;
  const learnedData = await readJsonFile(learnedPath, { required: false });
  const learnedSets =
    learnedData?.option_sets ?? learnedData?.optionSets ?? {};

  const defaultSelected =
    typeof chain?.selected_options_file === "string"
      ? resolveChainPath(chainDir, chain.selected_options_file)
      : path.join(chainDir, "selected-options.json");
  const selectedPath = options.selectedFile
    ? path.resolve(options.selectedFile)
    : defaultSelected;
  const selectedData = await readJsonFile(selectedPath, { required: false });

  const baseSets = chain?.option_sets ?? chain?.optionSets ?? {};
  const stepSets = step?.option_sets ?? step?.optionSets ?? {};
  const mergedSets = mergeOptionSets(mergeOptionSets(baseSets, stepSets), learnedSets);

  const overrideSelections = {};
  if (selectedData && typeof selectedData === "object") {
    Object.entries(selectedData).forEach(([key, value]) => {
      if (typeof value === "string") {
        overrideSelections[key] = value.trim();
      }
    });
  }
  for (const selection of options.selections) {
    const parsed = parseSelection(selection);
    if (parsed) {
      overrideSelections[parsed.setId] = parsed.optionId;
    }
  }

  const selections = resolveOptionSelections(mergedSets, overrideSelections);
  const optionHints = buildOptionHintBlock(mergedSets, selections);

  const mergedContext = {
    ...(chain?.context && typeof chain.context === "object" ? chain.context : {}),
    ...(step?.context && typeof step.context === "object" ? step.context : {}),
  };

  const instructions = [chain?.instructions, step?.instructions]
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .join("\n\n");

  const promptObject = await renderPrompt({
    schemaId,
    schema,
    chain,
    step,
    instructions,
    optionSets: mergedSets,
    selections,
    optionHints,
    context: mergedContext,
    chainDir,
  });

  const promptText = `${JSON.stringify(promptObject, null, 2)}\n`;
  const systemPrompt = await resolveSystemPrompt(options, chain);

  const model =
    options.model ??
    chain?.default_model ??
    chain?.defaults?.model ??
    "mistralai/devstral-small-2-2512";
  const maxTokens =
    options.maxTokens ??
    chain?.defaults?.max_tokens ??
    chain?.defaults?.maxTokens ??
    900;
  const temperature =
    options.temperature ??
    chain?.defaults?.temperature ??
    0;

  const payload = {
    model,
    stream: false,
    max_tokens: Math.max(-1, Math.floor(maxTokens)),
    temperature,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: sanitizeSchemaName(schemaId),
        schema,
      },
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: promptText.trimEnd() },
    ],
  };

  if (options.promptOut) {
    const outPath = path.resolve(options.promptOut);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, promptText, "utf8");
  }

  if (options.writeSelected && selectedPath) {
    await fsp.mkdir(path.dirname(selectedPath), { recursive: true });
    await fsp.writeFile(selectedPath, `${JSON.stringify(selections, null, 2)}\n`, "utf8");
  }

  if (options.output) {
    const outPath = path.resolve(options.output);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  if (!options.send) {
    if (!options.output) {
      console.log(JSON.stringify(payload, null, 2));
    }
    return {
      payload,
      promptText,
      selections,
      chainPath,
      chainDir,
      step,
      chain,
      schemaId,
      selectedPath,
      learnedPath,
    };
  }

  const url = `${stripTrailingSlashes(options.baseUrl)}/api/v0/chat/completions`;
  const completion = await fetchJson(url, payload, options.timeoutMs);
  if (options.responseFile) {
    const outPath = path.resolve(options.responseFile);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, `${JSON.stringify(completion, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(completion, null, 2));

  return {
    payload,
    promptText,
    selections,
    chainPath,
    chainDir,
    step,
    chain,
    schemaId,
    selectedPath,
    learnedPath,
  };
}

async function run(options) {
  if (!options.watch) {
    await runOnce(options);
    return;
  }

  let running = false;
  let pending = false;
  let lastInfo = null;

  const execute = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      lastInfo = await runOnce(options);
    } catch (error) {
      console.error(`[prompt-composer] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        setTimeout(execute, 100);
      }
    }
  };

  await execute();

  if (!lastInfo) {
    console.warn("[prompt-composer] Unable to determine watch targets.");
    return;
  }

  const watchFiles = collectWatchFiles(
    lastInfo.chainPath,
    lastInfo.chainDir,
    lastInfo.chain,
    lastInfo.step,
    lastInfo.selectedPath ?? null,
    lastInfo.learnedPath ?? null,
  );
  if (!watchFiles.length) {
    console.warn("[prompt-composer] No watch files detected.");
    return;
  }

  let debounce = null;
  const schedule = () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      console.log("[prompt-composer] Change detected; recomposing.");
      execute();
    }, 120);
  };

  const watchers = watchFiles.map((filePath) =>
    fs.watch(filePath, { persistent: true }, () => schedule()),
  );

  const cleanup = () => {
    watchers.forEach((watcher) => watcher.close());
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  await run(options);
}

main().catch((error) => {
  console.error(`[prompt-composer] ${error instanceof Error ? error.message : String(error)}`);
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
