# 🔮 Sentinel - The Churn Predictor

> Your AI retention agent that predicts churn, identifies at-risk customers, and suggests actions to keep them.

## Overview

Sentinel helps you retain customers before they leave:

- Scores accounts by churn risk based on behavior
- Alerts when active users go silent
- Suggests personalized retention actions
- Analyzes churn reasons and patterns

## Quick Start

### Installation

```bash
mkdir -p ~/.openclaw/agents/churn-predictor/agent
cp SOUL.md ~/.openclaw/agents/churn-predictor/agent/

openclaw agents add churn-predictor --workspace ~/.openclaw/agents/churn-predictor
```

### First Conversation

```bash
openclaw chat churn-predictor "Churn risk report"
```

## Use Cases

### 1. Weekly Risk Report
```
You: "Churn risk report"
Sentinel: [High/medium/low risk accounts with scores, signals, actions]
```

### 2. Churn Analysis
```
You: "Why did users churn last month?"
Sentinel: [Reasons breakdown, revenue impact, patterns, suggestions]
```

### 3. Re-engagement
```
You: "Draft re-engagement email for Tom"
Sentinel: [Personalized email highlighting new features and value]
```

### 4. Retention Strategy
```
You: "What can we do about price-sensitive churn?"
Sentinel: [Mid-tier plan suggestion, annual discount data, competitor comparison]
```

## Example Outputs

### Risk Report

```
Weekly Churn Risk - Feb 10-16

High Risk (80+): 3 accounts
1. Tom Baker (91) - $49/mo - 12 days inactive
2. Sarah Mills (85) - $29/mo - 2 failed payments
3. Dev Studio (82) - $49/mo - usage dropped 80%

Revenue at risk: $340/mo
Healthy: 142 accounts (92%)
```

### Churn Analysis

```
January: 7 cancellations ($203/mo lost)

Reasons:
- Too expensive: 3
- Switched competitor: 2
- No longer needed: 1
- Payment failed: 1

Pattern: Price churn peaks in month 2-3.
Suggestion: Add mid-tier plan.
```

## Tips

1. **Review risk reports weekly** - Early action prevents churn
2. **Personalize outreach** - Generic emails don't save customers
3. **Track what works** - Note which retention actions lead to saves
4. **Separate voluntary from involuntary** - Different problems, different solutions

## Changelog

- **v1.0.0** - Initial release with risk scoring
- **v1.1.0** - Churn reason analysis
- **v1.2.0** - Re-engagement email drafting

## Author

Created by [@openclaw](https://github.com/openclaw)

## License

MIT
