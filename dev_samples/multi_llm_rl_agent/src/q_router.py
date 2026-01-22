from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from .schemas import RouterObs


def _step_bucket(step: int) -> str:
    if step <= 1:
        return "early"
    if step <= 3:
        return "mid"
    return "late"


def featurize(obs: RouterObs) -> str:
    """
    Convert an observation into a discrete state key for tabular Q-learning.

    Keep this intentionally compact. If you add too many features, you may
    fragment the state space and learn slowly.
    """
    return "|".join(
        [
            obs.difficulty,
            _step_bucket(obs.step),
            obs.last_test_status,
            obs.last_error_kind,
        ]
    )


@dataclass
class QLearningRouter:
    """
    A lightweight RL router for picking which LLM to call next.

    This is intentionally simple (tabular Q-learning + ε-greedy) so that:
      - it runs locally
      - it is easy to inspect
      - it matches the "RL-assisted routing" idea in PickLLM-like systems
    """
    model_names: List[str]
    alpha: float = 0.2       # learning rate
    gamma: float = 0.95      # discount
    epsilon: float = 0.2     # exploration probability
    epsilon_min: float = 0.05
    epsilon_decay: float = 0.999

    q: Dict[str, Dict[str, float]] = None

    def __post_init__(self) -> None:
        if self.q is None:
            self.q = {}

    def _ensure_state(self, s: str) -> None:
        if s not in self.q:
            self.q[s] = {m: 0.0 for m in self.model_names}

    def choose_model(self, obs: RouterObs) -> str:
        s = featurize(obs)
        self._ensure_state(s)

        if random.random() < self.epsilon:
            return random.choice(self.model_names)

        # Greedy with random tie-breaking.
        best_val = max(self.q[s].values())
        best = [m for m, v in self.q[s].items() if v == best_val]
        return random.choice(best)

    def update(
        self,
        obs: RouterObs,
        chosen_model: str,
        reward: float,
        next_obs: RouterObs,
        done: bool,
    ) -> None:
        s = featurize(obs)
        ns = featurize(next_obs)
        self._ensure_state(s)
        self._ensure_state(ns)

        q_sa = self.q[s][chosen_model]
        max_next = 0.0 if done else max(self.q[ns].values())
        target = reward + self.gamma * max_next
        self.q[s][chosen_model] = q_sa + self.alpha * (target - q_sa)

        # Decay exploration very gently.
        self.epsilon = max(self.epsilon_min, self.epsilon * self.epsilon_decay)

    def save(self, path: str | Path) -> None:
        path = Path(path)
        payload = {
            "model_names": self.model_names,
            "alpha": self.alpha,
            "gamma": self.gamma,
            "epsilon": self.epsilon,
            "epsilon_min": self.epsilon_min,
            "epsilon_decay": self.epsilon_decay,
            "q": self.q,
        }
        path.write_text(json.dumps(payload, indent=2))

    @classmethod
    def load(cls, path: str | Path) -> "QLearningRouter":
        path = Path(path)
        payload = json.loads(path.read_text())
        router = cls(
            model_names=payload["model_names"],
            alpha=payload["alpha"],
            gamma=payload["gamma"],
            epsilon=payload["epsilon"],
            epsilon_min=payload["epsilon_min"],
            epsilon_decay=payload["epsilon_decay"],
        )
        router.q = payload["q"]
        return router
