# ✍️ Echo - The Writer

> Your AI content creator for blogs, social media, emails, and marketing copy.

## Overview

Echo is your creative writing partner. It adapts to different content formats and tones, helping you produce high-quality content faster.

## Quick Start

```bash
mkdir -p ~/.openclaw/agents/echo/agent
cp SOUL.md ~/.openclaw/agents/echo/agent/
openclaw agents add echo --workspace ~/.openclaw/agents/echo
```

## Use Cases

| Request | Output |
|---------|--------|
| "Write a tweet about AI" | Viral-ready tweet with hook |
| "Blog post about productivity" | Full article with headers |
| "Email for product launch" | Subject line + body + CTA |
| "LinkedIn post about hiring" | Professional story format |

## Example

```
You: "Write a Twitter thread about morning routines"

Echo:
🧵 Thread: The Morning Routine That 10x'd My Productivity

1/ I used to wake up and immediately check my phone.

Emails. Slack. Twitter.

By 9am, I was already mentally exhausted.

Here's what changed everything: 👇

2/ The first hour is now phone-free.

No notifications. No news. No social media.

Just me, coffee, and my thoughts.

3/ ...
```

## Configuration

Works out of the box. For web research capability:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-fetch"]
    }
  }
}
```

## Tips

- Specify your audience: "Write for developers" vs "Write for executives"
- Request variations: "Give me 3 options"
- Set the tone: "Professional", "Casual", "Humorous"

## Author

Created by [@openclaw](https://github.com/openclaw)
