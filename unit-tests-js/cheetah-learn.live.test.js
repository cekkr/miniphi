import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";
import { CheetahTcpClient } from "../src/libs/cheetah-context-engine.js";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import { ensureAskerAnchor } from "../src/libs/cheetah-knowledge-client.js";
import { runTeach, runAsk, runQuestions } from "../src/commands/cheetah-learn.js";

/**
 * Live proof for the "ignorant model" cheetah-learn pipeline: teaches one
 * ad-hoc fact through a real deliberately-small model, asks about it, and
 * confirms the open-question listing round trip, all against a real running
 * `cheetah-server` (see thirds/cheetah AGENTS.md for `go build -o
 * cheetah-server ./src` + `CHEETAH_HEADLESS=1 ./cheetah-server`).
 *
 * Assertions stay structural (types/shapes), not exact content: a 0.5B model
 * is genuinely variable turn to turn (see the "small-model-prompt-engineering"
 * memory) - this test proves the pipeline runs end-to-end without throwing,
 * not that the model answers a specific way.
 *
 * MINIPHI_LMSTUDIO_INTEGRATION=1 \
 * MINIPHI_CHEETAH_INTEGRATION=1 \
 * LMSTUDIO_REST_URL=http://192.168.56.1:1234 \
 * MINIPHI_LIVE_MODEL=qwen2.5-coder-0.5b-instruct \
 * node --test unit-tests-js/cheetah-learn.live.test.js
 */
const LIVE =
  process.env.MINIPHI_LMSTUDIO_INTEGRATION === "1" && process.env.MINIPHI_CHEETAH_INTEGRATION === "1";
const BASE_URL = process.env.LMSTUDIO_REST_URL ?? "http://192.168.56.1:1234";
const MODEL = process.env.MINIPHI_LIVE_MODEL ?? "qwen2.5-coder-0.5b-instruct";
const CHEETAH_HOST = process.env.MINIPHI_CHEETAH_HOST ?? "127.0.0.1";
const CHEETAH_PORT = Number(process.env.MINIPHI_CHEETAH_PORT ?? 4455);
const TIMEOUT_MS = 300000;

test(
  "live: cheetah-learn teaches a fact, recalls it, and lists the resulting open question(s)",
  {
    skip: LIVE ? false : "set MINIPHI_LMSTUDIO_INTEGRATION=1 and MINIPHI_CHEETAH_INTEGRATION=1",
    timeout: TIMEOUT_MS,
  },
  async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cheetah-learn-live-"));
    try {
      const restClient = new LMStudioRestClient({
        baseUrl: BASE_URL,
        defaultModel: MODEL,
        defaultContextLength: 32768,
        timeoutMs: 120000,
      });
      const cheetahClient = new CheetahTcpClient({
        host: CHEETAH_HOST,
        port: CHEETAH_PORT,
        database: `miniphi_knowledge_live_test_${Date.now()}`,
        timeoutMs: 5000,
      });
      const schemaRegistry = new PromptSchemaRegistry();

      await ensureAskerAnchor(cheetahClient);

      const teachOutcome = await runTeach({
        options: { text: "Lisbon is the capital city of Portugal." },
        restClient,
        cheetahClient,
        schemaRegistry,
        modelKey: MODEL,
        verbose: true,
        emitJson: false,
        noSave: true,
      });
      assert.equal(teachOutcome.results.length, 1);
      const taught = teachOutcome.results[0];
      assert.equal(typeof taught.subjectName, "string");
      assert.equal(typeof taught.noNewInformation, "boolean");
      assert.ok(Array.isArray(taught.knownFactsSkipped));
      assert.ok(Number.isInteger(taught.newFactsWritten));

      const askOutcome = await runAsk({
        options: {},
        positionals: ["ask", "What", "do", "you", "know", "about", "Lisbon?"],
        restClient,
        cheetahClient,
        schemaRegistry,
        modelKey: MODEL,
        emitJson: false,
        noSave: true,
      });
      assert.equal(askOutcome.result.question, "What do you know about Lisbon?");
      assert.equal(typeof askOutcome.result.grounded, "boolean");
      assert.equal(typeof askOutcome.result.anchorResolved, "boolean");
      // The load-bearing anti-hallucination invariant, proven live: grounded
      // can only be true when the adapter's own probe actually resolved an
      // anchor - never from the model's self-report alone.
      if (askOutcome.result.grounded) {
        assert.equal(askOutcome.result.anchorResolved, true);
      }

      const questionsOutcome = await runQuestions({
        options: { status: "open" },
        cheetahClient,
        emitJson: true,
      });
      assert.ok(Array.isArray(questionsOutcome.items));
      assert.equal(typeof questionsOutcome.count, "number");
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);
