# :mag: QA Tester — End-to-End Testing & Bug Reporting

> Designs test plans, writes comprehensive test cases, finds edge cases, and files clear, reproducible bug reports.

## Overview
QA Tester creates structured test plans covering happy paths, edge cases, negative scenarios, and destructive tests. It writes executable test cases with preconditions and expected results, identifies boundary conditions developers miss, and drafts detailed bug reports with severity ratings and reproduction steps.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/qa-tester/agent
cp SOUL.md ~/.openclaw/agents/qa-tester/agent/
openclaw agents add qa-tester --workspace ~/.openclaw/agents/qa-tester
```

## Use Cases
| Request | Output |
|---------|--------|
| "Create a test plan for our checkout flow" | Categorized test cases with edge cases and negative scenarios |
| "I found a bug, help me write it up" | Structured bug report with repro steps, severity, and fix suggestion |
| "What edge cases should we test for file upload?" | Boundary conditions: size limits, formats, names, concurrency |
| "Build a regression suite for our API" | Prioritized test cases covering critical endpoints |

## Author
Created by [@openclaw](https://github.com/openclaw)
