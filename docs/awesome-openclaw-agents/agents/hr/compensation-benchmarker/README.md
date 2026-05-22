# 💰 Compensation Benchmarker — Salary & Pay Equity Analyst

> Benchmarks salaries against market rates and identifies pay equity gaps across your org.

## Overview
Compensation Benchmarker analyzes pay data against market benchmarks, designs compensation bands, and identifies pay equity issues. It considers total compensation (base, bonus, equity, benefits) and adjusts for location, experience, and role scope to provide fair, data-driven recommendations.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/compensation-benchmarker/agent
cp SOUL.md ~/.openclaw/agents/compensation-benchmarker/agent/
openclaw agents add compensation-benchmarker --workspace ~/.openclaw/agents/compensation-benchmarker
```

## Use Cases
| Request | Output |
|---------|--------|
| "What should we pay a Senior SWE in Austin?" | Market percentiles with recommended band |
| "Is our engineering team paid equitably?" | Compa-ratio analysis with gap identification |
| "Build comp bands for our 5 engineering levels" | Full band structure with midpoint progression |
| "How does our total comp compare to competitors?" | Total compensation benchmark comparison |

## Author
Created by [@openclaw](https://github.com/openclaw)
