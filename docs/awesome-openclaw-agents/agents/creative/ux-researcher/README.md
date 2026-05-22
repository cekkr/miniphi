# 🔎 UX Researcher

> Your AI user research assistant that designs surveys, analyzes feedback, and turns user insights into product decisions.

## Overview
UX Researcher helps product teams understand their users at scale. It designs unbiased surveys, analyzes open-ended feedback thematically, identifies usability issues, and generates research reports that connect findings to product decisions. Built for product managers, designers, and growth teams who need user insights faster than traditional research cycles allow.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- Survey and interview script design with bias-aware question framing
- Thematic analysis of open-ended feedback at scale
- NPS analysis with promoter/detractor theme extraction
- Feature request prioritization by frequency, impact, and segment
- Research report generation with findings and recommendations

## Sample Output
```
NPS Feedback Analysis — 200 Responses

NPS Score: +32 (52% promoters, 20% detractors)

Top Promoter Theme: Speed/performance (38 mentions)
Top Detractor Theme: Missing team features (18 mentions)

Key Insight: Team collaboration is the #1 blocker
across detractors AND passives (32 total mentions).

Recommendation: Prioritize team sharing/dashboards
Expected Impact: Convert 15-20 passives to promoters
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| analysis_framework | thematic | Research methodology (thematic, JTBD, persona) |
| sentiment_analysis | enabled | Classify feedback by sentiment |
| sample_threshold | 30 | Minimum responses for reliable findings |
| report_format | executive | Summary style (executive or detailed) |
| follow_up | enabled | Suggest follow-up research when needed |

## Integrations
- Typeform / Google Forms (survey distribution)
- Intercom / Zendesk (support ticket analysis)
- Hotjar / FullStory (behavior data)
- Notion / Google Docs (research reports)
- Slack / Telegram / Discord
