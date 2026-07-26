import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createTempWorkspace,
  removeTempWorkspace,
} from "./cli-test-utils.js";

const CLI_PATH = path.resolve("src", "index.js");

function runCliAsync(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const ANSWERS = {
  "reasoning-sequence": "42",
  "coding-execution": "6",
  "context-retrieval": "violet-orbit-731",
  "writing-constraints": "Calm tools build trust.",
  "research-source-choice": "primary-source",
  "tool-planning": "read_file",
};

test("benchmark models CLI writes scores and then serves a zero-prompt cache hit", async () => {
  const workspace = await createTempWorkspace("miniphi-cli-model-bench-");
  let promptCalls = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/v1/models") {
      response.end(
        JSON.stringify({
          models: [
            {
              type: "llm",
              key: "fixture-model",
              architecture: "llama",
              quantization: { name: "Q4_K_M" },
              params_string: "7B",
              size_bytes: 4_000_000_000,
              max_context_length: 32768,
              loaded_instances: [
                {
                  id: "fixture-instance",
                  config: { context_length: 4096 },
                },
              ],
              capabilities: {
                vision: false,
                trained_for_tool_use: true,
              },
            },
          ],
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/v0/status") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "unsupported" }));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/api/v0/chat/completions"
    ) {
      promptCalls += 1;
      const payload = await body(request);
      assert.equal(payload.response_format.type, "json_schema");
      assert.equal(payload.context_length, undefined);
      const trialId = payload.messages[0].content.match(/Trial id: ([^\n]+)/)?.[1];
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schema_version: "model-benchmark-trial@v1",
                  trial_id: trialId,
                  answer: ANSWERS[trialId],
                  evidence: [],
                  needs_more_context: false,
                  missing_snippets: [],
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const env = {
    LMSTUDIO_REST_URL: `http://127.0.0.1:${address.port}`,
  };
  const args = [
    "benchmark",
    "models",
    "--easy",
    "--models",
    "fixture-model",
    "--json",
    "--cwd",
    workspace,
    "--model-timeout",
    "5",
  ];

  try {
    const first = await runCliAsync(args, {
      cwd: path.resolve("."),
      env,
    });
    assert.equal(first.code, 0, first.stderr);
    const firstJson = JSON.parse(first.stdout);
    assert.equal(firstJson.rows[0].modelId, "fixture-model");
    assert.equal(firstJson.rows[0].overall > 0, true);
    assert.equal(promptCalls, 6);

    const second = await runCliAsync(args, {
      cwd: path.resolve("."),
      env,
    });
    assert.equal(second.code, 0, second.stderr);
    const secondJson = JSON.parse(second.stdout);
    assert.equal(secondJson.results[0].cacheHit, true);
    assert.equal(promptCalls, 6);

    const shown = await runCliAsync(
      [
        "benchmark",
        "models",
        "--show",
        "--json",
        "--cwd",
        workspace,
      ],
      { cwd: path.resolve("."), env },
    );
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).mode, "show");
    assert.equal(promptCalls, 6);
  } finally {
    server.close();
    await once(server, "close");
    await removeTempWorkspace(workspace);
  }
});
