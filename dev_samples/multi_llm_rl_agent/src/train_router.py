from __future__ import annotations

import argparse
from pathlib import Path

from rich import print

from .env_sim import SimConfig, SimRouterEnv, SimTask
from .q_router import QLearningRouter


def build_default_env(model_names):
    tasks = [
        SimTask("add_two_numbers", "easy"),
        SimTask("is_prime", "medium"),
        SimTask("two_sum", "hard"),
    ]
    cfg = SimConfig(
        model_cost={"fast": 1.0, "balanced": 2.0, "strong": 3.0},
        success_prob={
            "fast": {"easy": 0.90, "medium": 0.50, "hard": 0.20},
            "balanced": {"easy": 0.95, "medium": 0.75, "hard": 0.50},
            "strong": {"easy": 0.98, "medium": 0.90, "hard": 0.85},
        },
        max_steps=6,
    )
    return SimRouterEnv(tasks=tasks, config=cfg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=5000)
    ap.add_argument("--save", type=str, default="router_q.json")
    args = ap.parse_args()

    model_names = ["fast", "balanced", "strong"]
    env = build_default_env(model_names)
    router = QLearningRouter(model_names=model_names)

    for ep in range(args.episodes):
        obs = env.reset()
        done = False
        ep_reward = 0.0
        while not done:
            m = router.choose_model(obs)
            next_obs, reward, done, info = env.step(m)
            router.update(obs, m, reward, next_obs, done)
            obs = next_obs
            ep_reward += reward

        if (ep + 1) % 500 == 0:
            print(f"[cyan]Episode {ep+1}[/cyan] reward={ep_reward:.2f} epsilon={router.epsilon:.3f}")

    out = Path(args.save)
    router.save(out)
    print(f"[green]Saved router Q-table to {out}[/green]")

    # Show a quick "policy sketch":
    def policy(difficulty, last_test_status="unknown", last_error_kind="none", step=0):
        from .schemas import RouterObs
        o = RouterObs(task_id="x", difficulty=difficulty, step=step,
                      last_test_status=last_test_status, last_error_kind=last_error_kind)
        # temporarily turn off exploration
        old_eps = router.epsilon
        router.epsilon = 0.0
        choice = router.choose_model(o)
        router.epsilon = old_eps
        return choice

    print("\n[bold]Greedy choices after training (one-step snapshot)[/bold]")
    for diff in ["easy", "medium", "hard"]:
        print(f"  {diff:6s} -> {policy(diff)}")


if __name__ == "__main__":
    main()
