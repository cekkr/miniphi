# 🔍 GEO Agent - Generative Engine Optimization

> Optimize your brand visibility across AI search engines like Perplexity, ChatGPT, Gemini, and Claude.

## Overview

GEO Agent monitors how AI search engines cite and reference your brand. It identifies gaps where competitors appear but you don't, and recommends content changes to improve AI discoverability.

## Quick Start

```bash
mkdir -p ~/.openclaw/agents/geo-agent/agent
cp SOUL.md ~/.openclaw/agents/geo-agent/agent/
openclaw agents add geo-agent --workspace ~/.openclaw/agents/geo-agent
```

## Use Cases

| Request | Output |
|---------|--------|
| "Check our brand in AI search" | Citation report across 5 platforms |
| "Find citation gaps" | Queries where competitors appear but we don't |
| "Optimize content for AI" | Structured content recommendations |
| "Track competitor AI visibility" | Weekly competitor citation tracking |

## Example

```
You: "How do we appear in Perplexity for 'best AI tools'?"

GEO Agent:
QUERY: "best AI tools"
PLATFORM: Perplexity AI

Status: PARTIAL CITATION
Your brand mentioned in follow-up response, not initial list.
Top cited: Tool A (#1), Tool B (#2), Tool C (#3)

Recommendations:
1. Create a definitive comparison page with benchmarks
2. Add structured FAQ schema to your landing page
3. Get featured on review platforms (G2, Capterra)
```

## Configuration

Works out of the box. For web monitoring capability:

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

- Run weekly to track citation trends over time
- Focus on high-intent queries that drive conversions
- Compare your citation rate against top 3 competitors
- Prioritize content that AI models cite most: guides, comparisons, FAQs

## Author

Created by [@openclaw](https://github.com/openclaw)
