from __future__ import annotations

import argparse
from pathlib import Path

from rich import print

from .agent import CodingAgent, RewardConfig
from .llms import MockLLM, OllamaLLM
from .q_router import QLearningRouter
from .task_loader import load_all_tasks


def build_mock_llms(tasks_root: Path):
    # Load reference solutions for the mock.
    solutions = {}
    for tdir in tasks_root.iterdir():
        if tdir.is_dir() and (tdir / "reference_solution.py").exists():
            solutions[tdir.name] = (tdir / "reference_solution.py").read_text()

    # Three "local LLMs" with different skill/cost tradeoffs.
    llms = {
        "fast": MockLLM(name="fast", skill=0.60, solutions=solutions),
        "balanced": MockLLM(name="balanced", skill=0.78, solutions=solutions),
        "strong": MockLLM(name="strong", skill=0.92, solutions=solutions),
    }
    return llms


def build_ollama_llms():
    # You can swap models to whatever you have locally.
    # Suggested: a smaller, faster model + a bigger, stronger model.
    llms = {
        "fast": OllamaLLM(name="fast", model="qwen2.5-coder:7b"),
        "balanced": OllamaLLM(name="balanced", model="llama3.1:8b"),
        "strong": OllamaLLM(name="strong", model="deepseek-coder-v2:16b"),
    }
    return llms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["mock", "ollama"], default="mock")
    ap.add_argument("--tasks", type=str, default="tasks")
    ap.add_argument("--workspace", type=str, default=".workspace")
    ap.add_argument("--router", type=str, default="router_q.json")
    ap.add_argument("--learn", action="store_true")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    tasks_root = (root / args.tasks).resolve()
    ws_root = (root / args.workspace).resolve()
    ws_root.mkdir(parents=True, exist_ok=True)

    tasks = load_all_tasks(tasks_root)
    if not tasks:
        raise SystemExit(f"No tasks found under {tasks_root}")

    if args.backend == "mock":
        llms = build_mock_llms(tasks_root)
    else:
        llms = build_ollama_llms()
        print("[yellow]Using Ollama backends. Make sure Ollama is running and models are pulled.[/yellow]")

    router_path = (root / args.router)
    if router_path.exists():
        router = QLearningRouter.load(router_path)
        print(f"[green]Loaded router from {router_path}[/green]")
    else:
        router = QLearningRouter(model_names=list(llms.keys()))
        print(f"[yellow]No router file found. Starting a fresh router.[/yellow]")

    reward_cfg = RewardConfig(model_cost={"fast": 1.0, "balanced": 2.0, "strong": 3.0}, max_steps=6)
    agent = CodingAgent(llms=llms, router=router, reward_cfg=reward_cfg, workspace_root=ws_root)

    results = []
    for t in tasks:
        ok, total_r = agent.solve_task(t, learn=args.learn)
        results.append((t.task_id, ok, total_r))
        print(f"[bold]{t.task_id}[/bold] -> ok={ok} total_reward={total_r:.2f}\n")

    router.save(router_path)
    print(f"[green]Saved router to {router_path}[/green]")

    print("\n[bold]Summary[/bold]")
    for tid, ok, r in results:
        print(f"  {tid:16s} ok={ok} reward={r:.2f}")


if __name__ == "__main__":
    main()
