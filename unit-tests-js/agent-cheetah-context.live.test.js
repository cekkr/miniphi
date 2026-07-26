import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import { CheetahContextEngine } from "../src/libs/cheetah-context-engine.js";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";

/**
 * Live proof for Cheetah-backed context selection.
 *
 * This test expects both services to be running. Every LM Studio turn still
 * uses AgentSession's exact agent-action schema + response_format=json_schema;
 * Cheetah only supplies graph-recalled stable node ids to the prompt selector.
 *
 * MINIPHI_LMSTUDIO_INTEGRATION=1 \
 * MINIPHI_CHEETAH_INTEGRATION=1 \
 * LMSTUDIO_REST_URL=http://127.0.0.1:1234 \
 * MINIPHI_LIVE_MODEL=qwen2.5-coder-7b-instruct \
 * node --test unit-tests-js/agent-cheetah-context.live.test.js
 */
const LIVE =
  process.env.MINIPHI_LMSTUDIO_INTEGRATION === "1" &&
  process.env.MINIPHI_CHEETAH_INTEGRATION === "1";
const BASE_URL = process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234";
const MODEL = process.env.MINIPHI_LIVE_MODEL ?? "qwen2.5-coder-7b-instruct";
const CHEETAH_HOST = process.env.MINIPHI_CHEETAH_HOST ?? "127.0.0.1";
const CHEETAH_PORT = Number(process.env.MINIPHI_CHEETAH_PORT ?? 4455);
const TIMEOUT_MS = 300000;

test(
  "live: Cheetah recall selects context for a schema-valid LM Studio edit",
  {
    skip: LIVE
      ? false
      : "set MINIPHI_LMSTUDIO_INTEGRATION=1 and MINIPHI_CHEETAH_INTEGRATION=1",
    timeout: TIMEOUT_MS,
  },
  async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-cheetah-live-"));
    try {
      const client = new LMStudioRestClient({
        baseUrl: BASE_URL,
        defaultModel: MODEL,
        timeoutMs: 120000,
      });
      const contextEngine = new CheetahContextEngine({
        host: CHEETAH_HOST,
        port: CHEETAH_PORT,
        database: "miniphi_context_live_test",
        sessionId: `live-${Date.now()}`,
        required: true,
        timeoutMs: 5000,
      });
      const events = [];
      const session = new AgentSession({
        client,
        cwd: workspace,
        baseDir: path.join(workspace, ".miniphi"),
        sessionId: `live-cheetah-${Date.now()}`,
        model: MODEL,
        contextEngine,
        contextBudgetTokens: 700,
        maxTurns: 5,
        maxActionsPerTurn: 2,
        approver: createHeadlessApprover({ policy: "allow" }),
        initialResearchQueries: ["fixture Cheetah context token"],
        webResearch: async (query) => ({
          query,
          provider: "fixture",
          results: [
            {
              title: "authoritative context",
              snippet: "CHEETAH_CONTEXT_TOKEN=7419",
            },
          ],
        }),
        sessionDeadline: Date.now() + TIMEOUT_MS - 30000,
      });
      session.on("context-engine", (event) => events.push(event));

      const result = await session.submitTask(
        "Create PROOF.md containing exactly CHEETAH_CONTEXT_TOKEN=7419 from the authoritative context already gathered, then finish.",
        [],
      );
      const proof = await fs
        .readFile(path.join(workspace, "PROOF.md"), "utf8")
        .catch(() => null);
      console.log(
        JSON.stringify(
          {
            stopReason: result.stopReason,
            summary: result.summary,
            edits: result.edits,
            engine: result.context.engine,
            contextEvents: events.map((event) => ({
              turn: event.turn,
              ok: event.ok,
              recalled: event.recalled,
              preferred: event.preferredNodeIds?.length ?? 0,
              fallback: event.fallback ?? null,
            })),
            proof,
          },
          null,
          2,
        ),
      );

      assert.equal(result.status, "completed");
      assert.notEqual(proof, null, "the model must create PROOF.md");
      assert.equal(proof.trim(), "CHEETAH_CONTEXT_TOKEN=7419");
      assert.equal(result.context.engine.engine, "cheetah");
      assert.equal(result.context.engine.available, true);
      assert.equal(result.context.engine.sessionFallbacks, 0);
      assert.ok(result.context.engine.queries >= 1);
      assert.ok(
        events.some((event) => event.ok && event.preferredNodeIds?.length),
        "at least one LM Studio prompt must receive graph-recalled context ids",
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
);
