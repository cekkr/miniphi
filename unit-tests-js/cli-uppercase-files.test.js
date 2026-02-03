import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import {
  createTempWorkspace,
  removeTempWorkspace,
} from "./cli-test-utils.js";

const REPO_ROOT = path.resolve(process.cwd());
const CLI_PATH = path.resolve("src", "index.js");

async function ensureIsolatedMiniPhiRoot(workspaceRoot) {
  const miniPhiRoot = path.join(workspaceRoot, ".miniphi");
  await fs.mkdir(miniPhiRoot, { recursive: true });
  return miniPhiRoot;
}

async function findMiniPhiRoot(startDir) {
  let current = path.resolve(startDir);
  const { root } = path.parse(current);
  while (true) {
    const candidate = path.join(current, ".miniphi");
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // ignore missing dirs
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return path.join(startDir, ".miniphi");
}

function sanitizeJournalId(raw) {
  if (!raw) {
    return "";
  }
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function loadPromptJournalSteps(workspaceRoot, promptJournalId) {
  const miniPhiRoot = await findMiniPhiRoot(workspaceRoot);
  const safeId = sanitizeJournalId(promptJournalId);
  const sessionDir = path.join(miniPhiRoot, "prompt-exchanges", "stepwise", safeId);
  const sessionPath = path.join(sessionDir, "session.json");
  const session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  const stepsDir = path.join(sessionDir, "steps");
  const steps = [];
  const totalSteps = session.steps ?? 0;
  for (let sequence = 1; sequence <= totalSteps; sequence += 1) {
    const stepPath = path.join(stepsDir, `step-${String(sequence).padStart(3, "0")}.json`);
    const step = JSON.parse(await fs.readFile(stepPath, "utf8"));
    steps.push(step);
  }
  return { miniPhiRoot, session, steps };
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
      });
    });
  });
}

const HELPER_SCRIPT = [
  'const fs = require("fs");',
  'const path = require("path");',
  "",
  "function isDot(name) {",
  "  return name.startsWith(\".\");",
  "}",
  "",
  "function renameSafely(fromPath, toPath) {",
  "  if (fromPath === toPath) {",
  "    return false;",
  "  }",
  "  if (fromPath.toLowerCase() === toPath.toLowerCase()) {",
  "    const dir = path.dirname(fromPath);",
  "    const temp = path.join(",
  "      dir,",
  "      `.__miniphi_tmp_${Date.now()}_${Math.random().toString(16).slice(2)}`",
  "    );",
  "    fs.renameSync(fromPath, temp);",
  "    fs.renameSync(temp, toPath);",
  "    return true;",
  "  }",
  "  fs.renameSync(fromPath, toPath);",
  "  return true;",
  "}",
  "",
  "function renameDirFiles(dir) {",
  "  const entries = fs.readdirSync(dir, { withFileTypes: true });",
  "  const operations = [];",
  "  for (const entry of entries) {",
  "    if (!entry.isFile()) {",
  "      continue;",
  "    }",
  "    if (isDot(entry.name)) {",
  "      continue;",
  "    }",
  "    const fromPath = path.join(dir, entry.name);",
  "    const upperName = entry.name.toUpperCase();",
  "    if (entry.name === upperName) {",
  "      continue;",
  "    }",
  "    const toPath = path.join(dir, upperName);",
  "    renameSafely(fromPath, toPath);",
  "    operations.push({ from: fromPath, to: toPath });",
  "  }",
  "  return operations;",
  "}",
  "",
  "const root = process.cwd();",
  "let operations = renameDirFiles(root);",
  "const rootEntries = fs.readdirSync(root, { withFileTypes: true });",
  "for (const entry of rootEntries) {",
  "  if (!entry.isDirectory()) {",
  "    continue;",
  "  }",
  "  if (isDot(entry.name)) {",
  "    continue;",
  "  }",
  "  const subdir = path.join(root, entry.name);",
  "  operations = operations.concat(renameDirFiles(subdir));",
  "}",
  "process.stdout.write(JSON.stringify(operations));",
].join("\n");

async function startLmStudioStub() {
  const requests = { navigator: [], decomposer: [] };
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/api/v0/status")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          loaded_model: "stub-model",
          context_length: 8192,
          gpu: "stub",
        }),
      );
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/v0/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/api/v0/chat/completions")) {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      await once(req, "end");
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const systemText = body?.messages?.[0]?.content ?? "";
      const isDecomposer = systemText.includes("MiniPhi prompt decomposer");
      const isNavigator = systemText.includes("MiniPhi navigation advisor");

      if (isDecomposer) {
        requests.decomposer.push(body);
        const plan = {
          schema_version: "prompt-plan@v1",
          plan_id: "rename-files-uppercase",
          summary: "Rename files to uppercase using a helper script.",
          needs_more_context: false,
          missing_snippets: [],
          steps: [
            {
              id: "1",
              title: "Rename files",
              description: "Run helper script to uppercase filenames.",
              requires_subprompt: false,
              recommendation: null,
              children: [],
            },
          ],
          recommended_tools: ["node"],
          notes: null,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
        return;
      }

      if (isNavigator) {
        requests.navigator.push(body);
        const navigationPlan = {
          schema_version: "navigation-plan@v1",
          navigation_summary: "Rename files to uppercase using a node helper script.",
          needs_more_context: false,
          missing_snippets: [],
          recommended_paths: [],
          file_types: [],
          focus_commands: [],
          actions: [],
          helper_script: {
            language: "node",
            name: "rename-to-uppercase-js",
            description:
              "Uppercase filenames in the current directory and immediate subdirectories.",
            code: HELPER_SCRIPT,
            stdin: null,
            notes: null,
          },
          notes: null,
          stop_reason: null,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(navigationPlan) } }],
          }),
        );
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown chat completion request." }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
  };
}

test(
  "CLI workspace navigator uppercases filenames via helper script",
  { timeout: 12 * 60 * 1000 },
  async () => {
    const workspace = await createTempWorkspace();
    const stub = await startLmStudioStub();
    try {
      await ensureIsolatedMiniPhiRoot(workspace);
      const targetRoot = path.join(workspace, "rename-target");
      const nestedDir = path.join(targetRoot, "subdir");
      await fs.mkdir(nestedDir, { recursive: true });
      const rootFiles = ["alpha.txt", "bravo.md"];
      const nestedFiles = ["charlie.js", "delta.json"];
      for (const file of rootFiles) {
        await fs.writeFile(path.join(targetRoot, file), `sample-${file}`, "utf8");
      }
      for (const file of nestedFiles) {
        await fs.writeFile(path.join(nestedDir, file), `sample-${file}`, "utf8");
      }
      const configPath = path.join(workspace, "stub-config.json");
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            lmStudio: {
              rest: {
                baseUrl: stub.baseUrl,
                timeoutMs: 5000,
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const task = [
        "Rename every file in the current directory and its immediate subdirectories to uppercase.",
        "Do not rename directories or dotfiles (for example, .miniphi).",
        "Use helper_script with language \"node\" to perform the rename.",
        "The helper script must apply the renames (not just list them) and then print JSON describing the applied {from,to} operations.",
        "Include files inside immediate subdirectories, not just the root.",
        "Handle case-only renames safely on Windows (use a temporary name when needed).",
        "Choose the most effective script based on the provided capability inventory.",
        "The helper should output a JSON array of {from,to} rename operations to stdout.",
        "Set actions to [], focus_commands to [], recommended_paths to [], file_types to [].",
        "Set needs_more_context to false and missing_snippets to [].",
      ].join(" ");

      const journalId = `uppercase-files-${Date.now()}`;
      const result = await runCliAsync(
        [
          "workspace",
          "--config",
          configPath,
          "--task",
          task,
          "--cwd",
          targetRoot,
          "--prompt-journal",
          journalId,
          "--prompt-journal-status",
          "paused",
        ],
        {
          cwd: REPO_ROOT,
          env: {
            LMSTUDIO_REST_URL: stub.baseUrl,
            MINIPHI_FORCE_REST: "1",
          },
        },
      );
      assert.equal(result.code, 0, result.stderr);

      const { miniPhiRoot, session, steps } = await loadPromptJournalSteps(
        targetRoot,
        journalId,
      );
      assert.ok(session.steps >= 2, "Prompt journal did not capture step-by-step calls.");
      const navigatorStep = steps.find((step) => step.label === "navigator-plan");
      assert.ok(navigatorStep, "Navigator step missing from prompt journal.");
      const helper = navigatorStep.metadata?.helper ?? null;
      assert.ok(helper, "Navigator helper script missing.");
      assert.equal(helper.language, "node");
      assert.ok(helper.run, "Navigator helper did not execute.");
      const summaryStep = steps.find((step) => step.label === "workspace-summary");
      assert.ok(summaryStep, "Workspace summary step missing from prompt journal.");
      assert.ok(summaryStep.metadata, "Workspace summary metadata missing.");
      assert.ok(
        Object.prototype.hasOwnProperty.call(summaryStep.metadata, "stopReason"),
        "Workspace summary metadata missing stopReason.",
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(summaryStep.metadata, "stopReasonCode"),
        "Workspace summary metadata missing stopReasonCode.",
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(summaryStep.metadata, "stopReasonDetail"),
        "Workspace summary metadata missing stopReasonDetail.",
      );
      const stderrPath = helper.run.stderr
        ? path.join(miniPhiRoot, helper.run.stderr)
        : null;
      if (helper.run.exitCode !== 0) {
        const stderrText = stderrPath
          ? await fs.readFile(stderrPath, "utf8").catch(() => "")
          : "";
        const commandHint = helper.run.command ? ` Command: ${helper.run.command}` : "";
        assert.equal(
          helper.run.exitCode,
          0,
          `Navigator helper execution failed: ${stderrText || "unknown error"}.${commandHint}`,
        );
      }
      const stdoutPath = helper.run.stdout
        ? path.join(miniPhiRoot, helper.run.stdout)
        : null;
      const stdoutText = stdoutPath
        ? await fs.readFile(stdoutPath, "utf8").catch(() => "")
        : "";

      await fs.stat(path.join(targetRoot, "subdir"));
      const rootNames = await listFiles(targetRoot);
      const nestedNames = await listFiles(nestedDir);
      const expectedRoot = rootFiles.map((name) => name.toUpperCase());
      const expectedNested = nestedFiles.map((name) => name.toUpperCase());
      const helperHint = stdoutText.trim()
        ? ` Helper output: ${stdoutText.trim().slice(0, 220)}`
        : "";
      expectedRoot.forEach((name) => {
        assert.ok(rootNames.includes(name), `Missing uppercased file ${name}.${helperHint}`);
      });
      expectedNested.forEach((name) => {
        assert.ok(nestedNames.includes(name), `Missing uppercased file ${name}.${helperHint}`);
      });
      rootFiles.forEach((name) => {
        assert.ok(!rootNames.includes(name), `Lowercase file still present: ${name}`);
      });
      nestedFiles.forEach((name) => {
        assert.ok(!nestedNames.includes(name), `Lowercase file still present: ${name}`);
      });

      assert.ok(
        stub.requests.decomposer.length > 0 && stub.requests.navigator.length > 0,
        "Stub did not capture step-by-step API calls.",
      );
      const navigatorRequest = stub.requests.navigator[0];
      const navigatorPayload = navigatorRequest?.messages?.[1]?.content ?? null;
      const payload = navigatorPayload ? JSON.parse(navigatorPayload) : null;
      assert.ok(payload, "Navigator request payload missing.");
      assert.ok(
        typeof payload.capabilitySummary === "string" &&
          payload.capabilitySummary.includes("node"),
        "Navigator payload missing interpreter summary.",
      );
      const osCommands = payload.capabilities?.osCommands ?? [];
      assert.ok(
        Array.isArray(osCommands) && osCommands.includes("node"),
        "Navigator payload missing osCommands interpreter info.",
      );
    } finally {
      stub.server.close();
      await removeTempWorkspace(workspace);
    }
  },
);
