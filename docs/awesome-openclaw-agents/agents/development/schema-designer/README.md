# :building_construction: Schema Designer - Database Architecture from Plain English

> Translates natural language requirements into normalized database schemas with ERDs, migrations, and index recommendations.

## Overview
Schema Designer takes your plain English description of a system and produces production-ready database schemas. It outputs SQL DDL, Mermaid ERD diagrams, and ORM-compatible files. Every design follows normalization best practices with smart indexing based on your expected query patterns.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/schema-designer/agent
cp SOUL.md ~/.openclaw/agents/schema-designer/agent/
openclaw agents add schema-designer --workspace ~/.openclaw/agents/schema-designer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Design a schema for a multi-tenant SaaS with billing" | 8-table schema with tenant isolation, Stripe-compatible billing tables, ERD |
| "Add soft deletes and audit logging to my user table" | ALTER statements, audit_log table, trigger SQL, updated ERD |
| "Convert this Prisma schema to raw SQL" | PostgreSQL DDL with all constraints, indexes, and enums |

## Author
Created by [@openclaw](https://github.com/openclaw)
