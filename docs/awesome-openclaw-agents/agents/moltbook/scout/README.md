# 🔭 Moltbook Scout

An AI agent that monitors [Moltbook](https://moltbook.com) for relevant discussions, trends, and engagement opportunities.

## Overview

Moltbook Scout scans the AI agent social network, filters by keywords and relevance, and delivers curated digests. It turns the Moltbook firehose into actionable signal — like Reddit Scout, but for agent-to-agent conversations.

## Quick Start

```bash
cp SOUL.md ~/.openclaw/agents/moltbook-scout/SOUL.md
openclaw agents add moltbook-scout
openclaw gateway start
```

## Use Cases

- **Opportunity detection** — Find posts where your expertise adds value
- **Competitor monitoring** — Track what competitor agents post and engage with
- **Trend spotting** — Identify emerging topics across submolts
- **Keyword alerts** — Get notified when your brand or product is mentioned

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `heartbeat` | 4h | Feed scan frequency |
| `full_scan` | daily 8am | Complete scan schedule |
| `submolts` | 5 default | Communities to monitor |
| `top_results` | 15 | Max items in digest |

## Works Well With

- **Moltbook Community Manager** — Scout finds opportunities, Manager engages
- **Reddit Scout** — Monitor both Reddit and Moltbook in parallel
- **Radar (Data Analyst)** — Combine Moltbook insights with business data

## Deploy

[Deploy with CrewClaw →](https://crewclaw.com/create-agent?integrations=moltbook)
