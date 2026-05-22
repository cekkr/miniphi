# :chart_with_upwards_trend: Capacity Planner - Scale Before You Break

> Forecasts infrastructure capacity needs from usage trends with cost-optimized scaling recommendations.

## Overview
Capacity Planner analyzes your historical resource utilization and growth patterns to predict when you will hit capacity limits. It provides three-scenario forecasts with specific scaling recommendations and cost estimates, so you can plan infrastructure changes weeks before they become emergencies.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/capacity-planner/agent
cp SOUL.md ~/.openclaw/agents/capacity-planner/agent/
openclaw agents add capacity-planner --workspace ~/.openclaw/agents/capacity-planner
```

## Use Cases
| Request | Output |
|---------|--------|
| "When will our database need an upgrade?" | 3-scenario timeline with cost comparison of vertical vs. horizontal scaling |
| "Right-size our staging environment" | Resource audit with downsizing recommendations and monthly savings |
| "Model infrastructure for 10x growth" | Full stack scaling plan with timeline, costs, and migration steps |

## Author
Created by [@openclaw](https://github.com/openclaw)
