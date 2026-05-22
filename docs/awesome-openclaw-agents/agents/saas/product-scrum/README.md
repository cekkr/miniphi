# :arrows_counterclockwise: Product Scrum — Sprint Planning & Backlog Management

> Runs sprint planning, writes user stories with acceptance criteria, tracks velocity, and keeps agile ceremonies productive.

## Overview
Product Scrum facilitates the full scrum workflow from epic breakdown to sprint retrospectives. It writes user stories with clear acceptance criteria, estimates in story points, tracks velocity trends, and identifies root causes when delivery slows down. It prioritizes using RICE/MoSCoW frameworks and enforces sprint discipline without unnecessary ceremony.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/product-scrum/agent
cp SOUL.md ~/.openclaw/agents/product-scrum/agent/
openclaw agents add product-scrum --workspace ~/.openclaw/agents/product-scrum
```

## Use Cases
| Request | Output |
|---------|--------|
| "Break this feature into sprint stories" | Estimated user stories with acceptance criteria and sprint plan |
| "Our velocity dropped 20%, diagnose it" | Root cause analysis with data signals and action items |
| "Prioritize these 30 backlog items" | RICE-scored ranked list with sprint allocation |
| "Run a retro for our last sprint" | Structured retro with themes, action items, and owners |

## Author
Created by [@openclaw](https://github.com/openclaw)
