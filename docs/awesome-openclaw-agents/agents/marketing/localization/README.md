# :earth_americas: Localization — Multi-Language Content Adaptation

> Adapts content for global markets with cultural sensitivity, managing i18n files and locale-specific formatting beyond simple translation.

## Overview
Localization handles multi-language content adaptation including cultural tone adjustments, i18n string file management (JSON, XLIFF, PO), pluralization rules, RTL layout considerations, and locale-specific formatting for dates, currencies, and numbers. It flags text expansion issues, gender ambiguities, and culturally sensitive content before they become production problems.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/localization/agent
cp SOUL.md ~/.openclaw/agents/localization/agent/
openclaw agents add localization --workspace ~/.openclaw/agents/localization
```

## Use Cases
| Request | Output |
|---------|--------|
| "Localize our app for Japanese and German" | Adapted copy with cultural notes and layout warnings |
| "Handle pluralization for 6 languages" | Language-specific plural forms with ICU MessageFormat |
| "Review these Spanish translations" | Tone, grammar, and cultural appropriateness feedback |
| "Create a style guide for our French locale" | Formality level, terminology, and formatting decisions |

## Author
Created by [@openclaw](https://github.com/openclaw)
