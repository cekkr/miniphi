#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { buildEnvironmentReport, formatEnvironmentReport } from "./system-info.js";
import { generateReadmeContent, writeReadme } from "./project-readme.js";
import { runFeature } from "./features/sample-feature.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_NAME = "MiniPhi Get-Started Sample";

function parseArgs(argv) {
  const flags = {
    info: false,
    readme: false,
    feature: false,
    smoke: false,
    output: null,
    flag: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--info") {
      flags.info = true;
    } else if (token === "--readme") {
      flags.readme = true;
    } else if (token === "--feature") {
      flags.feature = true;
    } else if (token === "--smoke") {
      flags.smoke = true;
    } else if (token === "--output") {
      flags.output = argv[i + 1] ?? null;
      i += 1;
    } else if (token === "--flag") {
      flags.flag = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return flags;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.info && !options.readme && !options.feature && !options.smoke) {
    console.log("Usage: node src/index.js [--info] [--readme --output ./README.md] [--feature --flag interactive] [--smoke]");
    process.exit(0);
  }

  const envReport = buildEnvironmentReport();

  if (options.info || options.smoke) {
    console.log("[Environment]");
    console.log(formatEnvironmentReport(envReport));
    console.log("");
  }

  if (options.readme || options.smoke) {
    const featureNotes = [`Generated via ${PROJECT_NAME} on ${new Date().toISOString()}`];
    const content = generateReadmeContent(PROJECT_NAME, envReport, featureNotes);
    const target = options.output ?? path.join(__dirname, "..", "..", "GENERATED_README.md");
    const resolved = writeReadme(path.resolve(target), content);
    console.log(`[README] Wrote ${resolved}`);
  }

  if (options.feature || options.smoke) {
    const overrides = options.flag ? { mode: options.flag } : undefined;
    const result = runFeature(envReport, overrides);
    console.log("[Feature]");
    console.log(JSON.stringify(result, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("/src/index.js")) {
  main();
}

export { parseArgs, main };
