# WebNLG text → learned graph → model-directed questions

This optional experiment uses the local English exports at
`thirds/cheetah/studies/datasets/web_nlg`. `cheetah-learn webnlg` reads **only the first
human-written target sentence** of each selected training entry into the model.
The RDF `input` triples are retained outside prompts for endpoint-pair coverage
metrics after extraction. This differs from Cheetah's Go demo, which imports gold
RDF triples to validate storage.

Initialize submodules and build/start Cheetah using its handbook, then load the model:

```sh
node src/index.js models --load qwen3-4b-thinking-2507-mlx --context-length 8192
node src/index.js lmstudio-health --timeout 10
node src/index.js cheetah-learn webnlg --limit 20 \
  --base-url http://127.0.0.1:1234 --model qwen3-4b-thinking-2507-mlx
node src/index.js cheetah-learn graph-ask "Where is Aarhus Airport located?"
```

Both new actions default to the exact Qwen key above and database `miniphi_webnlg`.
`--cheetah-database`, `--cheetah-host`, `--cheetah-port`, `--cheetah-text`, `--model`
and `--base-url` work as for the existing learner. These actions use a separate
`knowledge:<sha256>` entity namespace, distinct from `topic:` layered memories and
the interactive session-context mirror. Existing `ask` and `knowledge_lookup` use
the earlier memory shape; use `graph-ask` to query this graph.

`webnlg` accepts `--dataset-path <directory>`, `--limit <entries>` (default 20 per
invocation), `--offset <zero-based index>` (default 0), `--checkpoint <file>`,
`--no-resume`, `--session-timeout <seconds>` (default 900), and optionally
`--question <question>` after teaching. Repeating a command resumes from the next
entry. A checkpoint binds the dataset SHA-256, database, model and initial offset;
a mismatch is an error. Use different checkpoints for different slices. `--no-save`
disables run reports/checkpoints; prompt audit recording remains enabled.
Neither action resets a database. `--max-rounds <1..8>` defaults to four reasoning
turns, with at most two lookups per turn and sixteen returned edges per lookup.
`--json` prints structured results, including query traces and stop reasons.

A small cross-entry chain can be taught from the real export without importing gold:

```sh
# Aarhus Airport → Tirstrup
node src/index.js cheetah-learn webnlg --offset 3 --limit 1 --checkpoint .miniphi/cheetah/webnlg/airport.json
# Tirstrup → Denmark
node src/index.js cheetah-learn webnlg --offset 278 --limit 1 --checkpoint .miniphi/cheetah/webnlg/tirstrup.json
node src/index.js cheetah-learn graph-ask "In which country is Aarhus Airport located?" --json
```

Indices refer to the checked-in export. The source text, source id, model extraction,
rejected claims, edge probes, writes and endpoint metrics are saved in adjacent
`<checkpoint>.rows/<index>.json` receipts. The bounded checkpoint retains the last
50 records, last 20 answers and cumulative counters.
Full model messages, raw responses, reasoning, usage, `response_format`, `tool_calls`
and `tool_definitions` are retained by `PromptRecorder` under `.miniphi/`.

Extraction uses `cheetah-graph-extract@v1`; first/repair lookups use
`cheetah-graph-query@v1` (a nonempty lookup array); answering uses
`cheetah-graph-reason@v1`. All schemas use scalar types compatible with MLX, require
`needs_more_context` and `missing_snippets`, and travel as exact prompt schemas plus
`response_format=json_schema`. Schema repair is bounded by the existing handler;
the adapter independently revalidates before using a response. A failed extraction
keeps its verbatim episode, writes no claims and leaves the cursor at the failed row.
These graph commands opt into a workaround for LM Studio's MLX structured-output
routing: when `content` is empty, a **whole**, schema-valid JSON document in
`reasoning_content` may be used only with finish `stop` and no tool calls. Raw
content/reasoning are preserved alongside `structuredOutputSource`. Mixed prose,
fragments and truncated responses still fail.

Each source is bounded to 4000 UTF-8 bytes so a complete reference fits Cheetah's
per-reference byte limit. Each accepted claim needs source-overlapping subject,
object, relation and quote.
Negated/speculative quotes are refused. The adapter probes the exact edge before
writing, skips duplicates, retains episode provenance, and rejects partial batches.
Names merge case/whitespace variants; punctuation and accents remain significant.

The question model starts with no evidence and asks for an entity's outgoing or
incoming edges. It may then ask about a returned endpoint. Only names occurring in
the question or returned evidence are eligible; repeated lookups are refused.
Cheetah's upstream `buildTraversal` constructs every query. An answer must name an
exact endpoint and cite an ordered connected chain from a question entity. The
adapter returns that endpoint alone, preventing invented prose tails. A question
explicitly asking for a country, city, capital, language, leader or currency also
needs that role in the terminal source quote/relation. A wrong or unsupported
answer may trigger a required intermediate lookup within the same round cap.
Missing
evidence produces a decline and an open question in Cheetah, visible through
`cheetah-learn questions --cheetah-database miniphi_webnlg`.

Limitations: source overlap does **not** prove semantic entailment or relation
direction. Natural predicates are not WebNLG's RDF ontology; reported endpoint-pair
coverage is not RDF triple F1. These historical dataset claims are not current-world
verification. Exact entity spelling is needed apart from case/whitespace; there is
no automatic alias resolution, contradiction adjudication, unrestricted query code,
full-corpus quality claim, or automatic integration into the coding agent. Prompts
reserve schema/system/output space against the loaded context window; excessive
evidence stops with `context-overflow` rather than overflowing the model.

Offline verification:

```sh
node --test unit-tests-js/cheetah-graph-learning.test.js unit-tests-js/cheetah-learn-command.test.js
cd thirds/cheetah/binders/nodejs && node --test test/*.test.js
```

The live acceptance gate is extraction from separate real entries, a model-selected
intermediate lookup with both cited edges, decline of an untaught control, and
retention after restarting Cheetah. Record actual results before declaring this gate
passed; a scripted offline model proves the protocol, not Qwen's reasoning quality.

Run it with the model already loaded and the Cheetah binary built:

```sh
MINIPHI_LMSTUDIO_INTEGRATION=1 MINIPHI_CHEETAH_INTEGRATION=1 \
  LMSTUDIO_REST_URL=http://127.0.0.1:1234 \
  MINIPHI_LIVE_MODEL=qwen3-4b-thinking-2507-mlx \
  node --test unit-tests-js/cheetah-webnlg.live.test.js
```

On 2026-10-26 this test passed in 30.5 seconds with two facts extracted from
training entries 3 and 278, answer `Denmark` with both cited edges, an untaught
control declined, and the same chain retained after restart. Complete audit:
`.miniphi/cheetah/webnlg/live-1793021620390/`. A separate four-round CLI trace
shows Qwen initially proposing `Tirstrup`, receiving a role/citation rejection,
requesting `Tirstrup`'s edges, and then answering `Denmark` using `e1,e2`.

A 20-entry slice produced 8 new accepted claims and 1 known claim, rejected 4
unsupported proposals and returned 7 empty extractions. Only 5 of 20 gold endpoint
pairs matched. A separate language-source probe extracted no facts, so the longer
language question declined. These results establish the bounded learning/query
loop; extraction coverage, ontology alignment and longer reasoning need more work.

The manual proof's database files are retained in `.miniphi/cheetah/webnlg-data/`.
To reopen those learned facts after stopping the server, run from MiniPhi's root:

```sh
CHEETAH_HEADLESS=1 CHEETAH_LISTEN_ADDR=127.0.0.1:4455 \
  CHEETAH_DATA_DIR="$PWD/.miniphi/cheetah/webnlg-data" \
  thirds/cheetah/cheetah-server
```

For twenty varied concepts, confidence diagnostics, compound-question decomposition
and fully recorded delayed/rephrased retests, see
[`webnlg_learning.md`](webnlg_learning.md). Use `graph-ask --decompose --json` to
expose the same per-concept assessment and independently grounded recall in the CLI.
Self-confidence never supplies evidence or authorizes a fact write. Current runtime
repairs include focused entity references, bounded Cheetah lexical name completion,
predicate/direction discovery, partial-extraction repair and normalization of valid
cited subpaths. The older measurements above remain historical recorded results.
