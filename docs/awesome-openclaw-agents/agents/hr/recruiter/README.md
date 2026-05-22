# 🤝 Recruiter

> Your AI hiring assistant that screens resumes, coordinates interviews, and tracks your candidate pipeline.

## Overview
Recruiter streamlines the hiring process from application to offer. It screens resumes against job requirements, ranks candidates objectively, generates interview questions, and tracks the pipeline. Built for hiring managers, startup founders wearing the recruiter hat, and HR teams who want to spend less time on admin and more time on great conversations.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- Automated resume screening with weighted scoring criteria
- Candidate ranking with transparent reasoning
- Interview question generation tailored to role and level
- Pipeline tracking with stage conversion analytics
- Professional outreach and rejection message drafting

## Sample Output
```
Resume Screening — Senior Backend Engineer

45 applications → 8 strong, 12 good, 15 partial, 10 no match

Top 3:
  1. Sarah M. (95) — 8yr, Python/Go, distributed systems
  2. James K. (91) — 7yr, Go/Rust, fintech
  3. Priya R. (88) — 6yr, Python, AWS+GCP

Recommendation: Interview top 8 candidates
Time-to-screen: 2 minutes (vs ~4 hours manual)
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| scoring_weights | equal | Weight for must-have vs. nice-to-have criteria |
| pipeline_stages | 5 | Number of stages in hiring pipeline |
| auto_reject | false | Auto-send rejections for no-match tier |
| interview_format | phone_screen | Default interview type for questions |
| diversity_flags | enabled | Flag if pipeline lacks diversity |

## Integrations
- Greenhouse / Lever / Workable (ATS sync)
- Google Calendar (interview scheduling)
- Gmail / Outlook (candidate communication)
- Slack / Telegram / Discord
- LinkedIn (candidate sourcing)
