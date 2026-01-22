from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass
from typing import Any, Dict, Optional

import requests

from .schemas import LLMAction


_JSON_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)
_BRACE_RE = re.compile(r"\{", re.DOTALL)


def _extract_json(text: str) -> Dict[str, Any]:
    """
    Best-effort JSON extraction.

    We accept:
      - a fenced ```json { ... } ``` block
      - or a raw JSON object somewhere in the text

    If multiple candidates exist, we try the fenced one first.
    """
    m = _JSON_BLOCK_RE.search(text)
    candidates = []
    if m:
        candidates.append(m.group(1))

    # Fallback: take substring from first "{" to last "}"
    if "{" in text and "}" in text:
        candidates.append(text[text.find("{") : text.rfind("}") + 1])

    last_err = None
    for c in candidates:
        try:
            return json.loads(c)
        except Exception as e:
            last_err = e

    raise ValueError(f"Could not parse JSON from model output. Last error: {last_err}\nRaw:\n{text}")


class BaseLLM:
    def __init__(self, name: str):
        self.name = name

    def complete(self, system: str, user: str) -> str:
        raise NotImplementedError

    def get_action(self, system: str, user: str) -> LLMAction:
        txt = self.complete(system=system, user=user)
        payload = _extract_json(txt)
        return LLMAction.model_validate(payload)


@dataclass
class OllamaLLM(BaseLLM):
    """
    Minimal Ollama client.

    Requires:
      - Ollama installed + running locally
      - model pulled: e.g. `ollama pull llama3.1:8b`

    API docs: https://github.com/ollama/ollama/blob/main/docs/api.md
    """
    name: str
    model: str
    base_url: str = "http://localhost:11434"
    temperature: float = 0.2
    timeout_s: int = 120

    def __post_init__(self) -> None:
        super().__init__(name=self.name)

    def complete(self, system: str, user: str) -> str:
        url = f"{self.base_url}/api/generate"
        prompt = f"{system}\n\nUSER:\n{user}"
        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": self.temperature},
        }
        r = requests.post(url, json=payload, timeout=self.timeout_s)
        r.raise_for_status()
        data = r.json()
        return data.get("response", "")


class MockLLM(BaseLLM):
    """
    A deterministic-ish "LLM" used for:
      - quickly validating the tool loop
      - quickly training the RL router (without heavy models)

    This mock emits *valid* JSON matching the LLMAction schema.
    """
    def __init__(self, name: str, skill: float, solutions: Dict[str, str]):
        super().__init__(name=name)
        self.skill = float(skill)  # 0..1; higher = more likely to propose correct code
        self.solutions = solutions

    def complete(self, system: str, user: str) -> str:
        """
        The orchestrator sends JSON in the user message.
        We'll parse it and return an action.
        """
        try:
            req = json.loads(user)
        except Exception:
            # If user prompt isn't JSON, just emit a "final" message.
            return json.dumps({"action": "final", "final": "MockLLM received a non-JSON prompt."})

        task_id = req.get("task_id", "unknown")
        last_test_status = req.get("last_test_status", "unknown")
        last_error_kind = req.get("last_error_kind", "none")

        # If we already passed, stop.
        if last_test_status == "pass":
            return json.dumps({"action": "final", "final": f"{task_id}: ✅ tests passing"})

        # Propose code (maybe wrong).
        correct = self.solutions.get(task_id, "")
        if not correct:
            return json.dumps({"action": "final", "final": f"Unknown task_id={task_id} in MockLLM."})

        # Decide whether to output correct code.
        # If we failed before, we slightly increase the chance to fix it.
        p = self.skill + (0.15 if last_test_status == "fail" else 0.0)
        p = max(0.0, min(1.0, p))

        code = correct if random.random() < p else self._corrupt_code(correct, last_error_kind)

        return json.dumps(
            {
                "thought": f"(mock) propose solution for {task_id} (skill={self.skill:.2f}, p_correct={p:.2f})",
                "action": "tool",
                "tool": {
                    "tool": "write_file",
                    "args": {"path": "solution.py", "content": code},
                },
            }
        )

    def _corrupt_code(self, code: str, last_error_kind: str) -> str:
        """
        Introduce small, realistic bugs.
        """
        # A few simple corruption patterns.
        if "return" in code and random.random() < 0.5:
            return code.replace("return", "retun", 1)  # syntax error
        if "==" in code and random.random() < 0.5:
            return code.replace("==", "=", 1)  # syntax error
        # Off-by-one / incorrect logic: remove a line or change a constant.
        lines = code.splitlines()
        if len(lines) > 5 and random.random() < 0.6:
            i = random.randint(1, len(lines) - 2)
            lines.pop(i)
            return "\n".join(lines) + "\n"
        # Fallback: add a wrong return.
        return code + "\n# BUG: wrong return\n"
