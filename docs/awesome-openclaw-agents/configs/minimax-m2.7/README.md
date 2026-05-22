# MiniMax M2.7 Agent Configs

Drop-in OpenClaw configs for **MiniMax M2.7** — a 229B-parameter open-weight model that currently posts the highest agentic coding scores of any non-Anthropic model.

## Why MiniMax M2.7

The short version: if you care about raw SWE-bench-style agentic performance and you are okay either paying MiniMax's hosted API or running 229B weights yourself, this is the strongest option on the board right now.

Reported numbers (from MiniMax's own release page — treat as vendor-reported until independently verified):

- **229B parameters** (MoE, open weights)
- **SWE-Pro: 56.22%**
- **Terminal Bench 2: 57%**

Those are the two benchmarks r/openclaw users keep citing in the migration megathread. Real-world reports from users who actually switched describe it as "almost Opus-level on long tool chains, slightly worse on one-shot snippets."

## Quick Start

1. Either:
   - Get an API key from the MiniMax platform, OR
   - Self-host the weights (you'll need ~4x H100 for full precision; see the MiniMax HuggingFace model card for quantized variants)

2. Register the provider with OpenClaw:

```bash
openclaw provider add minimax \
  --api-key $MINIMAX_API_KEY \
  --base-url https://api.minimax.chat/v1
```

3. Copy the agent bundle:

```bash
cp configs/minimax-m2.7/SOUL.md ~/.openclaw/agents/swe-agent/SOUL.md
```

4. Run it:

```bash
openclaw agent --agent swe-agent --message "Find and fix the failing tests in this repo"
```

## Model IDs

| Model ID | Context | Good For |
|----------|---------|----------|
| `minimax-m2.7` | 256K | Default. Full weights. |
| `minimax-m2.7-turbo` | 128K | Same weights, lower latency, slightly higher price. |
| `minimax-m2.7-mini` | 128K | A distilled 34B version. Use for cheap routing. |

## About `mmx-cli`

MiniMax also ships their own CLI called `mmx-cli` that wraps the same API with a different agent loop. **This is a separate tool from OpenClaw.** If you see Reddit posts saying "MiniMax works great with mmx-cli but breaks in OpenClaw," that's usually because the poster was comparing two different agent harnesses, not two different models. This bundle targets OpenClaw's loop, not `mmx-cli`.

## Commercial License Caveat

**Read the license before you ship.** MiniMax M2.7's open weights are released under a source-available license that restricts certain commercial uses — specifically, companies above a revenue threshold need a separate commercial agreement. If you are:

- Solo / hobby / research → you're fine under the default terms
- Using MiniMax's **hosted API** → you're fine (the API TOS supersedes the weights license)
- A commercial product self-hosting the weights → talk to a lawyer before you deploy

This is not legal advice. This is "don't get surprised by a cease-and-desist." See the HuggingFace model card for the current license text.

## Cost Comparison (April 2026)

| Model | Input | Output | Notes |
|-------|-------|--------|-------|
| Claude Opus 4.6 | $15 | $75 | |
| **MiniMax M2.7 (hosted)** | **$1.20** | **$4.80** | |
| MiniMax M2.7 (self-hosted) | — | — | Your GPU bill. Break-even around 4-5M output tokens/day. |

## Gotchas When Migrating From Claude

1. **Aggressive tool calling.** M2.7 will call tools faster and more often than Claude. If your agent has side-effectful tools (writes files, runs shell), tighten the rules in `SOUL.md` about when it's allowed to act without confirmation. The example SOUL.md in this folder does this.

2. **Chains get long.** Because it's trained for agentic workflows, it will happily run 40+ tool calls in a single task. Set a max-steps cap in your OpenClaw config if you care about runaway cost.

3. **Worse at pure chat.** If the user asks a philosophical or open-ended question, M2.7 often responds like it's still trying to execute a task. For general-purpose chat, use a different model.

4. **Self-hosted: watch your KV cache.** At 256K context the KV cache will eat VRAM. Most users end up running it at 64K effective context unless they're on 8x H100.

## Related Threads

- r/openclaw "I switched to Minimax m2.7"
- r/openclaw "Megathread: If you've moved OpenClaw off Claude..."

## Files in This Bundle

- `SOUL.md` — agentic SWE agent tuned for M2.7's long tool chains
- `.env.example` — env vars (hosted API + optional self-hosted endpoint)
