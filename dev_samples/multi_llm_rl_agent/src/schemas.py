from __future__ import annotations

from typing import Any, Dict, Literal, Optional
from pydantic import BaseModel, Field, model_validator


class ToolCall(BaseModel):
    """
    A structured tool invocation emitted by an LLM.

    Example:
      {"tool": "write_file", "args": {"path": "solution.py", "content": "print('hi')"}}
    """
    tool: Literal[
        "read_file",
        "write_file",
        "run_tests",
        "run_command",
        "append_memory",
        "read_memory",
    ]
    args: Dict[str, Any] = Field(default_factory=dict)


class LLMAction(BaseModel):
    """
    The only format your models are allowed to output.

    Examples:
      {"thought": "...", "action": "tool", "tool": {"tool": "write_file", "args": {...}}}
      {"action": "final", "final": "All tests passing ✅"}
    """
    thought: Optional[str] = None
    action: Literal["tool", "final"]
    tool: Optional[ToolCall] = None
    final: Optional[str] = None

    @model_validator(mode="after")
    def _check_consistency(self) -> "LLMAction":
        if self.action == "tool" and self.tool is None:
            raise ValueError("When action='tool', field 'tool' must be provided.")
        if self.action == "final" and (self.final is None or not self.final.strip()):
            raise ValueError("When action='final', field 'final' must be a non-empty string.")
        return self


class RouterObs(BaseModel):
    """
    A compact observation for the RL router (kept small for context limits).
    """
    task_id: str
    difficulty: Literal["easy", "medium", "hard"]
    step: int
    last_test_status: Literal["unknown", "fail", "pass"]
    last_error_kind: Literal["none", "syntax", "assertion", "exception", "timeout", "other"] = "none"
