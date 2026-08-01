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
    this._client = null;
    this._active = 0;
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
      });
    }
    return this._client;
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

    const connection = this._connection();
    await connection.connect();
    const socket = connection.socket;
    this._retain(socket);
    try {
      // The binder's FIFO guarantees each promise resolves with the response to
      // its own command, so writing the batch up front is safe and pipelined.
      return await Promise.all(requested.map((command) => connection.send(command)));
    } finally {
      this._release(socket);
    }
  }

  async resetDatabase() {
    const connection = this._connection();
    await connection.connect();
    const socket = connection.socket;
    this._retain(socket);
    try {
      return await binder.admin.resetDatabase(connection, this.database);
    } finally {
      this._release(socket);
    }
  }

  async putValue(key, payload, options = undefined) {
    const connection = this._connection();
    await connection.connect();
    const socket = connection.socket;
    this._retain(socket);
    try {
      return await binder.kv.putValue(connection, key, payload, options);
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
