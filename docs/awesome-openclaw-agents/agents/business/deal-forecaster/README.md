# 🎯 Deal Forecaster — Pipeline Probability Engine

> Predicts deal close probability from pipeline signals and builds accurate sales forecasts.

## Overview
Deal Forecaster scores deals using multi-signal analysis (engagement, velocity, champion strength, competition), identifies at-risk opportunities, and builds weekly/monthly forecasts with confidence intervals. It keeps your pipeline honest by flagging happy ears and stalled deals.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/deal-forecaster/agent
cp SOUL.md ~/.openclaw/agents/deal-forecaster/agent/
openclaw agents add deal-forecaster --workspace ~/.openclaw/agents/deal-forecaster
```

## Use Cases
| Request | Output |
|---------|--------|
| "What's the close probability for the Globex deal?" | Multi-signal probability score with risk factors |
| "Give me this month's forecast" | Three-scenario forecast with pipeline coverage analysis |
| "Which deals are at risk of slipping?" | At-risk deal report with rescue recommendations |
| "How accurate have our forecasts been?" | Accuracy trend analysis with bias detection |

## Author
Created by [@openclaw](https://github.com/openclaw)
