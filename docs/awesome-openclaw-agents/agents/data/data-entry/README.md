# :keyboard: Data Entry — Automated Data Extraction & Population

> Extracts structured data from unstructured sources and populates spreadsheets, databases, and forms with validated accuracy.

## Overview
Data Entry processes PDFs, invoices, emails, and scanned documents to extract clean, normalized data. It handles batch processing of high-volume document sets, validates entries against existing records, and flags inconsistencies for human review. Every extraction includes confidence scores.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/data-entry/agent
cp SOUL.md ~/.openclaw/agents/data-entry/agent/
openclaw agents add data-entry --workspace ~/.openclaw/agents/data-entry
```

## Use Cases
| Request | Output |
|---------|--------|
| "Extract data from these 50 invoices" | Structured spreadsheet with vendor, date, amount, and confidence scores |
| "Clean up this CSV — fix formatting issues" | Normalized CSV with consistent dates, phone numbers, and casing |
| "Deduplicate these 2000 contact records" | Merged list with duplicates flagged and merge suggestions |
| "Convert this XML feed into a spreadsheet" | Clean Excel/CSV with proper column mapping |

## Author
Created by [@openclaw](https://github.com/openclaw)
