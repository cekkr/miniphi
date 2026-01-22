from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Dict, List, Tuple

from .schemas import RouterObs


@dataclass
class SimTask:
    task_id: str
    difficulty: str  # "easy" | "medium" | "hard"


@dataclass
class SimConfig:
    model_cost: Dict[str, float]
    success_prob: Dict[str, Dict[str, float]]  # model -> difficulty -> p_success
    step_penalty: float = 0.2
    success_reward: float = 10.0
    fail_penalty: float = -1.0
    max_steps: int = 6


class SimRouterEnv:
    """
    A tiny stochastic environment for training the router quickly.

    Each step:
      - agent picks which model to query (router action)
      - environment samples whether the attempt solves the task
      - reward trades off success vs cost (and wasted steps)

    This is NOT a full programming environment — it's the "trainer wheels"
    you can use before wiring in real LLMs + tools.
    """
    def __init__(self, tasks: List[SimTask], config: SimConfig):
        self.tasks = tasks
        self.cfg = config
        self._task: SimTask | None = None
        self._step = 0
        self._last_status = "unknown"
        self._last_err = "none"

    def reset(self) -> RouterObs:
        self._task = random.choice(self.tasks)
        self._step = 0
        self._last_status = "unknown"
        self._last_err = "none"
        return RouterObs(
            task_id=self._task.task_id,
            difficulty=self._task.difficulty,  # type: ignore
            step=self._step,
            last_test_status=self._last_status,  # type: ignore
            last_error_kind=self._last_err,       # type: ignore
        )

    def step(self, model_name: str) -> Tuple[RouterObs, float, bool, Dict]:
        assert self._task is not None, "Call reset() first."

        self._step += 1

        # Model "attempt": succeed with probability based on difficulty.
        p = self.cfg.success_prob[model_name][self._task.difficulty]
        solved = random.random() < p

        # Cost always paid.
        reward = -float(self.cfg.model_cost[model_name]) - self.cfg.step_penalty

        info = {"p_success": p, "model_cost": self.cfg.model_cost[model_name]}

        if solved:
            self._last_status = "pass"
            self._last_err = "none"
            reward += self.cfg.success_reward
            done = True
        else:
            self._last_status = "fail"
            self._last_err = random.choice(["assertion", "exception", "syntax", "other"])
            reward += self.cfg.fail_penalty
            done = self._step >= self.cfg.max_steps
            if done:
                reward += -10.0  # big failure penalty at episode end

        obs = RouterObs(
            task_id=self._task.task_id,
            difficulty=self._task.difficulty,  # type: ignore
            step=self._step,
            last_test_status=self._last_status,  # type: ignore
            last_error_kind=self._last_err,       # type: ignore
        )
        return obs, reward, done, info
