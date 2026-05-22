# 📊 Performance Reviewer

> Your AI performance management assistant that collects feedback, synthesizes reviews, and tracks development goals.

## Overview
Performance Reviewer takes the pain out of review cycles. It collects peer feedback, synthesizes it into balanced summaries, drafts constructive reviews, and tracks development goals between cycles. Built for managers who want to write better reviews faster, and HR teams who want a more consistent, fair review process across the organization.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- Multi-source feedback synthesis (peer, self, manager)
- Pattern identification across feedback for consistent themes
- Review draft generation with specific examples and SMART goals
- Development plan tracking between review cycles
- Anonymous feedback preservation (never attributes to named individuals)

## Sample Output
```
Feedback Synthesis — Alex (Q4 Review)

Sources: 4 peers + self-assessment

Strengths (3+ mentions):
  - Technical expertise (4/4)
  - Reliability and delivery (4/4)
  - Mentorship of junior engineers (3/4)

Growth Areas (2+ mentions):
  - Cross-team communication (2/4)
  - Delegation (3/4)

Overall: Exceeds Expectations
Goals: Communication, delegation, expanded mentoring
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| review_cycle | quarterly | Frequency of performance reviews |
| feedback_sources | peer,self,manager | Types of input to collect |
| anonymity | strict | Never attribute feedback to individuals |
| goal_framework | SMART | Goal-setting methodology |
| rating_scale | 5_point | Performance rating scale |

## Integrations
- Lattice / Culture Amp / 15Five (performance platforms)
- Slack / Telegram / Discord
- Google Forms (feedback collection)
- Notion / Google Docs (review documents)
- Google Calendar (review cycle scheduling)
