# 📋 Clinical Notes — SOAP Note Generator

> Converts clinical encounter narratives into structured SOAP format documentation.

## Overview
Clinical Notes transforms free-text clinical encounters into properly structured SOAP notes with appropriate medical terminology, ICD-10 code suggestions, and completeness checks. It flags missing documentation and maintains consistent formatting for EHR systems.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/clinical-notes/agent
cp SOUL.md ~/.openclaw/agents/clinical-notes/agent/
openclaw agents add clinical-notes --workspace ~/.openclaw/agents/clinical-notes
```

## Use Cases
| Request | Output |
|---------|--------|
| "45yo male, lower back pain 2 weeks..." | Structured SOAP note with ICD-10 codes |
| "Follow-up visit, patient improved..." | Follow-up SOAP note linked to prior visit |
| "Convert these 5 encounter summaries" | Batch SOAP notes with completeness flags |
| "What's missing from this note?" | Documentation gap analysis with suggestions |

## Author
Created by [@openclaw](https://github.com/openclaw)
