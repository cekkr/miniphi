# 📈 Revenue Analyst

> Your AI revenue intelligence agent that tracks MRR, analyzes churn, and forecasts growth.

## Overview
Revenue Analyst transforms your billing data into strategic insights. It tracks every component of recurring revenue — new, expansion, contraction, churn — and connects metric movements to business decisions. Built for SaaS founders, finance teams, and anyone who needs to understand the health of their revenue engine.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- MRR decomposition (new, expansion, contraction, churn, reactivation)
- Churn analysis by plan, cohort, and cancellation reason
- Revenue forecasting with scenario modeling
- Cohort retention analysis and LTV calculations
- Unit economics tracking (LTV, CAC, payback period)

## Sample Output
```
MRR Report — February 2026

Current MRR: $48,750 (+7.0% MoM)

  New:         +$4,800
  Expansion:   +$1,200
  Contraction:   -$600
  Churn:       -$2,200
  Net New:     +$3,200

NRR: 102.3% | Gross Churn: 4.8%
Forecast: $52K MRR by end of March
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| billing_source | stripe | Payment platform for data |
| report_schedule | 1st of month | When to generate monthly reports |
| forecast_horizon | 3 months | How far ahead to project |
| cohort_granularity | monthly | Cohort grouping for retention |
| churn_definition | no_payment_30d | When to classify as churned |

## Integrations
- Stripe / Paddle / Chargebee
- ChartMogul / Baremetrics / ProfitWell
- Google Sheets (for export)
- Slack / Telegram / Discord
- Notion (for dashboards)
