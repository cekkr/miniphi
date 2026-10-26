#!/usr/bin/env node
import { installWordNet } from "../src/libs/wordnet-installer.js";
const args = process.argv.slice(2);
try {
  if (args.length && (args[0] !== "--directory" || args.length !== 2)) throw new Error("Usage: node scripts/install-wordnet.js [--directory path]");
  console.log(JSON.stringify(await installWordNet({ directory: args[1] }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
