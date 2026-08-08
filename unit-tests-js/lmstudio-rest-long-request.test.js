import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { LMStudioRestClient, createNodeHttpFetch } from "../src/libs/lmstudio-api.js";

/**
 * The REST client must not inherit Node's global `fetch` deadline.
 *
 * undici caps a response at a 300-second `headersTimeout`/`bodyTimeout` that no
 * `fetch` option can raise, and a non-streamed `/chat/completions` sends nothing
 * until the whole completion is ready. A local model that needs longer than five
 * minutes — the normal case for a 27B model writing a file — therefore failed
 * with a bare "fetch failed" regardless of `lmStudio.rest.timeoutMs`. A real
 * sample run died on exactly that, twice, within two turns.
 *
 * These tests use a delay far shorter than 300s (the point is the *mechanism*,
 * and a five-minute unit test is not a unit test); the live proof that a
 * 559-second completion now returns is recorded in AGENTS.md.
 */

const startServer = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });

const close = (server) => new Promise((resolve) => server.close(resolve));

test("the default fetch implementation is not Node's global fetch", () => {
  const client = new LMStudioRestClient({ baseUrl: "http://127.0.0.1:1234" });
  assert.notEqual(client.fetchImpl, globalThis.fetch);
  assert.equal(typeof client.fetchImpl, "function");
  // An injected implementation still wins — every offline suite depends on it.
  const stub = async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "{}" });
  assert.equal(new LMStudioRestClient({ fetchImpl: stub }).fetchImpl, stub);
});

test("a slow response is delivered rather than cut off by a transport deadline", async () => {
  const { server, port } = await startServer((request, response) => {
    // Headers *and* body are withheld until the delay elapses, which is what a
    // non-streamed completion does and what undici's ceiling reacts to.
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }));
    }, 400);
  });
  try {
    const client = new LMStudioRestClient({
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: "slow",
      timeoutMs: 30000,
    });
    const completion = await client.createChatCompletion({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(completion.choices[0].message.content, '{"ok":true}');
  } finally {
    await close(server);
  }
});

test("the caller's own timeout still aborts the request", async () => {
  const { server, port } = await startServer(() => {
    // Never answers: only MiniPhi's AbortController can end this.
  });
  try {
    const client = new LMStudioRestClient({
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: "hung",
      timeoutMs: 1000,
    });
    await assert.rejects(
      client.createChatCompletion({
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 1000,
      }),
      /abort/i,
      "removing undici's deadline must not remove MiniPhi's own",
    );
  } finally {
    await close(server);
  }
});

test("a non-2xx answer still surfaces status, statusText and body", async () => {
  const { server, port } = await startServer((request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Context size has been exceeded" } }));
  });
  try {
    const client = new LMStudioRestClient({
      baseUrl: `http://127.0.0.1:${port}`,
      defaultModel: "strict",
    });
    await assert.rejects(
      client.createChatCompletion({ messages: [{ role: "user", content: "hi" }] }),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Context size has been exceeded/);
        return true;
      },
    );
  } finally {
    await close(server);
  }
});

test("the shim sends the method, headers and body it was given", async () => {
  const seen = {};
  const { server, port } = await startServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.method = request.method;
      seen.auth = request.headers.authorization;
      seen.contentType = request.headers["content-type"];
      seen.body = Buffer.concat(chunks).toString("utf8");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  try {
    const fetchImpl = createNodeHttpFetch();
    const answer = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
      body: JSON.stringify({ model: "m" }),
    });
    assert.equal(answer.ok, true);
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), "{}");
    assert.equal(seen.method, "POST");
    assert.equal(seen.auth, "Bearer token");
    assert.equal(seen.contentType, "application/json");
    assert.deepEqual(JSON.parse(seen.body), { model: "m" });
  } finally {
    await close(server);
  }
});
