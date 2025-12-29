import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const RUN_INTEGRATION = process.env.MINIPHI_LMSTUDIO_INTEGRATION === "1";
const LMSTUDIO_BASE_URL = (process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234").replace(
  /\/+$/g,
  "",
);
const MODEL_KEY = process.env.MINIPHI_LMSTUDIO_MODEL ?? "mistralai/devstral-small-2-2512";

async function fetchJson(url, init = undefined, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...(init ?? {}),
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const message =
        parsed?.error?.message ??
        parsed?.error ??
        (text ? text.slice(0, 240) : "") ??
        `HTTP ${res.status}`;
      throw new Error(`LM Studio request failed (${res.status} ${res.statusText}): ${message}`);
    }
    if (parsed === null) {
      throw new Error(`LM Studio returned non-JSON payload: ${text.slice(0, 240)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function listModels() {
  return fetchJson(`${LMSTUDIO_BASE_URL}/api/v0/models`, { method: "GET" }, 15000);
}

async function ensureModelExists(modelKey) {
  const payload = await listModels();
  const ids = Array.isArray(payload?.data) ? payload.data.map((entry) => entry?.id).filter(Boolean) : [];
  if (!ids.includes(modelKey)) {
    throw new Error(
      `LM Studio model "${modelKey}" not found in /api/v0/models. Available models: ${ids.slice(0, 12).join(", ")}${
        ids.length > 12 ? ", ..." : ""
      }`,
    );
  }
}

async function createChatCompletion(payload) {
  return fetchJson(
    `${LMSTUDIO_BASE_URL}/api/v0/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    180000,
  );
}

test(
  "LM Studio devstral enforces JSON schema (project automation plan)",
  { skip: !RUN_INTEGRATION, timeout: 240000 },
  async () => {
    await ensureModelExists(MODEL_KEY);
    const systemPromptPath = path.join(
      process.cwd(),
      "docs",
      "models",
      "devstrall",
      "defaultSystemPrompt.txt",
    );
    const systemPrompt = await fs.readFile(systemPromptPath, "utf8");

    const responseSchema = {
      type: "object",
      additionalProperties: false,
      required: ["goal", "directory_requests", "file_requests", "next_commands", "needs_more_context"],
      properties: {
        goal: { type: "string" },
        directory_requests: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "depth", "reason", "include_globs", "exclude_globs"],
            properties: {
              path: { type: "string" },
              depth: { type: "integer" },
              reason: { type: "string" },
              include_globs: { type: "array", items: { type: "string" } },
              exclude_globs: { type: "array", items: { type: "string" } },
            },
          },
        },
        file_requests: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "reason"],
            properties: {
              path: { type: "string" },
              reason: { type: "string" },
              excerpt_hint: { type: ["string", "null"] },
            },
          },
        },
        next_commands: { type: "array", items: { type: "string" } },
        questions: { type: "array", items: { type: "string" }, default: [] },
        editing_strategy: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["phase", "description"],
            properties: {
              phase: { type: "string" },
              description: { type: "string" },
              risks: { type: "array", items: { type: "string" }, default: [] },
            },
          },
        },
        needs_more_context: { type: "boolean" },
      },
    };

    const userPrompt = [
      "I want to automate the discovery + refactor planning for a large C++ repository.",
      "Produce a plan that tells an external script exactly what to list/read next (directories + files) and which safe commands to run.",
      "Assume the script will run on Windows PowerShell, and that the project may have CMake + third-party folders.",
      "Keep requests minimal but sufficient to propose a new directory/class structure.",
    ].join("\n");

    const completion = await createChatCompletion({
      model: MODEL_KEY,
      stream: false,
      max_tokens: 900,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "project-automation-plan",
          schema: responseSchema,
        },
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const content = completion?.choices?.[0]?.message?.content ?? "";
    assert.ok(typeof content === "string" && content.trim().length > 0, "Expected string content");
    const trimmed = content.trim();
    assert.ok(trimmed.startsWith("{") && trimmed.endsWith("}"), "Expected JSON-only object output");

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(trimmed);
    }, "Expected response content to be valid JSON");

    assert.equal(typeof parsed.goal, "string");
    assert.ok(Array.isArray(parsed.directory_requests));
    assert.ok(Array.isArray(parsed.file_requests));
    assert.ok(Array.isArray(parsed.next_commands));
    assert.equal(typeof parsed.needs_more_context, "boolean");
  },
);

