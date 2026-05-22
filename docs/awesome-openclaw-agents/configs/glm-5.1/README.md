# GLM-5.1 Agent Configs

Drop-in OpenClaw configs for Zhipu's **GLM-5.1** — the model that most r/openclaw threads this week are calling "the closest thing to Opus 4.6 you can actually buy today."

## Why GLM-5.1

If you landed here because your Claude access got cut off, this is probably the bundle you want to try first. Community sentiment on the r/openclaw "moved off Claude" megathread ranks GLM-5.1 above every other non-Anthropic option for long-horizon coding. It holds context across multi-file edits, follows tool-call schemas without drift, and — unlike most alternatives — your existing Opus 4.6 / Sonnet 4.6 system prompts mostly "just work" without rewrites.

It is not magic. See [Gotchas](#gotchas-when-migrating-from-claude) below.

## Quick Start

1. Get an API key from the Zhipu / z.ai console (see [official docs](https://docs.z.ai/) for the current URL — it changed twice this quarter).

2. Register the provider with OpenClaw:

```bash
openclaw provider add glm \
  --api-key $GLM_API_KEY \
  --base-url https://api.z.ai/api/coding/paas/v4
```

3. Copy the agent bundle:

```bash
cp configs/glm-5.1/SOUL.md ~/.openclaw/agents/coding-assistant/SOUL.md
```

4. Run it:

```bash
openclaw agent --agent coding-assistant --message "Refactor this function to use async/await"
```

## Model IDs

| Model ID | Context | Good For |
|----------|---------|----------|
| `glm-5.1` | 200K | Default. Use this unless you have a reason not to. |
| `glm-5.1-air` | 128K | Cheaper, faster, noticeably weaker on multi-file refactors. |
| `glm-5.1-flash` | 64K | Cheap classification / routing / small edits. |

Set it in your `SOUL.md` front matter as `Model: glm/glm-5.1`.

## Cost Comparison (April 2026)

Rough per-million-token pricing. Confirm current numbers on each provider's pricing page — these move.

| Model | Input | Output | Notes |
|-------|-------|--------|-------|
| Claude Opus 4.6 | $15 | $75 | If you can get access. |
| Claude Sonnet 4.6 | $3 | $15 | Still the price-performance baseline. |
| **GLM-5.1** | **$0.60** | **$2.20** | ~25x cheaper than Opus on output. |
| GLM-5.1 Air | $0.20 | $1.10 | |

For an all-day OpenClaw session burning ~2M output tokens, that's the difference between a $150 Claude day and a $5 GLM day.

## Gotchas When Migrating From Claude

These are all things actual users hit on r/openclaw in the last week. Not invented.

1. **System prompt length matters more than on Claude.** GLM-5.1 starts losing instructions around the 8K mark in the system message. If you have a bloated Opus SOUL.md with dozens of rules, trim it. The SOUL.md in this folder is intentionally lean.

2. **"Thinking" tags are different.** Claude's extended thinking is transparent; GLM emits a `<think>...</think>` block that some OpenClaw UI clients render raw. If your TUI looks noisy, update OpenClaw to 2026.4.11+ which strips it by default.

3. **Tool-call JSON is stricter.** Claude will sometimes heal malformed tool JSON; GLM will not. If you have custom tools, double-check your schemas. This is the #1 cause of "GLM doesn't work for me" posts that turn out to be config issues.

4. **Chinese-language leakage on very long runs.** After ~30K tokens of back-and-forth, GLM-5.1 occasionally drops a Chinese word into English output. Add `Always respond in English only` to your rules (the SOUL.md here already does).

5. **Refusals are rarer but blunter.** When GLM does refuse, it doesn't give the polite Claude-style explanation — it just stops. If an agent looks stuck, check for a short terminal "Sorry, I cannot help with that."

## Prompt Tweaks vs Claude

Coming from a Claude prompt, the two edits that matter most:

- **Drop the `<thinking>` scaffolding.** If your Claude prompt tells the model to "think step by step inside `<thinking>` tags," remove it. GLM already does this via its own reasoning pass and will double-wrap.
- **Be more explicit about output format.** Claude infers "return just the code" from context; GLM is happier with `Return ONLY a fenced code block. No prose.`

## Related Reddit Threads (verify before citing)

- r/openclaw "Megathread: If you've moved OpenClaw off Claude..."
- r/openclaw "We chose GLM-5.1 because its the best alternative to opus"

## Files in This Bundle

- `SOUL.md` — working coding-assistant agent tuned for GLM-5.1
- `.env.example` — the one env var you need
