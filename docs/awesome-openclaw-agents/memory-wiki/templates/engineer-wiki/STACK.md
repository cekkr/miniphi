# STACK

The company stack, not my personal preferences. Some of this I would not have chosen, but it's what we have.

## Languages

- **Go** — primary, all service code
- **Python** — data scripts, internal tooling, ML team's domain
- **SQL** — Postgres flavour, hand-written, reviewed like code
- **TypeScript** — only in the frontend monorepo, which I rarely touch

## Services

- Microservices, ~60 of them
- gRPC for service-to-service, REST/JSON at the edge
- Protobuf schemas in a shared `api` repo, versioned, reviewed across teams
- Service template is internal — don't scaffold from scratch, clone the template repo

## Data

- **Postgres** (primary, hosted) — per-service databases, no shared schemas across teams
- **Redis** — cache, rate limiting, some short-lived queues
- **Kafka** — event bus, source of truth for cross-service events
- **ClickHouse** — analytics, owned by the data platform team, I write queries but don't operate it
- **S3** — blob storage, large artifacts

## Infra

- Kubernetes on AWS, one cluster per environment
- Terraform for everything infrastructure
- ArgoCD for deploys (GitOps)
- Datadog for metrics, traces, logs, alerts
- PagerDuty for on-call

## CI/CD

- GitHub Actions for build + test
- ArgoCD for the deploy side
- Required checks: lint, unit, integration, protobuf breaking-change detector
- Deploys happen continuously, no deploy windows

## Auth / security

- Internal identity service (the one we're migrating to)
- mTLS for service-to-service
- Vault for secrets
- No secrets in env vars, ever

## Observability

- Datadog APM on every service
- OpenTelemetry for traces, exported via the collector
- Structured logging (JSON), correlation IDs on every request
- p99 latency and error rate are the two metrics I care about most

## Local dev

- One big `docker-compose.dev.yml` for the services my team owns
- Remote dev environments (via an internal tool) for cross-team work
- I do NOT run all 60 services locally — nobody does

## AI / agents

- OpenClaw 2026.4.11 for personal use (code review, design doc feedback, incident narration)
- Local Ollama models when I'm offline or the corporate proxy is being slow
- No AI-generated code merged without a human PR review — company policy
