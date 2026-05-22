# WORKING

> This is the only file the agent is allowed to overwrite. Everything else is human-maintained.

Last updated: 2026-04-13

## Current focus

Primary product, onboarding funnel. The signup → trial conversion is stuck at 3-4% and that's the single biggest lever for MRR this quarter.

## In flight this week

- [ ] Rework the trial welcome modal — 3 steps, show value before asking for payment
- [ ] Wire Mixpanel events for each step of the modal (`Welcome Modal Shown`, `Step Completed`, `CTA Clicked`)
- [ ] Ship the upgrade prompt on the secondary product's export limit
- [x] Memory-wiki wired into daily-driver OpenClaw agent
- [x] Weekly analytics script updated to include welcome-modal funnel

## Blocked / waiting

- GitHub referral banner PR on the secondary product — waiting on my own review, merge by Wednesday
- Vercel env migration for the new Postgres region — needs a 10-minute downtime window, scheduling for Friday morning

## Next up (not started)

- Programmatic SEO: comparison pages for the top 5 competitors on the primary product
- Reddit monitor agent: daily scan of 3 subreddits for mentions, Telegram alerts
- Rewrite the pricing page copy — current copy is 6 months stale

## Notes for next session

- If the welcome modal funnel is still flat after 3 days of data, try variant B (skip the pricing preview entirely)
- Don't forget to ping the open referral-banner PR before EOD Wednesday
- Check if the Stripe webhook rebuild from last week is still logging every event before acting
