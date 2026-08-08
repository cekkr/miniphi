import { render } from "ink";
import { html } from "./html.js";
import App from "./app.js";
import AgentSession from "../agent/agent-session.js";
import { createUiApprover } from "../agent/approvers.js";
import { scanWorkspaceFiles } from "./file-scan.js";
import WebResearcher from "../libs/web-researcher.js";
import {
  ModelBenchmarkRunner,
  loadFreshModelBenchmarkIndex,
} from "../libs/model-benchmarks.js";
import { selectVisionModel } from "../libs/model-catalog.js";
import { createVisionReviewAction } from "../libs/vision-reviewer.js";
import PromptSchemaRegistry from "../libs/prompt-schema-registry.js";
import { CheetahTcpClient } from "../libs/cheetah-binder.js";
import {
  resolveKnowledgeLookupConfig,
  createKnowledgeLookupAction,
} from "../libs/cheetah-knowledge-client.js";
import { createLocalContextMemory } from "../libs/local-context-memory.js";

/**
 * Boots the interactive MiniPhi agent UI. Dynamically imported from the CLI so
 * headless/CI paths never load Ink/React.
 *
 * @param {object} options
 * @param {object} options.client   LM Studio REST client (createChatCompletion).
 * @param {string} [options.cwd]    Workspace root.
 * @param {string} [options.baseDir] The `.miniphi` dir for session persistence.
 * @param {string} [options.initialTask] Pre-seeded task (skips the picker).
 * @param {Function} [options.runCommand] Policy-gated command runner for run_cmd.
 * @param {Function} [options.webResearch] Optional web researcher override for tests.
 * @param {number} [options.sessionDeadline] Absolute ms deadline.
 * @param {string} [options.model] Model id override.
 * @param {number} [options.contextLength] Loaded LM Studio context window, used to size the context budget.
 * @param {number} [options.contextBudgetTokens] Explicit context-graph budget (wins over contextLength).
 * @param {Function} [options.contextEngineFactory] Optional context-query engine factory.
 * @param {Array<object>} [options.modelCatalog] Normalized live LM Studio inventory.
 * @param {string} [options.modelCatalogSource] Inventory route used for discovery.
 * @param {string} [options.requestedModel] Config/CLI model request (`auto` or an id).
 * @param {string} [options.reasoningProfile] Initial reasoning profile.
 * @param {object} [options.configData] Loaded config.json, used to resolve optional capabilities (e.g. knowledge_lookup).
 * @returns {Promise<object>} the finished session result.
 */
export async function launchAgentUi(options = undefined) {
  const {
    client,
    cwd = process.cwd(),
    baseDir = null,
    initialTask = "",
    runCommand = null,
    webResearch = null,
    sessionDeadline = null,
    model = null,
    temperature = undefined,
    contextLength = null,
    contextBudgetTokens = null,
    contextEngineFactory = null,
    modelCatalog = [],
    modelCatalogSource = null,
    requestedModel = "auto",
    reasoningProfile = "high",
    configData = null,
  } = options ?? {};

  const files = await scanWorkspaceFiles(cwd);
  const benchmarkIndex = await loadFreshModelBenchmarkIndex({
    cwd,
    restClient: client,
    models: modelCatalog,
  });
  const benchmarkRunner = new ModelBenchmarkRunner({
    restClient: client,
    cwd,
  });
  const researcher = webResearch ? null : new WebResearcher();
  // Vision review is genuinely optional: only wire it in when the live LM
  // Studio inventory actually reports a VLM, so the model is never told about
  // an action that would just report "unavailable" every time.
  const visionModel = selectVisionModel(modelCatalog);
  const visionReview = visionModel
    ? createVisionReviewAction({
        restClient: client,
        schemaRegistry: new PromptSchemaRegistry(),
        model: visionModel.id,
      })
    : null;
  // Knowledge lookup (over the same Cheetah database `cheetah-learn` teaches)
  // is opt-in via config.knowledgeLookup.enabled / MINIPHI_KNOWLEDGE_LOOKUP=1,
  // off by default so a normal run never pays a reachability-probe cost for a
  // service most operators haven't set up. When enabled, mirror visual_review
  // exactly: one reachability probe, wired in only if it actually succeeds, so
  // the model is never told about an action that would just report
  // "unavailable" every turn.
  const knowledgeLookupConfig = resolveKnowledgeLookupConfig(configData);
  let knowledgeLookup = null;
  if (knowledgeLookupConfig.enabled) {
    const knowledgeClient = new CheetahTcpClient({
      host: knowledgeLookupConfig.host,
      port: knowledgeLookupConfig.port,
      database: knowledgeLookupConfig.database,
      timeoutMs: knowledgeLookupConfig.timeoutMs,
      binary: knowledgeLookupConfig.binary,
    });
    const reachable = await knowledgeClient
      .execute(["SYSTEM_STATS"])
      .then(() => true)
      .catch(() => false);
    if (reachable) {
      knowledgeLookup = createKnowledgeLookupAction({ cheetahClient: knowledgeClient });
    }
  }
  // Durable `.miniphi` memory. Unlike knowledge_lookup this costs no probe and
  // no network — it is a directory scan — so it is on unless explicitly
  // disabled, and an empty `.miniphi/memory/` simply recalls nothing.
  const localMemory = baseDir
    ? await createLocalContextMemory({
        baseDir,
        configData,
        sessionId: null,
        projectId: configData?.context?.cheetah?.projectId ?? null,
      }).catch(() => null)
    : null;
  const session = new AgentSession({
    client,
    cwd,
    baseDir,
    localMemory,
    runCommand,
    webResearch:
      webResearch ??
      ((query, researchOptions) => researcher.search(query, researchOptions)),
    visionReview,
    knowledgeLookup,
    sessionDeadline,
    model,
    temperature,
    contextLength,
    contextBudgetTokens,
    contextEngineFactory,
    modelSelection: {
      requested: requestedModel,
      resolvedModel: model,
      source: modelCatalogSource,
    },
  });
  // Wire the UI approver after construction so it can emit on the session.
  session.approver = createUiApprover(session);

  const startPhase = initialTask ? "prompt" : "home";
  const app = render(
    html`<${App}
      session=${session}
      files=${files}
      initialTask=${initialTask}
      startPhase=${startPhase}
      modelCatalog=${modelCatalog}
      modelCatalogSource=${modelCatalogSource}
      requestedModel=${requestedModel}
      benchmarkIndex=${benchmarkIndex}
      runEasyBenchmark=${(onProgress) =>
        benchmarkRunner.run({ onProgress })}
      initialReasoningProfile=${reasoningProfile}
    />`,
  );
  await app.waitUntilExit();
  return session;
}
