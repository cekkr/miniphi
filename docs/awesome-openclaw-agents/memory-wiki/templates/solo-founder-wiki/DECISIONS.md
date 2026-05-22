# DECISIONS

Append-only. Never delete an entry — if a decision is reversed, add a new entry that says so and reference the original by date.

Format:

```
## YYYY-MM-DD — short title
Decision: ...
Why: ...
Trade-off accepted: ...
```

---

## 2025-11-14 — Subscriptions for primary product, one-time for secondary
Decision: Primary product is monthly subscription, secondary product is one-time bundles.
Why: Primary has ongoing API costs per user (LLM calls). Secondary has near-zero marginal cost after sale.
Trade-off accepted: Two Stripe configurations to maintain, two different refund flows.

## 2025-12-02 — No freemium on primary product
Decision: 7-day trial with card on file, no free tier.
Why: Free tier users never converted at a rate that paid for their costs.
Trade-off accepted: Lower top-of-funnel signups, better economics on who does sign up.

## 2026-01-18 — Stay on Postgres, do not switch to SQLite + LiteFS
Decision: Keep hosted Postgres.
Why: I tried LiteFS for a weekend and the replication edge cases cost me a full day. Postgres is boring and works.
Trade-off accepted: $20/mo more than the SQLite path.

## 2026-02-09 — OpenClaw as primary agent runner, not Cursor or plain API
Decision: Daily driver for all agent work is OpenClaw.
Why: I want local-first, I want to own the memory layer, and SOUL.md is portable in a way that IDE-specific configs aren't.
Trade-off accepted: Fewer visual niceties than commercial IDE integrations.

## 2026-03-04 — Kill the mobile app idea for primary product
Decision: No mobile app for primary product in 2026.
Why: 92% of usage is desktop. Mobile would be six weeks of work for maybe 3% more revenue.
Trade-off accepted: Some users will complain. They can use the mobile web version.

## 2026-04-01 — Adopt the memory-wiki pattern for all my agents
Decision: Wire a memory-wiki into every OpenClaw agent I run.
Why: Session startup token cost was eating $3-5/day in API calls before the agent said anything useful.
Trade-off accepted: I have to actually maintain the wiki. Reviewing it every Monday.
