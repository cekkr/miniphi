# Cheetah memory benchmarks and practical retrieval results

This document records what MiniPhi achieves with Cheetah as external real-time memory: how Wikipedia
information is identified and stored across several memory layers, how retrieved evidence is placed
into the model's context, and what the resulting answers look like against the same questions asked
with no memory at all.

It supersedes the 2026-08-01/02 report, whose memory was a single stored sentence per subject
retrieved by one id lookup. The section ["What was wrong with the first-generation
memory"](#what-was-wrong-with-the-first-generation-memory) explains what that could not do and why.

**All 60 complete per-sample traces** — the learned passage, the teach turn, what was written into
each layer, every MiniPhi → Cheetah command with its decoded response, the memory items placed back
into the model's context, the recall turn(s), the closed-book answer and the final answer — are in
the companion record [`cheetah_memory_benchmark_samples.md`](cheetah_memory_benchmark_samples.md).

## Reference setup and evidence

- MiniPhi commit: `95fa65e` (working tree) · Cheetah submodule: `fe28f78`
- Model: `qwen3.5-0.8b-claude-4.6-opus-reasoning-distilled` (Jackrong, Q8_0, 752M params)
- LM Studio: `http://127.0.0.1:1234`, loaded at 16,384 context, `parallel: 4`
- Dataset: `E:\Models\datasets\wiki-data-2021` (605 real shards), sampled at **random byte offsets**
- Cheetah database: `wikimem` (reset before the run)
- Session: `.miniphi/cheetah/memory-benchmark/run-200/` (seed `20260803`)
- Learning: 200 random articles, 5,728 s, strictly sequential
- Benchmark: 52 answerable questions + 8 never-taught controls

Raw evidence is retained in `learned.jsonl` (every teach prompt, raw response, stored layers and
graph-write result), `questions.json`, `samples.jsonl` (every trace in this report), `report.json`,
and `.miniphi/prompt-exchanges/` (full schema-bound exchanges including the model's reasoning text).

Implementation map:

- [cheetah-memory-layers.js](../src/libs/cheetah-memory-layers.js): passage segmentation, category
  and mention extraction, question cues, extractive span selection, support ratio;
- [cheetah-hippocampus.js](../src/libs/cheetah-hippocampus.js): the multi-stage retrieval ladder and
  the follow-up round;
- [cheetah-knowledge-client.js](../src/libs/cheetah-knowledge-client.js): `writeLayeredMemory` and
  the Cheetah command shapes;
- [cheetah-learner.js](../src/libs/cheetah-learner.js): teach/recall orchestration and adjudication;
- [cheetah-question-generator.js](../src/libs/cheetah-question-generator.js): deterministic questions
  with gold answers;
- [run-cheetah-memory-benchmark.js](../scripts/run-cheetah-memory-benchmark.js) and
  [render-cheetah-memory-report.js](../scripts/render-cheetah-memory-report.js);
- [cheetah-teach-layered schema](prompts/cheetah-teach-layered.schema.json) and
  [cheetah-recall-layered schema](prompts/cheetah-recall-layered.schema.json), both sent through
  `response_format=json_schema`. The v1 [teach](prompts/cheetah-teach.schema.json) /
  [recall](prompts/cheetah-recall.schema.json) schemas are the superseded contracts.

## Results at a glance

Same 52 questions, same model, asked twice — once with no memory, once through the memory:

| | Closed book | With layered memory |
| --- | ---: | ---: |
| **Correct** | **2 / 52 (3.8%)** | **40 / 52 (76.9%)** |
| Wrong | 36 / 52 | 12 / 52 |
| Abstained | 14 / 52 | 0 / 52 |
| Anchor resolved | — | 52 / 52 |
| Never-taught controls correctly declined | 5 / 8 | **8 / 8** |

Correctness is scored against a gold answer extracted from the source article *before* the model was
asked (see [Method](#method-how-a-question-and-its-gold-answer-are-built)); a year question must
contain the exact year, everything else must reproduce ≥60% of the gold span's content words.

Where the accepted answers came from:

| Answer source | Used | Correct |
| --- | ---: | ---: |
| `model` — the model composed it and passed adjudication | 35 | 28 |
| `deterministic-extractive-span` — best sentence span from a retrieved passage | 12 | 8 |
| `deterministic-reference-fallback` — the stored gist, for a broad question | 5 | 4 |

By question kind:

| Kind | n | Closed book | With memory |
| --- | ---: | ---: | ---: |
| definition (`What kind of thing is X?`) | 9 | 0 | 7 |
| location (`Where is X located?`) | 9 | 1 | 8 |
| year (`In what year was X …?`) | 9 | 0 | 6 |
| agent (`Who wrote/created/directed X?`) | 9 | 0 | 7 |
| affiliation (`What is X associated with?`) | 7 | 0 | 4 |
| broad (`What do you know about X?`) | 9 | 1 | 8 |

Retrieval behaviour across the 52 answerable questions: 9.4 Cheetah commands per question on
average, 2.0 memory items placed in context. Of the items that made it into a prompt, **46 came from
the direct anchor, 42 from lexical reinstatement, 12 from spreading activation and 4 from a
model-requested follow-up** — the ladder's later stages contribute nearly as much evidence as exact
anchor resolution, which is the whole reason they exist.

## What was wrong with the first-generation memory

The previous report's memory stored exactly one thing per article and retrieved it exactly one way:

- **Writing** clipped the article to its first two sentences (≤700 characters) and hung that single
  string on one `topic:<slug(title)>` node as one `references[]` entry. Everything after the lead
  paragraph was discarded before it ever reached the database.
- **Reading** stripped a known question prefix (`What do you know about …`), re-derived the same
  slug, and did `GRAPH_NODE_GET`. If the slug matched, the model got that one pre-made sentence; if
  it did not, retrieval was over.

Three consequences showed up directly in that report:

1. **No second layer to fall back on.** Five of its ten documented traces asked for a specific detail
   that was not in the lead sentence, so the only honest answer was a decline. Its closing note
   called an extractive answer "the next needed improvement".
2. **No context around a fact.** The model was asked for bare `(relation, object)` pairs. A pair like
   `is_for → football matches` means nothing on its own, which is part of why only 105 semantic edges
   survived 3,933 articles.
3. **Nothing to discover.** One node per article and almost no edges is a bag of isolated points.
   There was no path from one subject to a related one, so retrieval could never be more than "did
   the slug match".

There is also an engine constraint that made the single-node design worse than it looks.
`graphNodeIndexTokens` (`thirds/cheetah/src/graph_recall.go`) gives a node at most **12** index
tokens from its id and labels plus about **20** from its reference sentences. Piling an entire
article onto one node therefore leaves everything past the first ~20 distinct words lexically
invisible: no free-text cue can reach it, no matter how much text is stored.

## The layered memory

Writing an article now produces a small subgraph instead of a single node:

```text
topic:<subject>                     identity + gist reference + props.context/tags
  -[:has_passage]->  passage:<subject>_pN   one detail passage each, with its section name
  -[:in_context]->   context:<tag>          shared category — the bridge between subjects
  -[:mentions]->     entity:<name> / time:<year>
  -[:<relation>]->   entity:<object>        model-proposed, with its situating context + quote
```

Over the 200 articles that produced **751 passage nodes and 2,763 edges** (against 105 accepted edges
per 3,933 articles previously), plus 126 accepted semantic facts with 121 rejected.

Each layer exists for a specific reason:

- **Passage nodes** give every detail its own index budget — the direct answer to the 32-token cap
  above. A question about the third paragraph can now reach the paragraph that says it, because that
  paragraph is its own indexed node rather than the invisible tail of a long reference list.
- **Context nodes** are the discovery layer. Two subjects taught days apart that never mention each
  other still meet at `context:football_stadium` or `time:2011`, so spreading activation has
  somewhere to spread. A category must be a common noun: a live run proposed `Fairy Stone State Park`
  as a lake's category, which would have made a neighbouring park the lake's entire frame, so proper
  names are rejected here and kept as mentions instead.
- **Mention nodes** carry named entities and years, extracted deterministically. A capitalized run
  that only ever appears sentence-initially is ordinary English, not a name, so it is dropped unless
  the same surface also appears mid-sentence.
- **Semantic edges** now carry `props.context` (the situating clause) and `props.quote` (the verbatim
  fragment that states the fact), so a retrieved relation still means something without re-reading
  the article.

Navigation sections (`See also`, `External links`, `References`, `Category:` …) are dropped before
segmentation. Storing them filled the passage layer with link lists and donated words like
`Category`, `Protected` and `Tourist` to the mention layer as if they were entities — observed in the
first smoke run of this work.

## Teaching the model how to store context

The teach prompt no longer just asks for triples. It tells the model what the memory is for and what
a later reader will not have:

> You are writing "<subject>" into an external memory that another reader will search LATER, with
> none of this passage in front of them. They will see only what you store, so what you store has to
> carry the context that makes it understandable on its own.

and then names what to store and why: the framing clause (`subject_context`), the shared category
(`context_tags` — "these are the bridges between subjects, so never a proper name"), and the facts,
each with the situating `context` a later reader needs plus the verbatim `evidence_quote`.

Three prompt-shape findings were needed to make that land on a sub-1B model:

- **The schema's `title` is stripped from the prompt copy.** A model this small reads any prominent
  proper-sounding string as content: both schema generations produced
  `subject_name: "MiniPhi Cheetah … teach turn"` — it filed the article under the schema's own title.
  `response_format=json_schema` still carries the complete schema.
- **The last line of the prompt is the task reminder, not the schema.** The model echoes whatever it
  read last.
- **Instruction order flips extraction on and off.** Leading with the anti-invention rules made the
  model return *zero* facts and say so in its own reasoning ("this violates the rule against
  inventing facts"). Leading with "copying facts out of the SOURCE TEXT is the task; an empty list
  because the facts feel obvious is a failure" restored extraction.

Every proposal is still adjudicated deterministically before anything is written: `object_name` and
`evidence_quote` must occur verbatim in the source, a relation must be supported by a verb near the
object, a category may not be all-capitalized, and `subject_context` — the one place a paraphrase is
allowed — needs ≥85% of its content words present in the source or it is replaced by a synthesized
sentence built from the deterministic category.

## Hippocampal retrieval

Retrieval replaces the single `GRAPH_NODE_GET` with a bounded three-stage ladder, then a discovery
round driven by the model itself:

1. **Pattern completion.** Every capitalized run in the question is tried as an anchor, not just the
   whole stripped question.
2. **Spreading activation.** Resolved anchors seed a two-hop `GRAPH_RECALL` (`expand=none`,
   `references=1`), reaching that subject's passage nodes, its context/mention nodes, and other
   subjects sharing them — text hydrated in the same round trip.
3. **Lexical reinstatement.** The question's content words seed a recall against the derived term
   index. This is *not* only the "anchor missing" fallback: it also runs when an anchor resolved but
   its passages do not cover the question — the case the old ladder had no answer for. It supplied 42
   of the retrieved items in this run.
4. **Discovery.** Everything retrieved is consolidated into ranked, id-tagged evidence (`e1`, `e2`,
   …). The model reasons over those ids and, when the items are about the right subject but do not
   state what was asked, sets `needs_more_context` and names what to fetch in `follow_up_lookups`.
   MiniPhi executes those lookups and re-prompts once. Nine questions requested a follow-up; two
   received new evidence and were re-prompted with it.

The model never speaks to Cheetah. MiniPhi derives the ids, builds every command, and adjudicates the
result.

## Answer adjudication

Groundedness is still never taken from the model's own `grounded` flag, and the check is now three
independent conditions instead of one:

| check | what it catches |
| --- | --- |
| retrieval actually resolved something | the model claiming knowledge of a subject the memory has never seen |
| the citation points at a real retrieved item (`used_evidence_ids`) | evidence invented to look like a quote |
| ≥60% of the answer's content words occur in the cited item | the hole in the previous check — an answer about something else paired with a correct-looking quote |

When the model fails that, MiniPhi answers deterministically rather than declining outright:

| condition | final result |
| --- | --- |
| broad question, anchor resolved, gist stored | the stored gist (`deterministic-reference-fallback`) |
| specific question, a retrieved passage covers the asked-for detail | the extractive span (`deterministic-extractive-span`) |
| specific question, nothing covers the detail | decline, optionally recording an open question |
| no anchor resolved | decline — lexical hits alone never produce a broad answer |

The extractive span is the fix for the previous report's open item, and it produced 12 of the 52
answers here. It is gated on **focus tokens** — the question's words minus the subject's own name —
so "When was Alpha founded?" cannot be answered with "Alpha is located in One." just because both
mention Alpha, and on a type match, so a `when` question needs a year in the span. A broad question
never gets a span: its focus tokens are just the subject name, so any lexically similar passage would
qualify, which is exactly how a never-taught subject would be answered out of somebody else's
article.

## Method: how a question and its gold answer are built

Every question is generated by matching a literal pattern in the *source article*, and its gold
answer is the span that pattern captured — fixed before the model is asked and never produced by a
model, so a wrong answer cannot be excused by a wrong question. A question is only kept when the
sentence it came from names the subject (or is one of the article's opening two sentences), which
stops "The show was created by Ernie Johnson" in a biography from becoming "Who created Marc Fein?".

At most two questions come from any one article, and broad questions are capped at 30% of the set so
the easiest shape cannot dominate. Eight further articles were sampled and deliberately **not**
taught; their questions measure whether the system declines what it never learned.

## Three worked examples

Full traces for all 60 are in
[`cheetah_memory_benchmark_samples.md`](cheetah_memory_benchmark_samples.md).

### The layered case: a detail the old design could not have stored

> **Sample 9 — In what year was Microceratus created?** (gold `2008`)

Closed book: `152 BC`. With memory: **correct**.

The answer is not in the article's lead, so the first-generation memory would never have held it. It
came from `passage:microceratus_p2`, a detail node reached by **lexical reinstatement**, not by the
anchor:

```text
e1 [lexical/detail]  "Though much of the material has since been reassigned to the genus
                      Graciliceratops, a replacement name Microceratus was created by Mateus in
                      2008 for the type specimen."
e2 [associated/gist] "Microceratus (meaning "small-horned") is a genus of small ceratopsian
                      dinosaur that lived in the Cretaceous period in Asia…"
e3, e4 [lexical/detail] two further passage nodes of the same article
```

Nine Cheetah commands ran: two anchor lookups, a relation histogram, a two-hop spread, a lexical
recall, and four hydrations. The model did not compose an accepted answer; the extractive span did,
returning the exact sentence that contains 2008.

### The discovery case: the model asks for more memory

> **Sample 7 — What kind of thing is God Is in the House (Hillsong Church album)?**

The first recall turn set `needs_more_context: true` and asked for
`{"kind":"subject","value":"Hillsong Album","why":"The album's type itself is what we're trying to
identify."}`. MiniPhi ran that lookup (`follow_up_anchor`, `follow_up_lexical`), added the new
passages as `e2`/`e3` and re-prompted. The follow-ups were not useful in this case — they returned
two unrelated albums — but the direct gist was still in context and the extractive span answered
correctly: *"God Is in the House is the fifth album in the live praise and worship series of
contemporary worship music by Hillsong Church."* Closed book had said "electronic Christian
alternative rock album".

### The control case: what the memory never learned

> **Sample 54 — What do you know about Jan Berglin?** (never taught)

Closed book invented a biography: *"Jan Berglin was a physicist known for his work on qubits and
fault-tolerant quantum computation…"*. With memory, no anchor resolved, no passage was retrieved, and
MiniPhi answered `I don't know.` All 8 controls declined; 3 of the 8 closed-book answers were
confident fabrications.

## Honest limitations

- **12 of 52 answers with memory are still wrong**, and they are wrong in instructive ways. Sample 4
  ("Who created Microceratus?") scored correct because the gold token `Mateus` appears, but the
  model's sentence continues *"…as a replacement name for the wasp subfamily Gelinae"*, which is
  fabricated. The ≥60% support check passes because most of the answer's words *are* in the evidence.
  Support ratio bounds how far an answer can drift; it does not verify entailment.
- **Gold-recall scoring credits an answer that contains the gold span**, even when it also contains
  unsupported material. That makes 40/52 an upper bound on fully-correct answers, in the same spirit
  as the previous report's 35/780 caveat.
- **Broad questions are partly self-fulfilling**: their gold answer is the stored gist, and the
  deterministic fallback returns exactly that. This is why broad is capped at 30% of the set and
  reported as its own row.
- **The category layer still admits noise.** A definition like "Jagmanpur, Kanar is a situated 9 km…"
  yields the tag `situated 9 km`. Such tags are inert (no other article produces the same phrase, so
  they bridge nothing) but they are visible in stored `props.context`.
- **15 of 200 teach turns fell back** (invalid JSON or an LM error). Those articles still received the
  full deterministic layers — passages, categories, mentions — and lost only the model's proposed
  facts and tags.
- **Two defects were found by reading these traces and fixed afterwards; the recorded run predates
  both.** (1) The mention extractor let a capitalized run cross a sentence boundary, so
  "…lived in Asia. It walked on two legs" produced the entity node `entity:asia_it` (and
  "Mongolia the" from a trailing connector) — visible in sample 9's spread response. (2) Hydration
  could then attach such a name to an unrelated passage as its displayed subject, which is why
  sample 4 labels a Microceratus passage `Asia. It`. Stored *topic* names were always correct, and
  both fixes are covered by
  `unit-tests-js/cheetah-memory-layers.test.js` / `cheetah-hippocampus.test.js`.
- Runtime is dominated by the model's reasoning. See [Reproducing](#reproducing-the-benchmark) — this
  distill needs `reasoning_effort: low` or turns take 10-30× longer.

## Reproducing the benchmark

```bash
node scripts/run-cheetah-memory-benchmark.js --base-url http://127.0.0.1:1234 --database wikimem --learn-count 200 --sample-count 52 --control-count 8 --seed 20260803 --concurrency 1 --reset-database
```

```bash
node scripts/render-cheetah-memory-report.js --session-dir .miniphi/cheetah/memory-benchmark/run-200 --out docs/cheetah_memory_benchmark_samples.md
```

Two host lessons are baked into the runner and matter for any repeat:

- **The model must be loaded explicitly.** With it unloaded, every `/v1/chat/completions` request
  hangs indefinitely while `/api/v1/models` answers in milliseconds — which reads exactly like a
  wedged server and is not one. `ensureModelLoaded` does catalog-check → `POST /api/v1/models/load`
  (~2.4 s) → warm completion before the run starts.
- **`reasoning_effort: low` is accepted even though this model advertises no reasoning capability.**
  Without it the distill produced **21,519 characters of reasoning for a 974-character answer** at
  53-200 s per turn; with it, ~1,500 characters at 5.5-9.4 s. Do *not* instead cap `max_tokens` low —
  at 1,900 the model spent the whole budget on reasoning and returned empty content on ~50% of turns.

Inspect:

- `.miniphi/cheetah/memory-benchmark/run-200/` — `learned.jsonl`, `questions.json`, `samples.jsonl`,
  `report.json`;
- `.miniphi/prompt-exchanges/` — complete schema-bound LM exchanges, now including the REST route's
  reasoning text;
- `thirds/cheetah/cheetah_data/wikimem` — the Cheetah database;
- [`docs/cheetah-wikipedia-learning.md`](cheetah-wikipedia-learning.md) — setup, controls and safety
  for the streaming learner.
