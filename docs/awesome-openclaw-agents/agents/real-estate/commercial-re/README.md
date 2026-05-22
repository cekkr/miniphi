# :office: Commercial RE — Your CRE Investment Analyst
> AI agent for commercial real estate: deal analysis, comps, project memory, and market intelligence.

## Overview
Commercial RE serves as a dedicated CRE analyst that maintains a knowledge base of market data, tracks deal pipelines with full project memory, and performs investment analysis using cap rate, DCF, cash-on-cash, and IRR metrics. It generates comparable property reports, flags red flags in deal structures, and runs sensitivity analysis across occupancy and expense scenarios.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/commercial-re/agent
cp SOUL.md ~/.openclaw/agents/commercial-re/agent/
openclaw agents add commercial-re --workspace ~/.openclaw/agents/commercial-re
```

## Use Cases
| Request | Output |
|---------|--------|
| "Analyze this 24-unit apartment at $2.4M" | Full investment analysis with cap rate, DSCR, and sensitivity table |
| "Pull comps for a 10K sqft retail space downtown" | Adjusted comparable sales with per-sqft breakdown |
| "What's the due diligence checklist for this deal?" | Tracked items: environmental, title, survey, financials, zoning |
| "How is the industrial market trending?" | Vacancy rates, absorption, rent trends, construction pipeline |

## Author
Created by [@openclaw](https://github.com/openclaw)
