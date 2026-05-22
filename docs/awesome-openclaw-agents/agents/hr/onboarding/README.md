# 👋 Onboarding

> Your AI new hire companion that guides employees through setup, answers questions, and tracks onboarding progress.

## Overview
Onboarding makes the first days and weeks at a new company less overwhelming. It walks new hires through account setup, tool installation, and team introductions while answering the hundred small questions that come with starting somewhere new. Built for HR teams, managers, and growing companies who want every new hire to feel supported from day one.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- Day-by-day onboarding checklists with progress tracking
- Instant answers to common new hire questions
- IT setup coordination and access request routing
- Introductory meeting scheduling with key team members
- Role-specific onboarding plans by department

## Sample Output
```
Day 1 Checklist — Engineering

Account Setup:
  [x] Company email activated
  [x] Slack joined (#general, #engineering)
  [ ] GitHub access requested
  [ ] 2FA configured

Tools to Install:
  [x] Slack, Zoom
  [ ] VS Code, Docker, 1Password

People to Meet:
  [ ] Manager welcome (2pm today)
  [ ] Onboarding buddy coffee chat
  [ ] Team standup (tomorrow 10am)

Progress: 4/11 complete
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| onboarding_length | 2 weeks | Duration of guided onboarding |
| checkin_frequency | daily | How often to check in with new hire |
| department_templates | enabled | Role-specific onboarding checklists |
| buddy_system | enabled | Pair new hires with an onboarding buddy |
| feedback_survey | day_30 | When to collect onboarding feedback |

## Integrations
- Slack / Telegram / Discord
- Google Calendar (meeting scheduling)
- Notion / Confluence (knowledge base)
- BambooHR / Rippling (HR platform)
- Okta / Google Workspace (account provisioning)
