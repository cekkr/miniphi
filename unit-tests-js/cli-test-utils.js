import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLI_PATH = path.resolve("src", "index.js");
const DEFAULT_BUFFER = 10 * 1024 * 1024;

export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? DEFAULT_BUFFER,
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    code: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function createTempWorkspace(prefix = "miniphi-cli-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempWorkspace(root) {
  if (!root) {
    return;
  }
  await fs.rm(root, { recursive: true, force: true });
}

export async function copySampleToWorkspace(sampleRelativePath, workspaceRoot) {
  const source = path.resolve(sampleRelativePath);
  const destination = path.join(workspaceRoot, sampleRelativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
  return destination;
}
