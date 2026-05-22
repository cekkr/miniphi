# 🎯 Orion - The Coordinator

<p align="center">
  <img src="../../../assets/orion-icon.png" alt="Orion" width="120">
</p>

> Your AI project manager that breaks down tasks, coordinates workflows, and keeps everything on track.

## Overview

Orion is designed to be the central coordinator of your AI team. It excels at:

- Breaking complex projects into actionable tasks
- Delegating work to specialized agents
- Tracking progress and providing updates
- Delivering daily briefings

## Quick Start

### Installation

```bash
# Clone the agent
mkdir -p ~/.openclaw/agents/orion/agent
cp SOUL.md ~/.openclaw/agents/orion/agent/

# Register with OpenClaw
openclaw agents add orion --workspace ~/.openclaw/agents/orion
```

### First Conversation

```bash
openclaw chat orion "What can you help me with?"
```

## Use Cases

### 1. Project Kickoff
```
You: "I'm starting a new SaaS product"
Orion: [Provides structured breakdown with phases, tasks, and assignments]
```

### 2. Daily Standup
```
You: "Morning briefing please"
Orion: [Summarizes pending tasks, deadlines, and priorities]
```

### 3. Multi-Agent Coordination
```
You: "Create a blog post about AI productivity"
Orion: [Assigns to Echo, tracks progress, delivers final result]
```

## Configuration

### Basic Setup

No additional configuration required. Works out of the box.

### With MCP Tools

Add to `~/.openclaw/agents/orion/agent/mcp.json`:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-fetch"]
    }
  }
}
```

## Example Outputs

### Task Breakdown

```
📋 Project: Website Redesign

Phase 1: Research (Week 1)
├── ✅ Competitor analysis
├── ⏳ User interviews
└── 📋 Design requirements

Phase 2: Design (Week 2-3)
├── 📋 Wireframes
├── 📋 Visual design
└── 📋 Prototype

Phase 3: Development (Week 4-6)
├── 📋 Frontend build
├── 📋 Backend integration
└── 📋 Testing
```

### Morning Briefing

```
☀️ Good morning! Here's your briefing:

📊 Status
• 3 tasks in progress
• 2 awaiting review
• 1 blocked (needs input)

🎯 Today's Priorities
1. Review Echo's blog draft
2. Check Radar's analytics report
3. Team sync at 2pm

⚠️ Attention Needed
• Client proposal due tomorrow
```

## Works Well With

| Agent | Collaboration |
|-------|--------------|
| Echo | Content creation tasks |
| Radar | Data analysis requests |
| DevOps Bot | Technical deployments |

## Tips

1. **Be specific** - "Launch product" vs "Launch product by Friday with email campaign"
2. **Set priorities** - Tell Orion what's most important
3. **Check in daily** - Use morning briefings to stay aligned

## Changelog

- **v1.0.0** - Initial release
- **v1.1.0** - Added multi-agent coordination
- **v1.2.0** - Morning briefing feature

## Author

Created by [@openclaw](https://github.com/openclaw)

## License

MIT
