# Quickstart: Run Your First OpenClaw Agent

Get a working AI agent running in under 5 minutes. No account needed.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A Telegram bot token ([create one here](https://t.me/BotFather))
- An API key from [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/)

## Setup

### 1. Clone and enter the repo

```bash
git clone https://github.com/mergisi/awesome-openclaw-agents.git
cd awesome-openclaw-agents/quickstart
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your keys:

```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ANTHROPIC_API_KEY=your_anthropic_key
AGENT_NAME=MyAgent
```

### 4. Choose a SOUL.md

Copy any agent template from the `agents/` folder:

```bash
# Example: use the content writer agent
cp ../agents/marketing/echo/SOUL.md ./SOUL.md
```

Or write your own. The SOUL.md defines your agent's personality, skills, and rules.

### 5. Run

```bash
node bot.js
```

Open Telegram, find your bot, and send a message. Your agent is live.

## What's in this folder

| File | Purpose |
|------|---------|
| `bot.js` | Minimal Telegram bot that reads SOUL.md and responds |
| `.env.example` | Environment variables template |
| `package.json` | Node.js dependencies |
| `SOUL.md` | Your agent's personality (copy from templates) |
| `docker-compose.yml` | Optional: run with Docker |

## Run with Docker

```bash
docker-compose up -d
```

## Next Steps

- Browse [50+ agent templates](../agents/) for different roles
- Customize your SOUL.md to fit your needs
- Deploy to production with [CrewClaw](https://crewclaw.com/create-agent) ($9 one-time)
- Add heartbeats, integrations, and multi-agent setups
