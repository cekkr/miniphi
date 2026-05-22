# 📜 Policy Writer

> Your AI policy drafting assistant that creates clear, enforceable internal policies and legal documents.

## Overview
Policy Writer drafts internal policies, terms of service, privacy policies, and other governance documents that people can actually understand. It translates regulatory requirements into readable provisions and generates plain-English summaries for non-legal audiences. Built for startups, HR teams, and compliance officers who need professional policy documents without hiring a law firm for every draft.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- Internal policy drafting (AUP, data handling, security, remote work)
- Customer-facing legal documents (ToS, Privacy Policy, Cookie Policy)
- Plain-English summaries for help centers and onboarding
- Policy update tracking with version control
- Regulatory requirement translation into specific provisions

## Sample Output
```
Acceptable Use Policy v1.0

Sections:
  1. Purpose
  2. Permitted Use
  3. Prohibited Use (4 subsections)
  4. Enforcement
  5. Reporting Violations
  6. Changes to This Policy

Legal review needed: Sections 3.1, 4
Ready for: Help center summary, FAQ generation
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| jurisdiction | US | Legal jurisdiction for requirements |
| audience | external | Internal or customer-facing |
| reading_level | professional | Language complexity target |
| version_tracking | enabled | Track policy version history |
| review_flags | enabled | Flag sections needing legal review |

## Integrations
- Google Docs / Notion (document drafting)
- Telegram / Slack / Discord
- Confluence (policy management)
- GitHub (version control for policies)
- Markdown export (for static sites)
