import test from "node:test";
import assert from "node:assert/strict";
import { retrieveLayeredMemory, retrieveFollowUp } from "../src/libs/cheetah-hippocampus.js";

const payload = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const success = (fields = {}) => ({
  ok: true,
  status: "SUCCESS",
  fields,
  raw: `SUCCESS${Object.entries(fields)
    .map(([key, value]) => `,${key}=${value}`)
    .join("")}`,
});
const failure = (message) => ({ ok: false, status: "ERROR", fields: {}, raw: `ERROR,${message}` });

/**
 * A fake Cheetah that answers by command shape, mirroring the layered write
 * layout: a topic node holding the gist, a passage node holding a detail, and
 * a lexical recall that only finds the passage node.
 */
function layeredCheetahClient({ nodes = {}, spread = [], lexical = [] } = {}) {
  const calls = [];
  return {
    calls,
    async execute(commands) {
      const list = Array.isArray(commands) ? commands : [commands];
      return list.map((command) => {
        calls.push(command);
        if (command.startsWith("GRAPH_NODE_GET")) {
          const id = command.split(" ")[1].replace(/^id=/, "");
          return nodes[id] ? success({ payload: payload(nodes[id]) }) : failure("node_not_found");
        }
        if (command.startsWith("GRAPH_NEIGHBOR_TYPES")) {
          return success({ payload: payload([{ type: "has_passage", count: 1 }]) });
        }
        if (command.startsWith("GRAPH_RECALL")) {
          const isLexical = !command.includes("expand=none");
          return success({
            payload: payload({ associations: isLexical ? lexical : spread, seeds: [] }),
          });
        }
        return success({});
      });
    },
  };
}

const topicNode = {
  id: "topic:hamoshava_stadium",
  labels: ["place"],
  props: { name: "HaMoshava Stadium" },
  references: [
    {
      id: "src-1",
      text: "The HaMoshava Stadium is a football stadium in Petah Tikva, Israel.",
      source: "wikipedia-2021:shard#gist:lead",
    },
  ],
};
const passageAssociation = {
  id: "passage:hamoshava_stadium_p1",
  distance: 1,
  score: 0.8,
  via: [
    { from: "topic:hamoshava_stadium", to: "passage:hamoshava_stadium_p1", type: "has_passage" },
  ],
  references: [
    {
      id: "src-2",
      text: "It was completed in 2011 and is home to both Hapoel Petah Tikva and Maccabi Petah Tikva.",
      source: "wikipedia-2021:shard#detail:lead",
    },
  ],
};

test("retrieveLayeredMemory reaches a detail passage that the anchor node itself does not hold", async () => {
  const client = layeredCheetahClient({
    nodes: { "topic:hamoshava_stadium": topicNode },
    spread: [passageAssociation],
  });
  const memory = await retrieveLayeredMemory(client, {
    question: "When was HaMoshava Stadium completed?",
    subjectHint: "HaMoshava Stadium",
  });
  assert.equal(memory.anchorResolved, true);
  assert.equal(memory.anchors[0].name, "HaMoshava Stadium");
  const texts = memory.passages.map((passage) => passage.text);
  assert.ok(
    texts.some((text) => text.includes("completed in 2011")),
    "the detail passage must be retrieved, not just the gist",
  );
  assert.ok(memory.passages.every((passage) => /^e\d+$/.test(passage.id)));
  assert.ok(memory.relations.some((relation) => relation.type === "has_passage"));
});

test("retrieveLayeredMemory labels the layer each passage came from", async () => {
  const client = layeredCheetahClient({
    nodes: { "topic:hamoshava_stadium": topicNode },
    spread: [passageAssociation],
  });
  const memory = await retrieveLayeredMemory(client, {
    question: "What do you know about HaMoshava Stadium?",
    subjectHint: "HaMoshava Stadium",
  });
  const gist = memory.passages.find((passage) => passage.layer === "gist");
  assert.ok(gist, "the gist layer must be distinguishable for a broad question");
  assert.equal(gist.origin, "direct");
});

test("retrieveLayeredMemory falls back to lexical recall when no id resolves", async () => {
  const client = layeredCheetahClient({
    nodes: {},
    lexical: [passageAssociation],
  });
  const memory = await retrieveLayeredMemory(client, {
    question: "Which stadium is home to Maccabi Petah Tikva?",
  });
  assert.equal(memory.anchorResolved, false);
  assert.equal(memory.resolved, true, "lexical reinstatement must still produce evidence");
  assert.ok(memory.passages.some((passage) => passage.origin === "lexical"));
  assert.ok(client.calls.some((command) => command.startsWith("GRAPH_RECALL")));
});

test("retrieveLayeredMemory records every command and decoded response for auditing", async () => {
  const client = layeredCheetahClient({
    nodes: { "topic:hamoshava_stadium": topicNode },
    spread: [passageAssociation],
  });
  const trace = [];
  await retrieveLayeredMemory(client, {
    question: "When was HaMoshava Stadium completed?",
    subjectHint: "HaMoshava Stadium",
    trace,
  });
  assert.ok(trace.length >= 3);
  assert.ok(trace.every((entry) => typeof entry.command === "string" && entry.command.length));
  assert.ok(trace.some((entry) => entry.stage === "anchor"));
  assert.ok(trace.some((entry) => entry.stage === "spread"));
  // The base64 payload must never be pasted into the trace verbatim.
  assert.ok(trace.every((entry) => !/payload=[A-Za-z0-9+/=]{40,}/.test(entry.response)));
});

test("retrieveFollowUp fetches what the model asked for and drops what it already saw", async () => {
  const client = layeredCheetahClient({
    nodes: {
      "topic:petah_tikva": {
        id: "topic:petah_tikva",
        props: { name: "Petah Tikva" },
        references: [{ id: "src-1", text: "Petah Tikva is a city in the Central District of Israel." }],
      },
    },
  });
  const trace = [];
  const result = await retrieveFollowUp(client, {
    lookups: [{ kind: "subject", value: "Petah Tikva", why: "need the city" }],
    question: "What district is HaMoshava Stadium's city in?",
    knownTexts: ["The HaMoshava Stadium is a football stadium in Petah Tikva, Israel."],
    trace,
  });
  assert.equal(result.requested[0], "Petah Tikva");
  assert.ok(result.passages.some((passage) => passage.text.includes("Central District")));
  assert.ok(trace.some((entry) => entry.stage === "follow_up_anchor"));
});
