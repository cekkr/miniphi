# GPT-5.4 Agent Configs

Drop-in OpenClaw configs for **OpenAI GPT-5.4** (Codex lineage). If you are migrating from Claude Sonnet 4.6, this is the bundle that needs the most prompt surgery — but once it's dialed in, it's a strong daily driver.

## "GPT-5.4 sucks in OpenClaw" — mostly a config problem

If you've been reading r/openclaw this week, you've seen the "GPT-5.4 is unusable" posts. Almost all of them turn out to be config issues, not model issues. Two settings in particular:

> **`thinking=high` + `fastmode=true` is the sweet spot.**
> — @Saboo_Shubham_ on Twitter

That's the combo most of the "actually it's fine now" follow-up posts converge on. This bundle ships those defaults.

## Quick Start

1. Make sure you have an OpenAI API key with GPT-5.4 access (it's gated on usage tier as of April 2026).

2. Register the provider:

```bash
openclaw provider add gpt \
  --api-key $OPENAI_API_KEY \
  --base-url https://api.openai.com/v1
```

3. Copy the agent bundle:

```bash
cp configs/gpt-5.4/SOUL.md ~/.openclaw/agents/coding-assistant/SOUL.md
```

4. Run with the recommended flags:

```bash
openclaw agent \
  --agent coding-assistant \
  --thinking high \
  --fastmode true \
  --message "Add error handling to this fetch call"
```

You can also set these permanently in `~/.openclaw/config.yaml`:

```yaml
providers:
  gpt:
    defaults:
      thinking: high
      fastmode: true
```

## Model IDs

| Model ID | Notes |
|----------|-------|
| `gpt-5.4` | Default. Use with `thinking=high`. |
| `gpt-5.4-mini` | Cheaper, faster. `thinking=medium` is usually enough. |
| `gpt-5.4-codex` | Codex-tuned variant. Better on raw code, worse on reasoning chains. |

## Cost Comparison (April 2026)

| Model | Input | Output |
|-------|-------|--------|
| Claude Sonnet 4.6 | $3 | $15 |
| **GPT-5.4** | **$2.50** | **$12** |
| GPT-5.4-mini | $0.50 | $2 |
| GPT-5.4-codex | $2 | $10 |

With `thinking=high`, expect output-token usage to be ~1.5-2x higher than a Sonnet session on the same task (the reasoning tokens are billed). Even so, it tends to come out cheaper than Sonnet overall.

## Transition Lessons From Claude Sonnet

This is the section the "Transition from Claude Sonnet to Codex-GPT5.4" Reddit thread actually needed. Concrete changes:

1. **Your role prompt is too long.** Sonnet loves a rich `Identity` + `Personality` section. GPT-5.4 with `thinking=high` treats a long preamble as constraints to reason about and burns reasoning tokens on it. Cut the SOUL.md preamble in half. The file in this bundle is ~20 lines on purpose.

2. **Drop explicit chain-of-thought requests.** If your Sonnet prompt says "think step by step" or "explain your reasoning before answering," remove it. GPT-5.4's `thinking=high` mode already does this internally; asking for it again produces a weird double-think where the visible answer is worse.

3. **Tool descriptions need to be tighter.** Sonnet infers tool intent from loose descriptions; GPT-5.4 will misuse a tool whose description is vague. Give every tool a one-sentence "use this when X" line.

4. **Turn OFF `fastmode` for hard reasoning tasks.** The Twitter sweet-spot quote is for coding. If you are doing architecture design, long analysis, or writing, `fastmode=false + thinking=high` is better. Coding: `fastmode=true`.

5. **Stop telling it to "be concise."** Sonnet takes this as a style hint. GPT-5.4 takes it as a hard limit and will truncate mid-function. Say "return complete code" instead.

## Gotchas

- **Reasoning tokens are invisible but billed.** Your output line count will look small while your bill looks big. That's expected.
- **Context poisoning is worse.** If GPT-5.4 makes a wrong assumption early in a long session, it will hold onto it harder than Claude does. Start a fresh conversation more often.
- **Tool-call streaming is flaky.** Some OpenClaw TUI versions render GPT-5.4 tool calls with visible latency spikes. Update to 2026.4.11+.

## Related Threads

- r/openclaw "Lessons learned: Transition from Claude Sonnet to Codex-GPT5.4"
- Twitter @Saboo_Shubham_ on the `thinking=high + fastmode=true` combo

## Files in This Bundle

- `SOUL.md` — lean coding-assistant tuned for GPT-5.4's reasoning budget
- `.env.example` — OpenAI API key
