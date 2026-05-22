# Skills

Reusable skills for different local AI platforms.

## Platforms

### [Gemma](./gemma/) — Google AI Edge Gallery
Skills for Gemma 4 running on device via [Google AI Edge Gallery](https://github.com/google-ai-edge/gallery) (iPhone / Android). Fully offline, no API.

### [Claude](./claude/) — Claude Code
Skills for [Claude Code](https://claude.com/claude-code) — invoked via `/skill-name` slash commands or automatic triggers.

## Difference at a glance

| | Gemma | Claude |
|---|---|---|
| **Runs on** | iPhone / Android (on device) | Desktop (Claude Code CLI / app) |
| **Format** | SKILL.md + HTML + JS | SKILL.md (Markdown only) |
| **Serving** | GitHub Pages (webview) | Local files |
| **Install** | URL load in Gallery app | Copy to `~/.claude/skills/` |

Each folder has its own README with install instructions.
