from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple

from rich import print

from .llms import BaseLLM
from .q_router import QLearningRouter
from .schemas import LLMAction, RouterObs
from .task_loader import Task
from .tools import ToolExecutor, ToolError


def _classify_error(output: str) -> str:
    out = output or ""
    if "SyntaxError" in out or "IndentationError" in out:
        return "syntax"
    if "AssertionError" in out:
        return "assertion"
    if "Traceback" in out or "Exception" in out or "Error" in out:
        return "exception"
    if "timeout" in out.lower():
        return "timeout"
    if not out.strip():
        return "none"
    return "other"


def _truncate(s: str, max_chars: int = 2500) -> str:
    s = s or ""
    if len(s) <= max_chars:
        return s
    return s[:max_chars] + "\n...[truncated]..."


@dataclass
class RewardConfig:
    model_cost: Dict[str, float]
    step_penalty: float = 0.2
    success_reward: float = 10.0
    fail_penalty: float = -1.0
    max_steps: int = 6


class CodingAgent:
    """
    A minimal multi-step "programming agent" that:
      - uses RL (tabular Q-learning) to choose which LLM to query each step
      - uses JSON-only tool calls from the chosen model
      - executes tools locally (write_file, read_file, run_tests)
      - uses test results as environment feedback / reward
    """

    def __init__(
        self,
        llms: Dict[str, BaseLLM],
        router: QLearningRouter,
        reward_cfg: RewardConfig,
        workspace_root: Path,
    ) -> None:
        self.llms = llms
        self.router = router
        self.reward_cfg = reward_cfg
        self.workspace_root = workspace_root

    def solve_task(self, task: Task, learn: bool = True) -> Tuple[bool, float]:
        ws = self.workspace_root / task.task_id
        if ws.exists():
            # start clean
            for p in ws.glob("**/*"):
                if p.is_file():
                    p.unlink()
        tools = ToolExecutor(workspace=ws)

        # Seed workspace with tests.
        tools.write_file("tests.py", task.tests_py)
        tools.write_file("solution.py", "# TODO: implement\n")

        obs = RouterObs(
            task_id=task.task_id,
            difficulty=task.difficulty,  # type: ignore
            step=0,
            last_test_status="unknown",
            last_error_kind="none",
        )
        total_reward = 0.0

        for step in range(1, self.reward_cfg.max_steps + 1):
            obs.step = step

            model_name = self.router.choose_model(obs)
            llm = self.llms[model_name]

            system_prompt = self._system_prompt()
            user_prompt = self._user_payload(tools=tools, task=task, obs=obs)

            try:
                action: LLMAction = llm.get_action(system=system_prompt, user=user_prompt)
            except Exception as e:
                # Treat invalid JSON or failures as a bad step.
                print(f"[red]Model {model_name} failed to produce a valid action:[/red] {e}")
                next_obs = RouterObs(
                    task_id=task.task_id,
                    difficulty=task.difficulty,  # type: ignore
                    step=step,
                    last_test_status="fail",
                    last_error_kind="other",
                )
                reward = -self.reward_cfg.model_cost.get(model_name, 1.0) - 2.0
                done = step >= self.reward_cfg.max_steps
                if learn:
                    self.router.update(obs, model_name, reward, next_obs, done)
                obs = next_obs
                total_reward += reward
                if done:
                    return False, total_reward
                continue

            if action.thought:
                print(f"[dim]{model_name} thought:[/dim] {action.thought}")

            if action.action == "final":
                # If the model says final, still run tests to check.
                test_res = tools.run_tests()
                ok = bool(test_res["ok"])
                obs2 = RouterObs(
                    task_id=task.task_id,
                    difficulty=task.difficulty,  # type: ignore
                    step=step,
                    last_test_status="pass" if ok else "fail",
                    last_error_kind="none" if ok else _classify_error(test_res["output"]),
                )
                reward = self._reward(model_name=model_name, ok=ok)
                done = True
                if learn:
                    self.router.update(obs, model_name, reward, obs2, done)
                total_reward += reward
                return ok, total_reward

            # Tool call
            try:
                tool_name = action.tool.tool  # type: ignore
                args = action.tool.args       # type: ignore
                tool_out = self._exec_tool(tools, tool_name, args)
            except ToolError as te:
                tool_out = {"ok": False, "error": str(te)}
            except Exception as e:
                tool_out = {"ok": False, "error": repr(e)}

            # After any tool, we run tests to produce an observation + reward.
            test_res = tools.run_tests()
            ok = bool(test_res["ok"])
            err_kind = "none" if ok else _classify_error(test_res["output"])

            next_obs = RouterObs(
                task_id=task.task_id,
                difficulty=task.difficulty,  # type: ignore
                step=step,
                last_test_status="pass" if ok else "fail",
                last_error_kind=err_kind,  # type: ignore
            )
            reward = self._reward(model_name=model_name, ok=ok)

            done = ok or (step >= self.reward_cfg.max_steps)

            # Optional external memory (tiny "reflexion-style" log).
            note = f"step={step} model={model_name} tool={tool_name} ok={ok} err={err_kind}\n"
            if not ok:
                note += _truncate(test_res["output"], 500) + "\n"
            tools.append_memory(note)

            if learn:
                self.router.update(obs, model_name, reward, next_obs, done)

            total_reward += reward
            obs = next_obs

            print(f"[blue]step {step}[/blue] model={model_name} tool={tool_name} tests_ok={ok} reward={reward:.2f}")

            if ok:
                return True, total_reward

        return False, total_reward

    def _reward(self, model_name: str, ok: bool) -> float:
        r = -float(self.reward_cfg.model_cost.get(model_name, 1.0)) - self.reward_cfg.step_penalty
        r += self.reward_cfg.success_reward if ok else self.reward_cfg.fail_penalty
        return r

    def _exec_tool(self, tools: ToolExecutor, tool_name: str, args: dict):
        if tool_name == "read_file":
            return tools.read_file(path=str(args.get("path", "")))
        if tool_name == "write_file":
            return tools.write_file(path=str(args.get("path", "")), content=str(args.get("content", "")))
        if tool_name == "run_tests":
            return tools.run_tests()
        if tool_name == "run_command":
            return tools.run_command(command=str(args.get("command", "")))
        if tool_name == "append_memory":
            return tools.append_memory(note=str(args.get("note", "")))
        if tool_name == "read_memory":
            return tools.read_memory(max_chars=int(args.get("max_chars", 4000)))
        raise ToolError(f"Unknown tool: {tool_name}")

    def _system_prompt(self) -> str:
        return (
            "You are a local programming agent. "
            "You must output ONLY valid JSON matching this schema:\n\n"
            "{\n"
            '  "thought": "optional",\n'
            '  "action": "tool" | "final",\n'
            '  "tool": {"tool": "read_file"|"write_file"|"run_tests"|"run_command"|"append_memory"|"read_memory", "args": {...}},\n'
            '  "final": "string"\n'
            "}\n\n"
            "Rules:\n"
            "- If action='tool', include 'tool'.\n"
            "- If action='final', include 'final'.\n"
            "- Do NOT include markdown fences or extra commentary.\n"
            "- For write_file, write ONLY solution.py unless asked otherwise.\n"
        )

    def _user_payload(self, tools: ToolExecutor, task: Task, obs: RouterObs) -> str:
        # Selective context insertion: only keep what is needed right now.
        sol = tools.read_file("solution.py")["content"]
        mem = tools.read_memory(max_chars=1200)["content"]

        payload = {
            "task_id": task.task_id,
            "difficulty": task.difficulty,
            "spec": task.spec,
            "solution_py_current": _truncate(sol, 1200),
            "last_test_status": obs.last_test_status,
            "last_error_kind": obs.last_error_kind,
            "memory_tail": _truncate(mem, 1200),
            "instruction": "Choose the next tool call to make tests pass. Usually: write_file(solution.py).",
        }
        return json.dumps(payload)
