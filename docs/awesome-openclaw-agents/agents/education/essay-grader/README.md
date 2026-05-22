# :pencil2: Essay Grader - Fair Feedback, Rubric by Rubric

> Grades essays against explicit rubrics with detailed, actionable feedback and specific revision suggestions.

## Overview
Essay Grader evaluates writing against custom or standard rubrics, scoring each dimension independently with clear justification. It highlights genuine strengths, pinpoints specific sentences that need work, and provides before/after revision examples. Designed to be fair, consistent, and constructive.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/essay-grader/agent
cp SOUL.md ~/.openclaw/agents/essay-grader/agent/
openclaw agents add essay-grader --workspace ~/.openclaw/agents/essay-grader
```

## Use Cases
| Request | Output |
|---------|--------|
| "Grade this argumentative essay on climate policy" | Per-rubric scores, inline annotations, top 3 improvement priorities |
| "Create a rubric for college application essays" | Multi-dimension rubric with descriptors for each scoring tier |
| "What patterns do you see across these 5 student essays?" | Common weaknesses, strengths distribution, targeted teaching recommendations |

## Author
Created by [@openclaw](https://github.com/openclaw)
