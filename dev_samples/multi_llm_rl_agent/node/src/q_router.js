// Tabular Q-learning router (NodeJS version)
// Mirrors src/q_router.py

export function stepBucket(step) {
  if (step <= 1) return "early";
  if (step <= 3) return "mid";
  return "late";
}

export function featurize(obs) {
  return [
    obs.difficulty,
    stepBucket(obs.step),
    obs.last_test_status,
    obs.last_error_kind,
  ].join("|");
}

export class QLearningRouter {
  constructor(modelNames, {
    alpha = 0.2,
    gamma = 0.95,
    epsilon = 0.2,
    epsilonMin = 0.05,
    epsilonDecay = 0.999,
  } = {}) {
    this.modelNames = modelNames;
    this.alpha = alpha;
    this.gamma = gamma;
    this.epsilon = epsilon;
    this.epsilonMin = epsilonMin;
    this.epsilonDecay = epsilonDecay;
    this.q = {}; // state -> { modelName: value }
  }

  ensureState(s) {
    if (!this.q[s]) {
      this.q[s] = {};
      for (const m of this.modelNames) this.q[s][m] = 0.0;
    }
  }

  chooseModel(obs) {
    const s = featurize(obs);
    this.ensureState(s);

    if (Math.random() < this.epsilon) {
      return this.modelNames[Math.floor(Math.random() * this.modelNames.length)];
    }

    const entries = Object.entries(this.q[s]);
    const bestVal = Math.max(...entries.map(([, v]) => v));
    const best = entries.filter(([, v]) => v === bestVal).map(([m]) => m);
    return best[Math.floor(Math.random() * best.length)];
  }

  update(obs, chosenModel, reward, nextObs, done) {
    const s = featurize(obs);
    const ns = featurize(nextObs);
    this.ensureState(s);
    this.ensureState(ns);

    const qsa = this.q[s][chosenModel];
    const maxNext = done ? 0.0 : Math.max(...Object.values(this.q[ns]));
    const target = reward + this.gamma * maxNext;
    this.q[s][chosenModel] = qsa + this.alpha * (target - qsa);

    this.epsilon = Math.max(this.epsilonMin, this.epsilon * this.epsilonDecay);
  }
}
