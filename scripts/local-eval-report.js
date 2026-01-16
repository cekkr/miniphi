import fs from "fs";
import path from "path";
import MiniPhiMemory from "../src/libs/miniphi-memory.js";

function parseArgs(tokens) {
  const options = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--root") {
      options.root = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--output") {
      options.output = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "--limit") {
      options.limit = Number(tokens[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
  }
  return options;
}

function percent(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/local-eval-report.js [--root <path>] [--output <path>] [--limit <n>]");
    process.exitCode = 0;
    return;
  }
  const root = options.root ? path.resolve(options.root) : process.cwd();
  const memory = new MiniPhiMemory(root);
  await memory.prepare();
  const baseDir = memory.baseDir;
  const indexPath = path.join(baseDir, "prompt-exchanges", "index.json");
  let entries = [];
  try {
    const index = JSON.parse(await fs.promises.readFile(indexPath, "utf8"));
    entries = Array.isArray(index.entries) ? index.entries : [];
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`[MiniPhi] Unable to read prompt exchanges index at ${indexPath}`);
      process.exitCode = 1;
      return;
    }
  }
  const limit =
    Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : entries.length;
  const sliced = entries.slice(0, limit);
  let total = 0;
  let withResponseFormat = 0;
  let withSchemaName = 0;
  let withToolCalls = 0;
  let withToolDefinitions = 0;
  let withRawResponseText = 0;
  const schemaNames = {};

  for (const entry of sliced) {
    const file = entry?.file ? path.join(baseDir, entry.file) : null;
    if (!file) {
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch {
      continue;
    }
    total += 1;
    const responseFormat = payload?.request?.response_format ?? null;
    if (responseFormat) {
      withResponseFormat += 1;
      const schemaName = responseFormat?.json_schema?.name ?? null;
      if (schemaName) {
        withSchemaName += 1;
        schemaNames[schemaName] = (schemaNames[schemaName] ?? 0) + 1;
      }
    }
    if (payload?.response && Object.prototype.hasOwnProperty.call(payload.response, "tool_calls")) {
      withToolCalls += 1;
    }
    if (payload?.response && Object.prototype.hasOwnProperty.call(payload.response, "tool_definitions")) {
      withToolDefinitions += 1;
    }
    if (payload?.response && Object.prototype.hasOwnProperty.call(payload.response, "rawResponseText")) {
      withRawResponseText += 1;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseDir,
    totalRecords: total,
    coverage: {
      responseFormat: { count: withResponseFormat, percent: percent(withResponseFormat, total) },
      schemaName: { count: withSchemaName, percent: percent(withSchemaName, total) },
      toolCalls: { count: withToolCalls, percent: percent(withToolCalls, total) },
      toolDefinitions: { count: withToolDefinitions, percent: percent(withToolDefinitions, total) },
      rawResponseText: { count: withRawResponseText, percent: percent(withRawResponseText, total) },
    },
    schemaNames,
    sampleLimit: limit,
  };

  if (options.output) {
    const outputPath = path.resolve(options.output);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[MiniPhi] Wrote local eval report to ${outputPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(`[MiniPhi] Local eval report failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
