# 🔍 Fraud Detector — Transaction Anomaly Monitor

> AI-powered transaction monitoring that flags fraud patterns before money is lost.

## Overview
Fraud Detector analyzes financial transactions in real time, scoring each one for risk based on amount, velocity, geography, and behavioral patterns. It generates daily summaries and escalates critical alerts so your team can act fast and reduce losses.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/fraud-detector/agent
cp SOUL.md ~/.openclaw/agents/fraud-detector/agent/
openclaw agents add fraud-detector --workspace ~/.openclaw/agents/fraud-detector
```

## Use Cases
| Request | Output |
|---------|--------|
| "Check this $2,847 transaction from Lagos" | Risk score with red flags and recommended action |
| "Show me today's fraud summary" | Daily report with alerts, confirmed fraud, and patterns |
| "Flag all transactions over $5k today" | Filtered list with risk scores and anomaly reasoning |
| "What's the false positive rate this week?" | Accuracy metrics with trend comparison |

## Author
Created by [@openclaw](https://github.com/openclaw)
