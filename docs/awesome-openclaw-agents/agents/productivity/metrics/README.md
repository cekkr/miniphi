# 📊 Pulse - The Metrics Agent

> Your AI analytics runner that pulls data from Mixpanel, Stripe, GA4, and GSC on command.

## Overview

Pulse is a script runner for your analytics stack:

- Pulls funnel data from Mixpanel
- Checks revenue and subscriptions from Stripe
- Monitors traffic from GA4 and Search Console
- Detects anomalies and alerts via Telegram

## Quick Start

### Installation

```bash
mkdir -p ~/.openclaw/agents/metrics/agent
cp SOUL.md ~/.openclaw/agents/metrics/agent/

openclaw agents add metrics --workspace ~/.openclaw/agents/metrics
```

### Setup Scripts

```bash
# Install dependencies
npm install dotenv

# Configure credentials in .env
cp .env.example .env
# Add your Mixpanel, Stripe, GA4, GSC credentials
```

### First Conversation

```bash
openclaw chat metrics "funnel today"
```

## Use Cases

### 1. Daily Funnel
```
You: "funnel today"
Pulse: [Full Mixpanel funnel with signup, query, checkout conversion rates]
```

### 2. Revenue Check
```
You: "stripe"
Pulse: [Revenue, new subs, cancels, failed payments, MRR]
```

### 3. Traffic Report
```
You: "traffic"
Pulse: [GA4 sessions by source, top pages, trends]
```

### 4. Full Report
```
You: "full report"
Pulse: [Runs all scripts: funnel + traffic + stripe + GSC]
```

## Example Outputs

### Funnel

```
AI2SQL Funnel for Feb 16:

Signup Page       80u   126t
Signup Done       36u    38t (45%)
Query             37u    83t (86%)
Checkout Done      2u     2t (50%)

Overall: 80 → 2 paid (2.5%)
```

### Stripe

```
Revenue: $58.00
New subs: 2 | Cancels: 0
Failed: 1
MRR: $3,420
```

## Supported Integrations

| Service | Script | Credentials |
|---------|--------|-------------|
| Mixpanel | `mixpanel-funnel.cjs` | API Secret |
| Stripe | `stripe-report.cjs` | Secret Key |
| GA4 | `ga4-traffic.cjs` | Service Account JSON |
| GSC | `gsc-report.cjs` | Service Account JSON |

## Tips

1. **Set up heartbeat** - Auto-run alert checks every hour
2. **Use date arguments** - `funnel 2026-02-10 2026-02-16` for date ranges
3. **Keep scripts compact** - Output should fit in a Telegram message (~50 char width)
4. **Check anomalies daily** - `alert check` catches broken funnels

## Changelog

- **v1.0.0** - Initial release with Mixpanel and Stripe
- **v1.1.0** - GA4 and GSC integration
- **v1.2.0** - Anomaly detection and Telegram alerts

## Author

Created by [@openclaw](https://github.com/openclaw)

## License

MIT
