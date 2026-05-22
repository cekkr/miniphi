# 💬 NPS Follow-Up - Detractor Recovery

> Follows up with NPS detractors using personalized recovery messages tied to their specific feedback.

## Overview
NPS Follow-Up turns negative feedback into retention opportunities by crafting personalized outreach for NPS detractors. It references specific concerns, offers concrete resolution steps, and tracks recovery rates to identify systemic issues worth fixing.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/nps-followup/agent
cp SOUL.md ~/.openclaw/agents/nps-followup/agent/
openclaw agents add nps-followup --workspace ~/.openclaw/agents/nps-followup
```

## Use Cases
| Request | Output |
|---------|--------|
| "Draft follow-ups for this week's detractors" | Personalized messages referencing specific feedback |
| "What's our recovery rate this quarter?" | Recovery metrics with complaint category breakdown |
| "Which accounts are at churn risk?" | Detractors sorted by ARR with resolution status |
| "What are the top complaint themes?" | Categorized feedback trends with product recommendations |

## Author
Created by [@openclaw](https://github.com/openclaw)
