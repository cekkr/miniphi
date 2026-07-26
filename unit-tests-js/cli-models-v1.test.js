import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const REPO_ROOT = path.resolve(".");
const CLI_PATH = path.join(REPO_ROOT, "src", "index.js");

function runCliAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
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

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

test("models CLI scans native v1 and performs explicit exact lifecycle actions", async () => {
  const calls = [];
  let loadedInstances = [];
  const server = http.createServer(async (request, response) => {
    calls.push({ method: request.method, url: request.url });
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/v1/models") {
      response.end(
        JSON.stringify({
          models: [
            {
              type: "llm",
              publisher: "Test",
              key: "test-coder-7b",
              display_name: "Test Coder 7B",
              architecture: "qwen2",
              quantization: { name: "Q4_K_M", bits_per_weight: 4 },
              size_bytes: 4000000000,
              params_string: "7B",
              loaded_instances: loadedInstances,
              max_context_length: 32768,
              format: "gguf",
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
    if (request.method === "POST" && request.url === "/api/v1/models/load") {
      const body = await readJsonBody(request);
      assert.equal(body.model, "test-coder-7b");
      assert.equal(body.context_length, 4096);
      loadedInstances = [
        {
          id: "test-coder-instance",
          config: { context_length: 4096 },
        },
      ];
      response.end(
        JSON.stringify({
          type: "llm",
          instance_id: "test-coder-instance",
          status: "loaded",
          load_config: { context_length: 4096 },
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/models/unload") {
      const body = await readJsonBody(request);
      assert.equal(body.instance_id, "test-coder-instance");
      loadedInstances = [];
      response.end(JSON.stringify({ instance_id: "test-coder-instance" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const env = { LMSTUDIO_REST_URL: baseUrl };

  try {
    const listed = await runCliAsync(
      ["models", "--task", "Implement parser tests", "--json", "--timeout", "5"],
      env,
    );
    assert.equal(listed.code, 0, listed.stderr);
    const listedJson = JSON.parse(listed.stdout);
    assert.equal(listedJson.source, "native-v1");
    assert.equal(listedJson.recommended, "test-coder-7b");
    assert.deepEqual(listedJson.models[0].capabilities, ["tool_use"]);

    const loaded = await runCliAsync(
      [
        "models",
        "--load",
        "test-coder-7b",
        "--context-length",
        "4096",
        "--json",
        "--timeout",
        "5",
      ],
      env,
    );
    assert.equal(loaded.code, 0, loaded.stderr);
    const loadedJson = JSON.parse(loaded.stdout);
    assert.equal(loadedJson.lifecycle.action, "load");
    assert.equal(loadedJson.models[0].loadedInstanceId, "test-coder-instance");

    const unloaded = await runCliAsync(
      [
        "models",
        "--unload",
        "test-coder-instance",
        "--json",
        "--timeout",
        "5",
      ],
      env,
    );
    assert.equal(unloaded.code, 0, unloaded.stderr);
    const unloadedJson = JSON.parse(unloaded.stdout);
    assert.equal(unloadedJson.lifecycle.action, "unload");
    assert.equal(unloadedJson.models[0].state, "not-loaded");
    assert.ok(
      calls.some(
        (call) =>
          call.method === "POST" && call.url === "/api/v1/models/load",
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === "POST" && call.url === "/api/v1/models/unload",
      ),
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
