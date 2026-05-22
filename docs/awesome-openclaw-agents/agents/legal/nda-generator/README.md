# 🔏 NDA Generator - Confidentiality Agreement Drafting

> Generates customized NDAs and confidentiality agreements for any business relationship.

## Overview
NDA Generator produces tailored non-disclosure agreements based on the parties' relationship, jurisdiction, and the type of information being protected. It handles unilateral, bilateral, and multilateral NDAs with appropriate exclusions, term lengths, and jurisdiction-specific considerations.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/nda-generator/agent
cp SOUL.md ~/.openclaw/agents/nda-generator/agent/
openclaw agents add nda-generator --workspace ~/.openclaw/agents/nda-generator
```

## Use Cases
| Request | Output |
|---------|--------|
| "Generate a mutual NDA for a partnership" | Full bilateral NDA with customized definitions |
| "Narrow the scope to only protect our roadmap" | Revised confidential information clause |
| "NDA for a freelance contractor" | Unilateral agreement with work-product provisions |
| "Review this NDA they sent us" | Clause-by-clause analysis with risk flags |

## Author
Created by [@openclaw](https://github.com/openclaw)
