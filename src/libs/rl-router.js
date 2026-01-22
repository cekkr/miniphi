const DEFAULT_ALPHA = 0.2;
const DEFAULT_GAMMA = 0.95;
const DEFAULT_EPSILON = 0.2;
const DEFAULT_EPSILON_MIN = 0.05;
const DEFAULT_EPSILON_DECAY = 0.995;

export function stepBucket(step) {
  if (step <= 1) return "early";
  if (step <= 3) return "mid";
  return "late";
}

export function sizeBucket(chars) {
  if (chars <= 1500) return "small";
  if (chars <= 6000) return "medium";
  return "large";
}

export function normalizeToken(value, fallback = "unknown") {
  if (!value && value !== 0) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase().replace(/\|/g, "-");
  return normalized.length ? normalized : fallback;
}

export function normalizeSchemaId(schemaId) {
  const normalized = normalizeToken(schemaId, "unknown");
  const atIndex = normalized.indexOf("@");
  return atIndex > 0 ? normalized.slice(0, atIndex) : normalized;
}

export function featurizeObservation(obs = undefined) {
  const mode = normalizeToken(obs?.mode, "unknown");
  const schemaId = normalizeSchemaId(obs?.schemaId);
  const step = Number.isFinite(obs?.step) ? obs.step : 0;
  const stepLabel = stepBucket(step);
  const lastStatus = normalizeToken(obs?.lastStatus, "unknown");
  const lastError = normalizeToken(obs?.lastErrorKind, "none");
  const size = normalizeToken(obs?.sizeBucket, "medium");
  return [mode, schemaId, stepLabel, lastStatus, lastError, size].join("|");
}

export function buildActionKey(modelKey, profileId) {
  return `${modelKey}::${profileId ?? "default"}`;
}

export function parseActionKey(actionKey) {
  if (!actionKey || typeof actionKey !== "string") {
    return { modelKey: null, profileId: null };
  }
  const [modelKey, profileId] = actionKey.split("::");
  return {
    modelKey: modelKey || null,
    profileId: profileId || null,
  };
}

export class QLearningRouter {
  constructor(actionKeys = [], options = undefined) {
    this.actionKeys = Array.isArray(actionKeys) ? actionKeys.slice() : [];
    this.alpha = Number.isFinite(options?.alpha) ? options.alpha : DEFAULT_ALPHA;
    this.gamma = Number.isFinite(options?.gamma) ? options.gamma : DEFAULT_GAMMA;
    this.epsilon = Number.isFinite(options?.epsilon) ? options.epsilon : DEFAULT_EPSILON;
    this.epsilonMin = Number.isFinite(options?.epsilonMin)
      ? options.epsilonMin
      : DEFAULT_EPSILON_MIN;
    this.epsilonDecay = Number.isFinite(options?.epsilonDecay)
      ? options.epsilonDecay
      : DEFAULT_EPSILON_DECAY;
    this.q = options?.q && typeof options.q === "object" ? { ...options.q } : {};
  }

  setActions(actionKeys) {
    this.actionKeys = Array.isArray(actionKeys) ? actionKeys.slice() : [];
    for (const state of Object.keys(this.q)) {
      this._ensureState(state);
    }
  }

  chooseAction(obs) {
    if (!this.actionKeys.length) {
      return null;
    }
    const state = featurizeObservation(obs);
    this._ensureState(state);

    if (Math.random() < this.epsilon) {
      return this.actionKeys[Math.floor(Math.random() * this.actionKeys.length)];
    }

    const entries = Object.entries(this.q[state]);
    let bestValue = -Infinity;
    for (const [, value] of entries) {
      if (value > bestValue) {
        bestValue = value;
      }
    }
    const best = entries.filter(([, value]) => value === bestValue).map(([key]) => key);
    return best[Math.floor(Math.random() * best.length)];
  }

  update(obs, actionKey, reward, nextObs, done) {
    if (!actionKey || !this.actionKeys.length) {
      return;
    }
    const state = featurizeObservation(obs);
    const nextState = featurizeObservation(nextObs);
    this._ensureState(state);
    this._ensureState(nextState);
    const qsa = this.q[state][actionKey] ?? 0.0;
    const maxNext = done ? 0.0 : Math.max(...Object.values(this.q[nextState]));
    const target = reward + this.gamma * maxNext;
    this.q[state][actionKey] = qsa + this.alpha * (target - qsa);
    this.epsilon = Math.max(this.epsilonMin, this.epsilon * this.epsilonDecay);
  }

  toJSON() {
    return {
      actionKeys: this.actionKeys,
      alpha: this.alpha,
      gamma: this.gamma,
      epsilon: this.epsilon,
      epsilonMin: this.epsilonMin,
      epsilonDecay: this.epsilonDecay,
      q: this.q,
    };
  }

  static fromJSON(payload, overrideActions = undefined) {
    const actionKeys =
      Array.isArray(overrideActions) && overrideActions.length
        ? overrideActions
        : Array.isArray(payload?.actionKeys)
          ? payload.actionKeys
          : [];
    const router = new QLearningRouter(actionKeys, {
      alpha: payload?.alpha,
      gamma: payload?.gamma,
      epsilon: payload?.epsilon,
      epsilonMin: payload?.epsilonMin,
      epsilonDecay: payload?.epsilonDecay,
    });
    if (payload?.q && typeof payload.q === "object") {
      router.q = { ...payload.q };
    }
    router.setActions(actionKeys);
    return router;
  }

  _ensureState(state) {
    if (!this.q[state]) {
      this.q[state] = {};
    }
    for (const actionKey of this.actionKeys) {
      if (!Object.prototype.hasOwnProperty.call(this.q[state], actionKey)) {
        this.q[state][actionKey] = 0.0;
      }
    }
    return this.q[state];
  }
}

