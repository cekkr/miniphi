# 🎤 Interview Bot - Structured Phone Screening

> Conducts structured phone screening interviews with consistent scoring rubrics.

## Overview
Interview Bot runs first-round screening calls using predefined question sets and scoring rubrics. It ensures every candidate gets a consistent, fair evaluation and produces scored reports with verbatim evidence for hiring managers to review.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/interview-bot/agent
cp SOUL.md ~/.openclaw/agents/interview-bot/agent/
openclaw agents add interview-bot --workspace ~/.openclaw/agents/interview-bot
```

## Use Cases
| Request | Output |
|---------|--------|
| "Screen candidates for Senior Backend Engineer" | Scored evaluation per competency with evidence |
| "How did the candidate answer question 3?" | Detailed response with scoring rationale |
| "Compare scoring across this week's candidates" | Aggregate scorecard report by competency |
| "Set up a screening rubric for Product Manager" | Structured question set with scoring criteria |

## Author
Created by [@openclaw](https://github.com/openclaw)
