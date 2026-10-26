#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { renderWebNlgExchangeMarkdown } from "./lib/webnlg-exchange-markdown.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, token, index, all) => {
  if (token.startsWith("--")) out.push([token.slice(2), all[index + 1]]);
  return out;
}, []));
const state = path.resolve(args.state ?? "docs/benchmarks/webnlg-correlations-wordnet-2026-10-26.json.gz");
const output = path.resolve(args.output ?? "docs/webnlg_learning.md");
const bytes = await fs.readFile(state);
const report = JSON.parse(state.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8"));
const auditLink = path.relative(path.dirname(output), state).split(path.sep).join("/");
const { markdown, counts } = renderWebNlgExchangeMarkdown(report, { auditLink,
  guideLink: path.relative(path.dirname(output), path.resolve("docs/cheetah-webnlg-learning.md")).split(path.sep).join("/"),
  legacyLink: path.relative(path.dirname(output), path.resolve("docs/webnlg_learning_legacy.md")).split(path.sep).join("/"),
  stateArgument: path.relative(process.cwd(), state), outputArgument: path.relative(process.cwd(), output),
});
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, markdown);
console.log(JSON.stringify({ output, ...counts }, null, 2));
