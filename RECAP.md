# MiniPhi — Recap Reference

The fast-access operational map for MiniPhi. Read this first, then follow the links.

It exists because [`AGENTS.md`](AGENTS.md) has grown past a thousand lines and mixes the current
contract with a chronological delivery log. This file carries only what is true of the checked-out
revision and what an agent must not get wrong; `AGENTS.md` remains authoritative for the full
per-file reference, the delivery history, and the detailed prompt/schema rules. When the two
disagree, inspect the code and fix the stale one in the same change.

Structure follows the construction protocol in
`ai-agents-bootstrap/AGENTS.bootstrap.md`. Where a fact could not be established, this file says so
rather than guessing.

---

## 1. What MiniPhi is

**MiniPhi is a local, LM Studio-powered coding agent that manipulates files in one workspace
directory.** It plans, reads, edits, runs commands, and validates — every model exchange bound to a
JSON schema, every prompt assembled from a budgeted context *graph* rather than a growing
transcript.

Maturity: **v0.1, pre-release.** The interactive agent loop, the layered context, guarded edits, and
the optional Cheetah/vision/knowledge capabilities are implemented and offline-tested; live proofs
are recorded per feature in `AGENTS.md` and several remain open.

What MiniPhi is **not**:

- Not a hosted or remote agent. There are no remote writes; the only network calls are to a local
  or LAN LM Studio host, an optional local Cheetah server, and bounded web research.
- Not a chat wrapper. A prompt that cannot be validated against a schema is a failure, not an
  answer to salvage.
- Not Cheetah. [`thirds/cheetah`](thirds/cheetah) is a separate upstream Go database with its own
  [`AGENTS.md`](thirds/cheetah/AGENTS.md) and its own commit/push workflow.

---

## 2. Read order and sources of truth

1. [`AGENTS.md`](AGENTS.md) — the full maintainer handbook: per-file reference, JSON/schema rules,
   `.miniphi/` layout, delivered-feature log with live-proof status.
2. [`docs/prompts/*.schema.json`](docs/prompts) — the executable contract for every model exchange.
   A prompt's real shape is its schema, not its prose.
3. `src/` — current behavior. When a doc and the code disagree, the code is what runs.
4. `unit-tests-js/` — what is actually asserted. A `.live.test.js` file proves nothing offline.
5. [`README.md`](README.md) — user-facing overview and command tour.
6. [`ROADMAP.md`](ROADMAP.md) — the active slice and exit criteria.
   [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md) — the cross-cutting optimization backlog.
7. [`thirds/cheetah/AGENTS.md`](thirds/cheetah/AGENTS.md) — governs everything inside that submodule.

---

## 3. Non-negotiable principles

### JSON-first, or fail deterministically
Every LM Studio call declares a schema id from [`docs/prompts/`](docs/prompts) and sets
`response_format=json_schema`. Responses are parsed strictly after stripping `<think>` blocks and
JSON fences. Prose is never mined for a JSON-shaped fragment. A drifting model gets one bounded
retry and then a deterministic fallback object carrying a canonical `stop_reason`.

### Context is a budgeted graph, never a transcript
Prompts are rendered per turn from [`src/libs/context-graph.js`](src/libs/context-graph.js) against
a budget derived from the model's **loaded** context window. Overflow degrades (full text → digest →
requestable stub) instead of vanishing, and the model reshapes its own context with `context_ops`.

### The model may only touch the workspace
Every model-supplied path goes through `resolveWorkspacePath`; absolute paths and `..` escapes are
rejected before any side effect. The one network target a model can name is a **loopback** URL for
`visual_review`, and even that is validated against a host allowlist.

### Bounded everything
Turns, actions per turn, retries, research actions, context reforms, context-only turns, helper
runtimes and session deadlines all have caps, and every run ends with a recorded stop reason.

### Degrade, never block
Cheetah, the knowledge base, the vision model, web research and durable memory are each optional.
Any of them being absent or unreachable removes a capability; it never stalls the loop, and the
model is not told about a capability it cannot use.

---

## 4. Critical contracts

- **`edit_file` anchors are literal substrings, not ranges.** Replacing a block requires the whole
  old block in `anchor`. JavaScript proposals are syntax-checked before commit; `invalid-content`
  leaves disk untouched.
- **Never size a prompt from `max_context_length`.** Only `loadedContextLength` from
  `resolveContextWindow()` may drive the budget; an unloaded model reports `jitUnknown` and the
  conservative default applies. `LMStudioRestClient` sends `context_length` only when explicitly
  configured.
- **Reasoning is set with two keys, because the two routes name it differently.** The native v1
  route takes `reasoning`; the compatible `/chat/completions` route — the one every schema-bound
  prompt uses — takes `reasoning_effort` and *silently ignores* `reasoning`. Sending only the native
  key meant an "off" profile still paid full reasoning.
  `toCompatibleReasoningEffort()` in [`src/libs/lmstudio-api.js`](src/libs/lmstudio-api.js) maps
  MiniPhi's `off|low|medium|high` onto that route's closed vocabulary
  (`none|minimal|low|medium|high|xhigh`); an unmapped value is a 400, not an ignore.
- **The REST client must not use `globalThis.fetch`.** undici caps a response at 300 s with a
  `headersTimeout`/`bodyTimeout` that no `fetch` option can raise, and a non-streamed completion
  sends nothing until it is finished — so any generation over five minutes failed with a bare
  "fetch failed" whatever timeout was configured. `createNodeHttpFetch()` in
  [`src/libs/lmstudio-api.js`](src/libs/lmstudio-api.js) is the default `fetchImpl`; MiniPhi's own
  AbortController is the only deadline.
- **An empty response with `finish_reason: "length"` is not invalid JSON.** It is a reasoning model
  that spent its whole token budget thinking. Report and retry it as a budget problem
  (`isTruncatedBeforeContent` in [`src/libs/vision-reviewer.js`](src/libs/vision-reviewer.js));
  retrying at the same cap can only fail again.
- **Never truncate an observation twice.** Read output is truncated once, with its
  `[output truncated at N chars]` marker preserved. The graph, not the caller, shrinks long nodes.
- **Corrections never go in `scratch`.** Anything the model must read next turn belongs in
  `contract` with a `ttlTurns`, or budget pressure demotes the very nudge meant to relieve it.
- **Cheetah command strings are built upstream.** MiniPhi never hand-encodes a `key=value`
  argument; every command comes from the submodule's Node binder through the single import site
  [`src/libs/cheetah-binder.js`](src/libs/cheetah-binder.js).
- **Cheetah context identity is doubly namespaced.** Project and session references are opaque
  SHA-256 values; `_localId()` must never accept an association outside the exact project+session
  prefix, even in a deliberately shared database.
- **`.miniphi/memory/` is the only tracked part of `.miniphi/`.** Everything else there is a
  per-run audit trail. See §7.

---

## 5. Control flow

```
CLI (src/index.js)
  └─ decideUiLaunch → Ink UI (src/ui/launch.js) | headless command (src/commands/*)
        └─ AgentSession (src/agent/agent-session.js)          ← the loop
             ├─ context: ContextGraph  ←boost/references─  CheetahContextEngine (optional)
             │                         ←references──────  LocalContextMemory (.miniphi/memory)
             │                         ←selection───────  ContextReferenceComposer (model call)
             ├─ prompt: LMStudioRestClient → /chat/completions (response_format=json_schema)
             ├─ actions (agent-executor.js):
             │    read_file · list_dir · search_text        auto-run
             │    web_research · visual_review · knowledge_lookup   auto-run, optional
             │    write_file · edit_file · run_cmd          approver-gated → writeFileWithGuard
             └─ validateWorkspace(...) → issues fed back into the next turn
```

Persistence per session: `.miniphi/agent-sessions/<id>/` holds `session.json`,
`transcript.jsonl`, `context-graph.json`, `context-engine.json`, `context-references.json`,
`result.json` and `rollbacks/`.

---

## 6. Where things live

| Responsibility | Owner |
| --- | --- |
| CLI entry, routing, headless flows | [`src/index.js`](src/index.js), [`src/commands/`](src/commands) |
| The agent loop | [`src/agent/agent-session.js`](src/agent/agent-session.js) |
| Action validation + guarded writes | [`src/agent/agent-executor.js`](src/agent/agent-executor.js), [`src/libs/file-edit-guard.js`](src/libs/file-edit-guard.js) |
| Approval policy | [`src/agent/approvers.js`](src/agent/approvers.js) |
| Layered context | [`src/libs/context-graph.js`](src/libs/context-graph.js) |
| Reference sentences + selection | [`src/libs/context-reference-memory.js`](src/libs/context-reference-memory.js), [`src/libs/context-reference-composer.js`](src/libs/context-reference-composer.js) |
| Durable `.miniphi` memory | [`src/libs/local-context-memory.js`](src/libs/local-context-memory.js) |
| Cheetah session-context mirror | [`src/libs/cheetah-context-engine.js`](src/libs/cheetah-context-engine.js) |
| Cheetah world-knowledge teach/recall | [`src/libs/cheetah-knowledge-client.js`](src/libs/cheetah-knowledge-client.js), [`src/libs/cheetah-learner.js`](src/libs/cheetah-learner.js) |
| Cheetah transport (only import site) | [`src/libs/cheetah-binder.js`](src/libs/cheetah-binder.js) |
| LM Studio transport + reasoning | [`src/libs/lmstudio-api.js`](src/libs/lmstudio-api.js), [`src/libs/reasoning-profile.js`](src/libs/reasoning-profile.js) |
| Model inventory, Auto, context window | [`src/libs/model-catalog.js`](src/libs/model-catalog.js) |
| Vision review + screenshots | [`src/libs/vision-reviewer.js`](src/libs/vision-reviewer.js) |
| Web research | [`src/libs/web-researcher.js`](src/libs/web-researcher.js), [`src/libs/web-browser.js`](src/libs/web-browser.js) |
| Schemas | [`docs/prompts/`](docs/prompts) |
| Interactive UI | [`src/ui/`](src/ui) |

The complete per-file reference with symbol lists and per-file pitfalls is section 6 of
[`AGENTS.md`](AGENTS.md).

---

## 7. Memory: three stores, three jobs

Do not conflate them. They use different backends, different lifetimes and different opt-ins.

### a. The session context graph — this turn
`ContextGraph`, in memory, persisted to `.miniphi/agent-sessions/<id>/context-graph.json`. It is the
authoritative, reconstructable record of what the model can see *right now*.

### b. Cheetah context engine — better recall inside this session
Opt-in (`context.engine: "cheetah"` / `MINIPHI_CONTEXT_ENGINE=cheetah`). Mirrors node *metadata* and
bounded reference sentences into a project-derived `miniphi_context_p_<hash>` database so
`GRAPH_RECALL` can boost which nodes get rendered. It never stores full context blocks or the
workspace path, and it is per-machine: `cheetah_data/` does not travel with the project.

### c. Durable `.miniphi` memory — across sessions and machines
[`src/libs/local-context-memory.js`](src/libs/local-context-memory.js), on by default. Plain JSONL
records plus markdown notes under `.miniphi/memory/`, ranked in-process by IDF-weighted cue overlap
and returned in the *same* candidate shape Cheetah recall produces, so one merged pool feeds
`ContextReferenceComposer` and the model grounds by id either way.

- **Reads**: markdown notes in `.miniphi/memory/notes/`, plus previous sessions' conclusion layers
  (`mission`/`plan`/`contract`) and `result.json` recaps. `evidence`/`scratch` are this-run working
  state and are deliberately not harvested.
- **Writes**: every applied `note` context op, plus one recap per finished session.
- **Never mirrored into Cheetah.** Candidate ids are prefixed `local:` and name no graph node.
- **Portable by construction.** `.miniphi/memory/` is the one part of `.miniphi/` that
  [`.gitignore`](.gitignore) tracks — text, small, and copyable to another device.
  `.miniphi/memory/index.json` stays ignored: it is a rebuildable cache keyed by local file mtimes,
  and deleting it costs a rescan, never a fact.
- **Config**: `context.localMemory.*` in `config.json`, `MINIPHI_LOCAL_MEMORY=0` to disable.

### d. Cheetah knowledge base — real-world facts
A *different* feature from (b): `cheetah-learn teach|ask|chat|questions|eval|wikipedia` and the
optional read-only `knowledge_lookup` action, over a separately selected database
(`miniphi_knowledge` by default, `wikidata` for the local Wikipedia workflow). Groundedness is
adjudicated by the adapter, never taken from the model's own `grounded` field.

---

## 8. Optional capabilities and how they are gated

| Capability | Enabled when | Action |
| --- | --- | --- |
| Web research | a researcher is injected | `web_research` |
| Vision review | the live catalog reports a `vision` model | `visual_review` (workspace `path` **or** loopback `url`) |
| Knowledge lookup | `knowledgeLookup.enabled` **and** one `SYSTEM_STATS` probe succeeds | `knowledge_lookup` |
| Cheetah context | `context.engine: "cheetah"` | (no action; changes selection) |
| Durable memory | on unless disabled | (no action; changes selection) |

The pattern is the same for all of them: **probe once, wire only if healthy, and never advertise an
action in the system prompt that would just answer `unavailable`.**

---

## 9. Build, run, test

```bash
npm install                                    # dependencies
node src/index.js lmstudio-health --timeout 10 # probe LM Studio before a long run
npm test                                       # full offline suite
```

Focused suites worth running by hand:

```bash
node --test unit-tests-js/agent-session.test.js unit-tests-js/agent-executor.test.js
node --test unit-tests-js/context-graph.test.js unit-tests-js/agent-context-layers.test.js
node --test unit-tests-js/local-context-memory.test.js
node --test unit-tests-js/cheetah-context-engine.test.js unit-tests-js/cheetah-binary-transport.test.js
```

Cheetah, when a test or run needs a live server:

```bash
git submodule update --init --recursive thirds/cheetah
cd thirds/cheetah && bash build.sh && CHEETAH_HEADLESS=1 ./cheetah-server
```

Sample runs (real model calls, minutes to hours; run live files **alone** — concurrent long
generations wedge LM Studio on the reference hosts):

```bash
node scripts/run-photos-social-sample.js --base-url http://127.0.0.1:1234 --model <model-key>
```

`.live.test.js` files are gated behind `MINIPHI_LMSTUDIO_INTEGRATION=1` and, where Cheetah is
involved, `MINIPHI_CHEETAH_INTEGRATION=1`. The full command list is in section 9 of
[`AGENTS.md`](AGENTS.md).

---

## 10. Recurring failure modes

### A local model re-sends an op that changed nothing
`applyOps()` reports rejections **and** no-ops, and both must be fed back into the context. Without
that feedback the model repeats the same reshaping every turn and the loop stalls.

### A vision or reference sub-call "returns invalid JSON" on a reasoning model
Check `finish_reason` and `reasoning_tokens` before believing it. The 512-token default caps that
predated reasoning models truncate the trace before any content appears. See §4.

### A screenshot of a server-rendered page shows an empty template
`file://` renders the template, not the app. Use `visual_review` with a loopback `url` so the page
is fetched from the running server, and screenshot at `networkidle2` rather than `load`.

### Validation issues pile up until the actionable one falls out of the budget
A validator reports the complete current issue set every run. Feed back a small, dependency-ordered
prefix; a local model cannot act on ten instructions at once.

### A local model keeps failing to write one large file
A syntax error in a 240-line one-shot generation is not a typo — it is the file being longer than
the model can emit correctly, and re-proposing it whole moves the error rather than fixing it. From
the second rejection of a large file the repair note must order a split, not another repair.

### A turn that ran out of tokens looks like a syntax error downstream
A `write_file` whose content was cut mid-file is rejected as unparseable, so the model debugs a
mistake it never made. Check `finish_reason` and say "length", not "syntax".

### A subjective gate never lets a working feature finish
A vision model has no upper bound on taste. Gate on it for a bounded number of attempts, then
demote it to advisory — or a functionally complete app iterates forever.

### A long generation dies with a bare "fetch failed"
Not the model, not the network: Node's global `fetch` has a 300-second ceiling of its own. See §4.
Two of those in a row also wedge LM Studio's engine into answering 400
`Engine protocol predict request failed` — recover with `models --unload` then `--load`.

### JIT context overflow
Advertising a static `context_length` exceeds a JIT-loaded model's smaller window and LM Studio
rejects the request with 400 "Context size has been exceeded".

More, with the specific runs that exposed them, in section 7 of [`AGENTS.md`](AGENTS.md).

---

## 11. Data boundaries

- **Canonical**: workspace files, `.miniphi/memory/records.jsonl` and `.miniphi/memory/notes/`,
  `docs/prompts/*.schema.json`.
- **Derived / disposable**: `.miniphi/memory/index.json`, `.miniphi/indices/`,
  `.miniphi/benchmarks/`, Cheetah's `cheetah_data/` mirror, everything under
  `.miniphi/agent-sessions/` (an audit trail, not an input to a later run — except the parts the
  durable store harvests).
- **Never committed**: LM Studio tokens (`LMSTUDIO_API_TOKEN`, redacted from instrumentation),
  generated sample apps (`samples/*/server/`), `cheetah_data/`, the `cheetah-server` binary.
- **Local only**: MiniPhi writes nothing outside the workspace and posts nothing to a remote
  service. Web research reads; it does not publish.

---

## 12. Task start and handoff checklist

Before changing code:

1. Read this file, then the relevant section of [`AGENTS.md`](AGENTS.md) and the schema in
   [`docs/prompts/`](docs/prompts) that governs the exchange you are touching.
2. `git status` — preserve unrelated changes.
3. Find the owning module in §6 and its focused tests before editing. Verify the doc's claim against
   the current source; do not trust a symbol name you have not seen.
4. Anything protocol-shaped for Cheetah belongs upstream in `thirds/cheetah`, committed and pushed
   there, with the submodule pointer recorded separately here.

Before finishing:

1. Run the focused suites for what you changed, plus `npm test`. Report what ran, what was skipped,
   and what is still unproven — a live proof that did not run is not a proof.
2. Update this file, the matching `AGENTS.md` section, and [`README.md`](README.md) for user-visible
   changes, **in the same change**. Remove stale claims rather than adding a newer one beside them.
3. Nothing shipped may still read as `Planned`, and nothing incomplete may read as `Shipped`.
