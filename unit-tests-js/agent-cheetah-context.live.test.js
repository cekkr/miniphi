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
 * Cheetah supplies graph-recalled stable node ids plus complete reference
 * sentences; the same session model selects sentence ids with the strict
 * context-reference-selection schema before the agent-action turn.
 *
 * MINIPHI_LMSTUDIO_INTEGRATION=1 \
 * MINIPHI_CHEETAH_INTEGRATION=1 \
 * LMSTUDIO_REST_URL=http://127.0.0.1:1234 \
 * MINIPHI_LIVE_MODEL=qwen/qwen3-4b-thinking-2507 \
 * node --test unit-tests-js/agent-cheetah-context.live.test.js
 */
const LIVE =
  process.env.MINIPHI_LMSTUDIO_INTEGRATION === "1" &&
  process.env.MINIPHI_CHEETAH_INTEGRATION === "1";
const BASE_URL = process.env.LMSTUDIO_REST_URL ?? "http://127.0.0.1:1234";
const MODEL = process.env.MINIPHI_LIVE_MODEL ?? "qwen/qwen3-4b-thinking-2507";
const CHEETAH_HOST = process.env.MINIPHI_CHEETAH_HOST ?? "127.0.0.1";
const CHEETAH_PORT = Number(process.env.MINIPHI_CHEETAH_PORT ?? 4455);
const TIMEOUT_MS = 300000;

test(
  "live: Cheetah recall and the same LM select complete sentences for an edit",
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
      const referenceEvents = [];
      const session = new AgentSession({
        client,
        cwd: workspace,
        baseDir: path.join(workspace, ".miniphi"),
        sessionId: `live-cheetah-${Date.now()}`,
        model: MODEL,
        contextEngine,
        contextBudgetTokens: 700,
        maxTurns: 3,
        maxTurnTokens: 768,
        maxActionsPerTurn: 2,
        contextReferenceTimeoutMs: 60000,
        approver: createHeadlessApprover({ policy: "allow" }),
        initialResearchQueries: ["fixture Cheetah context token"],
        webResearch: async (query) => ({
          query,
          provider: "fixture",
          results: [
            {
              title: "authoritative context",
              snippet: "The authoritative deployment token is CHEETAH_CONTEXT_TOKEN=7419.",
            },
          ],
        }),
        sessionDeadline: Date.now() + TIMEOUT_MS - 30000,
      });
      session.on("context-engine", (event) => events.push(event));
      session.on("context-references", (event) => referenceEvents.push(event));

      const result = await session.submitTask(
        "Create PROOF.md containing exactly the deployment token from the authoritative complete reference sentence already gathered, then finish.",
        [],
      );
      const referenceAudit = JSON.parse(
        await fs.readFile(
          path.join(workspace, ".miniphi", "agent-sessions", session.sessionId, "context-references.json"),
          "utf8",
        ),
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
            referenceEvents,
            referenceSelections: referenceAudit.selections.map((selection) => ({
              model: selection.model,
              candidates: selection.candidates.length,
              selectedReferenceIds: selection.selectedReferenceIds,
              fallback: selection.fallback,
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
      assert.ok(result.context.engine.recalledReferences >= 1);
      assert.ok(result.context.references.selections >= 1);
      assert.ok(
        referenceAudit.selections.some((selection) =>
          selection.candidates.some((candidate) =>
            candidate.sentence.includes("CHEETAH_CONTEXT_TOKEN=7419"),
          ),
        ),
        "the local audit must retain the complete recalled sentence",
      );
      assert.ok(
        referenceAudit.selections.every(
          (selection) =>
            selection.model === MODEL &&
            selection.attempts.every(
              (attempt) =>
                attempt.request.response_format.type === "json_schema" &&
                attempt.request.tool_definitions === null,
            ),
        ),
        "reference composition must use the same model and exact JSON schema",
      );
      assert.ok(
        events.some((event) => event.ok && event.preferredNodeIds?.length),
        "at least one LM Studio prompt must receive graph-recalled context ids",
      );
      assert.ok(
        referenceEvents.some((event) => event.selected > 0),
        "at least one prompt must receive selected complete sentence references",
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
);
