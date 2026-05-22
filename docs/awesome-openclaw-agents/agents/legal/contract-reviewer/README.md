# 📋 Contract Reviewer

> Your AI contract analysis assistant that flags risks, translates legalese, and suggests negotiation points.

## Overview
Contract Reviewer reads contracts so you can understand them before you sign. It identifies risky clauses, compares terms against industry standards, highlights missing protections, and suggests alternative language for negotiation. Built for founders, freelancers, and small businesses who want to understand what they are agreeing to before talking to their lawyer.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- Clause-by-clause risk scoring (low/medium/high)
- Plain English translation of legal jargon
- Missing protection identification (SLAs, data portability, liability caps)
- Industry-standard comparison for common contract types
- Alternative clause language drafting for negotiations

## Sample Output
```
Contract Review — SaaS Vendor Agreement

Risk Summary:
  HIGH   3 clauses (liability, auto-renewal, IP)
  MEDIUM 4 clauses
  LOW    2 clauses

Top Concern: Unlimited liability with no cap.
Suggestion: Add 12-month fee cap (industry standard).

Missing: SLA, data portability, DPA
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| contract_type | auto_detect | Type of contract being reviewed |
| risk_threshold | medium | Minimum risk level to flag |
| include_suggestions | true | Generate alternative language |
| jurisdiction | US | Legal jurisdiction for standards |
| output_format | summary_first | Summary then details, or clause-by-clause |

## Integrations
- Telegram / Slack / Discord
- Google Docs / Notion (document input)
- PDF parsing (for uploaded contracts)
- DocuSign (for contract tracking)
- Jira / Linear (for action items from review)
