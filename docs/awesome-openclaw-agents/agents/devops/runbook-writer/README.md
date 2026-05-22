# :notebook: Runbook Writer - Never Get Paged Without a Plan

> Generates step-by-step operational runbooks from incident history and system architecture.

## Overview
Runbook Writer turns your system architecture and past incidents into clear, numbered runbooks that any on-call engineer can follow under pressure. Each runbook includes symptoms, prerequisites, exact CLI commands, verification checks, rollback plans, and escalation paths.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/runbook-writer/agent
cp SOUL.md ~/.openclaw/agents/runbook-writer/agent/
openclaw agents add runbook-writer --workspace ~/.openclaw/agents/runbook-writer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Write a runbook for Kubernetes node not ready" | Step-by-step triage with kubectl commands, drain procedure, escalation matrix |
| "Convert last week's RDS failover incident into a runbook" | Preventive runbook with monitoring thresholds and automated checks |
| "Create an escalation matrix for our payment system" | Tiered contact chain with SLA timers and communication templates |

## Author
Created by [@openclaw](https://github.com/openclaw)
