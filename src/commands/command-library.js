import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import { parseNumericSetting } from "../libs/cli-utils.js";

export async function handleCommandLibrary({ options, verbose }) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const memory = new MiniPhiMemory(cwd);
  await memory.prepare();
  const limit =
    parseNumericSetting(options.limit, "--limit") ??
    parseNumericSetting(options.count, "--count") ??
    12;
  let entries = await memory.loadCommandLibrary(limit ?? 12);
  const search = typeof options.search === "string" ? options.search.trim().toLowerCase() : null;
  const tag = typeof options.tag === "string" ? options.tag.trim().toLowerCase() : null;
  if (tag) {
    entries = entries.filter((entry) =>
      Array.isArray(entry.tags) ? entry.tags.some((t) => t && t.toLowerCase().includes(tag)) : false,
    );
  }
  if (search) {
    entries = entries.filter((entry) => {
      const haystack = [
        entry.command,
        entry.description,
        ...(entry.files ?? []),
        ...(entry.tags ?? []),
        entry.owner,
        entry.source,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
  }
  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (!entries.length) {
    console.log("[MiniPhi][CommandLibrary] No commands matched the current filters.");
    if (verbose) {
      console.log(
        `[MiniPhi][CommandLibrary] Library is stored under ${
          path.relative(process.cwd(), memory.commandLibraryFile) || memory.commandLibraryFile
        }`,
      );
    }
    return;
  }
  console.log(
    `[MiniPhi][CommandLibrary] Showing ${entries.length} command${
      entries.length === 1 ? "" : "s"
    } (cwd: ${cwd})`,
  );
  entries.forEach((entry, idx) => {
    console.log(`\n${idx + 1}. ${entry.command}`);
    if (entry.description) {
      console.log(`   ${entry.description}`);
    }
    const metaParts = [];
    if (entry.owner) metaParts.push(`owner: ${entry.owner}`);
    if (entry.source) metaParts.push(`source: ${entry.source}`);
    if (entry.createdAt) metaParts.push(`captured: ${entry.createdAt}`);
    if (Array.isArray(entry.tags) && entry.tags.length) {
      metaParts.push(`tags: ${entry.tags.join(", ")}`);
    }
    if (Array.isArray(entry.files) && entry.files.length) {
      metaParts.push(`files: ${entry.files.slice(0, 4).join(", ")}`);
    }
    if (metaParts.length) {
      console.log(`   ${metaParts.join(" | ")}`);
    }
  });
  if (verbose) {
    console.log(
      `\n[MiniPhi][CommandLibrary] Stored at ${
        path.relative(process.cwd(), memory.commandLibraryFile) || memory.commandLibraryFile
      }`,
    );
  }
}
