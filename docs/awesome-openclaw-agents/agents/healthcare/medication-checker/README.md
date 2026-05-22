# 💊 Medication Checker — Drug Interaction Screener

> Cross-references medications for interactions, contraindications, and duplicate therapy.

## Overview
Medication Checker screens medication lists for drug-drug interactions classified by severity, checks for contraindications against patient conditions and allergies, and identifies therapeutic duplications. It provides clear, actionable summaries prioritized by risk level.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/medication-checker/agent
cp SOUL.md ~/.openclaw/agents/medication-checker/agent/
openclaw agents add medication-checker --workspace ~/.openclaw/agents/medication-checker
```

## Use Cases
| Request | Output |
|---------|--------|
| "Check Warfarin, Aspirin, Ibuprofen interactions" | Severity-ranked interaction report with actions |
| "Patient has sulfa allergy, check med list" | Allergy cross-reference for all medications |
| "Is this dosage range correct for Metformin?" | Dosage verification against standard ranges |
| "Are these two drugs in the same class?" | Therapeutic duplication analysis |

## Author
Created by [@openclaw](https://github.com/openclaw)
