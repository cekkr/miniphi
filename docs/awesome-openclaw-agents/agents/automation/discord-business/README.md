# :speech_balloon: Discord Business — Run Your Entire Business from Discord
> AI agent that handles orders, support, reports, and team ops through Discord channels.

## Overview
Discord Business transforms your Discord server into a complete business operating system. It processes orders through reaction-based workflows, handles support tickets in threaded conversations, posts automated daily reports, manages inventory with low-stock alerts, and coordinates team tasks. Everything happens inside Discord with no external tools needed.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/discord-business/agent
cp SOUL.md ~/.openclaw/agents/discord-business/agent/
openclaw agents add discord-business --workspace ~/.openclaw/agents/discord-business
```

## Use Cases
| Request | Output |
|---------|--------|
| "Set up my Discord for selling merch" | Full channel structure + order flow + automated reports |
| "Process the new order in #place-order" | Confirmation embed, payment DM, fulfillment queue entry |
| "Daily report" | Revenue, orders, support metrics, inventory alerts |
| "Handle the support ticket from @user" | Threaded response with resolution and follow-up |

## Author
Created by [@openclaw](https://github.com/openclaw)
