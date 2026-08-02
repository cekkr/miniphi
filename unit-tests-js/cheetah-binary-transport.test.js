import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  CheetahTcpClient,
  binaryProtocol,
  normalizeBinaryTransport,
} from "../src/libs/cheetah-binder.js";
import { resolveCheetahContextConfig } from "../src/libs/cheetah-context-engine.js";
import { resolveKnowledgeLookupConfig } from "../src/libs/cheetah-knowledge-client.js";

const { FRAME, KEY_MODE, KIND, PROTOCOL_VERSION, STATUS, decodeResponse, encodeFrame, readFrame } =
  binaryProtocol;

// --- a byte-wise server, small enough to read ---------------------------------
//
// The real encoder for these two frames lives in the Go server
// (src/binary_protocol.go); the binder only decodes them. So the fixture builds
// an ack and a response body by hand, and the assertion that they are built
// right is that the binder's own decoders accept them.

function shortString(text) {
  const raw = Buffer.from(String(text), "utf8");
  return Buffer.concat([Buffer.from([raw.length]), raw]);
}

function encodeHandshakeAck({ uint = 8, int = 8, float = 8, epoch = 7 } = {}) {
  const head = Buffer.alloc(13);
  head[0] = PROTOCOL_VERSION;
  head[1] = uint;
  head[2] = int;
  head[3] = float;
  head[4] = 0;
  head.writeBigUInt64BE(BigInt(epoch), 5);
  // Zero commands and zero argument keys: a session with an empty index is
  // legal (commands then travel by name), and it keeps the fixture honest about
  // never inventing ids the server did not send.
  const counts = Buffer.alloc(4);
  return encodeFrame(
    FRAME.HANDSHAKE_ACK,
    Buffer.concat([head, shortString("feedfacefeedface"), shortString("0badc0de0badc0de"), counts]),
  );
}

function encodeStringField(key, value) {
  const rawKey = Buffer.from(key, "utf8");
  const rawValue = Buffer.from(value, "utf8");
  const tag = Buffer.alloc(5);
  tag[0] = KIND.STRING << 4;
  tag.writeUInt32BE(rawValue.length, 1);
  return Buffer.concat([
    Buffer.from([KEY_MODE.INLINE, rawKey.length]),
    rawKey,
    tag,
    rawValue,
  ]);
}

function encodeResponseFrame(fields) {
  const entries = Object.entries(fields);
  const head = Buffer.alloc(3);
  head[0] = STATUS.SUCCESS;
  head.writeUInt16BE(entries.length, 1);
  return encodeFrame(
    FRAME.RESPONSE,
    Buffer.concat([head, ...entries.map(([key, value]) => encodeStringField(key, value))]),
  );
}

/**
 * Rebuilds the canonical command line a request frame carries.
 *
 * The argument section of a request is laid out exactly like the field section
 * of a response, so the binder's own `decodeResponse` reads it once a status
 * byte is prepended — which is the point: the fixture asserts what the server
 * would have routed, not what this test guessed the bytes mean.
 */
function requestLine(body) {
  const flags = body[0];
  let at = 1;
  let command;
  if (flags & 0x01) {
    const length = body[at];
    command = body.toString("utf8", at + 1, at + 1 + length);
    at += 1 + length;
  } else {
    command = `#${body.readUInt16BE(at)}`;
    at += 2;
  }
  if (flags & 0x02) {
    const length = body[at];
    command += `:${body.toString("utf8", at + 1, at + 1 + length)}`;
    at += 1 + length;
  }
  const decoded = decodeResponse(
    Buffer.concat([Buffer.from([STATUS.OTHER]), body.subarray(at)]),
  );
  const args = decoded.line.split(",").slice(1);
  return args.length ? `${command} ${args.join(" ")}` : command;
}

async function startBinaryServer({ answerHandshake = true } = {}) {
  const lines = [];
  const firstBytes = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    // One entry per connection: `0xC7` means this socket opened in binary mode.
    let sawFirstByte = false;
    socket.on("data", (chunk) => {
      if (!sawFirstByte) {
        sawFirstByte = true;
        firstBytes.push(chunk[0]);
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (!answerHandshake) {
        // A server built before the byte-wise protocol: it is waiting for a
        // newline, and a handshake frame never contains one.
        let newline = buffer.indexOf(0x0a);
        while (newline >= 0) {
          const line = buffer.toString("latin1", 0, newline).trim();
          buffer = buffer.subarray(newline + 1);
          if (line) {
            lines.push(line);
            socket.write(`SUCCESS,echo=${Buffer.from(line).toString("base64")}\n`);
          }
          newline = buffer.indexOf(0x0a);
        }
        return;
      }
      for (;;) {
        const taken = readFrame(buffer);
        if (!taken) return;
        buffer = Buffer.from(taken.rest);
        if (taken.frame.type === FRAME.HANDSHAKE) {
          socket.write(encodeHandshakeAck());
          continue;
        }
        const line = requestLine(taken.frame.body);
        lines.push(line);
        socket.write(
          encodeResponseFrame({ echo: Buffer.from(line, "utf8").toString("base64") }),
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    lines,
    firstBytes,
    // Destroying live sockets first: `server.close` waits for open connections,
    // so a failed assertion before the client is closed would hang the run
    // instead of reporting itself.
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

// --- transport option normalization -------------------------------------------

test("normalizeBinaryTransport defaults to bytes and understands the config dialects", () => {
  assert.equal(normalizeBinaryTransport(undefined), true);
  assert.equal(normalizeBinaryTransport(null), true);
  assert.equal(normalizeBinaryTransport(""), true);
  assert.equal(normalizeBinaryTransport("unrecognized"), true);
  assert.equal(normalizeBinaryTransport(true), true);
  assert.equal(normalizeBinaryTransport("1"), true);
  assert.equal(normalizeBinaryTransport("binary"), true);
  assert.equal(normalizeBinaryTransport(false), false);
  assert.equal(normalizeBinaryTransport("0"), false);
  assert.equal(normalizeBinaryTransport("off"), false);
  assert.equal(normalizeBinaryTransport("text"), false);
  assert.equal(normalizeBinaryTransport(undefined, false), false);
  // Explicit widths survive; an all-default triple collapses back to `true` so
  // the reported transport stays readable.
  assert.deepEqual(normalizeBinaryTransport({ uint: 4, float: 4 }), { uint: 4, float: 4 });
  assert.equal(normalizeBinaryTransport({ uint: 0, int: 0, float: 0 }), true);
  assert.throws(() => normalizeBinaryTransport({ uint: 3 }), /invalid Cheetah binary uint width/);
});

// --- the transport itself ------------------------------------------------------

test("CheetahTcpClient speaks the byte-wise protocol and reports its session", async () => {
  const server = await startBinaryServer();
  try {
    const client = new CheetahTcpClient({
      host: "127.0.0.1",
      port: server.port,
      database: "ctx_binary",
      timeoutMs: 1000,
    });
    const responses = await client.execute(["SYSTEM_STATS", "GRAPH_NODE_GET id=x"]);
    assert.equal(responses.length, 2);
    assert.deepEqual(server.lines, [
      "DATABASE ctx_binary",
      "SYSTEM_STATS",
      "GRAPH_NODE_GET id=x",
    ]);
    assert.equal(
      Buffer.from(responses[1].fields.echo, "base64").toString("utf8"),
      "GRAPH_NODE_GET id=x",
    );
    // Frames from byte one: this is how the server tells the modes apart.
    assert.deepEqual(server.firstBytes, [0xc7]);

    const status = client.transportStatus();
    assert.equal(status.requested, "binary");
    assert.equal(status.active, "binary");
    assert.equal(status.downgraded, false);
    assert.deepEqual(status.widths, { uint: 8, int: 8, float: 8 });
    assert.equal(status.commandIndexDigest, "feedfacefeedface");
    assert.equal(status.commandIndexEpoch, 7);

    await client.close();
  } finally {
    await server.close();
  }
});

test("CheetahTcpClient keeps the text protocol when binary is turned off", async () => {
  const server = await startBinaryServer({ answerHandshake: false });
  try {
    const client = new CheetahTcpClient({
      host: "127.0.0.1",
      port: server.port,
      database: "ctx_text",
      timeoutMs: 1000,
      binary: false,
    });
    const responses = await client.execute(["SYSTEM_STATS"]);
    assert.equal(responses.length, 1);
    assert.deepEqual(server.lines, ["DATABASE ctx_text", "SYSTEM_STATS"]);
    // Never a frame magic byte: an opted-out client must not probe at all.
    assert.deepEqual(server.firstBytes, ["D".charCodeAt(0)]);
    assert.deepEqual(client.transportStatus(), {
      requested: "text",
      active: "text",
      widths: null,
      commandIndexDigest: null,
      commandIndexEpoch: null,
      indexedCommands: null,
      downgraded: false,
      downgradeReason: null,
    });
    await client.close();
  } finally {
    await server.close();
  }
});

test("CheetahTcpClient degrades to text against a server that cannot handshake", async () => {
  const server = await startBinaryServer({ answerHandshake: false });
  try {
    const client = new CheetahTcpClient({
      host: "127.0.0.1",
      port: server.port,
      database: "ctx_legacy",
      // Short enough that the one handshake timeout this costs stays a test.
      timeoutMs: 300,
    });
    const responses = await client.execute(["SYSTEM_STATS"]);
    assert.equal(responses.length, 1);
    assert.equal(
      Buffer.from(responses[0].fields.echo, "base64").toString("utf8"),
      "SYSTEM_STATS",
    );
    assert.deepEqual(server.lines, ["DATABASE ctx_legacy", "SYSTEM_STATS"]);

    const status = client.transportStatus();
    assert.equal(status.requested, "binary");
    assert.equal(status.active, "text");
    assert.equal(status.downgraded, true);
    assert.match(status.downgradeReason, /binary handshake/i);

    // The downgrade is remembered: a later batch reuses the text connection
    // instead of paying the handshake timeout again.
    await client.execute(["GRAPH_NODE_GET id=y"]);
    assert.deepEqual(server.lines, [
      "DATABASE ctx_legacy",
      "SYSTEM_STATS",
      "GRAPH_NODE_GET id=y",
    ]);
    assert.deepEqual(server.firstBytes, [0xc7, "D".charCodeAt(0)]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a refused connection fails once instead of retrying as text", async () => {
  // Port 1 is not something this process can reach; the failure is about the
  // server, not the transport, so there is nothing to downgrade to.
  const client = new CheetahTcpClient({ host: "127.0.0.1", port: 1, timeoutMs: 300 });
  await assert.rejects(() => client.execute(["SYSTEM_STATS"]));
  assert.equal(client.transportStatus().active, "binary");
  assert.equal(client.transportStatus().downgraded, false);
  await client.close();
});

// --- configuration surfaces ----------------------------------------------------

test("context and knowledge configuration resolve the transport", () => {
  assert.equal(
    resolveCheetahContextConfig({ context: { engine: "cheetah" } }, {}).binary,
    true,
  );
  assert.equal(
    resolveCheetahContextConfig(
      { context: { engine: "cheetah", cheetah: { binary: false } } },
      {},
    ).binary,
    false,
  );
  assert.equal(
    resolveCheetahContextConfig(
      { context: { engine: "cheetah", cheetah: { binary: false } } },
      { MINIPHI_CHEETAH_BINARY: "1" },
    ).binary,
    true,
  );
  assert.deepEqual(
    resolveCheetahContextConfig(
      { context: { engine: "cheetah", cheetah: { binary: { uint: 4, float: 4 } } } },
      {},
    ).binary,
    { uint: 4, float: 4 },
  );

  assert.equal(resolveKnowledgeLookupConfig({ knowledgeLookup: { enabled: true } }, {}).binary, true);
  assert.equal(
    resolveKnowledgeLookupConfig(
      { knowledgeLookup: { enabled: true, cheetah: { binary: "text" } } },
      {},
    ).binary,
    false,
  );
  assert.equal(
    resolveKnowledgeLookupConfig(
      { knowledgeLookup: { enabled: true } },
      { MINIPHI_KNOWLEDGE_BINARY: "0" },
    ).binary,
    false,
  );
});
