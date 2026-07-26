import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import ContextGraph from "../src/libs/context-graph.js";
import {
  CheetahContextEngine,
  CheetahTcpClient,
  createCheetahContextEngineFactory,
  decodeCheetahPayload,
  deriveCheetahDatabaseName,
  deriveCheetahProjectReference,
  parseCheetahResponse,
  resolveCheetahContextConfig,
} from "../src/libs/cheetah-context-engine.js";

const success = (fields = {}) => ({
  ok: true,
  status: "SUCCESS",
  fields,
  raw: `SUCCESS${Object.entries(fields)
    .map(([key, value]) => `,${key}=${value}`)
    .join("")}`,
});

test("Cheetah response parsing preserves base64 padding and decodes JSON payloads", () => {
  const payload = Buffer.from(JSON.stringify({ associations: [{ id: "ctx:c1" }] })).toString(
    "base64",
  );
  const response = parseCheetahResponse(`SUCCESS,count=1,payload=${payload}`);
  assert.equal(response.ok, true);
  assert.equal(response.fields.payload, payload);
  assert.deepEqual(decodeCheetahPayload(response), {
    associations: [{ id: "ctx:c1" }],
  });
});

test("Cheetah context configuration is opt-in and supports environment overrides", () => {
  assert.deepEqual(resolveCheetahContextConfig({}, {}).engine, "memory");

  const config = resolveCheetahContextConfig(
    {
      context: {
        engine: "cheetah",
        cheetah: {
          host: "db.internal",
          port: 4555,
          database: "ctx_dev",
          required: true,
          recallLimit: 12,
        },
      },
    },
    {
      MINIPHI_CHEETAH_HOST: "127.0.0.2",
      MINIPHI_CHEETAH_REQUIRED: "false",
    },
  );
  assert.equal(config.enabled, true);
  assert.equal(config.host, "127.0.0.2");
  assert.equal(config.port, 4555);
  assert.equal(config.database, "ctx_dev");
  assert.equal(config.projectId, null);
  assert.equal(config.required, false);
  assert.equal(config.recallLimit, 12);

  const derived = resolveCheetahContextConfig(
    {
      context: {
        engine: "cheetah",
        cheetah: {},
      },
    },
    {},
  );
  assert.equal(derived.database, null, "the engine derives a project-specific database");
});

test("project-derived databases and graph ids isolate reused session ids", () => {
  const sessionId = "reused-session";
  const first = new CheetahContextEngine({
    sessionId,
    workspaceRoot: "/tmp/miniphi-project-alpha",
  });
  const second = new CheetahContextEngine({
    sessionId,
    workspaceRoot: "/tmp/miniphi-project-beta",
  });

  assert.notEqual(first.projectReference, second.projectReference);
  assert.notEqual(first.client.database, second.client.database);
  assert.equal(first.client.database, deriveCheetahDatabaseName(first.projectReference));
  assert.equal(second.client.database, deriveCheetahDatabaseName(second.projectReference));
  assert.notEqual(first._externalId("c1"), second._externalId("c1"));
  assert.equal(first._localId(second._externalId("c1")), null);
  assert.equal(second._localId(first._externalId("c1")), null);
});

test("explicit shared databases retain project isolation and project ids survive moves", () => {
  const sharedClient = (database) => ({
    host: "fixture",
    port: 4455,
    database,
    async execute() {
      return [];
    },
  });
  const first = new CheetahContextEngine({
    client: sharedClient("shared_context"),
    sessionId: "same-session",
    workspaceRoot: "/tmp/first-project",
  });
  const second = new CheetahContextEngine({
    client: sharedClient("shared_context"),
    sessionId: "same-session",
    workspaceRoot: "/tmp/second-project",
  });
  assert.equal(first.client.database, second.client.database);
  assert.notEqual(first._externalId("c7"), second._externalId("c7"));
  assert.equal(first._localId(second._externalId("c7")), null);

  const stableA = deriveCheetahProjectReference({
    workspaceRoot: "/tmp/old-location",
    projectId: "cekkr/miniphi",
  });
  const stableB = deriveCheetahProjectReference({
    workspaceRoot: "/tmp/new-location",
    projectId: "cekkr/miniphi",
  });
  assert.equal(stableA, stableB);
});

test("the Cheetah engine factory scopes its database to the session workspace", () => {
  const factory = createCheetahContextEngineFactory({
    configData: {
      context: {
        engine: "cheetah",
        cheetah: {},
      },
    },
    env: {},
  });
  const first = factory({ sessionId: "factory-session", cwd: "/tmp/factory-one" });
  const second = factory({ sessionId: "factory-session", cwd: "/tmp/factory-two" });
  assert.notEqual(first.stats().projectReference, second.stats().projectReference);
  assert.notEqual(first.stats().database, second.stats().database);
});

test("CheetahTcpClient selects a database and frames one response per command", async () => {
  const received = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const command = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (command) {
          received.push(command);
          if (command.startsWith("DATABASE ")) {
            socket.write("SUCCESS,database=selected\n");
          } else {
            socket.write(`SUCCESS,echo=${Buffer.from(command).toString("base64")}\n`);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const client = new CheetahTcpClient({
      host: "127.0.0.1",
      port: address.port,
      database: "ctx_test",
      timeoutMs: 1000,
    });
    const responses = await client.execute(["SYSTEM_STATS", "GRAPH_NODE_GET id=x"]);
    assert.equal(responses.length, 2);
    assert.deepEqual(received, [
      "DATABASE ctx_test",
      "SYSTEM_STATS",
      "GRAPH_NODE_GET id=x",
    ]);
    assert.equal(
      Buffer.from(responses[1].fields.echo, "base64").toString("utf8"),
      "GRAPH_NODE_GET id=x",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CheetahContextEngine mirrors layered nodes and recalls local stable ids", async () => {
  const graph = new ContextGraph({ budgetTokens: 500 });
  const mission = graph.add({
    layer: "mission",
    label: "operator task",
    text: "Task: inspect parser",
    kind: "mission",
  });
  const subtask = graph.openSubtask({
    label: "inspect parser",
    text: "find the numeric parser",
  });
  const evidence = graph.add({
    layer: "evidence",
    label: "read_file cli-utils.js",
    text: "export function parseNumericSetting() {}",
    importance: 0.9,
  });
  graph.link(evidence.id, mission.id, "supports");

  const calls = [];
  let engine = null;
  const client = {
    host: "fixture",
    port: 4455,
    database: "fixture",
    async execute(commands) {
      calls.push(commands);
      const recall = commands.find((command) => command.startsWith("GRAPH_RECALL "));
      if (recall) {
        const payload = Buffer.from(
          JSON.stringify({
            associations: [
              { id: engine._externalId(evidence.id), score: 0.9 },
              { id: "another-session:c99", score: 0.8 },
            ],
          }),
        ).toString("base64");
        return [success({ payload })];
      }
      return commands.map((command) =>
        success(
          command.startsWith("GRAPH_EDGE_SET_BATCH")
            ? { requested: 1, applied: 1, failed: 0 }
            : { node_set: 1 },
        ),
      );
    },
  };
  engine = new CheetahContextEngine({
    client,
    sessionId: "session with spaces",
    recallLimit: 8,
  });

  const selection = await engine.select(graph, { focusId: subtask.id });
  assert.equal(selection.ok, true);
  assert.ok(selection.preferredNodeIds.includes(mission.id));
  assert.ok(selection.preferredNodeIds.includes(subtask.id));
  assert.ok(selection.preferredNodeIds.includes(evidence.id));
  assert.equal(selection.preferredNodeIds.includes("c99"), false, "other sessions stay isolated");

  const syncCommands = calls[0];
  assert.equal(
    syncCommands.filter((command) => command.startsWith("GRAPH_NODE_SET ")).length,
    3,
  );
  assert.ok(
    syncCommands.some((command) => command.startsWith("GRAPH_EDGE_SET_BATCH ")),
    "local and structural relations are mirrored as a batch",
  );
  assert.match(calls[1][0], /^GRAPH_RECALL seeds=/);
  assert.match(calls[1][0], /direction=both/);

  const stats = engine.stats();
  assert.equal(stats.available, true);
  assert.equal(stats.queries, 1);
  assert.equal(stats.nodesMirrored, 3);
  assert.equal(stats.recalledNodes, 1);
});

test("optional Cheetah failures fall back without mutating the local graph", async () => {
  const graph = new ContextGraph();
  graph.add({
    layer: "mission",
    label: "task",
    text: "Task: remain local",
    kind: "mission",
  });
  const engine = new CheetahContextEngine({
    client: {
      host: "offline",
      port: 4455,
      database: "fixture",
      async execute() {
        throw new Error("connection refused");
      },
    },
    sessionId: "fallback",
    required: false,
  });

  const before = graph.toJSON();
  const selection = await engine.select(graph);
  assert.equal(selection.ok, false);
  assert.equal(selection.fallback, "memory");
  assert.deepEqual(selection.preferredNodeIds, []);
  assert.deepEqual(graph.toJSON(), before);
  assert.equal(engine.stats().fallbacks, 1);
});

test("Cheetah sync deletes context nodes that were dropped locally", async () => {
  const graph = new ContextGraph();
  graph.add({
    layer: "mission",
    label: "task",
    text: "Task: keep current context only",
    kind: "mission",
  });
  const stale = graph.add({
    layer: "evidence",
    label: "read_file old.js",
    text: "stale source",
  });
  const calls = [];
  const engine = new CheetahContextEngine({
    client: {
      host: "fixture",
      port: 4455,
      database: "fixture",
      async execute(commands) {
        calls.push(commands);
        return commands.map((command) =>
          success(
            command.startsWith("GRAPH_EDGE_SET_BATCH")
              ? { requested: 1, applied: 1, failed: 0 }
              : {},
          ),
        );
      },
    },
    sessionId: "drop-stale-context",
  });

  await engine.sync(graph);
  graph.update(stale.id, { state: "dropped" });
  const result = await engine.sync(graph);

  assert.equal(result.ok, true);
  assert.equal(result.nodesDeleted, 1);
  assert.ok(
    calls[1].some(
      (command) =>
        command === `GRAPH_NODE_DEL id=${engine._externalId(stale.id)} cascade=1`,
    ),
  );
  assert.equal(engine.stats().nodesDeleted, 1);
});

test("a failed recall invalidates mirror fingerprints for server-restart recovery", async () => {
  const graph = new ContextGraph();
  graph.add({
    layer: "mission",
    label: "task",
    text: "Task: recover after restart",
    kind: "mission",
  });
  const calls = [];
  let failRecall = true;
  const engine = new CheetahContextEngine({
    client: {
      host: "fixture",
      port: 4455,
      database: "fixture",
      async execute(commands) {
        calls.push(commands);
        if (commands[0].startsWith("GRAPH_RECALL ")) {
          if (failRecall) {
            failRecall = false;
            return [
              {
                ok: false,
                status: "ERROR",
                fields: {},
                raw: "ERROR,node_not_found",
              },
            ];
          }
          return [
            success({
              payload: Buffer.from(
                JSON.stringify({ associations: [] }),
              ).toString("base64"),
            }),
          ];
        }
        return commands.map(() => success({ node_set: 1 }));
      },
    },
    sessionId: "restart-recovery",
    required: false,
  });

  const first = await engine.select(graph);
  assert.equal(first.ok, false);
  engine._cooldownUntil = 0;
  const second = await engine.select(graph);
  assert.equal(second.ok, true);

  const syncBatches = calls.filter((commands) =>
    commands.some((command) => command.startsWith("GRAPH_NODE_SET ")),
  );
  assert.equal(syncBatches.length, 2, "the node mirror is replayed after recall loses server state");
});
