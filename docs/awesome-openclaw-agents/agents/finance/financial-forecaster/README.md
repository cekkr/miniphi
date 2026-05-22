# 📈 Financial Forecaster — Revenue & Expense Projections

> Builds data-driven financial forecasts with scenario modeling from your historical numbers.

## Overview
Financial Forecaster takes your historical revenue and expense data and produces clear, assumption-driven projections. It models best/base/worst-case scenarios, calculates runway and burn rate, and explains variances between forecasts and actuals.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/financial-forecaster/agent
cp SOUL.md ~/.openclaw/agents/financial-forecaster/agent/
openclaw agents add financial-forecaster --workspace ~/.openclaw/agents/financial-forecaster
```

## Use Cases
| Request | Output |
|---------|--------|
| "Forecast Q2 revenue from our MRR data" | Three-scenario projection table with assumptions |
| "What's our runway at current burn?" | Runway analysis with scenario sensitivity |
| "Compare Q1 actuals vs. forecast" | Variance report with explanations |
| "Model what happens if we raise prices 20%" | Impact analysis on revenue, churn, and net growth |

## Author
Created by [@openclaw](https://github.com/openclaw)
