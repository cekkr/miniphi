import test from "node:test";
import assert from "node:assert/strict";
import {
  ASKER_ID,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_DATABASE,
  DEFAULT_KNOWLEDGE_LOOKUP_TIMEOUT_MS,
  slugify,
  topicId,
  entityId,
  encodeProps,
  sanitizeForInsert,
  ensureAskerAnchor,
  logEpisode,
  probeBeforeWrite,
  writeFacts,
  recallAnchorFacts,
  recordOpenQuestion,
  resolveOpenQuestion,
  listOpenQuestions,
  resolveKnowledgeLookupConfig,
  createKnowledgeLookupAction,
} from "../src/libs/cheetah-knowledge-client.js";

function decodePayload(response) {
  const encoded = response?.fields?.payload;
  if (!encoded) return null;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

const success = (fields = {}) => ({
  ok: true,
  status: "SUCCESS",
  fields,
  raw: `SUCCESS${Object.entries(fields).map(([k, v]) => `,${k}=${v}`).join("")}`,
});
const failure = (message) => ({ ok: false, status: "ERROR", fields: {}, raw: `ERROR,${message}` });
const payloadField = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

// A fake CheetahTcpClient: records every command it was asked to execute and
// answers from a caller-supplied handler, exactly like the fixture pattern
// already used for CheetahContextEngine tests (a plain object with
// `execute()` — no real socket needed).
function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async execute(commands) {
      const list = Array.isArray(commands) ? commands : [commands];
      const responses = [];
      for (const command of list) {
        calls.push(command);
        responses.push(await handler(command, calls.length - 1));
      }
      return responses;
    },
  };
}

test("slugify/topicId/entityId normalize names into stable, opaque ids", () => {
  assert.equal(slugify("Café Münich"), "cafe_munich");
  assert.equal(topicId("Albert Einstein"), "topic:albert_einstein");
  assert.equal(entityId("place", "Berlin"), "place:berlin");
  assert.equal(slugify(""), "unknown");
});

test("sanitizeForInsert collapses newlines/tabs so the one-line protocol stays intact", () => {
  assert.equal(sanitizeForInsert("line1\nline2\ttab  space"), "line1 line2 tab space");
});

test("ensureAskerAnchor upserts the fixed agent node", async () => {
  const client = fakeClient((command) => {
    assert.match(command, new RegExp(`^GRAPH_NODE_SET id=${ASKER_ID} labels=agent$`));
    return success({ node_set: true, id: ASKER_ID });
  });
  const result = await ensureAskerAnchor(client);
  assert.equal(result.id, ASKER_ID);
});

test("logEpisode captures the INSERT key from the response, never a client-side counter", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) {
      assert.match(command, /^INSERT:\d+ My cat is a female siamese\.$/);
      return success({ key: "42" });
    }
    assert.match(command, /^PAIR_SET episode:\d+T\d+Z\/000007 42$/);
    return success({ pair_set: true });
  });
  const result = await logEpisode(client, "My cat is a female siamese.\n", { sequence: 7 });
  assert.equal(result.insertKey, "42");
  assert.match(result.episodePairKey, /^episode:.+\/000007$/);
  assert.equal(result.text, "My cat is a female siamese.");
});

test("logEpisode throws when INSERT does not return a key", async () => {
  const client = fakeClient(() => success({}));
  await assert.rejects(() => logEpisode(client, "text"), /did not return a key/);
});

test("probeBeforeWrite treats a missing/erroring node as a cheap, legitimate 'not known yet' answer", async () => {
  const missingClient = fakeClient(() => failure("node_not_found"));
  const missing = await probeBeforeWrite(missingClient, "topic:new_thing");
  assert.deepEqual(missing, { exists: false, relationHistogram: [] });

  const knownClient = fakeClient(() =>
    success({ count: 1, payload: payloadField([{ type: "located_in", count: 1 }]) }),
  );
  const known = await probeBeforeWrite(knownClient, "topic:paris");
  assert.equal(known.exists, true);
  assert.equal(known.relationHistogram.length, 1);
});

test("writeFacts upserts the subject/object nodes and batches edges with provenance", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) {
      assert.match(command, /^GRAPH_NODE_SET id=topic:springfield labels=place /);
      return success({ node_set: true });
    }
    if (index === 1) {
      assert.match(command, /^GRAPH_NODE_SET id=place:illinois labels=place /);
      return success({ node_set: true });
    }
    assert.match(command, /^GRAPH_EDGE_SET_BATCH items=/);
    const base64 = command.match(/items=([^\s]+)/)[1];
    const items = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    assert.equal(items.length, 1);
    assert.equal(items[0].from, "topic:springfield");
    assert.equal(items[0].to, "place:illinois");
    assert.equal(items[0].type, "located_in");
    assert.equal(items[0].props.src, "42");
    return success({ requested: 1, applied: 1, created: 1, updated: 0, failed: 0 });
  });

  const result = await writeFacts(client, {
    subjectId: "topic:springfield",
    subjectType: "place",
    subjectName: "Springfield",
    snippetText: "Springfield is a city in Illinois.",
    insertKey: "42",
    newFacts: [{ relation: "located_in", object_name: "Illinois", object_type: "place" }],
  });
  assert.equal(result.applied, 1);
  assert.equal(result.created, 1);
  assert.equal(result.edgeCount, 1);
});

test("writeFacts skips facts with no object_name and dedupes repeated objects", async () => {
  const client = fakeClient((command, index) => {
    if (index <= 1) return success({});
    const base64 = command.match(/items=([^\s]+)/)[1];
    const items = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    assert.equal(items.length, 2, "two edges to the same deduped object node");
    return success({ requested: 2, applied: 2, created: 1, updated: 1, failed: 0 });
  });
  const result = await writeFacts(client, {
    subjectId: "topic:x",
    subjectType: "other",
    subjectName: "X",
    snippetText: "",
    insertKey: "1",
    newFacts: [
      { relation: "likes", object_name: "  ", object_type: "other" },
      { relation: "located_in", object_name: "Illinois", object_type: "place" },
      { relation: "has_capital", object_name: "Illinois", object_type: "place" },
    ],
  });
  assert.equal(result.edgeCount, 2);
});

test("recallAnchorFacts follows GRAPH_NODE_GET -> GRAPH_NEIGHBOR_TYPES -> GRAPH_RECALL when the anchor exists", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) {
      assert.match(command, /^GRAPH_NODE_GET id=topic:springfield$/);
      return success({ id: "topic:springfield", payload: payloadField({ props: { name: "Springfield" } }) });
    }
    if (index === 1) {
      assert.match(command, /^GRAPH_NEIGHBOR_TYPES id=topic:springfield /);
      return success({ count: 1, payload: payloadField([{ type: "located_in", count: 1 }]) });
    }
    assert.match(command, /^GRAPH_RECALL seeds=topic:springfield /);
    return success({
      payload: payloadField({ associations: [{ id: "place:illinois", score: 0.9, via: [{ type: "located_in" }] }] }),
    });
  });
  const result = await recallAnchorFacts(client, { subjectName: "Springfield" });
  assert.equal(result.resolved, true);
  assert.equal(result.via, "direct");
  assert.equal(result.facts.length, 1);
});

test("recallAnchorFacts returns a legitimate empty histogram result without a recall call", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) {
      return success({ id: "topic:x", payload: payloadField({ props: {} }) });
    }
    assert.match(command, /^GRAPH_NEIGHBOR_TYPES/);
    return success({ count: 0, payload: payloadField([]) });
  });
  const result = await recallAnchorFacts(client, { subjectName: "X" });
  assert.equal(result.resolved, true);
  assert.equal(result.facts.length, 0);
});

test("recallAnchorFacts falls back to free-text GRAPH_RECALL when the exact anchor id is not found", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) {
      assert.match(command, /^GRAPH_NODE_GET id=topic:unknown_city$/);
      return failure("node_not_found");
    }
    assert.match(command, /^GRAPH_RECALL seeds=unknown,city /);
    assert.doesNotMatch(command, /expand=/);
    return success({
      payload: payloadField({
        seeds: [{ term: "unknown", matches: [{ id: "city:unknown_city", score: 0.4 }] }],
        associations: [{ id: "city:unknown_city", score: 0.4 }],
      }),
    });
  });
  const result = await recallAnchorFacts(client, { subjectName: "Unknown City" });
  assert.equal(result.resolved, true);
  assert.equal(result.via, "recall");
  assert.equal(result.nodeId, "city:unknown_city");
});

test("recallAnchorFacts reports unresolved when neither the anchor nor free-text recall find anything", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) return failure("node_not_found");
    return success({ payload: payloadField({ associations: [], seeds: [] }) });
  });
  const result = await recallAnchorFacts(client, { subjectName: "Totally Obscure Thing" });
  assert.equal(result.resolved, false);
});

test("recordOpenQuestion writes a hypothesis node and an unsure_about edge from the fixed asker anchor", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) {
      assert.match(command, /^GRAPH_NODE_SET id=hypothesis:.+ labels=hypothesis props=/);
      return success({ node_set: true });
    }
    assert.match(command, new RegExp(`^GRAPH_EDGE_SET from=${ASKER_ID} to=hypothesis:.+ type=unsure_about`));
    return success({ edge_set: true });
  });
  const result = await recordOpenQuestion(client, { questionText: "What is the capital of Elbonia?" });
  assert.match(result.hypothesisId, /^hypothesis:/);
});

test("resolveOpenQuestion merges existing props and flips status open -> resolved without deleting the edge", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) {
      assert.match(command, /^GRAPH_NODE_GET id=hypothesis:x$/);
      return success({ payload: payloadField({ props: { question: "Q?", status: "open" } }) });
    }
    if (index === 1) {
      assert.match(command, /^GRAPH_NODE_SET id=hypothesis:x props=/);
      const base64 = command.match(/props=([^\s]+)/)[1];
      const props = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
      assert.equal(props.question, "Q?", "existing props are preserved, not wiped");
      assert.equal(props.status, "resolved");
      return success({ node_set: true });
    }
    assert.match(command, new RegExp(`^GRAPH_EDGE_SET from=${ASKER_ID} to=hypothesis:x type=unsure_about`));
    return success({ edge_set: true });
  });
  const result = await resolveOpenQuestion(client, "hypothesis:x");
  assert.equal(result.status, "resolved");
});

test("listOpenQuestions filters by status client-side and passes through the cursor", async () => {
  const client = fakeClient((command) => {
    assert.match(command, new RegExp(`^GRAPH_NEIGHBORS id=${ASKER_ID} direction=out type=unsure_about limit=20$`));
    return success({
      count: 2,
      next_cursor: "*",
      payload: payloadField([
        { to: "hypothesis:a", props: { question: "A?", status: "open" } },
        { to: "hypothesis:b", props: { question: "B?", status: "resolved" } },
      ]),
    });
  });
  const openResult = await listOpenQuestions(client, { status: "open", limit: 20 });
  assert.equal(openResult.count, 1);
  assert.equal(openResult.items[0].hypothesisId, "hypothesis:a");
  assert.equal(openResult.nextCursor, "*");
});

test("resolveKnowledgeLookupConfig is opt-in and off by default (no reachability-probe cost for a normal run)", () => {
  const defaults = resolveKnowledgeLookupConfig({}, {});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.host, DEFAULT_HOST);
  assert.equal(defaults.port, DEFAULT_PORT);
  assert.equal(defaults.database, DEFAULT_DATABASE);
  assert.equal(defaults.timeoutMs, DEFAULT_KNOWLEDGE_LOOKUP_TIMEOUT_MS);
});

test("resolveKnowledgeLookupConfig reads config.json and env overrides", () => {
  const fromConfig = resolveKnowledgeLookupConfig(
    {
      knowledgeLookup: {
        enabled: true,
        cheetah: { host: "10.0.0.5", port: 5455, database: "custom_knowledge", timeoutMs: 3000 },
      },
    },
    {},
  );
  assert.equal(fromConfig.enabled, true);
  assert.equal(fromConfig.host, "10.0.0.5");
  assert.equal(fromConfig.port, 5455);
  assert.equal(fromConfig.database, "custom_knowledge");
  assert.equal(fromConfig.timeoutMs, 3000);

  const fromEnv = resolveKnowledgeLookupConfig(
    {},
    {
      MINIPHI_KNOWLEDGE_LOOKUP: "1",
      MINIPHI_KNOWLEDGE_HOST: "192.168.56.1",
      MINIPHI_KNOWLEDGE_PORT: "4999",
      MINIPHI_KNOWLEDGE_DATABASE: "env_knowledge",
    },
  );
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.host, "192.168.56.1");
  assert.equal(fromEnv.port, 4999);
  assert.equal(fromEnv.database, "env_knowledge");

  assert.equal(
    resolveKnowledgeLookupConfig({ knowledgeLookup: { enabled: false } }, { MINIPHI_KNOWLEDGE_LOOKUP: "false" })
      .enabled,
    false,
  );
});

test("createKnowledgeLookupAction returns null without a cheetahClient (mirrors createVisionReviewAction)", () => {
  assert.equal(createKnowledgeLookupAction({}), null);
  assert.equal(createKnowledgeLookupAction(), null);
});

test("createKnowledgeLookupAction resolves {ok:true, response} on success", async () => {
  const client = fakeClient((command, index) => {
    if (index === 0) {
      return success({ payload: payloadField({ props: { name: "Springfield" } }) });
    }
    return success({ payload: payloadField([]) });
  });
  const action = createKnowledgeLookupAction({ cheetahClient: client });
  const result = await action({ subject: "Springfield" });
  assert.equal(result.ok, true);
  assert.equal(result.response.resolved, true);
  assert.equal(result.response.nodeId, "topic:springfield");
});

test("createKnowledgeLookupAction resolves {ok:false, error} instead of throwing when Cheetah fails", async () => {
  const client = { async execute() { throw new Error("Cheetah closed the connection"); } };
  const action = createKnowledgeLookupAction({ cheetahClient: client });
  const result = await action({ subject: "Springfield" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Cheetah closed the connection/);
});
