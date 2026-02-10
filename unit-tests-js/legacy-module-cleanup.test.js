import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

async function listJsFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(target);
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

test("legacy lms-phi4 shim is removed and no source imports it", async () => {
  const shimPath = path.resolve("src", "libs", "lms-phi4.js");
  await assert.rejects(() => fs.access(shimPath));

  const sourceFiles = await listJsFiles(path.resolve("src"));
  const matches = [];
  for (const filePath of sourceFiles) {
    const content = await fs.readFile(filePath, "utf8");
    if (content.includes("lms-phi4")) {
      matches.push(path.relative(process.cwd(), filePath));
    }
  }
  assert.deepEqual(matches, []);
});

