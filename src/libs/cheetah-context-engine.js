import net from "node:net";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4455;
const DEFAULT_DATABASE = "miniphi_context";
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_RECALL_LIMIT = 32;
const DEFAULT_RECALL_HOPS = 2;
const DEFAULT_RECALL_PRECISION = 0.05;
const DEFAULT_FAILURE_COOLDOWN_MS = 10000;
const MAX_EDGE_BATCH_SIZE = 100;

const toPositiveInteger = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
};

const toBoundedNumber = (value, fallback, min, max) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return fallback;
};

const normalizeDatabase = (value) => {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_DATABASE;
  if (!/^[A-Za-z0-9._-]+$/.test(candidate)) {
    throw new Error(`invalid Cheetah database name "${candidate}"`);
  }
  return candidate;
};

const normalizeOptionalString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const hashReference = (namespace, value) =>
  `${namespace}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20)}`;

/**
 * Returns an opaque, stable project namespace without persisting the workspace
 * path in Cheetah. An explicit project id survives workspace moves; otherwise
 * the canonical workspace path deliberately creates a new namespace.
 */
export function deriveCheetahProjectReference({
  workspaceRoot = process.cwd(),
  projectId = null,
} = {}) {
  const explicit = normalizeOptionalString(projectId);
  if (explicit) {
    return hashReference("p", `project-id\0${explicit}`);
  }
  const resolved = path.resolve(normalizeOptionalString(workspaceRoot) ?? process.cwd());
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // New workspaces may not exist when configuration is assembled. The
    // resolved absolute path is still deterministic and project-specific.
  }
  return hashReference("p", `workspace\0${canonical}`);
}

export function deriveCheetahDatabaseName(projectReference) {
  const reference = normalizeOptionalString(projectReference);
  if (!reference || !/^p_[a-f0-9]{20}$/.test(reference)) {
    throw new Error("a valid Cheetah project reference is required");
  }
  return normalizeDatabase(`${DEFAULT_DATABASE}_${reference}`);
}

const normalizeLabel = (value, fallback = "context") => {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
};

const encodeJSON = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const responseError = (response) =>
  typeof response?.raw === "string" && response.raw.startsWith("ERROR")
    ? response.raw
    : null;

/**
 * Parses Cheetah's one-line protocol without splitting base64 padding on "=".
 */
export function parseCheetahResponse(line) {
  const raw = String(line ?? "").trim();
  const parts = raw.split(",");
  const status = parts.shift() ?? "";
  const fields = {};
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      fields[part] = true;
      continue;
    }
    fields[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return {
    ok: status === "SUCCESS",
    status,
    fields,
    raw,
  };
}

export function decodeCheetahPayload(response) {
  const encoded = response?.fields?.payload;
  if (typeof encoded !== "string" || !encoded) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Minimal bounded TCP client for Cheetah's one-line command protocol.
 *
 * One connection is used per batch. Context synchronization is infrequent
 * compared with model generation, and short-lived connections make timeout and
 * reconnect behavior deterministic when the optional engine is unavailable.
 */
export class CheetahTcpClient {
  constructor(options = undefined) {
    this.host =
      typeof options?.host === "string" && options.host.trim()
        ? options.host.trim()
        : DEFAULT_HOST;
    this.port = toPositiveInteger(options?.port, DEFAULT_PORT);
    this.database = normalizeDatabase(options?.database);
    this.timeoutMs = toPositiveInteger(options?.timeoutMs, DEFAULT_TIMEOUT_MS);
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

    const lines = [`DATABASE ${this.database}`, ...requested];
    const responses = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let buffer = "";
      let settled = false;
      const received = [];
      const finish = (error = null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(received);
        }
      };
      const timer = setTimeout(() => {
        finish(
          new Error(
            `Cheetah request timed out after ${this.timeoutMs}ms (${this.host}:${this.port})`,
          ),
        );
      }, this.timeoutMs);

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${lines.join("\n")}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trimEnd();
          buffer = buffer.slice(newline + 1);
          if (line) {
            received.push(parseCheetahResponse(line));
          }
          if (received.length === lines.length) {
            finish();
            return;
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        if (!settled) {
          finish(
            new Error(
              `Cheetah closed the connection after ${received.length}/${lines.length} response(s)`,
            ),
          );
        }
      });
    });

    const databaseResponse = responses[0];
    if (!databaseResponse?.ok) {
      throw new Error(
        `Cheetah database selection failed: ${databaseResponse?.raw ?? "no response"}`,
      );
    }
    return responses.slice(1);
  }
}

/**
 * Resolves the opt-in context engine configuration. The in-memory graph is the
 * default and remains the deterministic fallback.
 */
export function resolveCheetahContextConfig(configData = undefined, env = process.env) {
  const context = configData?.context && typeof configData.context === "object"
    ? configData.context
    : {};
  const cheetah = context.cheetah && typeof context.cheetah === "object"
    ? context.cheetah
    : {};
  const requestedEngine = String(
    env.MINIPHI_CONTEXT_ENGINE ?? context.engine ?? "memory",
  )
    .trim()
    .toLowerCase();
  const enabled = requestedEngine === "cheetah";
  return {
    engine: enabled ? "cheetah" : "memory",
    enabled,
    host: String(env.MINIPHI_CHEETAH_HOST ?? cheetah.host ?? DEFAULT_HOST).trim() || DEFAULT_HOST,
    port: toPositiveInteger(env.MINIPHI_CHEETAH_PORT ?? cheetah.port, DEFAULT_PORT),
    database:
      normalizeOptionalString(env.MINIPHI_CHEETAH_DATABASE ?? cheetah.database) === null
        ? null
        : normalizeDatabase(env.MINIPHI_CHEETAH_DATABASE ?? cheetah.database),
    projectId: normalizeOptionalString(
      env.MINIPHI_CHEETAH_PROJECT_ID ?? cheetah.projectId,
    ),
    timeoutMs: toPositiveInteger(
      env.MINIPHI_CHEETAH_TIMEOUT_MS ?? cheetah.timeoutMs,
      DEFAULT_TIMEOUT_MS,
    ),
    required: parseBoolean(
      env.MINIPHI_CHEETAH_REQUIRED ?? cheetah.required,
      false,
    ),
    recallLimit: toPositiveInteger(cheetah.recallLimit, DEFAULT_RECALL_LIMIT),
    recallHops: toPositiveInteger(cheetah.recallHops, DEFAULT_RECALL_HOPS),
    recallPrecision: toBoundedNumber(
      cheetah.recallPrecision,
      DEFAULT_RECALL_PRECISION,
      0.001,
      1,
    ),
    failureCooldownMs: toPositiveInteger(
      cheetah.failureCooldownMs,
      DEFAULT_FAILURE_COOLDOWN_MS,
    ),
  };
}

/**
 * Mirrors MiniPhi's layered graph into Cheetah and asks GRAPH_RECALL which
 * nodes should receive an external relevance boost for the next render.
 *
 * The full text stays in ContextGraph and its JSON audit trail. Cheetah stores
 * graph metadata only (stable local id, layer, label, state, importance and
 * turn), which keeps prompts reconstructable even when the optional service is
 * offline.
 */
export class CheetahContextEngine {
  constructor(options = undefined) {
    this.sessionId =
      typeof options?.sessionId === "string" && options.sessionId.trim()
        ? options.sessionId.trim()
        : `agent-${Date.now()}`;
    this.required = Boolean(options?.required);
    this.recallLimit = toPositiveInteger(options?.recallLimit, DEFAULT_RECALL_LIMIT);
    this.recallHops = toPositiveInteger(options?.recallHops, DEFAULT_RECALL_HOPS);
    this.recallPrecision = toBoundedNumber(
      options?.recallPrecision,
      DEFAULT_RECALL_PRECISION,
      0.001,
      1,
    );
    this.failureCooldownMs = toPositiveInteger(
      options?.failureCooldownMs,
      DEFAULT_FAILURE_COOLDOWN_MS,
    );
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.projectReference = deriveCheetahProjectReference({
      workspaceRoot: options?.workspaceRoot,
      projectId: options?.projectId,
    });
    this.sessionReference = hashReference(
      "s",
      `session\0${this.sessionId}`,
    );
    const database = normalizeOptionalString(options?.database)
      ? normalizeDatabase(options.database)
      : deriveCheetahDatabaseName(this.projectReference);
    this.client =
      options?.client ??
      new CheetahTcpClient({
        host: options?.host,
        port: options?.port,
        database,
        timeoutMs: options?.timeoutMs,
      });
    this._nodeFingerprints = new Map();
    this._edgeFingerprints = new Map();
    this._cooldownUntil = 0;
    this._stats = {
      engine: "cheetah",
      required: this.required,
      available: null,
      syncs: 0,
      queries: 0,
      fallbacks: 0,
      nodesMirrored: 0,
      nodesDeleted: 0,
      edgesMirrored: 0,
      recalledNodes: 0,
      lastError: null,
    };
  }

  _externalId(localId) {
    return `miniphi:${this.projectReference}:${this.sessionReference}:${localId}`;
  }

  _localId(externalId) {
    const prefix = `miniphi:${this.projectReference}:${this.sessionReference}:`;
    return typeof externalId === "string" && externalId.startsWith(prefix)
      ? externalId.slice(prefix.length)
      : null;
  }

  _log(message) {
    if (this.logger) {
      this.logger(message);
    }
  }

  _recordFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    this._stats.available = false;
    this._stats.fallbacks += 1;
    this._stats.lastError = message;
    this._cooldownUntil = Date.now() + this.failureCooldownMs;
    this._log(`[CheetahContextEngine] ${message}`);
    if (this.required) {
      throw error instanceof Error ? error : new Error(message);
    }
    return {
      ok: false,
      engine: "cheetah",
      preferredNodeIds: [],
      fallback: "memory",
      error: message,
    };
  }

  _nodeCommand(node) {
    const labels = [
      "miniphi_context",
      `layer_${normalizeLabel(node.layer)}`,
      node.kind ? `kind_${normalizeLabel(node.kind)}` : null,
      `label_${normalizeLabel(node.label)}`,
    ].filter(Boolean);
    const props = encodeJSON({
      local_id: node.id,
      layer: node.layer,
      label: node.label,
      state: node.state,
      importance: node.importance,
      turn: node.turn,
      subtask_id: node.subtaskId ?? null,
      project_reference: this.projectReference,
      session_reference: this.sessionReference,
    });
    return `GRAPH_NODE_SET id=${this._externalId(node.id)} labels=${labels.join(",")} props=${props}`;
  }

  _collectEdges(graph, liveNodes) {
    const edges = [];
    const seen = new Set();
    const add = (from, to, type, weight = 1) => {
      if (!liveNodes.has(from) || !liveNodes.has(to) || from === to) {
        return;
      }
      const key = `${from}\u0000${to}\u0000${type}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      edges.push({
        from: this._externalId(from),
        to: this._externalId(to),
        type: normalizeLabel(type, "related"),
        weight: toBoundedNumber(weight, 1, 0.01, 1),
      });
    };

    for (const edge of graph.edges ?? []) {
      add(edge.from, edge.to, `ctx_${edge.relation}`, 1);
    }

    const mission = [...liveNodes.values()].find((node) => node.kind === "mission");
    for (const node of liveNodes.values()) {
      if (mission && node.id !== mission.id) {
        add(mission.id, node.id, "context_member", node.importance);
      }
      if (node.subtaskId && node.subtaskId !== node.id) {
        add(node.subtaskId, node.id, "subtask_context", node.importance);
      }
      if (node.parentSubtaskId) {
        add(node.parentSubtaskId, node.id, "subtask_child", node.importance);
      }
    }
    return edges;
  }

  async sync(graph) {
    if (!graph?.nodes || typeof graph.nodes.values !== "function") {
      throw new Error("Cheetah context sync requires a ContextGraph");
    }
    if (Date.now() < this._cooldownUntil && !this.required) {
      return {
        ok: false,
        skipped: "cooldown",
        error: this._stats.lastError,
      };
    }

    try {
      const liveNodes = new Map(
        [...graph.nodes.values()]
          .filter((node) => node.state !== "dropped")
          .map((node) => [node.id, node]),
      );
      const deletedNodeIds = [...this._nodeFingerprints.keys()].filter(
        (nodeId) => !liveNodes.has(nodeId),
      );
      const deleteCommands = deletedNodeIds.map(
        (nodeId) => `GRAPH_NODE_DEL id=${this._externalId(nodeId)} cascade=1`,
      );
      const nodeCommands = [];
      for (const node of liveNodes.values()) {
        const fingerprint = JSON.stringify([
          node.layer,
          node.label,
          node.state,
          node.importance,
          node.turn,
          node.subtaskId,
          node.parentSubtaskId,
          node.kind,
        ]);
        if (this._nodeFingerprints.get(node.id) !== fingerprint) {
          nodeCommands.push(this._nodeCommand(node));
          this._nodeFingerprints.set(node.id, fingerprint);
        }
      }

      const changedEdges = [];
      for (const edge of this._collectEdges(graph, liveNodes)) {
        const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
        const fingerprint = JSON.stringify(edge);
        if (this._edgeFingerprints.get(key) !== fingerprint) {
          changedEdges.push(edge);
          this._edgeFingerprints.set(key, fingerprint);
        }
      }

      const commands = [...deleteCommands, ...nodeCommands];
      for (let index = 0; index < changedEdges.length; index += MAX_EDGE_BATCH_SIZE) {
        const batch = changedEdges.slice(index, index + MAX_EDGE_BATCH_SIZE);
        commands.push(
          `GRAPH_EDGE_SET_BATCH items=${encodeJSON(batch)} continue_on_error=1`,
        );
      }
      if (commands.length) {
        const responses = await this.client.execute(commands);
        const failed = responses.find(responseError);
        if (failed) {
          throw new Error(`Cheetah context sync failed: ${failed.raw}`);
        }
        const partialBatch = responses.find(
          (response) => Number(response?.fields?.failed ?? 0) > 0,
        );
        if (partialBatch) {
          throw new Error(`Cheetah context sync partially failed: ${partialBatch.raw}`);
        }
      }
      for (const nodeId of deletedNodeIds) {
        const externalId = this._externalId(nodeId);
        this._nodeFingerprints.delete(nodeId);
        for (const edgeKey of this._edgeFingerprints.keys()) {
          if (edgeKey.includes(`${externalId}\u0000`)) {
            this._edgeFingerprints.delete(edgeKey);
          }
        }
      }

      this._stats.available = true;
      this._stats.lastError = null;
      this._stats.syncs += 1;
      this._stats.nodesMirrored += nodeCommands.length;
      this._stats.nodesDeleted += deletedNodeIds.length;
      this._stats.edgesMirrored += changedEdges.length;
      return {
        ok: true,
        nodesMirrored: nodeCommands.length,
        nodesDeleted: deletedNodeIds.length,
        edgesMirrored: changedEdges.length,
      };
    } catch (error) {
      // A failed batch may have applied only a prefix (Cheetah commands are
      // intentionally non-transactional). Forget fingerprints so the next
      // attempt replays every idempotent upsert instead of assuming it landed.
      this._nodeFingerprints.clear();
      this._edgeFingerprints.clear();
      return this._recordFailure(error);
    }
  }

  _seedNodeIds(graph, focusId = undefined) {
    const live = [...graph.nodes.values()].filter((node) => node.state !== "dropped");
    const mission = live.find((node) => node.kind === "mission");
    const focus = focusId === undefined ? graph.focusId : focusId;
    const seeds = [];
    if (mission) {
      seeds.push(mission.id);
    }
    if (focus && graph.nodes.has(focus) && !seeds.includes(focus)) {
      seeds.push(focus);
    }
    return seeds;
  }

  async recall(graph, { focusId = undefined } = {}) {
    const seeds = this._seedNodeIds(graph, focusId);
    if (!seeds.length) {
      return { ok: true, preferredNodeIds: [] };
    }
    const command = [
      `GRAPH_RECALL seeds=${seeds.map((id) => this._externalId(id)).join(",")}`,
      `hops=${this.recallHops}`,
      `precision=${this.recallPrecision}`,
      `limit=${this.recallLimit}`,
      "direction=both",
      "expand=none",
      "include_seeds=1",
    ].join(" ");
    try {
      const [response] = await this.client.execute([command]);
      if (!response?.ok) {
        throw new Error(`Cheetah context recall failed: ${response?.raw ?? "no response"}`);
      }
      const payload = decodeCheetahPayload(response);
      const recalled = Array.isArray(payload?.associations)
        ? payload.associations
            .map((entry) => this._localId(entry?.id))
            .filter((id) => id && graph.nodes.get(id)?.state !== "dropped")
        : [];
      const preferredNodeIds = [...new Set([...seeds, ...recalled])];
      this._stats.available = true;
      this._stats.lastError = null;
      this._stats.queries += 1;
      this._stats.recalledNodes += recalled.length;
      return {
        ok: true,
        engine: "cheetah",
        preferredNodeIds,
        seeds,
        recalled: recalled.length,
      };
    } catch (error) {
      // The server may have restarted with an empty data directory while this
      // process still holds successful fingerprints. Force the next post-
      // cooldown sync to replay the idempotent mirror before recalling again.
      this._nodeFingerprints.clear();
      this._edgeFingerprints.clear();
      return this._recordFailure(error);
    }
  }

  async select(graph, options = undefined) {
    const synced = await this.sync(graph);
    if (!synced?.ok) {
      return {
        ok: false,
        engine: "cheetah",
        preferredNodeIds: [],
        fallback: "memory",
        error: synced?.error ?? this._stats.lastError,
      };
    }
    return this.recall(graph, options);
  }

  stats() {
    return {
      ...this._stats,
      host: this.client?.host ?? null,
      port: this.client?.port ?? null,
      database: this.client?.database ?? null,
      projectReference: this.projectReference,
      sessionReference: this.sessionReference,
    };
  }
}

export function createCheetahContextEngineFactory({
  configData = undefined,
  env = process.env,
  logger = null,
} = {}) {
  const config = resolveCheetahContextConfig(configData, env);
  if (!config.enabled) {
    return null;
  }
  return ({ sessionId, cwd }) =>
    new CheetahContextEngine({
      ...config,
      sessionId,
      workspaceRoot: cwd,
      logger,
    });
}
