# PROJECTS

What my team is actually working on, plus the cross-team things I'm plugged into. This is a work file, not a resume — it should reflect reality, including the messy parts.

## {{MAIN_PROJECT}} (primary, this half)

**One-liner:** Migrate the last three teams off the legacy `users` service onto the new `identity` service.

- **Status:** 7 of 10 teams migrated, three left (checkout, notifications, internal-tools)
- **My role:** Tech lead on the platform side, writing the migration playbook, reviewing their PRs
- **Blocker:** Checkout team wants a compatibility shim for their old session cookie format
- **Target:** Fully migrated by end of June, legacy service decommissioned by end of July

## latency-p99-reduction

**One-liner:** Cut p99 on the shared data access layer by 30%.

- **Status:** Research phase, profiling in progress
- **Hypothesis:** Most of the tail is from Redis N+1 patterns in two specific handlers
- **Next step:** Write a design doc with the three candidate fixes, circulate for review
- **Target:** Design doc by end of month, implementation next sprint

## oncall-playbook-refresh

**One-liner:** Our runbooks are 18 months out of date and the new hires can't use them.

- **Status:** I've volunteered to own the refresh for the top 10 alert types
- **My role:** Draft + review, not actually the one typing most of it — pairing with two mid-levels
- **Target:** Top 5 done by end of month

## Cross-team things I'm in the room for

- **Kafka upgrade** — data platform team owns it, I attend the weekly sync because it affects the event bus
- **Frontend monorepo split** — not my problem but they keep asking platform questions, so I'm the unofficial answerer

## Not on my plate

- Anything in the ML platform
- Frontend code
- The mobile apps (we have a whole other org for that)

## Rules for this file

- Two primary projects max. If someone tries to add a third, push back.
- If a project has been in "research phase" for more than 4 weeks, something's wrong — either commit or kill it.
- Cross-team things go in their own section. Don't pretend they're mine.
