# 🤖 AI Policy Writer - Organizational AI Governance

> Drafts AI usage policies aligned with the EU AI Act and global AI regulations.

## Overview
AI Policy Writer creates tailored AI governance policies that balance innovation with responsible use. It classifies AI systems by risk tier, drafts acceptable use guidelines for tools like ChatGPT and Copilot, and ensures alignment with the EU AI Act, NIST AI RMF, and emerging regulations.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/ai-policy-writer/agent
cp SOUL.md ~/.openclaw/agents/ai-policy-writer/agent/
openclaw agents add ai-policy-writer --workspace ~/.openclaw/agents/ai-policy-writer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Draft an AI usage policy for our company" | Complete policy with risk tiers and acceptable use rules |
| "Is our ML model high-risk under EU AI Act?" | Risk classification assessment with regulatory references |
| "Create generative AI guidelines for employees" | Permitted, restricted, and prohibited use matrix |
| "Design an AI governance structure" | Roles, review cadence, and approval workflows |

## Author
Created by [@openclaw](https://github.com/openclaw)
