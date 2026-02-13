import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import CliExecutor from "./cli-executor.js";
import WorkspaceProfiler from "./workspace-profiler.js";
import CapabilityInventory from "./capability-inventory.js";
import MiniPhiMemory from "./miniphi-memory.js";
import ResourceMonitor from "./resource-monitor.js";
import ApiNavigator from "./api-navigator.js";
import PromptDecomposer from "./prompt-decomposer.js";
import PromptTemplateBaselineBuilder from "./prompt-template-baselines.js";
import PromptRecorder from "./prompt-recorder.js";
import {
  buildJsonSchemaResponseFormat,
  summarizeJsonSchemaValidation,
  validateJsonObjectAgainstSchema,
} from "./json-schema-utils.js";
import { buildStopReasonInfo, classifyLmStudioError } from "./lmstudio-error-utils.js";
import { parseNumericSetting } from "./cli-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const GENERAL_BENCHMARK_BASELINE_PATH = path.join(
  PROJECT_ROOT,
  "benchmark",
  "baselines",
  "general-purpose-baseline.json",
);
const BENCHMARK_ASSESSMENT_SCHEMA_ID = "benchmark-general-assessment";
const BENCHMARK_ASSESSMENT_SCHEMA_VERSION = "benchmark-general-assessment@v1";
const COMMAND_OUTPUT_PREVIEW_CHARS = 1400;
const BENCHMARK_ASSESSMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "summary",
    "needs_more_context",
    "missing_snippets",
    "category_scores",
    "action_plan",
    "stop_reason",
  ],
  properties: {
    schema_version: { type: "string", enum: [BENCHMARK_ASSESSMENT_SCHEMA_VERSION] },
    summary: { type: "string" },
    needs_more_context: { type: "boolean" },
    missing_snippets: { type: "array", items: { type: "string" }, default: [] },
    category_scores: {
      type: "object",
      additionalProperties: false,
      required: [
        "function_calling_tool_use",
        "general_assistant_reasoning",
        "coding_software_engineering",
        "computer_interaction_gui_web",
      ],
      properties: {
        function_calling_tool_use: {
          type: "object",
          additionalProperties: false,
          required: ["score", "rationale"],
          properties: {
            score: { type: "integer" },
            rationale: { type: "string" },
          },
        },
        general_assistant_reasoning: {
          type: "object",
          additionalProperties: false,
          required: ["score", "rationale"],
          properties: {
            score: { type: "integer" },
            rationale: { type: "string" },
          },
        },
        coding_software_engineering: {
          type: "object",
          additionalProperties: false,
          required: ["score", "rationale"],
          properties: {
            score: { type: "integer" },
            rationale: { type: "string" },
          },
        },
        computer_interaction_gui_web: {
          type: "object",
          additionalProperties: false,
          required: ["score", "rationale"],
          properties: {
            score: { type: "integer" },
            rationale: { type: "string" },
          },
        },
      },
    },
    action_plan: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "category", "recommendation"],
        properties: {
          priority: { type: "string", enum: ["high", "medium", "low"] },
          category: {
            type: "string",
            enum: [
              "function_calling_tool_use",
              "general_assistant_reasoning",
              "coding_software_engineering",
              "computer_interaction_gui_web",
            ],
          },
          recommendation: { type: "string" },
        },
      },
    },
    stop_reason: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
  },
};
const BENCHMARK_ASSESSMENT_RESPONSE_FORMAT = buildJsonSchemaResponseFormat(
  BENCHMARK_ASSESSMENT_JSON_SCHEMA,
  BENCHMARK_ASSESSMENT_SCHEMA_ID,
);
const BENCHMARK_ASSESSMENT_SCHEMA_BLOCK = [
  "{",
  `  "schema_version": "${BENCHMARK_ASSESSMENT_SCHEMA_VERSION}",`,
  '  "summary": "overall benchmark readiness summary",',
  '  "needs_more_context": false,',
  '  "missing_snippets": ["repo-relative snippets still needed"],',
  '  "category_scores": {',
  '    "function_calling_tool_use": { "score": 0-100, "rationale": "..." },',
  '    "general_assistant_reasoning": { "score": 0-100, "rationale": "..." },',
  '    "coding_software_engineering": { "score": 0-100, "rationale": "..." },',
  '    "computer_interaction_gui_web": { "score": 0-100, "rationale": "..." }',
  "  },",
  '  "action_plan": [',
  '    { "priority": "high|medium|low", "category": "category key", "recommendation": "specific fix" }',
  "  ],",
  '  "stop_reason": null,',
  '  "notes": "optional details" ',
  "}",
].join("\n");
const BENCHMARK_ASSESSMENT_SYSTEM_PROMPT = [
  "You are evaluating MiniPhi general-purpose benchmark readiness.",
  "Return strictly valid JSON for schema benchmark-general-assessment@v1 and nothing else.",
  "Use command output, workspace metadata, and navigation/decomposition context to score readiness.",
  "Scores must be integers from 0 to 100.",
  "When data is insufficient, set needs_more_context=true and list concrete missing_snippets.",
  "Never output markdown or prose before/after the JSON object.",
].join(" ");

async function loadGeneralBenchmarkBaseline() {
  try {
    const payload = await fs.promises.readFile(GENERAL_BENCHMARK_BASELINE_PATH, "utf8");
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function computeResourceBaselineDiff(current, baseline) {
  if (!current || !baseline) {
    return null;
  }
  const diff = {};
  for (const metric of ["memory", "cpu", "vram"]) {
    const currentMetric = current[metric];
    const baselineMetric = baseline[metric];
    const currentAvg = Number(currentMetric?.avg ?? currentMetric?.mean ?? NaN);
    const baselineAvg = Number(baselineMetric?.avg ?? baselineMetric?.mean ?? NaN);
    if (!Number.isFinite(currentAvg) || !Number.isFinite(baselineAvg)) {
      continue;
    }
    diff[metric] = {
      currentAvg: Number(currentAvg.toFixed(2)),
      baselineAvg: Number(baselineAvg.toFixed(2)),
      delta: Number((currentAvg - baselineAvg).toFixed(2)),
    };
  }
  return Object.keys(diff).length ? diff : null;
}

function formatResourceBaselineDiff(diff) {
  if (!diff) {
    return "";
  }
  const parts = [];
  for (const metric of ["memory", "cpu", "vram"]) {
    const entry = diff[metric];
    if (!entry) {
      continue;
    }
    const delta = entry.delta;
    const deltaLabel = delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
    parts.push(
      `${metric} \u0394 ${deltaLabel} (current ${entry.currentAvg.toFixed(2)} vs baseline ${entry.baselineAvg.toFixed(2)})`,
    );
  }
  return parts.join(" | ");
}

function clampTextPreview(text, limit = COMMAND_OUTPUT_PREVIEW_CHARS) {
  if (!text || typeof text !== "string") {
    return "";
  }
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(80, limit))}...`;
}

function buildCategoryScore(score, rationale) {
  const numeric = Number(score);
  const normalizedScore = Number.isFinite(numeric)
    ? Math.max(0, Math.min(100, Math.round(numeric)))
    : 0;
  const normalizedRationale =
    typeof rationale === "string" && rationale.trim().length
      ? rationale.trim()
      : "No validated assessment data available.";
  return {
    score: normalizedScore,
    rationale: normalizedRationale,
  };
}

function buildBenchmarkAssessmentFallback(reason, stopReason = "invalid-response") {
  return {
    schema_version: BENCHMARK_ASSESSMENT_SCHEMA_VERSION,
    summary: `Benchmark assessment fallback: ${reason ?? stopReason}`,
    needs_more_context: true,
    missing_snippets: ["src/index.js", "src/libs/efficient-log-analyzer.js"],
    category_scores: {
      function_calling_tool_use: buildCategoryScore(0, "Assessment unavailable."),
      general_assistant_reasoning: buildCategoryScore(0, "Assessment unavailable."),
      coding_software_engineering: buildCategoryScore(0, "Assessment unavailable."),
      computer_interaction_gui_web: buildCategoryScore(0, "Assessment unavailable."),
    },
    action_plan: [
      {
        priority: "high",
        category: "coding_software_engineering",
        recommendation: "Re-run benchmark with a valid JSON response from LM Studio.",
      },
    ],
    stop_reason: stopReason,
    notes: reason ?? null,
  };
}

function isTimeoutLikeStopReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) {
    return false;
  }
  return reason.toLowerCase().includes("timeout");
}

function classifyAssessmentStopReason(validationStatus) {
  if (validationStatus === "preamble_detected") {
    return "preamble_detected";
  }
  if (validationStatus === "schema_invalid" || validationStatus === "invalid_json") {
    return "invalid-response";
  }
  return "analysis-error";
}

async function readCommandOutputPreview(commandDetails) {
  if (!commandDetails || typeof commandDetails !== "object") {
    return { stdout: "", stderr: "" };
  }
  const previews = { stdout: "", stderr: "" };
  const entries = [
    ["stdout", commandDetails.stdoutPath],
    ["stderr", commandDetails.stderrPath],
  ];
  for (const [field, filePath] of entries) {
    if (!filePath || typeof filePath !== "string") {
      continue;
    }
    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      previews[field] = clampTextPreview(content);
    } catch {
      previews[field] = "";
    }
  }
  return previews;
}

async function runLmGeneralBenchmarkAssessment({
  restClient,
  timeoutMs = undefined,
  schemaRegistry,
  promptRecorder,
  task,
  cwd,
  workspaceContext,
  commandDetails,
  decompositionPlan,
}) {
  if (!restClient) {
    return null;
  }
  const commandPreview = await readCommandOutputPreview(commandDetails);
  const schemaBlock = schemaRegistry?.buildInstructionBlock
    ? schemaRegistry.buildInstructionBlock(BENCHMARK_ASSESSMENT_SCHEMA_ID, {
        compact: true,
        maxLength: 1800,
      }) || ["```json", BENCHMARK_ASSESSMENT_SCHEMA_BLOCK, "```"].join("\n")
    : ["```json", BENCHMARK_ASSESSMENT_SCHEMA_BLOCK, "```"].join("\n");
  const requestBody = {
    objective: task,
    workspace: {
      cwd,
      classification: workspaceContext?.classification ?? null,
      summary: clampTextPreview(workspaceContext?.summary ?? "", 1000) || null,
      navigation_summary: clampTextPreview(workspaceContext?.navigationSummary ?? "", 700) || null,
      helper_script: workspaceContext?.helperScript
        ? {
            id: workspaceContext.helperScript.id ?? null,
            name: workspaceContext.helperScript.name ?? null,
            run: workspaceContext.helperScript.run
              ? {
                  exitCode: workspaceContext.helperScript.run.exitCode ?? null,
                  summary: workspaceContext.helperScript.run.summary ?? null,
                }
              : null,
          }
        : null,
    },
    command: commandDetails
      ? {
          command: commandDetails.command ?? null,
          exit_code: commandDetails.exitCode ?? null,
          silence_exceeded: commandDetails.silenceExceeded ?? false,
          duration_ms: commandDetails.durationMs ?? null,
          stdout_preview: commandPreview.stdout,
          stderr_preview: commandPreview.stderr,
        }
      : null,
    decomposition: decompositionPlan
      ? {
          id: decompositionPlan.planId ?? null,
          summary: clampTextPreview(decompositionPlan.summary ?? "", 600) || null,
          outline: clampTextPreview(decompositionPlan.outline ?? "", 1200) || null,
          stop_reason: decompositionPlan.stopReason ?? null,
        }
      : null,
    benchmark_categories: [
      "function_calling_tool_use",
      "general_assistant_reasoning",
      "coding_software_engineering",
      "computer_interaction_gui_web",
    ],
  };
  const messages = [
    {
      role: "system",
      content: `${BENCHMARK_ASSESSMENT_SYSTEM_PROMPT}\nJSON schema:\n${schemaBlock}`,
    },
    {
      role: "user",
      content: JSON.stringify(requestBody, null, 2),
    },
  ];
  let responseText = "";
  let toolCalls = null;
  let toolDefinitions = null;
  let schemaValidation = null;
  let errorMessage = null;
  let assessment = null;

  try {
    const completion = await restClient.createChatCompletion({
      messages,
      temperature: 0.1,
      max_tokens: -1,
      response_format: BENCHMARK_ASSESSMENT_RESPONSE_FORMAT,
      timeoutMs,
    });
    const message = completion?.choices?.[0]?.message ?? null;
    responseText = message?.content ?? "";
    toolCalls = message?.tool_calls ?? null;
    toolDefinitions = completion?.tool_definitions ?? null;
    const validationOutcome = validateJsonObjectAgainstSchema(
      BENCHMARK_ASSESSMENT_JSON_SCHEMA,
      responseText,
    );
    schemaValidation = validationOutcome.validation;
    if (validationOutcome.status === "ok" && validationOutcome.parsed) {
      assessment = validationOutcome.parsed;
      assessment.stop_reason = assessment.stop_reason ?? null;
    } else {
      const stopReason = classifyAssessmentStopReason(validationOutcome.status);
      errorMessage = validationOutcome.error ?? "invalid benchmark assessment JSON";
      assessment = buildBenchmarkAssessmentFallback(errorMessage, stopReason);
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    const errorInfo = classifyLmStudioError(errorMessage);
    assessment = buildBenchmarkAssessmentFallback(
      errorMessage,
      errorInfo.reason ?? "analysis-error",
    );
  }

  let promptRecord = null;
  if (promptRecorder) {
    const schemaValidationSummary = summarizeJsonSchemaValidation(schemaValidation, {
      maxErrors: 3,
    });
    const responsePayload = {
      ...(assessment ?? buildBenchmarkAssessmentFallback("missing assessment payload")),
      rawResponseText: responseText ?? "",
      schemaValidation: schemaValidationSummary ?? null,
      tool_calls: toolCalls ?? null,
      tool_definitions: toolDefinitions ?? null,
    };
    const stopInfo = buildStopReasonInfo({
      error: errorMessage,
      fallbackReason: responsePayload.stop_reason ?? null,
    });
    try {
      promptRecord = await promptRecorder.record({
        scope: "sub",
        label: "benchmark-general-assessment",
        mainPromptId: null,
        metadata: {
          type: "benchmark-general-assessment",
          objective: task,
          cwd,
          stop_reason: stopInfo.reason,
          stop_reason_code: stopInfo.code,
          stop_reason_detail: stopInfo.detail,
        },
        request: {
          endpoint: "/chat/completions",
          payload: requestBody,
          messages,
          response_format: BENCHMARK_ASSESSMENT_RESPONSE_FORMAT,
        },
        response: responsePayload,
        error: errorMessage ?? null,
      });
    } catch {
      promptRecord = null;
    }
  }

  return {
    assessment,
    error: errorMessage,
    schemaValidation: summarizeJsonSchemaValidation(schemaValidation, { maxErrors: 3 }),
    promptRecord,
    toolCalls,
    toolDefinitions,
  };
}

function buildBenchmarkDecompositionWorkspace(workspaceContext) {
  if (!workspaceContext || typeof workspaceContext !== "object") {
    return null;
  }
  return {
    classification: workspaceContext.classification ?? null,
    summary: clampTextPreview(workspaceContext.summary ?? "", 240),
    hintBlock: null,
    planDirectives: null,
    capabilitySummary: null,
    navigationSummary: null,
    manifestPreview: [],
    stats: workspaceContext.stats ?? null,
    cachedHints: null,
  };
}

async function runGeneralPurposeBenchmark({
  options,
  verbose,
  schemaRegistry,
  restClient = null,
  liveLmEnabled = false,
  liveLmTimeoutMs = 12000,
  liveLmPlanTimeoutMs = 12000,
  configData = undefined,
  resourceConfig = undefined,
  resourceMonitorForcedDisabled = false,
  generateWorkspaceSnapshot,
  globalMemory,
  schemaAdapterRegistry,
  mirrorPromptTemplateToGlobal,
  emitFeatureDisableNotice,
}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const task =
    (typeof options.task === "string" && options.task.trim()) ||
    (typeof options.objective === "string" && options.objective.trim()) ||
    "General-purpose benchmark";
  const command = options.cmd ?? options.command ?? null;
  const useLiveLm = Boolean(liveLmEnabled && restClient);
  const silenceTimeout = parseNumericSetting(options["silence-timeout"], "--silence-timeout") ?? 15000;
  const timeoutMs = parseNumericSetting(options.timeout, "--timeout") ?? 60000;
  const stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
  let promptRecorder = null;
  if (useLiveLm) {
    promptRecorder = new PromptRecorder(stateManager.baseDir);
    try {
      await promptRecorder.prepare();
    } catch (error) {
      promptRecorder = null;
      if (verbose) {
        console.warn(
          `[MiniPhi][Benchmark] Prompt recorder unavailable for live benchmark run: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  let benchmarkMonitor = null;
  let benchmarkMonitorResult = null;
  if (!resourceMonitorForcedDisabled) {
    const monitorHistoryFile = path.join(stateManager.historyDir, "benchmark-resource-usage.json");
    benchmarkMonitor = new ResourceMonitor({
      ...(resourceConfig ?? {}),
      historyFile: monitorHistoryFile,
      label: `benchmark:general:${path.basename(cwd) || "workspace"}`,
    });
    try {
      await benchmarkMonitor.start(`benchmark:${path.basename(cwd) || cwd}`);
    } catch (error) {
      benchmarkMonitor = null;
      if (verbose) {
        console.warn(
          `[MiniPhi][Benchmark] Resource monitor unavailable for general-purpose benchmark: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }
  const cli = new CliExecutor();
  const workspaceProfiler = new WorkspaceProfiler();
  const capabilityInventory = new CapabilityInventory();
  const navigator =
    useLiveLm &&
    new ApiNavigator({
      restClient,
      cliExecutor: cli,
      memory: stateManager,
      globalMemory,
      logger: verbose ? (message) => console.warn(message) : null,
      adapterRegistry: schemaAdapterRegistry,
      schemaRegistry,
      helperSilenceTimeoutMs: configData?.prompt?.navigator?.helperSilenceTimeoutMs,
      navigationRequestTimeoutMs: liveLmTimeoutMs,
      promptRecorder,
    });
  const workspaceContext = await generateWorkspaceSnapshot({
    rootDir: cwd,
    workspaceProfiler,
    capabilityInventory,
    verbose,
    navigator: navigator ?? null,
    objective: task,
    executeHelper: true,
    memory: stateManager,
    globalMemory,
    emitFeatureDisableNotice,
  });

  let decompositionPlan = null;
  if (useLiveLm) {
    const decompositionWorkspace = buildBenchmarkDecompositionWorkspace(workspaceContext);
    const decomposer = new PromptDecomposer({
      restClient,
      logger: verbose ? (message) => console.warn(message) : null,
      schemaRegistry,
      timeoutMs: liveLmPlanTimeoutMs,
      maxAttempts: 1,
    });
    try {
      decompositionPlan = await decomposer.decompose({
        objective: `${task} (plan)`,
        command: command ?? null,
        workspace: decompositionWorkspace,
        promptRecorder,
        storage: stateManager,
        metadata: { mode: "benchmark", scope: "general-purpose" },
      });
    } catch (error) {
      if (verbose) {
        console.warn(
          `[MiniPhi][Benchmark] Prompt decomposer skipped: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    } finally {
      if (typeof decomposer.consumeDisableNotice === "function") {
        const notice = decomposer.consumeDisableNotice();
        if (notice) {
          emitFeatureDisableNotice("Prompt decomposer", notice);
        }
      }
    }
  }

  const builder = new PromptTemplateBaselineBuilder({ schemaRegistry });
  const datasetSummary =
    workspaceContext?.summary ??
    `Workspace ${path.basename(cwd) || cwd} contains mixed artifacts; optimize prompts for this context.`;
  const templatePayloads = [
    builder.build({
      baseline: "truncation",
      task: `${task} (chunking)`,
      datasetSummary,
      workspaceContext,
    }),
    builder.build({
      baseline: "analysis",
      task: `${task} (analysis)`,
      datasetSummary,
      workspaceContext,
    }),
  ];
  const savedTemplates = [];
  for (const payload of templatePayloads) {
    const templateLabel = `general-purpose ${payload.metadata?.baseline ?? payload.baseline ?? "prompt"}`;
    const saved = await stateManager.savePromptTemplateBaseline({
      ...payload,
      label: templateLabel,
      cwd,
    });
    savedTemplates.push(saved);
    if (verbose) {
      const rel = path.relative(process.cwd(), saved.path) || saved.path;
      console.log(`[MiniPhi][Benchmark] Saved prompt template to ${rel}`);
    }
    await mirrorPromptTemplateToGlobal(
      saved,
      {
        label: templateLabel,
        schemaId: payload.schemaId ?? null,
        baseline: payload.metadata?.baseline ?? payload.baseline ?? null,
        task: payload.task ?? null,
      },
      workspaceContext,
      { verbose, source: "general-benchmark" },
    );
  }

  let commandDetails = null;
  if (command) {
    const logDir = path.join(stateManager.historyDir, "benchmarks");
    await fs.promises.mkdir(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = command.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "command";
    const stdoutPath = path.join(logDir, `${timestamp}-${slug}-stdout.log`);
    const stderrPath = path.join(logDir, `${timestamp}-${slug}-stderr.log`);
    if (verbose) {
      console.log(`[MiniPhi][Benchmark] Running general-purpose command: ${command}`);
    }
    let execResult;
    try {
      execResult = await cli.executeCommand(command, {
        cwd,
        timeout: timeoutMs,
        maxSilenceMs: silenceTimeout,
        captureOutput: true,
        onStdout: (text) => process.stdout.write(text),
        onStderr: (text) => process.stderr.write(text),
      });
    } catch (error) {
      execResult = {
        code: typeof error.code === "number" ? error.code : -1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? (error instanceof Error ? error.message : String(error)),
        silenceExceeded: error.silenceExceeded ?? false,
        durationMs: error.durationMs ?? null,
      };
      if (verbose) {
        console.warn(`[MiniPhi][Benchmark] Command execution failed: ${execResult.stderr}`);
      }
    }
    await fs.promises.writeFile(stdoutPath, execResult.stdout ?? "", "utf8");
    await fs.promises.writeFile(stderrPath, execResult.stderr ?? "", "utf8");
    commandDetails = {
      command,
      exitCode: execResult.code ?? execResult.exitCode ?? 0,
      stdoutPath,
      stderrPath,
      silenceExceeded: Boolean(execResult.silenceExceeded),
      durationMs: execResult.durationMs ?? null,
    };
    if (verbose) {
      console.log(
        `[MiniPhi][Benchmark] Command finished with exit ${commandDetails.exitCode}${
          commandDetails.silenceExceeded ? " (terminated for silence)" : ""
        }`,
      );
    }
    if (commandDetails.silenceExceeded) {
      console.warn(
        "[MiniPhi][Benchmark] Command output stalled; review stdout/stderr logs before trusting the run.",
      );
    }
  }

  let lmAssessment = null;
  if (useLiveLm) {
    const navigationStopReason = workspaceContext?.navigationHints?.raw?.stop_reason ?? null;
    const decompositionStopReason = decompositionPlan?.stopReason ?? null;
    const navigationTimedOut = isTimeoutLikeStopReason(navigationStopReason);
    const decompositionTimedOut = isTimeoutLikeStopReason(decompositionStopReason);
    const shouldSkipAssessment = navigationTimedOut && decompositionTimedOut;
    if (shouldSkipAssessment) {
      const skipReason = `skipped benchmark assessment after navigator+decomposer timeout (${[
        navigationStopReason,
        decompositionStopReason,
      ]
        .filter(Boolean)
        .join(", ")})`;
      lmAssessment = {
        assessment: buildBenchmarkAssessmentFallback(skipReason, "timeout"),
        error: skipReason,
        schemaValidation: null,
        promptRecord: null,
        toolCalls: null,
        toolDefinitions: null,
      };
    } else {
      lmAssessment = await runLmGeneralBenchmarkAssessment({
        restClient,
        timeoutMs: liveLmTimeoutMs,
        schemaRegistry,
        promptRecorder,
        task,
        cwd,
        workspaceContext,
        commandDetails,
        decompositionPlan,
      });
    }
  }

  if (benchmarkMonitor) {
    try {
      benchmarkMonitorResult = await benchmarkMonitor.stop();
      if (benchmarkMonitorResult?.persisted?.path && verbose) {
        const relMonitor =
          path.relative(process.cwd(), benchmarkMonitorResult.persisted.path) ||
          benchmarkMonitorResult.persisted.path;
        console.log(`[MiniPhi][Benchmark] Resource stats appended to ${relMonitor}`);
      }
      if (benchmarkMonitorResult?.summary?.warnings?.length) {
        for (const warning of benchmarkMonitorResult.summary.warnings) {
          console.warn(`[MiniPhi][Resources] ${warning}`);
        }
      }
    } catch (error) {
      console.warn(
        `[MiniPhi][Benchmark] Unable to finalize resource monitor: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  const summaryDir = path.join(stateManager.historyDir, "benchmarks");
  await fs.promises.mkdir(summaryDir, { recursive: true });
  const summaryPath = path.join(
    summaryDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-general-benchmark.json`,
  );
  const resourceStats = benchmarkMonitorResult?.summary?.stats ?? null;
  let resourceBaseline = null;
  let resourceBaselineDiff = null;
  try {
    resourceBaseline = await loadGeneralBenchmarkBaseline();
  } catch (error) {
    if (verbose) {
      console.warn(
        `[MiniPhi][Benchmark] Unable to load general-purpose baseline: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  if (resourceStats && resourceBaseline?.resourceStats) {
    resourceBaselineDiff = computeResourceBaselineDiff(resourceStats, resourceBaseline.resourceStats);
  }
  if (resourceBaselineDiff) {
    const diffSummary = formatResourceBaselineDiff(resourceBaselineDiff);
    if (diffSummary) {
      console.log(`[MiniPhi][Benchmark] Resource delta vs baseline: ${diffSummary}`);
    }
  }
  const summary = {
    kind: "general-purpose",
    analyzedAt: new Date().toISOString(),
    directory: cwd,
    task,
    liveLm: {
      requested: Boolean(liveLmEnabled),
      active: useLiveLm,
      assessmentStopReason: lmAssessment?.assessment?.stop_reason ?? null,
      assessmentPromptExchangeId: lmAssessment?.promptRecord?.id ?? null,
      assessmentSchemaStatus: lmAssessment?.schemaValidation?.status ?? null,
      assessmentError: lmAssessment?.error ?? null,
    },
    workspaceType: workspaceContext?.classification?.label ?? null,
    workspaceSummary: workspaceContext?.summary ?? null,
    templates: savedTemplates.map((entry) => entry?.path ?? null).filter(Boolean),
    command: commandDetails,
    navigation: workspaceContext?.navigationSummary ?? null,
    navigationPromptExchangeId: workspaceContext?.navigationHints?.promptExchange?.id ?? null,
    helperScript: workspaceContext?.helperScript
      ? {
          id: workspaceContext.helperScript.id ?? null,
          name: workspaceContext.helperScript.name ?? null,
          path: workspaceContext.helperScript.path ?? null,
          version: workspaceContext.helperScript.version ?? null,
          stdin: workspaceContext.helperScript.stdin ?? null,
          run: workspaceContext.helperScript.run
            ? {
                exitCode: workspaceContext.helperScript.run.exitCode ?? null,
                summary: workspaceContext.helperScript.run.summary ?? null,
                silenceExceeded: workspaceContext.helperScript.run.silenceExceeded ?? null,
              }
            : null,
        }
      : null,
    decompositionPlan: decompositionPlan
      ? {
          id: decompositionPlan.planId ?? null,
          summary: decompositionPlan.summary ?? null,
          outline: decompositionPlan.outline ?? null,
          promptExchangeId: decompositionPlan.promptExchange?.id ?? null,
        }
      : null,
    lmAssessment: lmAssessment?.assessment ?? null,
    lmAssessmentSchemaValidation: lmAssessment?.schemaValidation ?? null,
    resourceStats,
    resourceWarnings: benchmarkMonitorResult?.summary?.warnings ?? [],
    resourceLogPath: benchmarkMonitorResult?.persisted?.path ?? null,
    resourceBaseline: resourceBaseline?.resourceStats ?? null,
    resourceBaselineLabel: resourceBaseline?.label ?? null,
    resourceBaselineSources: resourceBaseline?.logSources ?? resourceBaseline?.sources ?? null,
    resourceBaselineDiff,
  };
  await fs.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  await stateManager.recordBenchmarkSummary(summary, { summaryPath, type: "general-purpose" });
  if (verbose) {
    const rel = path.relative(process.cwd(), summaryPath) || summaryPath;
    console.log(`[MiniPhi][Benchmark] General-purpose benchmark summary saved to ${rel}`);
  }
}

export { runGeneralPurposeBenchmark };
