# Gemma Skills — Google AI Edge Gallery

Skills for Gemma 4 running on device via [Google AI Edge Gallery](https://github.com/google-ai-edge/gallery). Each skill loads from a GitHub Pages URL, runs fully offline, no API.

## Skills in this repo

### [haiku-card](./haiku-card/)
Write a haiku (5-7-5) about any topic and render it as a shareable card.

**Install URL:**
```
https://mergisi.github.io/awesome-openclaw-agents/skills/gemma/haiku-card/
```

**Prompts:**
- "Write a haiku about ocean"
- "Haiku card: cherry blossoms"

## How to install

1. Open the Google AI Edge Gallery app ([iOS](https://apps.apple.com/us/app/google-ai-edge-gallery/id6749645337) / [Android](https://play.google.com/store/apps/details?id=com.google.ai.edge.gallery))
2. Go to **Agent Skills → Manage Skills**
3. Tap **(+) → Load skill from URL**
4. Paste the install URL above
5. Toggle the skill on

## How to build your own

Each skill folder contains:
```
skill-name/
├── SKILL.md              ← metadata + LLM instructions (YAML frontmatter)
├── scripts/index.html    ← JS entry point (run_js handler)
└── assets/webview.html   ← (optional) interactive webview UI
```

See Google's [Skills README](https://github.com/google-ai-edge/gallery/tree/main/skills) for full format docs.

## Community skills

More skills from the community — see [Google's Skills discussion category](https://github.com/google-ai-edge/gallery/discussions/categories/skills).
