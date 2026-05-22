# 📦 Inventory Forecaster - Demand Prediction & Reorder Planning

> Predicts stock demand using historical data and generates smart reorder recommendations.

## Overview
Inventory Forecaster analyzes sales patterns, seasonal trends, and market signals to project future demand with confidence intervals. It calculates optimal reorder points and safety stock levels to prevent both stockouts and costly overstock.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/inventory-forecaster/agent
cp SOUL.md ~/.openclaw/agents/inventory-forecaster/agent/
openclaw agents add inventory-forecaster --workspace ~/.openclaw/agents/inventory-forecaster
```

## Use Cases
| Request | Output |
|---------|--------|
| "Why do we keep stocking out on SKU-1042?" | Root cause analysis with corrected reorder points |
| "Forecast Q3 demand for top 10 products" | Monthly projections with confidence ranges |
| "Which items are overstocked right now?" | Dead stock report with markdown recommendations |
| "Set up reorder alerts for warehouse B" | Threshold-based alert schedule per SKU |

## Author
Created by [@openclaw](https://github.com/openclaw)
