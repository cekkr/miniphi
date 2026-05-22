# 📊 Portfolio Rebalancer — Investment Allocation Optimizer

> Monitors portfolio drift and recommends tax-aware trades to maintain target allocations.

## Overview
Portfolio Rebalancer compares your current investment positions against target allocations, identifies meaningful drift, and generates specific trade recommendations. It factors in tax implications, transaction costs, and correlation analysis to keep your portfolio aligned with your strategy.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/portfolio-rebalancer/agent
cp SOUL.md ~/.openclaw/agents/portfolio-rebalancer/agent/
openclaw agents add portfolio-rebalancer --workspace ~/.openclaw/agents/portfolio-rebalancer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Rebalance my 60/25/10/5 portfolio to 50/30/15/5" | Specific buy/sell trades with tax considerations |
| "Is my portfolio well-diversified?" | Diversification score with improvement suggestions |
| "Show positions with drift over 5%" | Flagged holdings with recommended actions |
| "Find tax-loss harvesting opportunities" | Loss positions eligible for strategic selling |

## Author
Created by [@openclaw](https://github.com/openclaw)
