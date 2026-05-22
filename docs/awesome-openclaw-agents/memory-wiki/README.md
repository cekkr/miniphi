# Memory Wiki Starter for OpenClaw

A pre-compiled, human-readable "wiki" your OpenClaw agent reads once at session start — instead of re-exploring your codebase and life story from cold every time you open a chat.

Built for OpenClaw 2026.4.11+.

## What is a memory-wiki?

The pattern was popularised by Andrej Karpathy earlier this month in his "LLM Wiki" note: treat the model like a new hire on their first day. A new hire doesn't grep your repo to figure out what you do — they read the onboarding doc. So write the onboarding doc, check it into git, and hand it to the model at the top of every session.

Harrison Chase's follow-up ("Your harness, your memory") framed the same idea from the harness side: the agent doesn't *have* memory, the harness *gives* it memory by reading the right files in the right order. Garry Tan's one-liner stuck: **"memory is markdown, brain is a git repo, harness is a thin conductor."** That's this starter, more or less.

The v2 of the community "LLM Wiki" pattern added a memory lifecycle — some files are immutable facts (who you are, what you ship), some decay over time (what you were working on last Tuesday), and some get rebuilt on a schedule. You'll see that split reflected in the layout below: five stable files plus one mutable `WORKING.md` that's the only thing the agent is allowed to overwrite.

None of this is novel on its own. What's missing is a clean, OpenClaw-compatible starter that drops into `~/.openclaw/agents/<name>/` without ceremony. That's what this folder is.

## Why it matters for OpenClaw agents

The top post on r/openclaw this month ("90%+ fewer tokens per session by reading a pre-compiled wiki instead of exploring files cold") put numbers on something everyone running local agents had already noticed: cold-start exploration is the single biggest cost sink in long-lived agents. The follow-up thread ("the new memory-wiki stack is actually usable now") is worth a read if you want the receipts.

Three things get better once you wire a wiki in:

1. **Token cost drops.** The Reddit thread reports 90%+ reduction per session in the "what is this repo / who are you / what are we doing" preamble. A ~2KB wiki replaces dozens of tool calls.
2. **Continuity survives restarts.** Kill the agent, reopen tomorrow, pick up where you were — because `WORKING.md` is still sitting there on disk.
3. **Decisions stop getting re-litigated.** `DECISIONS.md` means you don't argue with the agent about "why aren't we using Postgres" for the fourth time this week.

### Rough cost math

Cold session on a medium repo, no wiki:

```
~18 tool calls to understand project (ls, grep, read package.json, read README...)
~12k tokens of file contents pulled into context
~4k tokens of agent narration ("Let me check X... now let me look at Y...")
                                                      ------
                                                      ~16k tokens before first useful reply
```

Same session with a 2KB wiki loaded at start:

```
~1 read of memory-wiki/ (6 files)
~1.5k tokens total
                                                      ------
                                                      ~1.5k tokens before first useful reply
```

That's the 90% the thread is talking about. Your mileage will vary — on a tiny repo you save less, on a big monorepo you save more.

## Directory layout

```
memory-wiki/
├── PROFILE.md      # who I am, role, goals — immutable
├── STACK.md        # tech stack, tools, versions — quarterly refresh
├── PROJECTS.md     # current projects, one-liner each — monthly refresh
├── DECISIONS.md    # key decisions + why — append-only
├── PEOPLE.md       # collaborators, co-founders, clients — as needed
└── WORKING.md      # what I'm working on right now — the ONLY mutable file
```

The split is deliberate. Agents are allowed to *read* everything in `memory-wiki/` but only allowed to *write* to `WORKING.md`. Everything else is human-maintained. This is the same discipline Chase argued for — the harness controls what the agent can touch, the human owns the canon.

Both templates in this starter (`solo-founder-wiki/` and `engineer-wiki/`) ship all six files. Start with the one closest to your situation, run `bootstrap.sh`, and edit from there.

## Wiring it into an OpenClaw agent

Add a block like this near the top of your agent's `SOUL.md`:

```markdown
## Memory Wiki

At the start of every session, before doing anything else, read these files in order:

1. `~/memory-wiki/PROFILE.md` — who the user is
2. `~/memory-wiki/STACK.md` — their tools
3. `~/memory-wiki/PROJECTS.md` — active projects
4. `~/memory-wiki/DECISIONS.md` — prior decisions, don't re-litigate
5. `~/memory-wiki/PEOPLE.md` — collaborators (may be empty)
6. `~/memory-wiki/WORKING.md` — current focus

Do not explore the filesystem to answer questions that these files already cover.
You may update WORKING.md at the end of the session. Do not modify the other files
without explicit permission.
```

Then point the agent at wherever you keep the wiki:

```bash
cp -r memory-wiki ~/.openclaw/agents/orion/
openclaw agent --agent orion --message "what am I working on today?"
```

On a fresh session the agent will load the wiki, answer from it, and skip the usual 10-minute rediscovery phase.

## Keeping it fresh

Three tiers of freshness, matching the file lifecycle:

**Per-session (WORKING.md).** The agent itself updates this at the end of each session. Add a Stop hook to your OpenClaw config if you want it automated:

```json
{
  "hooks": {
    "Stop": "openclaw agent --agent $AGENT --message 'update WORKING.md with a 5-bullet summary of this session'"
  }
}
```

**Weekly (PROJECTS.md, PEOPLE.md).** Open them in your editor every Monday. Five minutes. Delete what's dead, add what's new.

**Quarterly (PROFILE.md, STACK.md, DECISIONS.md).** These change rarely. Review them when the season changes or when something big shifts — a new job, a new co-founder, a framework migration. `DECISIONS.md` is append-only; never delete old entries, just cross them out if they get reversed.

If you want a nuclear option, there's a rebuild pattern you can run manually: feed your last 30 days of git commits + session logs to an agent, ask it to propose diffs against the wiki, and review them. The "LLM Wiki v2" crowd calls this the "forgetting curve rebuild." You don't need it on day one.

## Two templates to start from

This starter ships two flavours. Pick one:

- **`templates/solo-founder-wiki/`** — indie hacker running 1-2 SaaS products, OpenClaw-native, Stripe + Mixpanel stack. Good baseline if you're shipping your own thing.
- **`templates/engineer-wiki/`** — senior backend engineer on a team, Postgres + Go + microservices. Good baseline if you work inside a bigger codebase.

Neither will match you exactly. That's fine — the placeholders are there to be replaced. Run `bootstrap.sh` to copy + fill the basics interactively.

## Quick start

```bash
chmod +x memory-wiki/bootstrap.sh
./memory-wiki/bootstrap.sh ~/memory-wiki                 # solo-founder (default)
./memory-wiki/bootstrap.sh ~/memory-wiki --engineer      # engineer variant
```

Then edit the files by hand — the bootstrap only fills the obvious blanks (name, main project, primary language). Everything else is your job.

## What this starter is not

- **Not a memory framework.** No vector DB, no embeddings, no retrieval. Just markdown files the agent reads top-to-bottom.
- **Not automatic.** You write the wiki. The agent reads it. If you lie to the wiki, the agent will confidently lie back to you.
- **Not a replacement for SOUL.md.** SOUL.md is *how* the agent behaves. The wiki is *what it knows about you*. Both matter.

## Credits

- Andrej Karpathy — the "LLM Wiki" framing
- Harrison Chase — "Your harness, your memory"
- Garry Tan — the markdown/git/conductor one-liner
- r/openclaw — the 90% number and the v2 lifecycle split

PRs welcome. If you build a third template (data scientist, PM, designer, student), open one.
