import fs from "node:fs/promises";
import path from "node:path";
import AgentsBootstrapper, { HANDBOOK_SECTIONS } from "../libs/agents-bootstrapper.js";
import PromptSchemaRegistry from "../libs/prompt-schema-registry.js";
import { LMStudioRestClient } from "../libs/lmstudio-api.js";
import { inspectModelLimits } from "../libs/model-limits.js";
import { createPromptTrace } from "../libs/prompt-trace.js";

/**
 * `miniphi bootstrap-agents [dir]` — writes a project's `AGENTS.md` from the
 * construction protocol in `docs/guidelines/AGENTS.bootstrap.md`.
 *
 * The generated handbook is then loaded into every later agent run for that
 * workspace by `project-guidelines.js`, which is the point: the protocol
 * produces the project-specific rules, and those rules — not the 33 KB
 * protocol — are what a small local model can actually carry per turn.
 */
export async function handleBootstrapAgentsCommand({
  options = {},
  positionals = [],
  verbose = false,
  restBaseUrl = null,
} = {}) {
  const workspaceRoot = path.resolve(positionals[0] ?? options.dir ?? process.cwd());
  const output = path.resolve(options.output ?? path.join(workspaceRoot, "AGENTS.md"));
  const sections = typeof options.sections === "string"
    ? options.sections.split(",").map((entry) => entry.trim()).filter(Boolean)
    : null;
  const log = (message) => process.stdout.write(`${message}\n`);

  if (sections?.length) {
    const known = new Set(HANDBOOK_SECTIONS.map((section) => section.id));
    const unknown = sections.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(
        `unknown section(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}`,
      );
    }
  }

  const existing = await fs.readFile(output, "utf8").catch(() => null);
  if (existing && options.force !== true && options.force !== "true") {
    throw new Error(
      `${output} already exists (${existing.length} bytes). Re-run with --force to replace it, or --output <path> to write elsewhere.`,
    );
  }

  const useModel = options["no-model"] !== true && options["no-model"] !== "true";
  let client = null;
  let model = null;
  let contextLength = null;
  if (useModel) {
    const baseUrl = options["base-url"] ?? restBaseUrl ?? process.env.LMSTUDIO_REST_URL ?? undefined;
    client = new LMStudioRestClient({
      baseUrl,
      timeoutMs: Number(options["timeout-ms"]) || 600000,
    });
    model = options.model ?? process.env.MINIPHI_LIVE_MODEL ?? client.defaultModel;
    const limits = await inspectModelLimits({ restClient: client, modelId: model }).catch(() => null);
    contextLength = limits?.effectiveContextLength ?? null;
    log(`model: ${model} (loaded context ${contextLength ?? "unknown"})`);
  } else {
    log("running without a model: the handbook is written from the deterministic survey only");
  }

  const trace = createPromptTrace({
    baseDir: path.join(workspaceRoot, ".miniphi"),
    sessionId: `bootstrap-agents-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    logger: verbose ? log : null,
  });

  const bootstrapper = new AgentsBootstrapper({
    client,
    schemaRegistry: new PromptSchemaRegistry(),
    model,
    contextLength,
    maxTokens: Number(options["max-tokens"]) || 2000,
    trace,
    logger: verbose ? log : null,
    protocolPath: options.protocol ?? null,
  });

  const result = await bootstrapper.build({ workspaceRoot, sections });
  await fs.writeFile(output, result.markdown, "utf8");
  await trace.finalize?.({ workspaceRoot, output });

  log(
    `wrote ${output} (${result.markdown.length} bytes, ${result.sections.length} section(s), ${result.fallbacks} written from the survey alone)`,
  );
  log(`surveyed ${result.survey.fileCount} file(s); ${result.survey.testFiles.length} test file(s) found`);
  if (trace.active) {
    log(`prompt trace: ${trace.dir}`);
  }
  return { output, ...result };
}

export default handleBootstrapAgentsCommand;
