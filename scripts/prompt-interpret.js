import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import { parseStrictJson } from "../src/libs/core-utils.js";
import { validateJsonAgainstSchema } from "../src/libs/json-schema-utils.js";
import {
  DEFAULT_LEARNED_SCHEMA_VERSION,
  mergeLearnedOptions,
  normalizeOptionUpdates,
} from "../src/libs/prompt-chain-utils.js";

const VALIDATION_REPORT_SCHEMA_VERSION = "prompt-chain-validation@v1";
const DEFAULT_VALIDATION_REPORT_PATH = path.join(
  ".miniphi",
  "prompt-chain",
  "validation-report.json",
);

function printUsage() {
  const lines = [
    "Prompt chain interpreter (validates JSON responses + updates learned options).",
    "",
    "Usage:",
    "  node scripts/prompt-interpret.js --response-file .miniphi/prompt-chain/response.json",
    "  node scripts/prompt-interpret.js --content-file response-content.json",
    "",
    "Options:",
    "  --response-file <path>  Raw LM Studio response JSON (choices[0].message.content)",
    "  --content-file <path>   Raw assistant content or direct JSON response",
    "  --chain <path>          Prompt chain definition (default: samples/prompt-chain/chain.json)",
    "  --step <id|index>       Chain step id (or 1-based index) used for fallback",
    "  --schema-id <id>        Override schema id (defaults to chain schema_id)",
    "  --learned-file <path>   Learned option set file to update",
    "  --selected-file <path>  Selected option file to update",
    "  --no-update-learned     Skip learned option updates",
    "  --no-update-selected    Skip selected option updates",
    "  --output <path>         Write normalized response JSON to a file",
    "  -h, --help              Show help",
  ];
  console.log(lines.join("\n"));
}

function parseArgs(argv) {
  const options = {
    help: false,
    responseFile: null,
    contentFile: null,
    chain: path.join("samples", "prompt-chain", "chain.json"),
    step: null,
    schemaId: null,
    learnedFile: null,
    selectedFile: null,
    updateLearned: true,
    updateSelected: true,
    output: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--response-file") {
      options.responseFile = argv[++i];
      continue;
    }
    if (arg === "--content-file") {
      options.contentFile = argv[++i];
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
    if (arg === "--schema-id") {
      options.schemaId = argv[++i];
      continue;
    }
    if (arg === "--learned-file") {
      options.learnedFile = argv[++i];
      continue;
    }
    if (arg === "--selected-file") {
      options.selectedFile = argv[++i];
      continue;
    }
    if (arg === "--no-update-learned") {
      options.updateLearned = false;
      continue;
    }
    if (arg === "--no-update-selected") {
      options.updateSelected = false;
      continue;
    }
    if (arg === "--output") {
      options.output = argv[++i];
      continue;
    }
  }

  return options;
}

function buildExcerpt(text, limit = 400) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}...`;
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

async function loadValidationReport(reportPath) {
  const existing = await readJsonFile(reportPath, { required: false });
  if (!existing || typeof existing !== "object") {
    return {
      schema_version: VALIDATION_REPORT_SCHEMA_VERSION,
      updated_at: null,
      entries: [],
    };
  }
  return {
    schema_version:
      typeof existing.schema_version === "string" && existing.schema_version.trim()
        ? existing.schema_version.trim()
        : VALIDATION_REPORT_SCHEMA_VERSION,
    updated_at:
      typeof existing.updated_at === "string" && existing.updated_at.trim()
        ? existing.updated_at.trim()
        : null,
    entries: Array.isArray(existing.entries) ? existing.entries : [],
  };
}

async function appendValidationReport(reportPath, entry) {
  if (!entry) {
    return;
  }
  const report = await loadValidationReport(reportPath);
  report.entries.push(entry);
  report.updated_at = entry.timestamp ?? new Date().toISOString();
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function buildValidationEntry({
  schemaId,
  stepId,
  stopReason,
  errors,
  preambleDetected,
  rawText,
  responseFile,
  contentFile,
}) {
  const normalizedErrors = Array.isArray(errors) ? errors.filter(Boolean) : [];
  if (!stopReason && normalizedErrors.length === 0) {
    return null;
  }
  const trimmedResponseFile =
    typeof responseFile === "string" && responseFile.trim().length > 0 ? responseFile.trim() : null;
  const trimmedContentFile =
    typeof contentFile === "string" && contentFile.trim().length > 0 ? contentFile.trim() : null;
  return {
    timestamp: new Date().toISOString(),
    schema_id: schemaId ?? null,
    step_id: stepId ?? "unknown",
    stop_reason: stopReason ?? "validation_error",
    preamble_detected: Boolean(preambleDetected),
    errors: normalizedErrors,
    raw_length: typeof rawText === "string" ? rawText.length : 0,
    raw_excerpt: buildExcerpt(rawText),
    source: {
      response_file: trimmedResponseFile,
      content_file: trimmedContentFile,
    },
  };
}

function resolveStep(chain, stepId) {
  const steps = Array.isArray(chain?.steps) ? chain.steps : [];
  if (!steps.length) {
    return null;
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
  return null;
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

function normalizeSelections(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        normalized[key] = trimmed;
      }
    } else if (value === null) {
      normalized[key] = null;
    }
  }
  return normalized;
}

async function loadResponseContent({ responseFile, contentFile }) {
  let rawText = null;
  let parsedEnvelope = null;
  let directObject = null;

  if (responseFile) {
    const raw = await fsp.readFile(responseFile, "utf8");
    const trimmed = raw.trim();
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.choices) && parsed.choices[0]?.message?.content) {
        parsedEnvelope = parsed;
        rawText = String(parsed.choices[0].message.content);
      } else if (typeof parsed.content === "string") {
        parsedEnvelope = parsed;
        rawText = parsed.content;
      } else {
        directObject = parsed;
        rawText = trimmed;
      }
    } else {
      rawText = trimmed;
    }
  }

  if (!rawText && !directObject && contentFile) {
    rawText = await fsp.readFile(contentFile, "utf8");
  }

  return { rawText, parsedEnvelope, directObject };
}

function buildFallback({ schemaId, stepId, stopReason, notes }) {
  const fallbackVersion = schemaId ? `${schemaId}@v1` : DEFAULT_LEARNED_SCHEMA_VERSION;
  return {
    schema_version: fallbackVersion,
    step_id: stepId ?? "unknown",
    summary: "Fallback JSON generated after invalid or missing response.",
    selected_options: {},
    option_updates: [],
    needs_more_context: true,
    missing_snippets: [stopReason],
    stop_reason: stopReason,
    notes: notes ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!options.responseFile && !options.contentFile) {
    throw new Error("Pass --response-file or --content-file.");
  }

  const chainPath = path.resolve(options.chain);
  const chainDir = path.dirname(chainPath);
  const chain = await readJsonFile(chainPath, { required: true });
  const step = resolveStep(chain, options.step);

  const schemaId =
    options.schemaId ??
    (typeof step?.schema_id === "string" ? step.schema_id : null) ??
    (typeof chain?.schema_id === "string" ? chain.schema_id : null);
  if (!schemaId) {
    throw new Error("Unable to resolve schema_id (use --schema-id to override).");
  }

  const registry = new PromptSchemaRegistry();
  const schemaEntry = registry.getSchema(schemaId);
  if (!schemaEntry) {
    throw new Error(`Schema "${schemaId}" not found under docs/prompts.`);
  }

  const defaultLearned =
    typeof chain?.learned_options_file === "string"
      ? resolveChainPath(chainDir, chain.learned_options_file)
      : path.join(chainDir, "learned-options.json");
  const learnedPath = options.learnedFile
    ? path.resolve(options.learnedFile)
    : defaultLearned;
  const defaultSelected =
    typeof chain?.selected_options_file === "string"
      ? resolveChainPath(chainDir, chain.selected_options_file)
      : path.join(chainDir, "selected-options.json");
  const selectedPath = options.selectedFile
    ? path.resolve(options.selectedFile)
    : defaultSelected;

  const resolvedResponseFile = options.responseFile ? path.resolve(options.responseFile) : null;
  const resolvedContentFile = options.contentFile ? path.resolve(options.contentFile) : null;
  const { rawText, directObject } = await loadResponseContent({
    responseFile: resolvedResponseFile,
    contentFile: resolvedContentFile,
  });

  let parsed = directObject;
  let preambleDetected = false;
  if (!parsed && rawText) {
    parsed = parseStrictJson(rawText, { allowPreamble: false });
    if (!parsed) {
      const salvage = parseStrictJson(rawText, { allowPreamble: true });
      if (salvage) {
        preambleDetected = true;
      }
    }
  }

  let finalResponse = null;
  let fallbackReason = null;
  let validationErrors = null;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fallbackReason = preambleDetected ? "preamble_detected" : "invalid_json";
    if (rawText) {
      const strictValidation = validateJsonAgainstSchema(schemaEntry.definition, rawText, {
        allowPreamble: false,
      });
      if (strictValidation?.errors?.length) {
        validationErrors = strictValidation.errors;
      }
    }
  } else {
    const validation = registry.validate(schemaId, JSON.stringify(parsed));
    if (!validation?.valid) {
      fallbackReason = "schema_validation_failed";
      if (validation?.errors?.length) {
        validationErrors = validation.errors;
        const message = validationErrors.slice(0, 6).join("; ");
        finalResponse = buildFallback({
          schemaId,
          stepId: parsed.step_id ?? step?.id ?? null,
          stopReason: fallbackReason,
          notes: message,
        });
      }
    } else {
      finalResponse = validation.parsed;
    }
  }

  if (!finalResponse) {
    const fallbackNotes = preambleDetected
      ? "Response included a non-JSON preamble; strict JSON-only output is required."
      : validationErrors?.length
        ? validationErrors.slice(0, 2).join("; ")
        : null;
    finalResponse = buildFallback({
      schemaId,
      stepId: step?.id ?? null,
      stopReason: fallbackReason ?? "invalid_json",
      notes: fallbackNotes,
    });
  }

  const validationEntry = buildValidationEntry({
    schemaId,
    stepId: finalResponse.step_id ?? step?.id ?? null,
    stopReason: fallbackReason,
    errors: validationErrors,
    preambleDetected,
    rawText,
    responseFile: resolvedResponseFile,
    contentFile: resolvedContentFile,
  });
  await appendValidationReport(DEFAULT_VALIDATION_REPORT_PATH, validationEntry);

  if (options.updateLearned) {
    const updates = normalizeOptionUpdates(finalResponse.option_updates);
    if (updates.length > 0 && learnedPath) {
      const existing = await readJsonFile(learnedPath, { required: false });
      const merged = mergeLearnedOptions(existing, updates, {
        now: new Date().toISOString(),
        stepId: finalResponse.step_id ?? step?.id ?? null,
      });
      await fsp.mkdir(path.dirname(learnedPath), { recursive: true });
      await fsp.writeFile(learnedPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    }
  }

  if (options.updateSelected && selectedPath) {
    const normalizedSelections = normalizeSelections(finalResponse.selected_options);
    if (Object.keys(normalizedSelections).length > 0) {
      const existing = await readJsonFile(selectedPath, { required: false });
      const merged = {
        ...(existing && typeof existing === "object" ? existing : {}),
        ...normalizedSelections,
      };
      await fsp.mkdir(path.dirname(selectedPath), { recursive: true });
      await fsp.writeFile(selectedPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    }
  }

  if (options.output) {
    const outPath = path.resolve(options.output);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, `${JSON.stringify(finalResponse, null, 2)}\n`, "utf8");
  } else {
    console.log(JSON.stringify(finalResponse, null, 2));
  }
}

main().catch((error) => {
  console.error(`[prompt-interpret] ${error instanceof Error ? error.message : String(error)}`);
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
