# :briefcase: Job Applicant — Apply to 500+ Jobs Overnight
> AI agent that mass-applies to jobs while customizing every resume and cover letter to match each listing.

## Overview
Job Applicant scans job boards, filters listings against your criteria, and submits customized applications at scale. Each resume gets ATS-optimized keyword matching, each cover letter references something specific about the company, and every application is tracked in a pipeline with status updates and follow-up scheduling.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/job-applicant/agent
cp SOUL.md ~/.openclaw/agents/job-applicant/agent/
openclaw agents add job-applicant --workspace ~/.openclaw/agents/job-applicant
```

## Use Cases
| Request | Output |
|---------|--------|
| "Apply to 50 React jobs in NYC, $150K+" | Overnight batch with tiered customization per listing |
| "Customize my resume for this Stripe listing" | ATS-optimized resume with company-specific bullet points |
| "Show my application pipeline" | Tracker with status, customization notes, follow-up dates |
| "Which of my applications are strongest?" | Match scoring with skills gap analysis per role |

## Author
Created by [@openclaw](https://github.com/openclaw)
