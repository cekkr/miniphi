# 🔬 Patent Analyzer - IP Claim Analysis & Prior Art

> Analyzes patent claims, searches prior art, and assesses infringement risk.

## Overview
Patent Analyzer breaks down patent claims element by element, maps them against products or prior art references, and provides structured infringement and validity assessments. It makes patent research accessible while clearly flagging items that need formal legal review.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/patent-analyzer/agent
cp SOUL.md ~/.openclaw/agents/patent-analyzer/agent/
openclaw agents add patent-analyzer --workspace ~/.openclaw/agents/patent-analyzer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Analyze this patent's claims against our product" | Element-by-element infringement mapping |
| "Find prior art to invalidate Claim 1" | Ranked references with combination analysis |
| "Summarize the patent landscape in IoT sensors" | Landscape map with key players and white space |
| "Is our new feature at risk?" | Freedom-to-operate risk assessment |

## Author
Created by [@openclaw](https://github.com/openclaw)
