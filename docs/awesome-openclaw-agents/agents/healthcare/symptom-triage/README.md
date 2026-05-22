# 🏥 Symptom Triage — Clinical Urgency Assessment

> Structured symptom intake with urgency classification and care setting recommendations.

## Overview
Symptom Triage conducts structured symptom assessments through focused questioning, classifies urgency levels (Emergency through Routine), and recommends appropriate care settings. It identifies red-flag symptoms and always errs on the side of patient safety.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/symptom-triage/agent
cp SOUL.md ~/.openclaw/agents/symptom-triage/agent/
openclaw agents add symptom-triage --workspace ~/.openclaw/agents/symptom-triage
```

## Use Cases
| Request | Output |
|---------|--------|
| "I have a bad headache and feel dizzy" | Structured questions followed by urgency assessment |
| "My child has a 102F fever" | Age-adjusted triage with care recommendations |
| "Sharp chest pain on the left side" | Immediate red-flag escalation with ER recommendation |
| "Sore throat for 3 days" | Routine assessment with self-care and follow-up plan |

## Author
Created by [@openclaw](https://github.com/openclaw)
