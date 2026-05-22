# WORKING

> This is the only file the agent is allowed to overwrite. Everything else is human-maintained.

Last updated: 2026-04-13

## Current focus

Identity service migration — the checkout team is the last hard one. Everything else on my plate is second priority until they're unblocked.

## In flight this week

- [ ] Review the session-cookie compatibility shim PR from the checkout team
- [ ] Write the design doc for p99 latency cuts on the data access layer — two candidate approaches
- [ ] Pair with one of the mids on their oncall-playbook refresh for the Kafka lag alert
- [x] Deprecation timeline for legacy users service shared in #platform
- [x] Memory-wiki wired into my personal OpenClaw agent

## Blocked / waiting

- Waiting on data platform team to confirm the Kafka upgrade window for next month — blocks the identity service final cutover
- Waiting on security review of the new mTLS config for the migration — filed Tuesday, their SLA is 5 business days

## On-call / incidents

- I'm on primary rotation next week (April 20-26)
- Last week's p1: Redis failover on the notifications service, root cause was a connection pool exhaustion on the client side. Fix is in, postmortem draft is in the shared doc.

## Next up (not started)

- Retire the old deploy webhook handler — it's been shadowed by ArgoCD for three months, nobody uses it, pull it out
- Look into the ClickHouse query that feeds the platform-health dashboard, it got 4x slower after their schema change

## Notes for next session

- Do not let the p99 design doc slip to next month — it slipped last month, can't slip again
- When pairing on the oncall-playbook refresh, remember the new hire doesn't know what "quorum loss" means yet — define terms
- If checkout team pushes back again on the shim, escalate to their tech lead, don't try to negotiate it myself
