import fs from "fs";
import path from "path";
import { resolveDurationMs } from "../libs/cli-utils.js";
import { relativeToCwd } from "../libs/recompose-utils.js";

export async function handleRecomposeCommand(context) {
  const {
    options,
    positionals,
    verbose,
    configData,
    promptDefaults,
    contextLength,
    debugLm,
    gpu,
    schemaRegistry,
    systemPrompt,
    modelKey,
    promptDbPath,
    resolveRecomposeMode,
    createRecomposeHarness,
  } = context;

  const sessionLabel =
    typeof options.label === "string"
      ? options.label
      : typeof options["session-label"] === "string"
        ? options["session-label"]
        : null;
  const rawMode =
    typeof options["recompose-mode"] === "string"
      ? options["recompose-mode"].toLowerCase()
      : configData.recompose?.mode?.toLowerCase() ?? "auto";
  const recomposeMode = await resolveRecomposeMode({
    rawMode,
    configData,
    modelKey,
    contextLength,
    verbose,
  });
  const workspaceOverviewTimeoutMs =
    resolveDurationMs({
      secondsValue: options["workspace-overview-timeout"],
      secondsLabel: "--workspace-overview-timeout",
      millisValue: options["workspace-overview-timeout-ms"],
      millisLabel: "--workspace-overview-timeout-ms",
    }) ?? null;
  const harness = await createRecomposeHarness({
    configData,
    promptDefaults,
    contextLength,
    debugLm,
    verbose,
    sessionLabel,
    gpu,
    schemaRegistry,
    promptDbPath,
    recomposeMode,
    systemPrompt,
    modelKey,
    workspaceOverviewTimeoutMs,
  });
  const sampleArg = options.sample ?? options["sample-dir"] ?? positionals[0] ?? null;
  const direction = (options.direction ?? positionals[1] ?? "roundtrip").toLowerCase();
  let report;
  let reportPath = null;
  let promptLogExportPath = null;
  try {
    report = await harness.tester.run({
      sampleDir: sampleArg ? path.resolve(sampleArg) : null,
      direction,
      codeDir: options["code-dir"],
      descriptionsDir: options["descriptions-dir"],
      outputDir: options["output-dir"],
      clean: Boolean(options.clean),
      sessionLabel,
    });
    const defaultReportBase = report.sampleDir ?? (sampleArg ? path.resolve(sampleArg) : process.cwd());
    reportPath = path.resolve(options.report ?? path.join(defaultReportBase, "recompose-report.json"));
    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
    if (typeof harness.tester.exportPromptLog === "function") {
      promptLogExportPath = await harness.tester.exportPromptLog({
        targetDir: path.dirname(reportPath),
        fileName: `${path.basename(reportPath, path.extname(reportPath))}.prompts.log`,
        label: sessionLabel ?? direction,
      });
    }
  } finally {
    await harness.cleanup();
  }

  report.steps.forEach((step) => {
    if (step.phase === "code-to-markdown") {
      console.log(
        `[MiniPhi][Recompose] code\u2192md: ${step.converted}/${step.discovered} files converted in ${step.durationMs} ms (skipped ${step.skipped})`,
      );
    } else if (step.phase === "markdown-to-code") {
      console.log(
        `[MiniPhi][Recompose] md\u2192code: ${step.converted}/${step.processed} markdown files restored in ${step.durationMs} ms (warnings: ${step.warnings.length})`,
      );
      if (verbose && step.warnings.length) {
        step.warnings.slice(0, 5).forEach((warning) => {
          console.warn(`[MiniPhi][Recompose][Warn] ${warning.path}: ${warning.reason}`);
        });
        if (step.warnings.length > 5) {
          console.warn(`[MiniPhi][Recompose][Warn] ...${step.warnings.length - 5} additional warnings`);
        }
      }
    } else if (step.phase === "comparison") {
      console.log(
        `[MiniPhi][Recompose] compare: ${step.matches} matches, ${step.mismatches.length} mismatches, ${step.missing.length} missing, ${step.extras.length} extra files (took ${step.durationMs} ms)`,
      );
    }
  });

  if (!reportPath) {
    throw new Error("Failed to resolve recompose report path.");
  }
  if (promptLogExportPath) {
    const relPrompt = relativeToCwd(promptLogExportPath);
    const normalizedPrompt = relPrompt ? relPrompt.replace(/\\/g, "/") : relPrompt;
    report.promptLogExport = normalizedPrompt;
    console.log(`[MiniPhi][Recompose] Prompt log saved to ${normalizedPrompt}`);
  }
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  const rel = path.relative(process.cwd(), reportPath);
  console.log(`[MiniPhi][Recompose] Report saved to ${rel || reportPath}`);
}
