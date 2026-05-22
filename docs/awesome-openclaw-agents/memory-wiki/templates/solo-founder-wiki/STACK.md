# STACK

Everything I reach for by default. If you're proposing something not on this list, justify the switch.

## Languages

- **TypeScript** — primary, for everything web
- **Python** — scripts, analytics, one-off data work
- **Bash** — glue, deploy scripts

## Web / frontend

- Next.js 15 (App Router)
- Tailwind CSS
- shadcn/ui for components
- Framer for landing pages (non-devs can edit without asking me)

## Backend / data

- Node.js runtime, TypeScript everywhere
- Postgres (hosted) for relational data
- Prisma for schema + migrations
- Redis for rate limiting and session cache

## Infra

- Vercel for web apps and API routes
- Cloudflare for DNS, R2 for object storage
- GitHub Actions for CI
- No Kubernetes, no Docker Compose circus — keep it flat

## Payments

- Stripe Checkout for subscriptions and one-time
- Webhook handler logs every event to Postgres before acting on it
- Refund policy: no-questions-asked within 7 days

## Analytics / observability

- Mixpanel for product analytics (free plan, Export API + local Python)
- GA4 for marketing pages
- Google Search Console for SEO
- Sentry for errors
- Plain log files for everything else

## Auth

- Firebase Auth for consumer products
- Magic links preferred over passwords

## AI / agents

- OpenClaw 2026.4.11 as the daily driver
- Local Ollama models (gemma4, qwen3) when I don't want to burn API credits
- Frontier API only for the hard stuff — research, long-form writing, code review

## Tools I actually open every day

- VS Code
- iTerm2 + zsh
- Linear for personal tasks
- Notion for reports and runbooks
- Telegram for mobile notifications from my own bots

## Banned list

- ORMs that hide SQL completely — I want to see the query
- Anything that requires a docker-compose file to run locally
- Frameworks younger than 6 months in production
