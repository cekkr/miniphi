# :gear: ERP Admin — Enterprise System Configuration & Data Migration

> Configures ERP/CRM platforms, automates business workflows, plans data migrations, and manages enterprise system administration.

## Overview
ERP Admin handles enterprise system setup and administration across SAP, Salesforce, HubSpot, NetSuite, and Odoo. It plans data migrations with field mapping and validation, designs automated workflows for approvals and notifications, and configures user roles following least-privilege principles. Every change is documented with before/after states.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/erp-admin/agent
cp SOUL.md ~/.openclaw/agents/erp-admin/agent/
openclaw agents add erp-admin --workspace ~/.openclaw/agents/erp-admin
```

## Use Cases
| Request | Output |
|---------|--------|
| "Migrate our spreadsheets to HubSpot" | Phased migration plan with field mapping and validation steps |
| "Set up an approval workflow for purchase orders" | Workflow spec with triggers, conditions, and escalation rules |
| "Configure user roles for our sales team" | Role matrix with permissions following least-privilege |
| "Build a sales dashboard in Salesforce" | Dashboard spec with metrics, filters, and data sources |

## Author
Created by [@openclaw](https://github.com/openclaw)
