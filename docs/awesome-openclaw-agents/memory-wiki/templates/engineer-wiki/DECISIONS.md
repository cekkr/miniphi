# DECISIONS

Append-only. Never delete. If something gets reversed, add a new dated entry and reference the old one.

Format:

```
## YYYY-MM-DD — short title
Decision: ...
Why: ...
Trade-off accepted: ...
```

---

## 2024-09-11 — Per-service Postgres, no shared schemas
Decision: Each service owns its own Postgres database. No cross-service JOINs.
Why: Every shared-schema situation we had ended in a release coupling disaster.
Trade-off accepted: More data duplication, more care needed on eventual consistency.

## 2024-12-03 — gRPC internal, REST at the edge
Decision: All service-to-service traffic is gRPC. Only the edge gateway speaks REST/JSON.
Why: Typed contracts, faster serialization, better tooling for streaming.
Trade-off accepted: Steeper onboarding for new engineers, debugging requires grpcurl.

## 2025-02-22 — Kafka as source of truth for cross-service events
Decision: The event bus is the system of record for cross-service events. No direct "service A calls service B" for things that should be events.
Why: Direct calls created outage blast radius — A goes down, B goes down, C goes down.
Trade-off accepted: Eventual consistency edge cases we have to think about carefully.

## 2025-06-18 — New identity service, deprecate legacy users service
Decision: Build the new `identity` service, migrate everyone off the 7-year-old `users` service.
Why: Legacy service had a data model we could no longer extend without ugly workarounds.
Trade-off accepted: ~9 months of migration work across 10 teams. Worth it.

## 2025-10-04 — Datadog for APM, no self-hosted alternative
Decision: Stay on Datadog.
Why: We evaluated self-hosted alternatives over a hackweek. The operational cost was higher than the license cost for a team our size.
Trade-off accepted: Vendor lock-in, line item on the budget.

## 2026-01-15 — Design doc required before any new service
Decision: No new service is created without a reviewed design doc. Template is in the internal wiki.
Why: Three services shipped in 2025 that duplicated functionality of existing services.
Trade-off accepted: Slower to start, fewer mistakes downstream.

## 2026-03-20 — OpenClaw allowed for personal productivity, not for merged code
Decision: Engineers can use OpenClaw for design doc drafting, code review prep, and incident narration. AI-generated code still needs a human PR author.
Why: We want the speedup without shipping unreviewed model output.
Trade-off accepted: Some friction in the happy path.
