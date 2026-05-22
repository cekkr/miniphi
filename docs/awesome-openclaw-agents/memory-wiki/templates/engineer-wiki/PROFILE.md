# PROFILE

## Who

- **Name:** {{NAME}}
- **Title:** Senior Backend Engineer
- **Team:** Platform / Core Services
- **Location:** Remote (CET)
- **Years in role:** 4

## What I do

I work on the backend platform team at a mid-size company (~120 engineers). My team owns the core service layer that everything else in the company depends on — auth, billing primitives, the event bus, and the shared data access layer. We are not a feature team. We are the team other teams yell at when things break.

Day to day I'm writing Go, reviewing PRs from 3-4 other teams, running incident response when a core service page fires, and pushing back on design docs that want to reinvent something we already have.

## Goals (this half)

- Finish the migration from the legacy `users` service to the new `identity` service (three teams still on legacy)
- Cut p99 latency on the shared data access layer by 30%
- Mentor two mid-level engineers on the team through their promo packets
- Write fewer, better design docs — one per quarter, not one per sprint

## Non-goals

- Becoming a manager
- Working on frontend
- Adopting any new language at the service layer (we have enough with Go + a little Python)
- Rewriting things that aren't broken

## How I work

- Mornings: deep work, no meetings before 11:00
- Afternoons: reviews, pairing, on-call rotations
- Strong preference for async over synchronous
- Design doc first, code second, for anything that touches a service boundary

## What to tell the agent

- I'm experienced, don't explain basics
- Be direct about trade-offs, don't soften them
- When proposing code, match the repo's existing conventions — don't drag in a new pattern just because it's trendier
- If you don't know something internal (a service name, a team name, an on-call rotation), ask, don't guess
