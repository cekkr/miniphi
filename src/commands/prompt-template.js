import fs from "fs";
import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import PromptTemplateBaselineBuilder from "../libs/prompt-template-baselines.js";
import WorkspaceProfiler from "../libs/workspace-profiler.js";
import CapabilityInventory from "../libs/capability-inventory.js";
import { parseNumericSetting } from "../libs/cli-utils.js";

function parseListOption(value) {
  if (!value && value !== 0) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseListOption(entry)).filter(Boolean);
  }
  const text = value.toString().trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[,|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export async function handlePromptTemplateCommand(context) {
  const {
    options,
    verbose,
    schemaRegistry,
    generateWorkspaceSnapshot,
    globalMemory,
    mirrorPromptTemplateToGlobal,
  } = context;

  const rawBaseline =
    (typeof options.baseline === "string" && options.baseline.trim()) ||
    (typeof options.type === "string" && options.type.trim()) ||
    "truncation";
  const baseline = rawBaseline.toLowerCase();
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const task =
    (typeof options.task === "string" && options.task.trim()) ||
    "Explain how to truncate this oversized dataset so I can analyze it with Phi across multiple prompts while keeping history synced.";
  const datasetSummary =
    (typeof options["dataset-summary"] === "string" && options["dataset-summary"].trim()) ||
    (typeof options.dataset === "string" && options.dataset.trim()) ||
    `Oversized log/output data captured from ${path.basename(cwd) || "the workspace"}.`;
  const totalLines =
    parseNumericSetting(options["total-lines"], "--total-lines") ??
    parseNumericSetting(options.lines, "--lines");
  const chunkTarget =
    parseNumericSetting(options["target-lines"], "--target-lines") ??
    parseNumericSetting(options["chunk-size"], "--chunk-size");
  const helperFocus = parseListOption(options["helper-focus"]);
  const historyKeys = parseListOption(options["history-keys"]);
  const schemaId =
    (typeof options["schema-id"] === "string" && options["schema-id"].trim()) ||
    (typeof options.schema === "string" && options.schema.trim()) ||
    null;
  const notes =
    typeof options.notes === "string" && options.notes.trim().length ? options.notes.trim() : null;
  const skipWorkspace = Boolean(options["no-workspace"]);

  const stateManager = new MiniPhiMemory(cwd);
  await stateManager.prepare();
  let workspaceContext = null;
  if (!skipWorkspace) {
    const workspaceProfiler = new WorkspaceProfiler();
    const capabilityInventory = new CapabilityInventory();
    workspaceContext = await generateWorkspaceSnapshot({
      rootDir: cwd,
      workspaceProfiler,
      capabilityInventory,
      verbose,
      navigator: null,
      objective: task,
      executeHelper: false,
      memory: stateManager,
      globalMemory,
    });
  }

  const builder = new PromptTemplateBaselineBuilder({ schemaRegistry });
  let template;
  try {
    template = builder.build({
      baseline,
      task,
      datasetSummary,
      datasetStats: { totalLines, chunkTarget },
      helperFocus,
      historyKeys,
      notes,
      schemaId,
      workspaceContext,
    });
  } catch (error) {
    console.error(
      `[MiniPhi] Unable to build prompt baseline: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
    return;
  }

  const labelCandidate = typeof options.label === "string" ? options.label.trim() : "";
  const label = labelCandidate || `${baseline}-baseline`;
  const saved = await stateManager.savePromptTemplateBaseline({
    baseline,
    label,
    schemaId: template.schemaId,
    task: template.task,
    prompt: template.prompt,
    metadata: template.metadata,
    cwd,
  });
  const savedRel = path.relative(process.cwd(), saved.path);
  console.log(
    `[MiniPhi] Prompt template baseline ${saved.id} stored at ${savedRel || saved.path}`,
  );
  await mirrorPromptTemplateToGlobal(
    saved,
    {
      label,
      schemaId: template.schemaId ?? null,
      baseline: template.metadata?.baseline ?? baseline,
      task: template.task ?? task,
    },
    workspaceContext,
    { verbose, source: "prompt-template-cli" },
  );

  const outputPath =
    typeof options.output === "string" && options.output.trim()
      ? path.resolve(options.output.trim())
      : null;
  if (outputPath) {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, `${template.prompt}\n`, "utf8");
    const rel = path.relative(process.cwd(), outputPath);
    console.log(`[MiniPhi] Prompt text exported to ${rel || outputPath}`);
  }

  console.log("\n--- Prompt Template ---\n");
  console.log(template.prompt);
  console.log("\n--- End Template ---");
}
