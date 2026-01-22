from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Tuple


class ToolError(RuntimeError):
    pass


def _safe_join(root: Path, rel_path: str) -> Path:
    """
    Prevent path traversal outside of root.
    """
    root = root.resolve()
    p = (root / rel_path).resolve()
    if root not in p.parents and p != root:
        raise ToolError(f"Unsafe path: {rel_path}")
    return p


@dataclass
class ToolExecutor:
    workspace: Path

    def __post_init__(self) -> None:
        self.workspace.mkdir(parents=True, exist_ok=True)

    def read_file(self, path: str) -> Dict[str, Any]:
        p = _safe_join(self.workspace, path)
        if not p.exists():
            raise ToolError(f"File not found: {path}")
        return {"path": path, "content": p.read_text()}

    def write_file(self, path: str, content: str) -> Dict[str, Any]:
        p = _safe_join(self.workspace, path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return {"path": path, "bytes": len(content.encode("utf-8"))}

    def run_tests(self) -> Dict[str, Any]:
        """
        Runs `python -m unittest -q` in the workspace.
        Assumes a `tests.py` file exists in the workspace.
        """
        cmd = ["python", "-m", "unittest", "-q"]
        proc = subprocess.run(
            cmd,
            cwd=str(self.workspace),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60,
            env={**os.environ, "PYTHONPATH": str(self.workspace)},
        )
        out = proc.stdout.strip()
        ok = proc.returncode == 0
        return {"ok": ok, "returncode": proc.returncode, "output": out}

    def run_command(self, command: str) -> Dict[str, Any]:
        """
        Dangerous by default. For a real agent, consider sandboxing.
        Here, we keep it simple and *only* allow commands that start with 'python '.
        """
        command = command.strip()
        if not command.startswith("python "):
            raise ToolError("Blocked command. Only 'python ...' is allowed in this demo.")
        proc = subprocess.run(
            command,
            cwd=str(self.workspace),
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=60,
        )
        out = proc.stdout.strip()
        ok = proc.returncode == 0
        return {"ok": ok, "returncode": proc.returncode, "output": out}

    def append_memory(self, note: str) -> Dict[str, Any]:
        p = _safe_join(self.workspace, "memory.log")
        with p.open("a", encoding="utf-8") as f:
            f.write(note.rstrip() + "\n")
        return {"ok": True}

    def read_memory(self, max_chars: int = 4000) -> Dict[str, Any]:
        p = _safe_join(self.workspace, "memory.log")
        if not p.exists():
            return {"content": ""}
        txt = p.read_text(encoding="utf-8")
        return {"content": txt[-max_chars:]}
