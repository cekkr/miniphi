import fs from "fs";
import path from "path";
import LMStudioHandler from "./lmstudio-handler.js";
import {
  QLearningRouter,
  buildActionKey,
  durationBucket,
  featurizeObservation,
  normalizeToken,
  normalizeSchemaId,
  sizeBucket,
} from "./rl-router.js";

const DEFAULT_PROFILE_ID = "default";
const DEFAULT_MAX_STEPS = 6;
const DEFAULT_SAVE_INTERVAL_MS = 15000;

const DEFAULT_REWARD = {
  successReward: 1.0,
  failurePenalty: -1.5,
  schemaPenalty: -0.5,
  followUpPenalty: -0.2,
  scoreWeight: 0.01,
  stepPenalty: 0.1,
  defaultModelCost: 1.0,
  modelCosts: {},
};

function normalizeProfiles(raw) {
  const profiles = [];
  const pushProfile = (entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const id = typeof entry.id === "string" && entry.id.trim()
      ? entry.id.trim()
      : DEFAULT_PROFILE_ID;
    profiles.push({
      id,
      label: typeof entry.label === "string" ? entry.label.trim() : id,
      prefix: typeof entry.prefix === "string" ? entry.prefix : "",
      suffix: typeof entry.suffix === "string" ? entry.suffix : "",
    });
  };

  if (Array.isArray(raw)) {
    raw.forEach(pushProfile);
  } else if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([id, entry]) => {
      pushProfile({ id, ...(entry ?? {}) });
    });
  }

  if (!profiles.length) {
    profiles.push({ id: DEFAULT_PROFILE_ID, label: "Default", prefix: "", suffix: "" });
  }
  return profiles;
}

function normalizeModels(raw, fallbackModel) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set();
  const normalized = [];
  for (const entry of list) {
    if (!entry) continue;
    const trimmed = String(entry).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  if (!normalized.length && fallbackModel) {
    normalized.push(fallbackModel);
  }
  return normalized;
}

function normalizeRewardConfig(raw) {
  const reward = { ...DEFAULT_REWARD };
  if (!raw || typeof raw !== "object") {
    return reward;
  }
  for (const key of Object.keys(DEFAULT_REWARD)) {
    if (key === "modelCosts") {
      const modelCosts = raw.modelCosts;
      reward.modelCosts =
        modelCosts && typeof modelCosts === "object" ? { ...modelCosts } : reward.modelCosts;
      continue;
    }
    if (Number.isFinite(raw[key])) {
      reward[key] = Number(raw[key]);
    }
  }
  return reward;
}

function classifyErrorKind(message) {
  if (!message || typeof message !== "string") {
    return "other";
  }
  const lower = message.toLowerCase();
  if (lower.includes("schema")) return "schema";
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("exceeded")) {
    return "timeout";
  }
  if (lower.includes("protocol")) return "protocol";
  if (lower.includes("stream") || lower.includes("hang")) return "stream";
  if (lower.includes("transport") || lower.includes("rest") || lower.includes("ws")) {
    return "transport";
  }
  if (lower.includes("empty response") || lower.includes("returned an empty")) return "empty";
  return "other";
}

function normalizeFlag(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function resolveFollowUpNeeded(performance) {
  if (typeof performance?.followUpNeeded === "boolean") {
    return performance.followUpNeeded;
  }
  if (typeof performance?.evaluation?.follow_up_needed === "boolean") {
    return performance.evaluation.follow_up_needed;
  }
  if (typeof performance?.evaluation?.needs_more_context === "boolean") {
    return performance.evaluation.needs_more_context;
  }
  return null;
}

function resolveMode(traceOptions, schemaId) {
  const modeRaw = traceOptions?.metadata?.mode ?? null;
  if (modeRaw) {
    return normalizeToken(modeRaw, "unknown");
  }
  const schema = normalizeSchemaId(schemaId);
  if (schema.includes("log-analysis")) return "analysis";
  if (schema.includes("prompt-plan")) return "plan";
  if (schema.includes("navigation-plan")) return "navigation";
  if (schema.includes("recompose")) return "recompose";
  return "unknown";
}

function applyPromptProfile(prompt, profile) {
  const prefix = profile?.prefix?.trim() ?? "";
  const suffix = profile?.suffix?.trim() ?? "";
  if (!prefix && !suffix) {
    return prompt;
  }
  const parts = [];
  if (prefix) parts.push(prefix);
  parts.push(prompt);
  if (suffix) parts.push(suffix);
  return parts.join("\n\n");
}

export default class AdaptiveLMStudioHandler {
  constructor(manager, options = undefined) {
    this.manager = manager;
    this.systemPrompt = options?.systemPrompt;
    this.promptTimeoutMs = options?.promptTimeoutMs ?? null;
    this.noTokenTimeoutMs = options?.noTokenTimeoutMs ?? null;
    this.schemaRegistry = options?.schemaRegistry ?? null;
    this.restClient = options?.restClient ?? null;
    this.preferRestTransport = Boolean(options?.preferRestTransport);
    this.executionRegister = null;
    this.executionContext = null;
    this.learnEnabled = options?.learnEnabled !== false;
    this.maxSteps =
      Number.isFinite(options?.maxSteps) && options.maxSteps > 0
        ? options.maxSteps
        : DEFAULT_MAX_STEPS;
    this.saveIntervalMs =
      Number.isFinite(options?.saveIntervalMs) && options.saveIntervalMs > 0
        ? options.saveIntervalMs
        : DEFAULT_SAVE_INTERVAL_MS;
    this.lastSaveAt = 0;
    this.pendingSave = null;
    this.lastPromptExchange = null;
    this.lastPerformanceSummary = null;
    this.stepCount = 0;
    this.lastStatus = "unknown";
    this.lastErrorKind = "none";
    this.lastSchemaValid = "unknown";
    this.lastFollowUpNeeded = "unknown";
    this.lastDurationMs = null;
    this.sharedHistory = null;
    this.loadOptions = null;
    this.handlers = new Map();

    const fallbackModel = options?.defaultModelKey ?? null;
    this.modelKeys = normalizeModels(options?.modelKeys, fallbackModel);
    this.modelKey = this.modelKeys[0] ?? fallbackModel ?? null;

    this.profiles = normalizeProfiles(options?.promptProfiles);
    this.profileMap = new Map(this.profiles.map((profile) => [profile.id, profile]));
    this.defaultProfileId = this.profiles[0]?.id ?? DEFAULT_PROFILE_ID;

    this.actionEntries = this._buildActionEntries();
    this.router = this._loadRouterState(options?.routerStatePath, options?.routerConfig);
  }

  setPromptRecorder(recorder) {
    this._forEachHandler((handler) => handler.setPromptRecorder(recorder));
  }

  setExecutionRegister(register, context = undefined) {
    this.executionRegister = register ?? null;
    this.executionContext = context ?? null;
    this._forEachHandler((handler) => {
      if (typeof handler.setExecutionRegister === "function") {
        handler.setExecutionRegister(this.executionRegister, this.executionContext);
      }
    });
  }

  setPerformanceTracker(tracker) {
    this._forEachHandler((handler) => handler.setPerformanceTracker(tracker));
  }

  setSchemaRegistry(registry) {
    this.schemaRegistry = registry ?? null;
    this._forEachHandler((handler) => handler.setSchemaRegistry(registry));
  }

  setRestClient(restClient, options = undefined) {
    this.restClient = restClient ?? null;
    if (typeof options?.preferRestTransport === "boolean") {
      this.preferRestTransport = options.preferRestTransport;
    }
    this._forEachHandler((handler) =>
      handler.setRestClient(restClient, { preferRestTransport: this.preferRestTransport }),
    );
  }

  setNoTokenTimeout(timeoutMs, options = undefined) {
    this.noTokenTimeoutMs = timeoutMs;
    this._forEachHandler((handler) => handler.setNoTokenTimeout(timeoutMs, options));
  }

  setPromptTimeout(timeoutMs, options = undefined) {
    this.promptTimeoutMs = timeoutMs;
    this._forEachHandler((handler) => handler.setPromptTimeout(timeoutMs, options));
  }

  async load(options = undefined) {
    this.loadOptions = options ?? null;
    if (!this.modelKey) {
      return;
    }
    const handler = this._getHandler(this.modelKey);
    if (handler) {
      await handler.load(options);
    }
  }

  async eject() {
    await Promise.allSettled(
      Array.from(this.handlers.values()).map((handler) => handler.eject()),
    );
    await this._flushRouterSave();
    this.sharedHistory = null;
  }

  clearHistory() {
    this.sharedHistory = null;
    this.stepCount = 0;
    this.lastStatus = "unknown";
    this.lastErrorKind = "none";
    this.lastSchemaValid = "unknown";
    this.lastFollowUpNeeded = "unknown";
    this.lastDurationMs = null;
    this._forEachHandler((handler) => handler.clearHistory());
  }

  getHistory() {
    if (this.sharedHistory) {
      return this.sharedHistory.map((entry) => ({ ...entry }));
    }
    const handler = this._getHandler(this.modelKey);
    return handler ? handler.getHistory() : [];
  }

  setHistory(history) {
    this.sharedHistory = Array.isArray(history) ? history.map((entry) => ({ ...entry })) : null;
    if (this.sharedHistory && this.sharedHistory.length <= 1) {
      this.stepCount = 0;
    }
    this._forEachHandler((handler) => handler.setHistory(history));
  }

  getLastPromptExchange() {
    return this.lastPromptExchange;
  }

  consumeLastPromptExchange() {
    const exchange = this.lastPromptExchange;
    this.lastPromptExchange = null;
    return exchange;
  }

  getLastPerformanceSummary() {
    return this.lastPerformanceSummary;
  }

  consumeLastPerformanceSummary() {
    const summary = this.lastPerformanceSummary;
    this.lastPerformanceSummary = null;
    return summary;
  }

  async getContextWindow() {
    const handler = this._getHandler(this.modelKey);
    return handler ? handler.getContextWindow() : null;
  }

  async chatStream(prompt, onToken, onThink, onError, traceOptions = undefined) {
    const obs = this._buildObservation(prompt, traceOptions);
    const actionKey = this.router.chooseAction(obs) ?? this.actionEntries[0]?.actionKey ?? null;
    const action = this.actionEntries.find((entry) => entry.actionKey === actionKey) ?? null;
    const modelKey = action?.modelKey ?? this.modelKey ?? null;
    const profile = this.profileMap.get(action?.profileId ?? this.defaultProfileId);
    const handler = modelKey ? this._getHandler(modelKey) : null;

    if (!handler) {
      throw new Error("Adaptive router has no available model handler.");
    }

    this.modelKey = modelKey;
    await this._ensureLoaded(handler);
    this._syncHistoryToHandler(handler);

    const routedPrompt = applyPromptProfile(prompt, profile);
    const routedTrace = this._buildTraceOptions(traceOptions, {
      actionKey,
      modelKey,
      profileId: profile?.id ?? this.defaultProfileId,
      state: featurizeObservation(obs),
    });

    let result = "";
    let errorMessage = null;
    try {
      result = await handler.chatStream(routedPrompt, onToken, onThink, onError, routedTrace);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      this._updateAfterPrompt({
        handler,
        obs,
        actionKey,
        errorMessage,
      });
      throw error;
    }

    this._updateAfterPrompt({
      handler,
      obs,
      actionKey,
      errorMessage: null,
    });

    return result;
  }

  _buildObservation(prompt, traceOptions) {
    const schemaId = traceOptions?.schemaId ?? traceOptions?.metadata?.schemaId ?? null;
    const mode = resolveMode(traceOptions, schemaId);
    const size = sizeBucket(prompt?.length ?? 0);
    const scope = traceOptions?.scope === "main" ? "main" : traceOptions?.scope === "sub" ? "sub" : "unknown";
    return {
      mode,
      schemaId,
      step: this.stepCount + 1,
      lastStatus: this.lastStatus,
      lastErrorKind: this.lastErrorKind,
      sizeBucket: size,
      scope,
      lastSchemaValid: this.lastSchemaValid,
      lastFollowUpNeeded: this.lastFollowUpNeeded,
      lastDurationBucket: durationBucket(this.lastDurationMs),
    };
  }

  _buildTraceOptions(traceOptions, routingDetails) {
    const metadata = { ...(traceOptions?.metadata ?? {}) };
    metadata.routing = {
      model: routingDetails.modelKey ?? null,
      profile: routingDetails.profileId ?? null,
      action: routingDetails.actionKey ?? null,
      state: routingDetails.state ?? null,
      epsilon: this.router.epsilon,
      step: this.stepCount + 1,
    };
    return {
      ...(traceOptions ?? {}),
      metadata,
    };
  }

  _buildActionEntries() {
    const entries = [];
    for (const modelKey of this.modelKeys) {
      for (const profile of this.profiles) {
        const actionKey = buildActionKey(modelKey, profile.id);
        entries.push({
          actionKey,
          modelKey,
          profileId: profile.id,
        });
      }
    }
    return entries;
  }

  _loadRouterState(statePath, routerConfig = undefined) {
    const actionKeys = this.actionEntries.map((entry) => entry.actionKey);
    const config = routerConfig ?? {};
    let router = null;
    const resolvedPath =
      typeof statePath === "string" && statePath.trim()
        ? path.resolve(statePath)
        : null;
    if (resolvedPath && fs.existsSync(resolvedPath)) {
      try {
        const raw = fs.readFileSync(resolvedPath, "utf8");
        const parsed = JSON.parse(raw);
        router = QLearningRouter.fromJSON(parsed, actionKeys);
      } catch {
        router = null;
      }
    }
    if (!router) {
      router = new QLearningRouter(actionKeys, {
        alpha: config.alpha,
        gamma: config.gamma,
        epsilon: config.epsilon,
        epsilonMin: config.epsilonMin,
        epsilonDecay: config.epsilonDecay,
      });
    }
    router.statePath = resolvedPath;
    router.rewardConfig = normalizeRewardConfig(config.reward);
    return router;
  }

  async _ensureLoaded(handler) {
    if (!handler) {
      return;
    }
    try {
      await handler.load(this.loadOptions ?? undefined);
    } catch {
      // let chatStream surface model load errors
    }
  }

  _syncHistoryToHandler(handler) {
    if (!handler) {
      return;
    }
    if (this.sharedHistory) {
      handler.setHistory(this.sharedHistory);
    } else if (this.systemPrompt) {
      handler.setHistory([{ role: "system", content: this.systemPrompt }]);
    }
  }

  _updateAfterPrompt({ handler, obs, actionKey, errorMessage }) {
    const nextStatus = errorMessage ? "error" : "ok";
    const errorKind = errorMessage ? classifyErrorKind(errorMessage) : "none";
    const nextObs = {
      ...obs,
      step: obs.step + 1,
      lastStatus: nextStatus,
      lastErrorKind: errorKind,
    };

    const promptExchange = handler.getLastPromptExchange();
    const perfSummary = handler.consumeLastPerformanceSummary?.() ?? null;
    const reward = this._computeReward({
      modelKey: this.modelKey,
      errorMessage,
      errorKind,
      performance: perfSummary,
      promptExchange,
    });

    const followUpNeeded = resolveFollowUpNeeded(perfSummary);
    const schemaValid = promptExchange?.response?.schemaValidation?.valid;
    const durationMs = promptExchange?.response?.durationMs ?? null;

    this.stepCount = obs.step;
    this.lastStatus = nextStatus;
    this.lastErrorKind = errorKind;
    this.lastSchemaValid = normalizeFlag(schemaValid);
    this.lastFollowUpNeeded = normalizeFlag(followUpNeeded);
    this.lastDurationMs = Number.isFinite(durationMs) ? durationMs : null;
    this.sharedHistory = handler.getHistory();
    this.lastPromptExchange = promptExchange ?? null;
    this.lastPerformanceSummary = perfSummary ?? null;

    if (this.learnEnabled && actionKey) {
      const done = obs.step >= this.maxSteps;
      this.router.update(obs, actionKey, reward, nextObs, done);
      this._scheduleRouterSave();
    }
  }

  _computeReward({ modelKey, errorMessage, errorKind, performance, promptExchange }) {
    const rewardCfg = this.router.rewardConfig ?? DEFAULT_REWARD;
    const rawCost =
      rewardCfg.modelCosts?.[modelKey] ??
      rewardCfg.defaultModelCost ??
      DEFAULT_REWARD.defaultModelCost;
    const modelCost = Number.isFinite(Number(rawCost))
      ? Number(rawCost)
      : DEFAULT_REWARD.defaultModelCost;
    const stepPenalty = Number.isFinite(Number(rewardCfg.stepPenalty))
      ? Number(rewardCfg.stepPenalty)
      : 0;
    let reward = -modelCost - stepPenalty;

    if (errorMessage) {
      const failurePenalty = Number.isFinite(Number(rewardCfg.failurePenalty))
        ? Number(rewardCfg.failurePenalty)
        : 0;
      reward += failurePenalty;
      if (errorKind === "schema") {
        const schemaPenalty = Number.isFinite(Number(rewardCfg.schemaPenalty))
          ? Number(rewardCfg.schemaPenalty)
          : 0;
        reward += schemaPenalty;
      }
      return reward;
    }

    const successReward = Number.isFinite(Number(rewardCfg.successReward))
      ? Number(rewardCfg.successReward)
      : 0;
    reward += successReward;

    if (performance?.score !== null && performance?.score !== undefined) {
      const score = Number(performance.score);
      const scoreWeight = Number.isFinite(Number(rewardCfg.scoreWeight))
        ? Number(rewardCfg.scoreWeight)
        : 0;
      if (Number.isFinite(score)) {
        reward += score * scoreWeight;
      }
    }

    if (performance?.followUpNeeded) {
      const followUpPenalty = Number.isFinite(Number(rewardCfg.followUpPenalty))
        ? Number(rewardCfg.followUpPenalty)
        : 0;
      reward += followUpPenalty;
    }

    const schemaValid = promptExchange?.response?.schemaValidation?.valid;
    if (schemaValid === false) {
      const schemaPenalty = Number.isFinite(Number(rewardCfg.schemaPenalty))
        ? Number(rewardCfg.schemaPenalty)
        : 0;
      reward += schemaPenalty;
    }

    return reward;
  }

  _scheduleRouterSave() {
    const statePath = this.router.statePath;
    if (!statePath) {
      return;
    }
    const now = Date.now();
    if (now - this.lastSaveAt < this.saveIntervalMs || this.pendingSave) {
      return;
    }
    this.lastSaveAt = now;
    const payload = this.router.toJSON();
    const targetDir = path.dirname(statePath);
    this.pendingSave = fs.promises
      .mkdir(targetDir, { recursive: true })
      .then(() => fs.promises.writeFile(statePath, JSON.stringify(payload, null, 2), "utf8"))
      .catch(() => {})
      .finally(() => {
        this.pendingSave = null;
      });
  }

  async _flushRouterSave() {
    const statePath = this.router.statePath;
    if (!statePath) {
      return;
    }
    const payload = this.router.toJSON();
    try {
      await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
      await fs.promises.writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
      this.lastSaveAt = Date.now();
    } catch {
      // ignore router save errors
    }
  }

  _getHandler(modelKey) {
    if (!this.handlers.has(modelKey)) {
      const handler = new LMStudioHandler(this.manager, {
        systemPrompt: this.systemPrompt,
        promptTimeoutMs: this.promptTimeoutMs,
        schemaRegistry: this.schemaRegistry,
        noTokenTimeoutMs: this.noTokenTimeoutMs,
        modelKey,
      });
      if (this.restClient) {
        handler.setRestClient(this.restClient, { preferRestTransport: this.preferRestTransport });
      }
      if (this.executionRegister && typeof handler.setExecutionRegister === "function") {
        handler.setExecutionRegister(this.executionRegister, this.executionContext);
      }
      this.handlers.set(modelKey, handler);
    }
    return this.handlers.get(modelKey);
  }

  _forEachHandler(fn) {
    if (!this.handlers) {
      this.handlers = new Map();
    }
    for (const modelKey of this.modelKeys) {
      const handler = this._getHandler(modelKey);
      if (handler) {
        fn(handler);
      }
    }
  }
}
