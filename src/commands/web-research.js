import fs from "fs";
import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import WebResearcher from "../libs/web-researcher.js";
import { parseNumericSetting } from "../libs/cli-utils.js";

export async function handleWebResearch({ options, positionals, verbose }) {
  const queries = [];
  const pushQuery = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      queries.push(trimmed);
    }
  };
  pushQuery(options.query);
  for (const positional of positionals) {
    pushQuery(positional);
  }
  if (options["query-file"]) {
    const filePath = path.resolve(options["query-file"]);
    const contents = await fs.promises.readFile(filePath, "utf8");
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach(pushQuery);
  }

  if (queries.length === 0) {
    throw new Error(
      'web-research expects at least one query via --query "<text>" or positional arguments.',
    );
  }

  const provider = typeof options.provider === "string" ? options.provider : "duckduckgo";
  const maxResults = parseNumericSetting(options["max-results"], "--max-results");
  const includeRaw = Boolean(options["include-raw"]);
  const note = typeof options.note === "string" ? options.note : null;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const memory = new MiniPhiMemory(cwd);
  await memory.prepare();
  const researcher = new WebResearcher();
  const shouldSave = !options["no-save"];

  for (const query of queries) {
    if (verbose) {
      console.log(`[MiniPhi][Research] Searching "${query}" via ${provider}...`);
    }
    const report = await researcher.search(query, {
      provider,
      maxResults,
      includeRaw,
      note,
    });
    const persisted = shouldSave ? await memory.saveResearchReport(report) : null;
    console.log(
      `[MiniPhi][Research] ${report.results.length} result${
        report.results.length === 1 ? "" : "s"
      } for "${report.query}" (${report.durationMs} ms)`,
    );
    report.results.forEach((result, index) => {
      console.log(
        `  ${index + 1}. ${result.title ?? result.url} [${result.source ?? "unknown"}]`,
      );
      console.log(`     ${result.url}`);
      if (result.snippet) {
        console.log(`     ${result.snippet}`);
      }
    });
    if (persisted?.path && verbose) {
      const rel = path.relative(process.cwd(), persisted.path);
      console.log(`[MiniPhi][Research] Saved snapshot to ${rel || persisted.path}`);
    }
  }
}
