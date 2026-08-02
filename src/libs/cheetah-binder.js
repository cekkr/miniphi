import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * MiniPhi's single entry point into the Cheetah Node.js binder that ships with
 * the `thirds/cheetah` submodule (`binders/nodejs`).
 *
 * The binder is the upstream description of the wire protocol — command
 * spellings, base64/`x<hex>` encodings, the traps that fail silently. Keeping
 * exactly one import site here means a submodule bump is the only thing that
 * has to move when the protocol changes, and it is also the one place that has
 * to know the binder is CommonJS while MiniPhi is ESM.
 *
 * MiniPhi-specific policy (project/session namespacing, opt-in configuration,
 * fallback behavior) stays in `cheetah-context-engine.js` and
 * `cheetah-knowledge-client.js`; nothing of that belongs upstream.
 */

const require = createRequire(import.meta.url);
const binderRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../thirds/cheetah/binders/nodejs",
);

const binder = require(binderRoot);

export const CheetahBinderClient = binder.CheetahClient;
export const CheetahBinderError = binder.CheetahError;
export const CheetahBinderConnectionError = binder.CheetahConnectionError;
export const startCheetahServer = binder.startServer;

export const protocol = binder.protocol;
// The byte-wise codec. MiniPhi never encodes a frame by hand — `CheetahClient`
// transcodes the canonical command line for us — but the constants and the
// decoders are how a test fixture stands in for a byte-wise server.
export const binaryProtocol = binder.binary;
export const graphCommands = binder.graph;
export const kvCommands = binder.kv;
export const adminCommands = binder.admin;

export const {
  buildCommand,
  buildKeyValueCommand,
  encodeArgument,
  parseResponse,
  rawArgument,
} = binder.protocol;

export const {
  buildEdgeSet,
  buildEdgeSetBatch,
  buildNeighborTypes,
  buildNeighbors,
  buildNodeDel,
  buildNodeGet,
  buildNodeSet,
  buildRecall,
  encodeJsonArgument,
} = binder.graph;

/**
 * Parses one response line. Re-exported under MiniPhi's historical name so the
 * existing call sites and their tests keep working while the parsing itself
 * comes from upstream.
 */
export function parseCheetahResponse(line) {
  return parseResponse(String(line ?? "").trim());
}

/**
 * Decodes a base64 `payload=` field, or `null`.
 *
 * The binder throws when a payload is not JSON; MiniPhi treats that as "no
 * usable payload" instead, because every Cheetah call here is an optional
 * enrichment whose failure must degrade to the in-memory path rather than
 * abort the turn.
 */
export function decodeCheetahPayload(response) {
  try {
    return binder.protocol.decodePayload(response?.fields) ?? null;
  } catch {
    return null;
  }
}

const toPositiveInteger = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
};

/** Handshake width bytes the binder/server accept; `0` means "server decides". */
const BINARY_WIDTHS = new Set([0, 1, 2, 4, 8]);
const BINARY_WIDTH_KEYS = ["uint", "int", "float"];

const TRUE_STRINGS = new Set(["1", "true", "yes", "on", "enabled", "binary", "bytes"]);
const FALSE_STRINGS = new Set(["0", "false", "no", "off", "disabled", "text", "line"]);

/**
 * Normalizes the transport option into what the binder's `CheetahClient`
 * expects: `false` (newline text), `true` (byte-wise frames, server-chosen
 * numeric widths) or an explicit `{uint, int, float}` width triple.
 *
 * Binary is the default because it is never more expensive and it is transparent
 * above the socket: the binder transcodes the same canonical command line and
 * turns each response frame back into that line, so every command builder here
 * is untouched by the choice and the responses come back byte-identical.
 *
 * Do not expect a large saving on MiniPhi's own graph traffic, though — measured
 * at 0.4% of bytes written and 3.0% of bytes read over a 400-node mirror plus 20
 * recalls. Those commands carry one big base64 `props`/`references` argument,
 * which binary sends as a length-prefixed string exactly as text does; the typed
 * numbers and the 2-byte command index only pay off on numeric/keyed traffic.
 */
export function normalizeBinaryTransport(value, fallback = true) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (TRUE_STRINGS.has(normalized)) {
      return true;
    }
    if (FALSE_STRINGS.has(normalized)) {
      return false;
    }
    return fallback;
  }
  if (typeof value === "object") {
    const widths = {};
    for (const key of BINARY_WIDTH_KEYS) {
      if (value[key] === undefined || value[key] === null) {
        continue;
      }
      const width = Number(value[key]);
      if (!BINARY_WIDTHS.has(width)) {
        throw new Error(
          `invalid Cheetah binary ${key} width "${value[key]}" (expected 0, 1, 2, 4 or 8)`,
        );
      }
      widths[key] = width;
    }
    // An all-default triple is the same request as `true`; keep the simpler
    // shape so the reported transport status stays readable.
    return Object.values(widths).some((width) => width > 0) ? widths : true;
  }
  return fallback;
}

/**
 * True when a connection failure is about the byte-wise transport itself
 * (handshake refused, unsupported protocol version, undecodable frame) rather
 * than about reaching the server at all.
 *
 * The distinction is what keeps the text fallback cheap: a refused TCP connect
 * must fail once and let the caller degrade to the in-memory path, not pay a
 * second full connect timeout re-trying a server that is simply not there.
 */
function isBinaryTransportFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /binary|handshake|frame|unmatched response|unexpected/i.test(message);
}

/**
 * The batch-shaped adapter MiniPhi's Cheetah modules are written against:
 * `execute(commands)` returns one parsed response per command, in order, with
 * the connection's `DATABASE` selection already handled.
 *
 * It sits on the binder's `CheetahClient`, which holds one socket and matches
 * responses to commands by arrival order, so the whole batch is pipelined
 * instead of paying a round trip per command — the mirror step writes one
 * command per changed node, and that used to be its dominant cost.
 *
 * Two deliberate deviations from the binder's defaults:
 *
 * - **No connect retries.** Cheetah is an optional engine here. A refused
 *   connection has to surface inside the caller's own timeout so the turn falls
 *   back to the in-memory graph; a five-attempt backoff would stall a prompt
 *   for seconds to reach the same conclusion.
 * - **The idle socket is unref'd.** A persistent connection otherwise keeps the
 *   Node event loop alive and a finished `miniphi` run would not exit. The
 *   socket is re-ref'd while a batch is in flight, so an in-flight request still
 *   holds the process open.
 * - **The byte-wise transport degrades to text.** MiniPhi speaks to whatever
 *   Cheetah the operator happens to be running, including one built before the
 *   binary protocol existed; such a server never answers the handshake, so the
 *   first connection would otherwise stall for the whole timeout on every
 *   attempt. A transport-shaped connect failure downgrades this client to the
 *   newline protocol for the rest of its life and reconnects immediately, and
 *   `transportStatus()` reports that it happened.
 */
export class CheetahTcpClient {
  constructor(options = undefined) {
    this.host =
      typeof options?.host === "string" && options.host.trim()
        ? options.host.trim()
        : "127.0.0.1";
    this.port = toPositiveInteger(options?.port, 4455);
    this.database = normalizeDatabaseName(options?.database);
    this.timeoutMs = toPositiveInteger(options?.timeoutMs, 2500);
    this.binary = normalizeBinaryTransport(options?.binary);
    this._transport = this.binary ? "binary" : "text";
    this._downgradeReason = null;
    this._session = null;
    this._client = null;
    this._active = 0;
  }

  /**
   * What this client is actually speaking, plus the negotiated session identity
   * when it is speaking bytes. Persisted as run telemetry so a slow or
   * surprising run can be read back against its transport.
   */
  transportStatus() {
    return {
      requested: this.binary ? "binary" : "text",
      active: this._transport,
      widths: this._session?.widths ?? null,
      commandIndexDigest: this._session?.digest ?? null,
      commandIndexEpoch: this._session?.epoch ?? null,
      indexedCommands: this._session?.indexedCommands ?? null,
      downgraded: Boolean(this._downgradeReason),
      downgradeReason: this._downgradeReason,
    };
  }

  _connection() {
    if (!this._client) {
      this._client = new binder.CheetahClient({
        host: this.host,
        port: this.port,
        database: this.database,
        connectTimeoutMs: this.timeoutMs,
        commandTimeoutMs: this.timeoutMs,
        maxReconnectAttempts: 0,
        binary: this._transport === "binary" ? this.binary : false,
      });
    }
    return this._client;
  }

  /**
   * Connects, downgrading to the text protocol once if the byte-wise handshake
   * is what failed. Retrying here is safe precisely because a connect-phase
   * failure means no command was written yet; a frame that fails to decode
   * mid-conversation is handled by `_noteTransportFailure` instead, which only
   * changes what the *next* connection speaks — the batch that saw the error is
   * reported as failed rather than silently replayed, because the server may
   * already have applied it.
   */
  async _ready() {
    const connection = this._connection();
    try {
      await connection.connect();
    } catch (error) {
      if (this._transport !== "binary" || !isBinaryTransportFailure(error)) {
        throw error;
      }
      this._downgradeTransport(error);
      const fallback = this._connection();
      await fallback.connect();
      this._captureSession(fallback);
      return fallback;
    }
    this._captureSession(connection);
    return connection;
  }

  _downgradeTransport(error) {
    this._downgradeReason = error instanceof Error ? error.message : String(error);
    this._transport = "text";
    this._session = null;
    const stale = this._client;
    this._client = null;
    this._active = 0;
    stale?.close?.().catch(() => {});
  }

  _noteTransportFailure(error) {
    if (this._transport === "binary" && isBinaryTransportFailure(error)) {
      this._downgradeTransport(error);
    }
  }

  _captureSession(connection) {
    const session = connection?.binary ?? null;
    this._session = session
      ? {
          widths: { ...session.widths },
          digest: session.digest ?? null,
          epoch: session.epoch ?? null,
          indexedCommands: session.commandIds?.size ?? 0,
        }
      : null;
  }

  async execute(commands) {
    const requested = (Array.isArray(commands) ? commands : [commands])
      .filter((command) => typeof command === "string" && command.trim())
      .map((command) => command.trim());
    if (!requested.length) {
      return [];
    }
    for (const command of requested) {
      if (/[\r\n]/.test(command)) {
        throw new Error("Cheetah commands must contain exactly one line");
      }
    }

    // The binder's FIFO guarantees each promise resolves with the response to
    // its own command, so writing the batch up front is safe and pipelined.
    return this._withConnection((connection) =>
      Promise.all(requested.map((command) => connection.send(command))),
    );
  }

  async resetDatabase() {
    return this._withConnection((connection) =>
      binder.admin.resetDatabase(connection, this.database),
    );
  }

  async putValue(key, payload, options = undefined) {
    return this._withConnection((connection) =>
      binder.kv.putValue(connection, key, payload, options),
    );
  }

  async _withConnection(run) {
    const connection = await this._ready();
    const socket = connection.socket;
    this._retain(socket);
    try {
      return await run(connection);
    } catch (error) {
      this._noteTransportFailure(error);
      throw error;
    } finally {
      this._release(socket);
    }
  }

  _retain(socket) {
    this._active += 1;
    if (this._active === 1) {
      socket?.ref?.();
    }
  }

  _release(socket) {
    this._active = Math.max(0, this._active - 1);
    if (this._active === 0 && socket && !socket.destroyed) {
      socket.unref?.();
    }
  }

  async close() {
    if (this._client) {
      const client = this._client;
      this._client = null;
      this._active = 0;
      await client.close();
    }
  }
}

function normalizeDatabaseName(value) {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : "miniphi_context";
  if (!/^[A-Za-z0-9._-]+$/.test(candidate)) {
    throw new Error(`invalid Cheetah database name "${candidate}"`);
  }
  return candidate;
}

export { normalizeDatabaseName };
