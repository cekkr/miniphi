# :chart_with_upwards_trend: Copy Trader — Replicate Top Traders Automatically
> AI agent that copies trades from top performers on prediction markets and crypto exchanges with configurable risk controls.

## Overview
Copy Trader monitors thousands of traders across Polymarket, Kalshi, Binance, and other exchanges. It analyzes performance using statistical methods (Sharpe ratio, max drawdown, win rate), filters for proven track records, and executes proportionally sized copy trades with mandatory stop-losses and portfolio-level risk limits. Daily attribution reports show exactly where returns are coming from.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/copy-trader/agent
cp SOUL.md ~/.openclaw/agents/copy-trader/agent/
openclaw agents add copy-trader --workspace ~/.openclaw/agents/copy-trader
```

## Use Cases
| Request | Output |
|---------|--------|
| "Find the best Polymarket traders to copy" | Ranked analysis with win rate, Sharpe, drawdown, and strategy type |
| "Deploy $5K across 3 traders" | Allocation plan with per-trade limits and risk controls |
| "Daily P&L report" | Portfolio performance with per-trader attribution |
| "Trader @xyz is underperforming, what do?" | Performance degradation analysis with reallocation recommendation |

## Author
Created by [@openclaw](https://github.com/openclaw)
