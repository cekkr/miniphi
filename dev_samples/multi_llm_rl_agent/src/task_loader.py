from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Task:
    task_id: str
    difficulty: str
    spec: str
    tests_py: str


def load_task(task_dir: Path) -> Task:
    meta = json.loads((task_dir / "meta.json").read_text())
    task_id = meta["task_id"]
    difficulty = meta["difficulty"]
    spec = (task_dir / "spec.txt").read_text()
    tests_py = (task_dir / "tests.py").read_text()
    return Task(task_id=task_id, difficulty=difficulty, spec=spec, tests_py=tests_py)


def load_all_tasks(tasks_root: Path) -> list[Task]:
    out = []
    for p in sorted(tasks_root.iterdir()):
        if p.is_dir() and (p / "meta.json").exists():
            out.append(load_task(p))
    return out
