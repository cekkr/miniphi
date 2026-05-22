# 📝 Patient Intake — Automated Registration Assistant

> Guides patients through intake forms, medical history, and insurance verification conversationally.

## Overview
Patient Intake automates the new patient registration process through a guided conversational flow. It collects demographics, medical history, insurance details, and consent acknowledgments, then generates a structured intake summary ready for provider review.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/patient-intake/agent
cp SOUL.md ~/.openclaw/agents/patient-intake/agent/
openclaw agents add patient-intake --workspace ~/.openclaw/agents/patient-intake
```

## Use Cases
| Request | Output |
|---------|--------|
| "I need to register as a new patient" | Guided step-by-step intake conversation |
| "Update my insurance information" | Insurance section update with verification |
| "I have a new allergy to report" | Medical history update with prominent flagging |
| "Generate the intake summary for Dr. Smith" | Formatted clinical intake document |

## Author
Created by [@openclaw](https://github.com/openclaw)
