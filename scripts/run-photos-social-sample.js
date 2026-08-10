#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import CliExecutor from "../src/libs/cli-executor.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import WebResearcher from "../src/libs/web-researcher.js";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";
import { CheetahContextEngine } from "../src/libs/cheetah-context-engine.js";
import { CheetahTcpClient } from "../src/libs/cheetah-binder.js";
import { createKnowledgeLookupAction } from "../src/libs/cheetah-knowledge-client.js";
import { createVisionReviewAction } from "../src/libs/vision-reviewer.js";
import { createLocalContextMemory } from "../src/libs/local-context-memory.js";
import { fetchModelCatalog } from "../src/libs/model-catalog.js";
import { findCatalogModel, resolveReasoningProfile } from "../src/libs/reasoning-profile.js";
import { createPromptTrace } from "../src/libs/prompt-trace.js";
import WorkspaceCheckpoints from "../src/libs/workspace-checkpoints.js";
import {
  DEFAULT_TOKENS_PER_SECOND,
  MAX_REQUEST_SECONDS,
  ensureModelLoaded,
} from "../src/libs/model-limits.js";
import { composeGuidelines } from "../src/libs/project-guidelines.js";
import SubpromptComposer from "../src/libs/subprompt-composer.js";
import ErrorLearner from "../src/libs/error-learning.js";
import { createPageInspectAction, inspectPageSource } from "../src/libs/page-inspector.js";
import { createPageUnderstandAction } from "../src/libs/page-understanding.js";
import { ModelBenchmarkRunner } from "../src/libs/model-benchmarks.js";
import createPhotosSocialValidator from "./photos-social/validator.js";

/**
 * Drives the `samples/photos-social` sample end to end.
 *
 * The sample is the one that exercises *everything at once*: the layered
 * context graph over a Cheetah-backed engine, durable `.miniphi` memory,
 * web research for library choices, the Cheetah knowledge base, vision review
 * of the running app, guarded edits, policy-gated commands, and a workspace
 * validator that boots the result and tests it through Puppeteer.
 *
 * It is instrumentation: treat a failure here as a MiniPhi runtime bug and fix
 * the runtime, not this script — only extend it to widen coverage or logging.
 *
 *   node scripts/run-photos-social-sample.js \
 *     --base-url http://192.168.1.5:1234 --model prism-ml/bonsai-27b \
 *     --load-context-length 32768 --reload-model
 *
 * Notable flags:
 *   --load-context-length <n>  the window this run wants (default 32768)
 *   --reload-model             consent to unload/reload an operator-loaded
 *                              instance to get that window; without it a
 *                              smaller instance is reported and used as-is
 *   --skip-benchmark           skip the pre-run Easy benchmark (not advised:
 *                              it is what tells you the model can do the job)
 *   --refresh-benchmark        re-measure instead of reusing a fresh cache entry
 *   --skip-own-tests           do not require `npm test` inside the app
 *   --max-detail-regions <n>   vision subtasks per page_understand call
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SAMPLE_ROOT = path.join(REPO_ROOT, "samples", "photos-social");

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const [flag, inline] = token.slice(2).split("=");
    if (inline !== undefined) {
      options[flag] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[flag] = "true";
      continue;
    }
    options[flag] = next;
    index += 1;
  }
  return options;
};

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * The contract the validator enforces, stated to the model up front.
 *
 * A local model will not guess route names, and a validator that only reports
 * "GET /feed answered 404" after the fact spends turns teaching what could have
 * been said once. The prose stays about *what the app must do*; how to build it
 * (framework, upload handling, templating) is deliberately left open, which is
 * what makes web_research worth spending turns on.
 */
/**
 * The stack line changes once the app exists.
 *
 * Telling a resumed run to "research and choose the HTTP framework" invites it
 * to re-decide a question that is already answered *and installed* — observed
 * live, a run with a working Express server spent its turns switching to Hono
 * and reinstalling. A run that starts from an empty `server/` should still
 * research the choice; a run that finds one should be told what it inherited.
 */
const stackLine = (existing) =>
  existing
    ? `The application already exists in server/ and uses ${existing}. That choice is settled: do not research frameworks again and do not switch to another one — it would discard working code. Use web_research only for API details you are unsure of, and run_cmd for npm install when you add a package.`
    : "Use web_research to choose the HTTP framework and the multipart-upload library before writing code, and install them with run_cmd (npm install inside server/).";

const TASK = [
  "Build a real, working photo social network as a Node.js application, using the static HTML/CSS design in html-template/ as its front-end.",
  "",
  "Put the entire application in the server/ directory of this workspace. Nothing outside server/ may be modified: html-template/ is a read-only design reference you copy markup and asset paths from.",
  "",
  "Storage MUST be SQLite on disk under server/ (for example server/data/photos.db) with tables for users, posts, likes and comments. Do not keep data in memory.",
  "The server MUST listen on process.env.PORT (defaulting to 3000) and serve the html-template assets so the pages keep their styling.",
  "",
  "The following HTTP contract is verified automatically after every change; implement all of it:",
  '- GET /health -> 200 JSON {"status":"ok"}',
  "- GET /register and POST /register (form fields: username, email, password) -> creates the user in SQLite, starts a session (Set-Cookie), answers 200/201 or redirects",
  "- GET /login and POST /login (form fields: username, password) -> starts a session (Set-Cookie)",
  '- POST /upload as multipart/form-data with an "image" file part and a "caption" text field -> stores the file under server/ and inserts the post for the logged-in user',
  "- GET /api/posts -> 200 JSON array of posts, newest first, each with id, caption, imageUrl and author; imageUrl MUST be fetchable and return 200",
  "- GET /feed -> 200 HTML page listing the posts, showing each caption and each photo as an <img src=...>",
  "- GET /u/:username -> 200 HTML profile page showing that user's posts",
  '- POST /posts/:id/like -> 200 JSON {"likes": <number>}',
  '- POST /posts/:id/comments (form field: text) -> persists the comment',
  "",
  "Environment constraints for this host, which you cannot discover from an error message:",
  "- Node.js 24 is installed. Packages with a native C++ addon that must be compiled (better-sqlite3, sqlite3, node-gyp builds) DO NOT build here: Node 24's headers need a newer C++ standard than their build sets, and no prebuilt binary covers Node 24. An `npm install` of one of those fails with node-gyp errors and can never succeed, so do not retry it.",
  "- Node 24 ships SQLite in core as the built-in `node:sqlite` module (`import { DatabaseSync } from 'node:sqlite'`). It needs no installation and is the SQLite driver to use here. Any other dependency you pick must be pure JavaScript.",
  "",
  "Write the application as several small modules (for example db, routes, views) and create them one file per turn. A single turn's output is capped, so a very large file will be cut off mid-way and rejected.",
  "",
  "The front-end is not optional and not a suggestion. Every HTML page the app serves MUST be built from the matching html-template/ file:",
  "- Serve html-template/assets as a static directory so the design's CSS, JS, icons and images load at the paths its markup already uses.",
  "- Build /feed from html-template/home.html, /u/:username from html-template/profile.html, /login from html-template/form-login.html and /register from html-template/form-register.html, keeping the template's own markup and class names and substituting real data into it.",
  "- Validation counts how many of the template's own CSS classes appear on each served page and refuses pages that do not use them. Writing your own equivalent markup fails, however good it looks.",
  "- Use page_inspect on a template file to get its structure, classes, assets and forms without reading the whole file, and page_understand on the page you are about to implement to learn what each region contains and which data fields it needs.",
  "",
  "Ship the tests with the app. Add an automated suite in server/ wired to `npm test`, using node:test (no dependency needed): unit tests for the data layer plus an end-to-end test that starts the app on an ephemeral port and drives the real HTTP surface — register, login, upload, GET /api/posts, GET /feed — asserting on status codes and on strings that must be present in the HTML. Every assertion must be textual so the suite decides pass or fail on its own. Validation runs `npm test` and requires it to exit 0.",
  "",
  "%%STACK%%",
  "Use visual_review with a loopback url (the validator runs the app on http://127.0.0.1:3117) to check that /feed actually looks like a photo feed, and fix what the vision model reports.",
  "Finish only when the automatic validation reports no issues.",
].join("\n");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = options["base-url"] ?? process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234";
  const model = options.model ?? process.env.MINIPHI_LIVE_MODEL ?? "prism-ml/bonsai-27b";
  const visionModel = options["vision-model"] ?? model;
  const maxTurns = number(options["max-turns"], 60);
  const maxActionsPerTurn = number(options["max-actions"], 4);
  const deadlineMinutes = number(options["deadline-minutes"], 600);
  const cheetahHost = options["cheetah-host"] ?? process.env.MINIPHI_CHEETAH_HOST ?? "127.0.0.1";
  const cheetahPort = number(options["cheetah-port"] ?? process.env.MINIPHI_CHEETAH_PORT, 4455);
  const validationPort = number(options["validation-port"], 3117);
  const requestTimeoutMs = number(options["request-timeout-ms"], 900000);
  const sessionId = options["session-id"] ?? "photos-social";
  const workspace = options.workspace ? path.resolve(options.workspace) : SAMPLE_ROOT;
  const baseDir = path.join(workspace, ".miniphi");
  const artifactsDir = path.join(baseDir, "live-tests", "photos-social");

  await fs.mkdir(artifactsDir, { recursive: true });
  // What the app already is, read from its own manifest, so a resumed run is
  // told what it inherited instead of being invited to re-choose it.
  const existingStack = await fs
    .readFile(path.join(workspace, "server", "package.json"), "utf8")
    .then((raw) => {
      const deps = Object.keys(JSON.parse(raw).dependencies ?? {});
      return deps.length ? `${deps.join(", ")} with the built-in node:sqlite module` : null;
    })
    .catch(() => null);
  const task = TASK.replace("%%STACK%%", stackLine(existingStack));
  if (existingStack) {
    process.stdout.write(`${new Date().toISOString()} resuming an existing app: ${existingStack}\n`);
  }
  // server/ is generated output, exactly as the sample README requires.
  await fs.writeFile(
    path.join(workspace, ".gitignore"),
    ["# Generated by the photos-social sample run.", "server/", ".miniphi/", ""].join("\n"),
    "utf8",
  );

  const log = (message) => {
    process.stdout.write(`${new Date().toISOString()} ${message}\n`);
  };

  const client = new LMStudioRestClient({
    baseUrl,
    defaultModel: model,
    timeoutMs: requestTimeoutMs,
  });

  // Ask for the window the run needs instead of accepting whatever LM Studio
  // JIT-loaded. bonsai-27b advertises 262144 and was being driven at the 4096
  // cold default on a fresh host — every prompt, every file it could be shown
  // and every file it could emit were sized by a number nobody chose.
  const desiredContextLength = number(options["load-context-length"], 32768);
  const loadOutcome = await ensureModelLoaded({
    restClient: client,
    modelId: model,
    desiredContextLength,
    allowReload: options["reload-model"] === "true",
    logger: log,
  });
  const limits = loadOutcome.limits;
  const contextLength = limits.effectiveContextLength;
  // Deliberately *not* a fraction of the window. AgentSession derives the
  // budget itself from `contextLength` minus the measured cost of the system
  // prompt (which now carries the navigation rules and the project handbook)
  // and an output reserve; a flat percentage here would silently overshoot the
  // window the moment the guidelines grew. Only an explicit --context-budget
  // overrides that derivation.
  const contextBudgetTokens = Number(options["context-budget"]) || null;

  // Reasoning has to be resolved and *sent*, not left to the server default.
  // On a slow local model an unbounded reasoning trace is the difference
  // between ~15 turns and ~60 inside the same deadline, and the agent loop's
  // own structure (context graph, validator feedback) is what carries the
  // deliberation here.
  const catalog = await fetchModelCatalog({ restClient: client }).catch(() => null);
  const reasoning = resolveReasoningProfile({
    profile: options.reasoning ?? "off",
    source: "cli",
    model: findCatalogModel(catalog?.models ?? [], model),
  });
  client.setDefaultReasoning(reasoning);
  log(
    `model=${model} loaded-context=${contextLength ?? "unknown"} (${loadOutcome.action}, max ${limits.maxContextLength ?? "?"}) context-budget=${contextBudgetTokens ?? "derived from the window"} reasoning=${reasoning.profile} (model effort: ${reasoning.model?.resolved ?? "n/a"})`,
  );
  log(
    `capabilities: vision=${limits.vision} tool_use=${limits.toolUse} reasoning-options=${limits.reasoningOptions.join("/") || "none"}`,
  );

  // Always benchmark before trusting the model with a long run. A cached fresh
  // result is reused; anything else is measured now. This is not ceremony: the
  // first run of this sample was scored against a model whose six benchmark
  // trials had all failed the same way, and nobody knew because nothing looked.
  let benchmark = null;
  // Measured generation speed, used to keep every request inside LM Studio's
  // ~300s engine ceiling. Defaults to the conservative local-model rate until
  // the benchmark measures the real one.
  let tokensPerSecond = number(options["tokens-per-second"], DEFAULT_TOKENS_PER_SECOND);
  if (options["skip-benchmark"] !== "true") {
    log(`benchmarking ${model} before the run…`);
    const runner = new ModelBenchmarkRunner({
      restClient: client,
      cwd: REPO_ROOT,
      contextLength: Math.min(contextLength, 16384),
      timeoutMs: number(options["benchmark-timeout-ms"], 900000),
    });
    const outcome = await runner
      .run({ modelIds: [model], refresh: options["refresh-benchmark"] === "true" })
      .catch((error) => {
        log(`benchmark failed: ${error?.message ?? error}`);
        return null;
      });
    benchmark = outcome?.results?.[0] ?? null;
    if (benchmark) {
      const scores = benchmark.scores ?? {};
      log(
        `benchmark: overall=${scores.overall} reasoning=${scores.reasoning} coding=${scores.coding} context=${scores.context} tool_use=${scores.tool_use} avg-latency=${scores.averageLatencyMs}ms${benchmark.cacheHit ? " (cached)" : ""}`,
      );
      const failed = (benchmark.trials ?? []).filter((trial) => trial.status === "invalid-response");
      if (failed.length) {
        log(
          `WARNING: ${failed.length}/${benchmark.trials.length} benchmark trials never produced schema-valid JSON (${failed
            .map((trial) => trial.id)
            .join(", ")}). Expect the same failure inside the run.`,
        );
      }
      // Derive throughput from the attempts that actually completed. This is
      // what turns the server's request-time ceiling into a token cap: on the
      // reference host every request past ~305s died with `400 Engine protocol
      // predict request failed`, so a turn must be sized in seconds, not just
      // in tokens.
      const samples = (benchmark.trials ?? [])
        .flatMap((trial) => trial.attempts ?? [])
        .filter(
          (attempt) =>
            Number(attempt?.usage?.completion_tokens) > 0 && Number(attempt?.latencyMs) > 0,
        );
      if (samples.length) {
        const totalTokens = samples.reduce(
          (sum, attempt) => sum + Number(attempt.usage.completion_tokens),
          0,
        );
        const totalMs = samples.reduce((sum, attempt) => sum + Number(attempt.latencyMs), 0);
        const measured = (totalTokens / totalMs) * 1000;
        if (Number.isFinite(measured) && measured > 0) {
          tokensPerSecond = measured;
          log(
            `measured throughput: ${measured.toFixed(2)} tokens/second over ${samples.length} completed attempt(s) -> a single request may emit at most ~${Math.floor(measured * MAX_REQUEST_SECONDS)} tokens before the server's ${MAX_REQUEST_SECONDS}s+ engine ceiling rejects it`,
          );
        }
      }
    }
  }

  // Every optional capability, wired at once — this sample exists to prove they
  // compose, so each one is constructed here rather than probed away.
  const schemaRegistry = new PromptSchemaRegistry({
    // The registry defaults to `process.cwd()/docs/prompts`, which is wrong the
    // moment this script is run from anywhere but the repository root.
    schemaDir: path.join(REPO_ROOT, "docs", "prompts"),
  });
  const researcher = new WebResearcher();
  const visionReview = createVisionReviewAction({
    restClient: client,
    schemaRegistry,
    model: visionModel,
    timeoutMs: Math.min(requestTimeoutMs, 600000),
  });

  // Complete prompt/subprompt debug log: every exchange, in full, on disk.
  const trace = createPromptTrace({ baseDir, sessionId, logger: log });
  log(`prompt trace: ${trace.active ? trace.dir : "disabled"}`);

  const pageInspect = createPageInspectAction({ workspaceRoot: workspace, logger: log });
  const pageUnderstand = limits.vision
    ? createPageUnderstandAction({
        restClient: client,
        schemaRegistry,
        model: visionModel,
        workspaceRoot: workspace,
        artifactsDir: path.join(baseDir, "page-understanding"),
        timeoutMs: Math.min(requestTimeoutMs, 600000),
        maxDetailRegions: number(options["max-detail-regions"], 4),
        trace,
        logger: log,
      })
    : null;
  log(`page tools: page_inspect wired, page_understand ${pageUnderstand ? "wired" : "unavailable (model has no vision capability)"}`);

  const knowledgeClient = new CheetahTcpClient({
    host: cheetahHost,
    port: cheetahPort,
    database: options["knowledge-database"] ?? "miniphi_knowledge",
    timeoutMs: 5000,
  });
  const knowledgeReachable = await knowledgeClient
    .execute(["SYSTEM_STATS"])
    .then(() => true)
    .catch(() => false);
  const knowledgeLookup = knowledgeReachable
    ? createKnowledgeLookupAction({ cheetahClient: knowledgeClient })
    : null;
  log(`knowledge_lookup ${knowledgeReachable ? "wired" : "unavailable (Cheetah not reachable)"}`);

  const contextEngine = new CheetahContextEngine({
    host: cheetahHost,
    port: cheetahPort,
    workspaceRoot: workspace,
    projectId: "miniphi-photos-social",
    sessionId,
    required: false,
    timeoutMs: 8000,
    recallLimit: 48,
    recallHops: 3,
    logger: log,
  });

  const localMemory = await createLocalContextMemory({
    baseDir,
    sessionId,
    projectId: "miniphi-photos-social",
    logger: log,
  });
  log(
    `local memory: ${localMemory ? `${localMemory.stats().records} record(s) in ${localMemory.memoryDir}` : "disabled"}`,
  );

  const cli = new CliExecutor();
  const runCommand = async (command) => {
    const result = await cli
      .executeCommand(command, {
        cwd: workspace,
        // npm install of an HTTP framework + a native SQLite driver routinely
        // needs minutes; the interactive default of 60s would report a false
        // failure the model would then try to "fix" in code.
        timeout: 600000,
        captureOutput: true,
      })
      .catch((error) => error ?? {});
    const stdout = result?.stdout ?? "";
    const stderr = result?.stderr ?? "";
    return [stdout, stderr].filter(Boolean).join("\n") || result?.message || "";
  };

  const validateWorkspace = createPhotosSocialValidator({
    workspaceRoot: workspace,
    visionReview,
    artifactsDir,
    logger: log,
    port: validationPort,
    requireOwnTests: options["skip-own-tests"] !== "true",
    // `CliExecutor` resolves only on exit code 0 and rejects otherwise, so a
    // rejection is a failure even when it carries no numeric code (a timeout
    // does not). Defaulting a caught error to 0 would report a hung suite as a
    // pass, which is the one outcome a validator must never produce.
    runTestCommand: async (command, { cwd, timeoutMs } = {}) => {
      try {
        const result = await cli.executeCommand(command, {
          cwd: cwd ?? workspace,
          timeout: timeoutMs ?? 180000,
          captureOutput: true,
        });
        return {
          code: result?.code ?? 0,
          output: [result?.stdout ?? "", result?.stderr ?? ""].filter(Boolean).join("\n"),
        };
      } catch (error) {
        return {
          code: Number.isFinite(error?.code) ? error.code : 1,
          output:
            [error?.stdout ?? "", error?.stderr ?? ""].filter(Boolean).join("\n") ||
            (error instanceof Error ? error.message : String(error)),
        };
      }
    },
  });

  // Pre-written navigation rules + the workspace's own AGENTS.md, if it has one.
  // The handbook's share of the window scales with the window: on an 8192-token
  // instance a 6000-character handbook is a third of the prompt budget, and the
  // rules are worth nothing if they crowd out the work they are meant to guide.
  const guidelines = await composeGuidelines({
    workspaceRoot: workspace,
    handbookMaxChars: Math.min(6000, Math.max(1500, Math.round(contextLength * 0.4))),
  });
  log(
    `guidelines: ${guidelines.sources.join(", ") || "none"}${guidelines.handbook?.truncated ? " (handbook truncated to fit the window)" : ""}`,
  );

  // Deterministic facts for the planner, so the plan names real files. A local
  // model plans well from an inventory and invents structure from prose.
  const templateDir = path.join(workspace, "html-template");
  const templatePages = await fs
    .readdir(templateDir)
    .then((entries) => entries.filter((entry) => entry.endsWith(".html")).sort())
    .catch(() => []);
  const homeStructure = templatePages.includes("home.html")
    ? await inspectPageSource(path.join(templateDir, "home.html")).catch(() => null)
    : null;
  const planFacts = [
    `Workspace: ${workspace}`,
    `Design template pages available (read-only reference): ${templatePages.join(", ") || "none found"}`,
    homeStructure
      ? `html-template/home.html links ${homeStructure.stylesheets.length} stylesheet(s) (${homeStructure.stylesheets.slice(0, 3).join(", ")}), ${homeStructure.scripts.length} script(s), and reuses these classes most: ${homeStructure.repeatedClasses.slice(0, 12).map((entry) => entry.class).join(", ")}`
      : null,
    existingStack
      ? `An application already exists in server/ using ${existingStack}.`
      : "server/ is empty; the application does not exist yet.",
    "Validation after every change: boots the app, drives register/login/upload/api/feed/profile/like/comment over HTTP, checks SQLite on disk, counts the template's own CSS classes on each served page, opens /feed in a browser and requires `npm test` in server/ to exit 0.",
  ]
    .filter(Boolean)
    .join("\n");

  const subpromptComposer = new SubpromptComposer({
    client,
    schemaRegistry,
    model,
    reasoning,
    contextLength,
    maxTokens: number(options["plan-max-tokens"], 2500),
    tokensPerSecond,
    timeoutMs: Math.min(requestTimeoutMs, 900000),
    trace,
    logger: log,
    maxSubtasks: number(options["max-subtasks"], 8),
  });

  // Version history of the generated app, scored by validation + its own tests.
  const checkpoints = new WorkspaceCheckpoints({
    workspaceRoot: workspace,
    baseDir,
    enabled: options["no-checkpoints"] !== "true",
    logger: log,
  });
  await checkpoints.prepare();
  log(
    `change history: ${checkpoints.enabled ? `${checkpoints.gitDir} (${checkpoints.list().length} existing checkpoint(s))` : "disabled"}`,
  );

  const errorLearner = new ErrorLearner({
    client,
    schemaRegistry,
    model,
    localMemory,
    knowledgeClient: knowledgeReachable ? knowledgeClient : null,
    webResearch: (query, researchOptions) => researcher.search(query, researchOptions),
    baseDir,
    projectId: "miniphi-photos-social",
    trace,
    logger: log,
    timeoutMs: Math.min(requestTimeoutMs, 600000),
  });

  const sessionDeadline = Date.now() + deadlineMinutes * 60000;
  const session = new AgentSession({
    client,
    cwd: workspace,
    baseDir,
    sessionId,
    model,
    reasoning,
    contextEngine,
    localMemory,
    contextLength,
    // Omitted unless the operator pinned one, so the session derives it.
    ...(contextBudgetTokens ? { contextBudgetTokens } : {}),
    maxTurns,
    maxActionsPerTurn,
    // `-1` (the default) lets a turn generate the whole remaining context
    // window. On a model producing ~7 tokens/second that is an hour inside one
    // HTTP request, and a request that long is where both Node's transport and
    // LM Studio's own engine protocol give out. Bounding the turn keeps each
    // request in minutes and pushes the model toward one file per turn.
    maxTurnTokens: number(options["max-turn-tokens"], 4000),
    tokensPerSecond,
    // The documented cure for a wedged engine, finally wired: RECAP.md has said
    // since July that two over-ceiling requests make LM Studio answer 400 until
    // the model is unloaded and reloaded, and nothing did it.
    reloadModel: async () => {
      const outcome = await ensureModelLoaded({
        restClient: client,
        modelId: model,
        desiredContextLength,
        allowReload: true,
        // A wedged engine still advertises the right window, so the recovery
        // has to recycle the instance unconditionally or it clears nothing.
        force: true,
        logger: log,
      });
      if (outcome.error) {
        throw new Error(outcome.error);
      }
      return outcome;
    },
    maxWebResearchActions: number(options["max-research"], 6),
    // Only on a from-scratch run. The task text tells a *resumed* run that the
    // stack is settled and not to research frameworks again — and then this gate
    // refused every write until it did. Observed live: ten turns, no write, the
    // model looping on inspection while the policy block demanded research it
    // had been told not to perform. A contradiction the model cannot resolve is
    // a stalled run.
    requireWebResearch: !existingStack,
    webResearch: (query, researchOptions) => researcher.search(query, researchOptions),
    visionReview,
    pageInspect,
    pageUnderstand,
    knowledgeLookup,
    trace,
    guidelines: guidelines.block,
    subpromptComposer,
    planFacts,
    planConstraints: [
      "Node.js 24: native C++ addons (better-sqlite3, sqlite3, node-gyp builds) cannot compile on this host. Use the built-in node:sqlite module.",
      "Nothing outside server/ may be modified; html-template/ is read-only reference.",
      "Each served page must be built from its matching html-template/ file, not from new markup.",
      "`npm test` inside server/ must exist and exit 0.",
    ].join("\n"),
    errorLearner,
    checkpoints,
    autoRevertOnRegression: options["no-auto-revert"] !== "true",
    runCommand,
    validateWorkspace,
    approver: createHeadlessApprover({ policy: "allow" }),
    sessionDeadline,
    // The reference composer runs an extra model call per turn. On a slow local
    // model a 45s default is always a timeout and always wasted, so it gets a
    // window it can actually answer inside.
    contextReferenceTimeoutMs: number(options["reference-timeout-ms"], 240000),
    logger: log,
  });

  log(
    `derived context budget: ${session.contextBudgetTokens} tokens (system prompt + schema cost ~${session._fixedPromptTokens} of the ${contextLength}-token window)`,
  );
  // A floor-level budget is a configuration failure, not a tight fit: the model
  // would be driven with no room to see the workspace at all. Name the exact
  // remedy rather than letting the run fail obscurely twenty turns later.
  if (!contextBudgetTokens && session.contextBudgetTokens <= 512) {
    log(
      `WARNING: only ${session.contextBudgetTokens} tokens are left for context. Re-run with --reload-model --load-context-length ${Math.min(32768, limits.maxContextLength ?? 32768)} so the model is loaded with a window this task fits in.`,
    );
  }

  const events = [];
  const record = (kind) => (event) => {
    events.push({ kind, at: new Date().toISOString(), ...event });
  };
  session.on("status", (event) => {
    events.push({ kind: "status", at: new Date().toISOString(), ...event });
    log(`turn ${event.turn ?? "?"}: ${event.message ?? event.phase ?? JSON.stringify(event)}`);
  });
  session.on("action-result", (event) => {
    events.push({ kind: "action-result", at: new Date().toISOString(), ...event });
    log(
      `  action ${event.action?.type ?? "?"} ${event.action?.path ?? event.action?.url ?? event.action?.query ?? ""} -> ${event.status}`,
    );
  });
  session.on("edit-proposed", record("edit-proposed"));
  session.on("validation", (event) => {
    events.push({ kind: "validation", at: new Date().toISOString(), ...event });
    log(`  validation valid=${event.valid} issues=${event.issues?.length ?? 0}`);
    for (const issue of event.issues ?? []) {
      log(`    - ${String(issue).slice(0, 220)}`);
    }
  });
  session.on("context-engine", (event) => {
    events.push({ kind: "context-engine", at: new Date().toISOString(), ...event });
    if (event.ok === false) {
      log(`  cheetah context: ${event.error ?? "unavailable"}`);
    }
  });
  session.on("local-memory", (event) => {
    events.push({ kind: "local-memory", at: new Date().toISOString(), ...event });
    log(
      `  local memory: ${event.candidates} candidate(s) from ${event.matched}/${event.scanned} record(s) in ${event.elapsedMs}ms`,
    );
  });
  session.on("context-references", record("context-references"));
  session.on("plan", (event) => {
    events.push({ kind: "plan", at: new Date().toISOString(), ...event });
    log(
      `plan (${event.fallback ? "deterministic fallback" : "model"}): ${event.plan.subtasks
        .map((subtask) => subtask.id)
        .join(" -> ")}`,
    );
    for (const subtask of event.plan.subtasks) {
      log(`  ${subtask.id}: ${subtask.goal}`);
    }
  });
  session.on("plan-progress", (event) => {
    events.push({ kind: "plan-progress", at: new Date().toISOString(), ...event });
    log(`  plan: ${event.completed.length} done, now ${event.current ?? "(finished)"}`);
  });
  session.on("regression", (event) => {
    events.push({ kind: "regression", at: new Date().toISOString(), ...event });
    log(
      `  REGRESSION: score ${event.current.score} against ${event.bestBefore.score} at ${event.bestBefore.id} ("${event.bestBefore.label}")`,
    );
  });
  session.on("auto-reverted", (event) => {
    events.push({ kind: "auto-reverted", at: new Date().toISOString(), ...event });
    log(`  restored ${event.to.id} ("${event.to.label}")`);
  });
  session.on("lesson", (event) => {
    events.push({ kind: "lesson", at: new Date().toISOString(), ...event });
    log(`  learned: ${event.lesson.title} — ${event.lesson.rule}`);
  });
  session.on("error", (event) => {
    events.push({ kind: "error", at: new Date().toISOString(), ...event });
    log(`  error: ${event?.message ?? JSON.stringify(event)}`);
  });

  const startedAt = Date.now();
  let result = null;
  let failure = null;
  try {
    result = await session.submitTask(task, ["README.md"]);
  } catch (error) {
    failure = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
  }

  const finalValidation = await validateWorkspace().catch((error) => ({
    valid: false,
    summary: `final validation threw: ${error instanceof Error ? error.message : error}`,
    issues: [],
  }));

  const report = {
    schemaVersion: "photos-social-sample@v1",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    endpoint: baseUrl,
    model,
    visionModel,
    contextLength,
    contextBudgetTokens: session.contextBudgetTokens,
    modelLimits: limits,
    modelLoad: { action: loadOutcome.action, error: loadOutcome.error, requested: desiredContextLength },
    benchmark: benchmark
      ? {
          scores: benchmark.scores,
          cacheHit: Boolean(benchmark.cacheHit),
          trials: (benchmark.trials ?? []).map((trial) => ({
            id: trial.id,
            category: trial.category,
            status: trial.status,
            score: trial.score,
            latencyMs: trial.latencyMs,
          })),
        }
      : null,
    guidelines: guidelines.sources,
    reasoning,
    cheetah: { host: cheetahHost, port: cheetahPort, knowledgeReachable },
    result,
    failure,
    finalValidation,
    stats: {
      contextEngine: contextEngine.stats(),
      localMemory: localMemory?.stats() ?? null,
      promptTrace: trace.stats(),
      lessons: errorLearner.stats(),
      changes: checkpoints.stats(),
    },
    events,
  };
  const reportPath = path.join(artifactsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await contextEngine.close().catch(() => {});
  await knowledgeClient.close?.().catch?.(() => {});

  log(`stop reason: ${result?.stopReason ?? failure?.message ?? "unknown"}`);
  log(`final validation: valid=${finalValidation.valid} — ${finalValidation.summary}`);
  // Whether "reasoning off" actually took effect. Measured against
  // prism-ml/bonsai-27b on 2026-08-10 it does not: the model returns
  // reasoning_content regardless of `reasoning`/`reasoning_effort`, so every
  // turn pays a full trace at roughly 7 tokens/second. That is a property of
  // the model worth seeing in the log rather than inferring from a slow run.
  const ignoredReasoning = (result?.reasoning?.requests ?? []).filter((entry) => entry?.ignored);
  if (ignoredReasoning.length) {
    log(
      `NOTE: reasoning=${reasoning.profile} was requested but ${ignoredReasoning.length} request(s) still returned reasoning tokens — this model cannot be taken out of reasoning mode, so budget for it.`,
    );
  }
  const traceStats = trace.stats();
  log(
    `prompt trace: ${traceStats.exchanges} exchange(s), ${traceStats.failures} failed — ${traceStats.dir ?? "disabled"}`,
  );
  const lessonStats = errorLearner.stats();
  if (lessonStats.lessons) {
    log(`lessons learned: ${lessonStats.lessonTitles.join(" | ")}`);
  }
  log(`report: ${reportPath}`);
  process.exitCode = finalValidation.valid ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
