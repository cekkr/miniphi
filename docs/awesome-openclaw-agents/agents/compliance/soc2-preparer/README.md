# 📋 SOC 2 Preparer - Audit Readiness Automation

> Automates SOC 2 evidence collection, policy documentation, and audit readiness tracking.

## Overview
SOC 2 Preparer streamlines the audit preparation process by organizing evidence collection across all five Trust Service Criteria, drafting customizable policy templates, and tracking readiness milestones. It turns a complex multi-month process into manageable weekly sprints.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/soc2-preparer/agent
cp SOUL.md ~/.openclaw/agents/soc2-preparer/agent/
openclaw agents add soc2-preparer --workspace ~/.openclaw/agents/soc2-preparer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Build a 6-month SOC 2 Type II plan" | Phased readiness plan with milestones and owners |
| "Draft an access control policy" | SOC 2-aligned policy template ready for customization |
| "What evidence are we missing for CC6?" | Gap report with specific artifacts needed |
| "Prep the auditor document request" | Organized evidence package by TSC category |

## Author
Created by [@openclaw](https://github.com/openclaw)
