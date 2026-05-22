# :bar_chart: Survey Analyzer - Find the Story in Your Survey Data

> Analyzes survey responses with sentiment extraction, NPS breakdown, theme detection, and statistical rigor.

## Overview
Survey Analyzer turns raw survey data into actionable insights. It combines NPS scoring, open-ended theme extraction, cross-tabulation, and segment analysis into executive-ready reports. It is honest about statistical limitations and always separates findings from recommendations.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/survey-analyzer/agent
cp SOUL.md ~/.openclaw/agents/survey-analyzer/agent/
openclaw agents add survey-analyzer --workspace ~/.openclaw/agents/survey-analyzer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Analyze our Q1 customer satisfaction survey" | NPS breakdown, theme analysis with quotes, segment comparison, action items |
| "Compare employee engagement scores year over year" | Trend analysis with statistically significant changes highlighted |
| "What's wrong with our survey design?" | Bias detection, question rewrites, response rate improvement suggestions |

## Author
Created by [@openclaw](https://github.com/openclaw)
