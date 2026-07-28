import readline from "readline";
import { LMStudioRestClient } from "../libs/lmstudio-api.js";
import { buildRestClientOptions } from "../libs/lmstudio-client-options.js";
import LMStudioHandler from "../libs/lmstudio-handler.js";
import PromptSchemaRegistry from "../libs/prompt-schema-registry.js";
import { CheetahTcpClient } from "../libs/cheetah-context-engine.js";
import {
  DEFAULT_HOST as CHEETAH_DEFAULT_HOST,
  DEFAULT_PORT as CHEETAH_DEFAULT_PORT,
  DEFAULT_DATABASE as CHEETAH_DEFAULT_DATABASE,
  ensureAskerAnchor,
  listOpenQuestions,
} from "../libs/cheetah-knowledge-client.js";
import { teachFromText, recallAnswer } from "../libs/cheetah-learner.js";
import {
  HfDatasetClient,
  fetchDisjointSamples,
  clipSnippet,
  guessSubjectFromText,
  DEFAULT_DATASET,
} from "../libs/hf-dataset-client.js";
import CheetahRunReport from "../libs/cheetah-run-report.js";
import { parseNumericSetting } from "../libs/cli-utils.js";

// Fixed by design: this command is a demonstration of a deliberately small,
// "ignorant" model driven entirely by Cheetah. Registering it in
// model-presets.js would make it a candidate in unrelated --model auto
// coding-task ranking, a different concern from this one-fixed-model command.
const QWEN_MODEL_KEY = "qwen2.5-coder-0.5b-instruct";
const QWEN_CONTEXT_LENGTH = 32768;

const CHEETAH_LEARN_SYSTEM_PROMPT = [
  "You serve an external database that starts out empty, no matter how famous or obvious a subject is.",
  "You never answer factual questions from your own training knowledge, and you never skip saving a fact just because it feels obvious to you - only what the database already has counts as 'known'.",
  "You only work from what is explicitly given to you in each prompt: a text snippet to learn from plus what the database already records, or facts retrieved from the database to answer a question from.",
  "Always reply with strict JSON matching the requested schema only - no commentary, no markdown fences.",
].join(" ");

function optionsString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildLmStudioHandler({ restClient, schemaRegistry, modelKey }) {
  const handler = new LMStudioHandler(undefined, {
    systemPrompt: CHEETAH_LEARN_SYSTEM_PROMPT,
    schemaRegistry,
    modelKey,
  });
  handler.setRestClient(restClient, { preferRestTransport: true });
  handler.setTransportPreference({
    forceRest: true,
    preferRestTransport: true,
    reason: "cheetah-learn is REST-only (fixed small model, no interactive load)",
  });
  return handler;
}

export function buildCheetahClient(options) {
  return new CheetahTcpClient({
    host: optionsString(options["cheetah-host"]) ?? CHEETAH_DEFAULT_HOST,
    port: Number(options["cheetah-port"]) || CHEETAH_DEFAULT_PORT,
    database: optionsString(options["cheetah-database"]) ?? CHEETAH_DEFAULT_DATABASE,
    timeoutMs: parseNumericSetting(options["cheetah-timeout-ms"], "--cheetah-timeout-ms"),
  });
}

export function printTeachResult(record, { emitJson }) {
  if (emitJson) {
    return;
  }
  const savedNote = record.noNewInformation
    ? "nothing new (already known)"
    : `${record.newFactsWritten} new fact(s) saved`;
  console.log(`[cheetah-learn][teach] ${record.subjectName} (${record.subjectType}) - ${savedNote}`);
  if (record.thinking) {
    console.log(`  thinking: ${record.thinking}`);
  }
  if (record.knownFactsSkipped?.length) {
    console.log(`  already known: ${record.knownFactsSkipped.join(", ")}`);
  }
  if (record.error) {
    console.log(`  (fallback used: ${record.error})`);
  }
}

export function printRecallResult(record, { emitJson }) {
  if (emitJson) {
    return;
  }
  console.log(`[cheetah-learn][ask] ${record.question}`);
  console.log(`  answer: ${record.answer} (grounded=${record.grounded}, confidence=${record.confidence})`);
  if (record.thinking) {
    console.log(`  thinking: ${record.thinking}`);
  }
  if (record.modelClaimedGroundedButAnchorMissing) {
    console.log("  note: model claimed groundedness the adapter's own probe did not support; overridden to ungrounded.");
  }
  if (record.openQuestion) {
    console.log(`  open question recorded: ${record.openQuestion.hypothesisId}`);
  }
  if (record.error) {
    console.log(`  (fallback used: ${record.error})`);
  }
}

export async function runTeach({
  options,
  restClient,
  cheetahClient,
  schemaRegistry,
  modelKey,
  verbose,
  emitJson,
  noSave,
  runReport,
}) {
  const startedAt = new Date().toISOString();
  const handler = buildLmStudioHandler({ restClient, schemaRegistry, modelKey });
  const adHocText = optionsString(options.text);
  const results = [];
  let params;

  if (adHocText) {
    params = { text: adHocText };
    const record = await teachFromText(adHocText, {
      handler,
      cheetahClient,
      schemaRegistry,
      subjectHint: guessSubjectFromText(adHocText),
      sequence: 0,
    });
    printTeachResult(record, { emitJson });
    results.push(record);
  } else {
    const dataset = optionsString(options.dataset) ?? DEFAULT_DATASET;
    const limit = parseNumericSetting(options.limit, "--limit") ?? 20;
    const teachOffset = parseNumericSetting(options["teach-offset"], "--teach-offset") ?? 0;
    params = { dataset, limit, teachOffset };
    const hfClient = new HfDatasetClient({ dataset });
    const { rows } = await hfClient.getRows({ offset: teachOffset, length: limit });
    let sequence = 0;
    for (const row of rows) {
      const snippet = clipSnippet(row.text);
      if (!snippet) {
        continue;
      }
      const subjectHint = guessSubjectFromText(row.text);
      if (verbose) {
        console.log(`[cheetah-learn][teach] row ${row.rowIdx}: ${clipSnippet(row.text, { maxSentences: 1, maxChars: 100 })}`);
      }
      const record = await teachFromText(snippet, {
        handler,
        cheetahClient,
        schemaRegistry,
        subjectHint,
        sequence: sequence++,
      });
      printTeachResult(record, { emitJson });
      results.push(record);
    }
  }

  if (!noSave) {
    await runReport.saveRun({
      id: `teach-${Date.now()}`,
      mode: "teach",
      startedAt,
      finishedAt: new Date().toISOString(),
      params,
      results,
    });
  }
  if (emitJson) {
    console.log(JSON.stringify({ mode: "teach", params, results }, null, 2));
  }
  return { params, results };
}

export async function runAsk({
  options,
  positionals,
  restClient,
  cheetahClient,
  schemaRegistry,
  modelKey,
  emitJson,
  noSave,
  runReport,
}) {
  const startedAt = new Date().toISOString();
  const question = positionals.slice(1).join(" ").trim() || optionsString(options.question);
  if (!question) {
    throw new Error('cheetah-learn ask expects a question, e.g. `cheetah-learn ask "What is X?"`.');
  }
  const handler = buildLmStudioHandler({ restClient, schemaRegistry, modelKey });
  const record = await recallAnswer(question, {
    handler,
    cheetahClient,
    schemaRegistry,
    subjectHint: optionsString(options.subject),
  });
  printRecallResult(record, { emitJson });
  if (!noSave) {
    await runReport.saveRun({
      id: `ask-${Date.now()}`,
      mode: "ask",
      startedAt,
      finishedAt: new Date().toISOString(),
      params: { question },
      results: record,
    });
  }
  if (emitJson) {
    console.log(JSON.stringify({ mode: "ask", result: record }, null, 2));
  }
  return { result: record };
}

export async function runChat({ restClient, cheetahClient, schemaRegistry, modelKey }) {
  const handler = buildLmStudioHandler({ restClient, schemaRegistry, modelKey });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "cheetah> ",
  });
  console.log('[cheetah-learn] Interactive chat. Type a question, or "exit"/"quit" to stop.');
  rl.prompt();
  for await (const line of rl) {
    const question = line.trim();
    if (!question) {
      rl.prompt();
      continue;
    }
    if (["exit", "quit", ":q"].includes(question.toLowerCase())) {
      break;
    }
    try {
      const record = await recallAnswer(question, { handler, cheetahClient, schemaRegistry });
      printRecallResult(record, { emitJson: false });
    } catch (error) {
      console.error(`[cheetah-learn] error: ${error instanceof Error ? error.message : error}`);
    }
    rl.prompt();
  }
  rl.close();
}

export async function runQuestions({ options, cheetahClient, emitJson }) {
  const status = optionsString(options.status) ?? "open";
  const limit = parseNumericSetting(options.limit, "--limit") ?? 20;
  const result = await listOpenQuestions(cheetahClient, { status, limit });
  if (emitJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[cheetah-learn][questions] ${result.count} ${status} question(s):`);
    for (const item of result.items) {
      console.log(`  - [${item.hypothesisId}] ${item.question}`);
    }
  }
  return result;
}

export async function runEval({
  options,
  restClient,
  cheetahClient,
  schemaRegistry,
  modelKey,
  verbose,
  emitJson,
  noSave,
  runReport,
}) {
  const startedAt = new Date().toISOString();
  const dataset = optionsString(options.dataset) ?? DEFAULT_DATASET;
  const teachLimit = parseNumericSetting(options["teach-limit"], "--teach-limit") ?? 20;
  const teachOffset = parseNumericSetting(options["teach-offset"], "--teach-offset") ?? 0;
  const evalLimit = parseNumericSetting(options["eval-limit"], "--eval-limit") ?? 10;
  const evalOffset = parseNumericSetting(options["eval-offset"], "--eval-offset") ?? 100000;
  const params = { dataset, teachLimit, teachOffset, evalLimit, evalOffset, modelKey };

  const hfClient = new HfDatasetClient({ dataset });
  const { teachRows, evalKnownRows, evalUnknownRows } = await fetchDisjointSamples(hfClient, {
    teachOffset,
    teachLimit,
    evalOffset,
    evalKnownCount: evalLimit,
    evalUnknownCount: evalLimit,
  });

  const handler = buildLmStudioHandler({ restClient, schemaRegistry, modelKey });

  const teachResults = [];
  let sequence = 0;
  for (const row of teachRows) {
    const snippet = clipSnippet(row.text);
    if (!snippet) {
      continue;
    }
    if (verbose) {
      console.log(`[cheetah-learn][eval] teaching row ${row.rowIdx}...`);
    }
    const record = await teachFromText(snippet, {
      handler,
      cheetahClient,
      schemaRegistry,
      subjectHint: row.subjectHint,
      sequence: sequence++,
    });
    printTeachResult(record, { emitJson });
    teachResults.push(record);
  }

  const askKnownOrUnknown = async (row, expectedGrounded) => {
    const subjectName = row.subjectHint?.subject;
    if (!subjectName) {
      return null;
    }
    const question = `What do you know about ${subjectName}?`;
    if (verbose) {
      console.log(`[cheetah-learn][eval] asking (${expectedGrounded ? "known" : "unknown"}): ${question}`);
    }
    const record = await recallAnswer(question, {
      handler,
      cheetahClient,
      schemaRegistry,
      subjectHint: subjectName,
    });
    printRecallResult(record, { emitJson });
    return { ...record, expectedGrounded };
  };

  const knownResults = [];
  for (const row of evalKnownRows) {
    const result = await askKnownOrUnknown(row, true);
    if (result) {
      knownResults.push(result);
    }
  }

  const unknownResults = [];
  for (const row of evalUnknownRows) {
    const result = await askKnownOrUnknown(row, false);
    if (result) {
      unknownResults.push(result);
    }
  }

  const groundedCorrect = knownResults.filter((entry) => entry.grounded).length;
  const correctlyDeclined = unknownResults.filter((entry) => !entry.grounded).length;
  const hallucinationCount = unknownResults.filter((entry) => entry.grounded).length;
  const openQuestionsRaised = [...knownResults, ...unknownResults].filter((entry) => entry.openQuestion).length;

  const metrics = {
    taughtCount: teachResults.length,
    evalKnownCount: knownResults.length,
    evalUnknownCount: unknownResults.length,
    groundedCorrect,
    groundedCorrectRate: knownResults.length ? groundedCorrect / knownResults.length : null,
    correctlyDeclined,
    correctlyDeclinedRate: unknownResults.length ? correctlyDeclined / unknownResults.length : null,
    hallucinationCount,
    hallucinationRate: unknownResults.length ? hallucinationCount / unknownResults.length : null,
    openQuestionsRaised,
  };

  console.log(`[cheetah-learn][eval] metrics: ${JSON.stringify(metrics)}`);

  if (!noSave) {
    await runReport.saveRun({
      id: `eval-${Date.now()}`,
      mode: "eval",
      startedAt,
      finishedAt: new Date().toISOString(),
      params,
      results: { teachResults, knownResults, unknownResults },
      metrics,
    });
  }
  if (emitJson) {
    console.log(JSON.stringify({ mode: "eval", params, metrics, teachResults, knownResults, unknownResults }, null, 2));
  }
  return { params, metrics, teachResults, knownResults, unknownResults };
}

export async function handleCheetahLearnCommand({
  options,
  positionals,
  verbose,
  configData,
  restBaseUrl,
}) {
  const action = (positionals[0] ?? options.action ?? "ask").toLowerCase();
  const modelKey = optionsString(options.model) ?? QWEN_MODEL_KEY;
  const overrideBaseUrl =
    optionsString(options["base-url"]) ?? optionsString(options.host) ?? restBaseUrl ?? undefined;
  const restClient = new LMStudioRestClient(
    buildRestClientOptions(
      configData,
      { modelKey, contextLength: QWEN_CONTEXT_LENGTH },
      overrideBaseUrl ? { baseUrl: overrideBaseUrl } : undefined,
    ) ?? { defaultModel: modelKey, defaultContextLength: QWEN_CONTEXT_LENGTH },
  );
  const schemaRegistry = new PromptSchemaRegistry();
  const cheetahClient = buildCheetahClient(options);
  const emitJson = Boolean(options.json);
  const noSave = Boolean(options["no-save"]);
  const runReport = new CheetahRunReport();

  await ensureAskerAnchor(cheetahClient);

  const shared = { options, positionals, restClient, cheetahClient, schemaRegistry, modelKey, verbose, emitJson, noSave, runReport };

  switch (action) {
    case "teach":
      return runTeach(shared);
    case "ask":
      return runAsk(shared);
    case "chat":
      return runChat(shared);
    case "questions":
      return runQuestions(shared);
    case "eval":
      return runEval(shared);
    default:
      throw new Error(
        `Unsupported cheetah-learn action "${action}". Expected teach, ask, chat, questions, or eval.`,
      );
  }
}
