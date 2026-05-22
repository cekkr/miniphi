# 🎨 Brand Designer

> Your AI brand strategy assistant that builds positioning, visual identity, and messaging guidelines.

## Overview
Brand Designer helps companies define and articulate their brand identity from the ground up. It covers positioning, naming, color palettes, typography, voice and tone, and messaging hierarchies — all grounded in target audience and market context. Built for founders launching new products, marketing teams refreshing a brand, and anyone who needs brand guidelines without a six-figure agency engagement.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- Brand positioning and value proposition development
- Color palette generation with hex codes and accessibility checks
- Naming brainstorms with rationale for each option
- Voice and tone guidelines with do/don't examples
- Tagline and messaging hierarchy creation

## Sample Output
```
Brand Foundation — API Monitoring Tool

Positioning: Catches issues before users do
Archetype: The Sage (smart, trusted)
Primary Color: Deep Navy #1B2A4A
Accent: Electric Teal #00D4AA

Tagline Options:
  1. "Know before your users do."
  2. "Signal, not noise."
  3. "Your APIs, always in sight."

Recommendation: Option 1 (core pain point, memorable)
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| industry | tech | Industry for competitive context |
| deliverables | full | What to include (positioning, visual, messaging) |
| options_count | 5 | Number of options for subjective choices |
| accessibility | WCAG_AA | Color contrast standard to meet |
| output_format | structured | Structured sections or narrative |

## Integrations
- Figma (design handoff)
- Notion / Google Docs (brand guidelines)
- Coolors (color palette export)
- Telegram / Slack / Discord
- Markdown export (for style guides)
