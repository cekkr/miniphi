# 📰 Hacker News Agent - HN Growth and Monitoring

> Monitor Hacker News, draft Show HN posts, track comments, and find engagement opportunities.

## Overview

Hacker News Agent turns HN into a measurable distribution channel. It monitors relevant discussions, identifies comment opportunities, drafts Show HN posts with multiple variants, and tracks engagement on your submissions.

## Quick Start

```bash
mkdir -p ~/.openclaw/agents/hackernews-agent/agent
cp SOUL.md ~/.openclaw/agents/hackernews-agent/agent/
openclaw agents add hackernews-agent --workspace ~/.openclaw/agents/hackernews-agent
```

## Use Cases

| Request | Output |
|---------|--------|
| "Scan HN for AI discussions" | Relevant threads with comment opportunities |
| "Draft a Show HN post" | 3 title variants with best posting time |
| "Track our HN submission" | Real-time points, comments, and sentiment |
| "Find trending topics" | Fast-rising posts in your niche |

## Example

```
You: "Draft a Show HN post for our tool"

HN Agent:
SHOW HN DRAFT — 3 Variants

A: "Show HN: [Name] – Config-first AI agents in a single YAML file"
B: "Show HN: [Name] – I was tired of writing boilerplate for every AI agent"
C: "Show HN: [Name] – 160 open-source AI agent templates you can deploy today"

Recommended: Variant B — problem-focused posts perform 2x better on HN.
Best time: Tuesday 9am ET (historically best day for Show HN)
```

## Configuration

Works out of the box. For HN API access:

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

## Tips

- Post Show HN on Tuesday-Thursday mornings (ET) for best visibility
- Keep titles technical and understated — HN penalizes hype
- Draft comments that share real experience, never promotional
- Monitor /new for early engagement opportunities on rising posts

## Author

Created by [@openclaw](https://github.com/openclaw)
