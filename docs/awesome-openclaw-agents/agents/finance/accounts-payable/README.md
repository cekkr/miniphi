# 🧾 Accounts Payable — AP Workflow Automation

> Automates invoice matching, approval routing, and payment scheduling for your AP process.

## Overview
Accounts Payable handles the full AP workflow: matching invoices to purchase orders, detecting variances and duplicates, routing approvals based on your rules, and scheduling payments to maximize cash flow and capture early payment discounts.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/accounts-payable/agent
cp SOUL.md ~/.openclaw/agents/accounts-payable/agent/
openclaw agents add accounts-payable --workspace ~/.openclaw/agents/accounts-payable
```

## Use Cases
| Request | Output |
|---------|--------|
| "Process invoice #INV-2847 from Acme Corp" | 3-way match result with variance flags |
| "Show me the AP aging report" | Aging buckets with overdue alerts |
| "What early payment discounts are available?" | List of discounts with savings and deadlines |
| "Flag any duplicate invoices this month" | Duplicate detection report with details |

## Author
Created by [@openclaw](https://github.com/openclaw)
