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
import { fetchModelCatalog, resolveContextWindow } from "../src/libs/model-catalog.js";
import { findCatalogModel, resolveReasoningProfile } from "../src/libs/reasoning-profile.js";
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
 *     --base-url http://192.168.1.5:1234 --model prism-ml/bonsai-27b
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

  const window = await resolveContextWindow({ restClient: client, modelId: model }).catch(
    () => null,
  );
  const contextLength = window?.loadedContextLength ?? window?.contextLength ?? null;
  const contextBudgetTokens = number(options["context-budget"], 6500);

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
    `model=${model} loaded-context=${contextLength ?? "unknown"} context-budget=${contextBudgetTokens} reasoning=${reasoning.profile} (model effort: ${reasoning.model?.resolved ?? "n/a"})`,
  );

  // Every optional capability, wired at once — this sample exists to prove they
  // compose, so each one is constructed here rather than probed away.
  const schemaRegistry = new PromptSchemaRegistry();
  const researcher = new WebResearcher();
  const visionReview = createVisionReviewAction({
    restClient: client,
    schemaRegistry,
    model: visionModel,
    timeoutMs: Math.min(requestTimeoutMs, 600000),
  });

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
    contextBudgetTokens,
    maxTurns,
    maxActionsPerTurn,
    // `-1` (the default) lets a turn generate the whole remaining context
    // window. On a model producing ~7 tokens/second that is an hour inside one
    // HTTP request, and a request that long is where both Node's transport and
    // LM Studio's own engine protocol give out. Bounding the turn keeps each
    // request in minutes and pushes the model toward one file per turn.
    maxTurnTokens: number(options["max-turn-tokens"], 4000),
    maxWebResearchActions: number(options["max-research"], 6),
    // The whole point of the sample is a *researched* implementation, so the
    // model may not start writing an app before it has looked something up.
    requireWebResearch: true,
    webResearch: (query, researchOptions) => researcher.search(query, researchOptions),
    visionReview,
    knowledgeLookup,
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
    contextBudgetTokens,
    reasoning,
    cheetah: { host: cheetahHost, port: cheetahPort, knowledgeReachable },
    result,
    failure,
    finalValidation,
    stats: {
      contextEngine: contextEngine.stats(),
      localMemory: localMemory?.stats() ?? null,
    },
    events,
  };
  const reportPath = path.join(artifactsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await contextEngine.close().catch(() => {});
  await knowledgeClient.close?.().catch?.(() => {});

  log(`stop reason: ${result?.stopReason ?? failure?.message ?? "unknown"}`);
  log(`final validation: valid=${finalValidation.valid} — ${finalValidation.summary}`);
  log(`report: ${reportPath}`);
  process.exitCode = finalValidation.valid ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
