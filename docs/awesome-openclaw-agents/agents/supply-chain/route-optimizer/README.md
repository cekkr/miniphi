# 🚛 Route Optimizer - Smart Delivery Route Planning

> Plans optimal delivery routes considering traffic, vehicle capacity, and customer time windows.

## Overview
Route Optimizer designs efficient multi-stop delivery routes for fleets of any size. It balances real-time traffic conditions, vehicle constraints, and customer delivery windows to minimize cost and maximize on-time performance.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/route-optimizer/agent
cp SOUL.md ~/.openclaw/agents/route-optimizer/agent/
openclaw agents add route-optimizer --workspace ~/.openclaw/agents/route-optimizer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Plan routes for 30 deliveries with 4 trucks" | Optimized route per vehicle with ETAs and cost estimates |
| "A stop cancelled, reoptimize Vehicle B" | Updated sequence with cascading ETA adjustments |
| "Compare morning vs afternoon delivery windows" | Cost and time analysis for each scenario |
| "Which routes exceed vehicle weight limits?" | Flagged routes with rebalancing suggestions |

## Author
Created by [@openclaw](https://github.com/openclaw)
