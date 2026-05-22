# 🔭 Scout - The Competitor Watch

> Your AI competitor analyst that monitors pricing, features, and market moves.

## Overview

Scout keeps you informed about the competition:

- Monitors competitor websites for changes
- Compares pricing and features
- Alerts on significant market moves
- Weekly competitive digest

## Quick Start

### Installation

```bash
mkdir -p ~/.openclaw/agents/competitor-watch/agent
cp SOUL.md ~/.openclaw/agents/competitor-watch/agent/

openclaw agents add competitor-watch --workspace ~/.openclaw/agents/competitor-watch
```

### First Conversation

```bash
openclaw chat competitor-watch "Competitor update"
```

## Use Cases

### 1. Weekly Digest
```
You: "Competitor update"
Scout: [Changes by competitor, impact assessment, recommended actions]
```

### 2. Pricing Comparison
```
You: "Pricing comparison"
Scout: [Table of all competitors with tiers, your positioning]
```

### 3. Feature Gap Analysis
```
You: "What features do competitors have that we don't?"
Scout: [Feature matrix with gaps and priorities]
```

### 4. Market Trends
```
You: "What should we watch for?"
Scout: [Key trends, shifts, strategic recommendations]
```

## Example Outputs

### Weekly Digest

```
Competitive Digest - Feb 16

1. SQLChat: Launched free tier (was $12 min)
   → May attract price-sensitive users
   → Action: Highlight AI quality advantage

2. Text2SQL: Raised pricing $9→$15
   → Opens gap at $5-10 price point
   → Action: Capture their budget users

No new entrants this week.
```

### Pricing Table

```
| Tool    | Free | Basic  | Pro    |
|---------|------|--------|--------|
| AI2SQL  | 2 q  | $5/mo  | -      |
| SQLChat | Yes  | $12/mo | $29/mo |
| Text2SQL| No   | $15/mo | $29/mo |

Your position: Cheapest paid tier.
```

## Tips

1. **Define your competitors** - Give Scout a list of 3-5 to monitor
2. **Check weekly** - Markets move fast
3. **Focus on actions** - Every insight should lead to a decision
4. **Track over time** - Patterns matter more than single changes

## Changelog

- **v1.0.0** - Initial release with competitor monitoring
- **v1.1.0** - Pricing comparison tables
- **v1.2.0** - Feature gap analysis

## Author

Created by [@openclaw](https://github.com/openclaw)

## License

MIT
