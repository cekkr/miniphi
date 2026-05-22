---
name: cost-optimizer
description: Trigger when the user asks to audit Claude Code costs, reduce token spend, says "my Claude bill is too high", "optimize my CLAUDE.md", "why is this project burning tokens", or "/cost-optimizer". Scans a project for the common Claude Code cost leaks and returns a prioritized fix list.
---

# Cost Optimizer

Audit a project's Claude Code setup for the handful of well-known cost leaks and output a prioritized remediation list. This is a static inspection — no pricing API calls, no guesswork about past spend.

## When to use

- "My Claude Code bill doubled this month — what's going on?"
- "Audit this project for token waste"
- "Why is my session context always huge?"
- Post-mortem after a runaway agent run

## What to check

Run each check and record `PASS` / `WARN` / `FAIL` with a short note.

### 1. CLAUDE.md size

```bash
wc -l CLAUDE.md .claude/CLAUDE.md 2>/dev/null
```

- **PASS:** under 100 lines
- **WARN:** 100-300 lines
- **FAIL:** >300 lines — this is prepended to every message, so every line costs tokens forever.

Fix: move reference material (API keys, runbooks, verbose examples) into skill files or `docs/`, and leave CLAUDE.md as a thin pointer.

### 2. Memory file bloat

```bash
find ~/.claude/projects -name 'MEMORY.md' -exec wc -l {} \;
find .claude/memory -type f -exec wc -l {} \; 2>/dev/null
```

- **WARN** if any memory file is >500 lines.
- **FAIL** if >1500 lines — memory should be a curated index with links to detail files, not a dump.

Fix: extract old sections into `memory/<topic>.md` detail files and link from the index.

### 3. Unused or shadowed skills

```bash
ls ~/.claude/skills/ .claude/skills/ 2>/dev/null
```

- Cross-reference with the skill invocations in the last 30 days of shell history or session logs if available.
- Skills that have never been invoked but have huge `SKILL.md` bodies (>300 lines) are loaded into the skill index every turn — prune them.

### 4. Subagent fan-out patterns

Grep the project for Task/agent launch patterns:

```bash
grep -rn 'TaskCreate\|subagent\|parallel.*agent' --include='*.md' --include='*.js' --include='*.ts' .
```

- **WARN** if the repo spawns >5 parallel subagents per run without aggregation — each spins up its own context window.
- **FAIL** if subagents re-read the whole repo instead of receiving a scoped prompt.

Fix: pass a short brief + a handful of file paths to each subagent, not the entire CLAUDE.md context.

### 5. Prompt cache hygiene

Look for `.claude/settings.json` and check if the project sets an unusually short cache TTL, or if hooks invalidate the cache every message (e.g. a hook that echoes a timestamp into the system prompt).

- **FAIL** any hook that injects `date` / `uuidgen` / random content into every turn — it kills the cache, 10x cost.

### 6. Model selection

Grep for explicit model pins:

```bash
grep -rn 'opus\|sonnet\|haiku\|claude-3\|claude-4' .claude/ CLAUDE.md 2>/dev/null
```

- **WARN** if Opus is pinned for routine tasks that Sonnet could handle. Recommend the `/model-cost-compare` skill for a per-task estimate.

### 7. Session file size

```bash
du -sh ~/.claude/projects/*/sessions 2>/dev/null | sort -h | tail -5
```

Huge session dirs suggest you never `/compact` long-running threads. Suggest periodic compaction.

## Output format

Print a ranked list. Top of the list = biggest win per effort.

```
Cost Optimizer — <project>

Priority 1 (FAIL)
  [CLAUDE.md]      412 lines — prepended every turn. Extract sections into skills/.
  [cache hygiene]  .claude/settings.json hook injects `date +%s` on SessionStart. Remove it.

Priority 2 (WARN)
  [memory]         MEMORY.md is 820 lines. Index top, details linked.
  [model pinning]  Opus 4.6 pinned in 4 skill files — 2 could drop to Sonnet 4.6.

Priority 3 (nice-to-have)
  [skills]         3 skills (haiku-card, foo, bar) never invoked in last 30 days.

Estimated impact: roughly halving per-turn overhead — validate with a before/after /cost check.
```

Do not invent dollar savings. You can estimate relative impact ("~30% smaller context") but not absolute currency unless the user provides their current bill.

## Example invocations

- `/cost-optimizer`
- "Audit this project for Claude Code cost waste"
- "My CLAUDE.md feels too big — what should I cut?"
- "Why is my prompt cache missing every turn?"
