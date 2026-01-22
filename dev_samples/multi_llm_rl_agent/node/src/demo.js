import { QLearningRouter } from "./q_router.js";

function simStep({ taskDifficulty, modelName }) {
  const modelCost = { fast: 1.0, balanced: 2.0, strong: 3.0 };
  const successProb = {
    fast: { easy: 0.90, medium: 0.50, hard: 0.20 },
    balanced: { easy: 0.95, medium: 0.75, hard: 0.50 },
    strong: { easy: 0.98, medium: 0.90, hard: 0.85 },
  };

  const p = successProb[modelName][taskDifficulty];
  const solved = Math.random() < p;

  const stepPenalty = 0.2;
  const successReward = 10.0;
  const failPenalty = -1.0;

  let reward = -modelCost[modelName] - stepPenalty;
  if (solved) reward += successReward;
  else reward += failPenalty;

  return { solved, reward };
}

function policy(router, difficulty) {
  const old = router.epsilon;
  router.epsilon = 0.0;
  const choice = router.chooseModel({
    difficulty,
    step: 0,
    last_test_status: "unknown",
    last_error_kind: "none",
  });
  router.epsilon = old;
  return choice;
}

async function main() {
  const router = new QLearningRouter(["fast", "balanced", "strong"]);
  const tasks = ["easy", "medium", "hard"];
  const maxSteps = 6;

  for (let ep = 1; ep <= 3000; ep++) {
    const difficulty = tasks[Math.floor(Math.random() * tasks.length)];
    let obs = {
      difficulty,
      step: 0,
      last_test_status: "unknown",
      last_error_kind: "none",
    };

    let done = false;
    let total = 0.0;
    for (let step = 1; step <= maxSteps && !done; step++) {
      obs.step = step;
      const m = router.chooseModel(obs);
      const { solved, reward } = simStep({ taskDifficulty: difficulty, modelName: m });

      const nextObs = {
        difficulty,
        step,
        last_test_status: solved ? "pass" : "fail",
        last_error_kind: solved ? "none" : "assertion",
      };

      done = solved || step === maxSteps;
      router.update(obs, m, reward, nextObs, done);
      obs = nextObs;
      total += reward;
    }

    if (ep % 500 === 0) {
      console.log(`ep=${ep} epsilon=${router.epsilon.toFixed(3)} total=${total.toFixed(2)}`);
    }
  }

  console.log("Greedy policy snapshot:");
  for (const d of tasks) console.log(`  ${d} -> ${policy(router, d)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
