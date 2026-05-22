# 💰 Ledger - The Invoice Tracker

> Your AI payment monitor that tracks revenue, alerts on failed payments, and reports MRR.

## Overview

Ledger keeps your finances visible:

- Monitors Stripe/PayPal for payments in real time
- Alerts immediately on failed payments
- Tracks MRR, churn, and revenue trends
- Chases overdue invoices automatically

## Quick Start

### Installation

```bash
mkdir -p ~/.openclaw/agents/invoice-tracker/agent
cp SOUL.md ~/.openclaw/agents/invoice-tracker/agent/

openclaw agents add invoice-tracker --workspace ~/.openclaw/agents/invoice-tracker
```

### First Conversation

```bash
openclaw chat invoice-tracker "Today's revenue"
```

## Use Cases

### 1. Daily Revenue
```
You: "Today's revenue"
Ledger: [Payments received, breakdown by plan, failed payments, MRR]
```

### 2. Failed Payment Alert
```
Ledger (auto): "Failed payment: $29 from sarah@acme.com. Card expired. Retry in 3 days."
```

### 3. Overdue Invoices
```
You: "Overdue invoices"
Ledger: [List with amounts, days overdue, actions taken]
```

### 4. Monthly Summary
```
You: "January summary"
Ledger: [Revenue, new subs, cancellations, net MRR change, comparison]
```

## Example Outputs

### Daily Revenue

```
Revenue - Feb 16

Payments: 4 ($127.00)
- Pro Monthly ($29): 3 payments
- Team Monthly ($49): 1 payment

Failed: 1 ($29, retry scheduled)
MRR: $3,420 (+$78)
```

### Monthly Summary

```
January 2026

Revenue: $3,890 gross / $3,512 net
New subs: 12 | Cancels: 3
Net MRR: +$261

Top plan: Pro Monthly (68%)
Payment success: 94.2%
vs December: +18% revenue
```

## Tips

1. **Set up failed payment alerts** - Every failed payment is potential churn
2. **Check MRR daily** - Small changes compound fast
3. **Review overdue weekly** - Don't let invoices age past 30 days
4. **Celebrate milestones** - Ledger tracks MRR records for you

## Changelog

- **v1.0.0** - Initial release with Stripe monitoring
- **v1.1.0** - Invoice tracking and reminders
- **v1.2.0** - Monthly reporting and MRR tracking

## Author

Created by [@openclaw](https://github.com/openclaw)

## License

MIT
