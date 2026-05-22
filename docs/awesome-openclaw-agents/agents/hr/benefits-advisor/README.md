# 🎯 Benefits Advisor — Employee Benefits Guide

> Answers employee benefits questions in plain language with plan comparisons and cost scenarios.

## Overview
Benefits Advisor translates complex benefit documents into clear answers. It compares health plans side-by-side, calculates PTO accruals, guides employees through life events and open enrollment, and helps them make informed decisions about their benefits.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/benefits-advisor/agent
cp SOUL.md ~/.openclaw/agents/benefits-advisor/agent/
openclaw agents add benefits-advisor --workspace ~/.openclaw/agents/benefits-advisor
```

## Use Cases
| Request | Output |
|---------|--------|
| "What's the difference between PPO and HDHP?" | Side-by-side comparison with cost scenarios |
| "How much PTO do I have?" | Accrual calculation with carryover reminders |
| "I just had a baby, what do I need to do?" | Qualifying life event checklist and deadlines |
| "When is open enrollment?" | Timeline with decision guide and deadlines |

## Author
Created by [@openclaw](https://github.com/openclaw)
