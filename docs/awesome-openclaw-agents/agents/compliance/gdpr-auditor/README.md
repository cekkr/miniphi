# 🔒 GDPR Auditor - Privacy Compliance Scanner

> Scans systems for GDPR compliance gaps and generates actionable remediation plans.

## Overview
GDPR Auditor helps organizations identify privacy compliance gaps by auditing data processing activities against GDPR requirements. It maps data flows, flags missing controls, and produces prioritized remediation plans with specific article references.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/gdpr-auditor/agent
cp SOUL.md ~/.openclaw/agents/gdpr-auditor/agent/
openclaw agents add gdpr-auditor --workspace ~/.openclaw/agents/gdpr-auditor
```

## Use Cases
| Request | Output |
|---------|--------|
| "Audit our SaaS for GDPR compliance" | Gap analysis with prioritized remediation plan |
| "Do we need a DPO?" | Article 37 assessment based on your processing activities |
| "Map our personal data flows" | Data flow diagram with processor inventory |
| "Draft a DSAR response process" | Step-by-step workflow with response templates |

## Author
Created by [@openclaw](https://github.com/openclaw)
