# Reusable Wikipedia real-time memory learning with Cheetah

This workflow streams a local Wikipedia JSON dump into Cheetah while MiniPhi uses a small LM Studio model to propose conservative semantic edges. At fixed intervals it re-queries the same early subjects, so retrieval and answer changes are visible while later articles are still being learned.

The reusable script is configured for this reference setup:

- dataset: `E:\Models\datasets\wiki-data-2021`
- LM Studio: `http://192.168.56.1:1234`
- model: `smollm2-360m-instruct` (`SmolLM2-360M-Instruct-GGUF`)
- Cheetah database: `wikidata`
- checkpoint: `.miniphi/cheetah/wikipedia/wikidata-checkpoint.json`

The observed dump contains 605 real JSON shards (about 22.08 GiB) plus 605 `._*.json` AppleDouble sidecars. The reader sorts the real shards, skips the sidecars, and parses each top-level JSON array as a byte stream instead of loading a shard into memory.

## Safety and learning model

Each usable article creates an authoritative `topic:<title>` memory containing a bounded, exact source excerpt and provenance. SmolLM2 may additionally propose up to three semantic `(relation, object)` edges. An edge is saved only when:

1. `object_name` is a contiguous phrase in the source excerpt; and
2. meaningful relation terms are supported by a nearby source sentence.

This division is intentional. The exact excerpt is the safe memory of record; tiny-model triples are optional search structure. Invalid JSON, unsupported relations, and hallucinated objects cannot silently become semantic facts. Every model request carries the exact registered JSON schema through both the prompt and `response_format=json_schema`; prompt text, responses, reasoning, tool definitions, and validation metadata are recorded under `.miniphi/prompt-exchanges/`.

Inference probes are read-only. They never create open-question training data. A probe reports three separate outcomes:

- `retrievalResolvedRate`: Cheetah found the exact learned subject.
- `modelGroundedRate`: the model returned a non-decline answer whose evidence matches a retrieved source reference.
- `effectiveGroundedRate`: either the model grounded correctly or, for the broad retention question `What do you know about <subject>?`, MiniPhi returned the exact retrieved reference as a deterministic fallback.

`deterministicFallbackCount` is not model success. It is reported separately because a 360M model can retrieve the right memory and still fail to compose a reliable JSON-grounded answer. Specific unanswered questions still decline; the broad fallback is not used to imply that an arbitrary detail was found.

## Prerequisites

1. Install/load `SmolLM2-360M-Instruct-GGUF` in LM Studio and confirm its model key is `smollm2-360m-instruct`.
2. Make LM Studio reachable at `http://192.168.56.1:1234`.
3. Initialize Cheetah once from the MiniPhi root:

   ```powershell
   git submodule update --init --recursive thirds/cheetah
   ```

4. Confirm the dataset directory exists and its real shards are top-level JSON arrays whose items include `id`, `title`, and `text`.

The script builds and starts the submodule's `cheetah-server` when port 4455 is free. It keeps database files under `thirds/cheetah/cheetah_data/wikidata` and stops only the process it started.

## Recommended staged run

Run a destructive smoke test only when you intentionally want a fresh `wikidata` database:

```powershell
node scripts/run-cheetah-wikipedia-learning.js --reset-database --limit 3 --probe-every 1 --probe-count 2 --verbose
```

Then resume without resetting:

```powershell
node scripts/run-cheetah-wikipedia-learning.js --limit 100 --probe-every 10 --probe-count 3 --verbose
```

Repeat the second command for additional bounded slices. The checkpoint is written after every article and contains the next shard byte offset, cumulative counters, fixed retention subjects, recent results, probe history, and canonical stop reason. A crash or operator stop therefore loses at most the in-flight article.

For unattended automation, keep each invocation bounded and inspect its exit code and checkpoint before launching the next slice. Example PowerShell loop:

```powershell
for ($batch = 1; $batch -le 10; $batch += 1) {
  node scripts/run-cheetah-wikipedia-learning.js --limit 1000 --probe-every 100 --probe-count 5 --json
  if ($LASTEXITCODE -ne 0) { break }
}
```

Do not add `--reset-database` to a resume loop. `--no-resume` ignores the saved input position but deliberately does not clear Cheetah, which is useful for idempotency testing but not for starting over.

## Four-hour reliability and benchmark session

Use the soak runner when the goal is continuous execution with retained time-series evidence rather than ingestion alone:

```powershell
node scripts/run-cheetah-wikipedia-soak.js --duration-hours 4
```

Every cycle resumes a bounded Wikipedia batch, probes fixed early memories, refreshes the model's Easy benchmark, archives that complete benchmark payload instead of overwriting history, and runs `npm test`. The session stops immediately on a failed step so the defect can be repaired before resuming the same artifact directory and original deadline:

```powershell
node scripts/run-cheetah-wikipedia-soak.js `
  --session-dir .miniphi\cheetah\soak\<session-id>
```

Session state, step events, stdout/stderr logs, checkpoint snapshots, and benchmark snapshots live under `.miniphi/cheetah/soak/<session-id>/`. Defaults are 100 articles per cycle, probes every 25 articles over five retained subjects, and one benchmark plus one full unit-test gate per cycle. Use `--article-batch`, `--probe-every`, `--probe-count`, `--benchmark-every`, and `--test-every` to change cadence without weakening the four-hour deadline.

## Useful controls

```text
--limit <n>                 Articles attempted in this invocation
--probe-every <n>           Re-run retention inference after N articles
--probe-count <n>           Number of fixed early subjects to retain and probe
--max-errors <n>            Stop after consecutive LM inference errors
--max-no-progress <n>       Stop after articles save neither memory nor facts
--max-sentences <n>         Leading article sentences sent to the model
--max-chars <n>             Source excerpt character cap
--max-article-bytes <n>     Parser cap for one raw JSON article
--checkpoint <file>         Alternate resumable state file
--no-start-cheetah          Require an already-running server
--keep-cheetah              Leave an auto-started server running
--reset-database            Destructively clear the selected DB and restart input
--no-resume                 Restart input without clearing the selected DB
--json                      Machine-readable final result
```

Run `node scripts/run-cheetah-wikipedia-learning.js --help` for the complete current list, including endpoint and Cheetah connection overrides.

The same workflow is available through the lower-level command if Cheetah is already running:

```powershell
node src/index.js cheetah-learn wikipedia `
  --dataset-path E:\Models\datasets\wiki-data-2021 `
  --base-url http://192.168.56.1:1234 `
  --model smollm2-360m-instruct `
  --cheetah-database wikidata `
  --limit 100 --probe-every 10 --probe-count 3
```

## Interpreting and comparing a run

Inspect:

- checkpoint and probe history: `.miniphi/cheetah/wikipedia/wikidata-checkpoint.json`
- per-invocation reports: `.miniphi/cheetah/runs/wikipedia-*.json`
- run index: `.miniphi/cheetah/index.json`
- complete LM exchanges: `.miniphi/prompt-exchanges/`
- database: `thirds/cheetah/cheetah_data/wikidata`

For every probe, compare `changes.newlyResolved`, `changes.newlyGrounded`, `changes.regressedResolution`, `changes.regressedGrounding`, and `changes.answerChanged` with the prior probe. A healthy retention test has no resolution or grounding regressions for the fixed early subjects. Treat an increasing semantic fact count as useful only when rejection counts and recorded prompt exchanges confirm that source grounding stayed conservative.

## Live reference proof (2026-08-01)

The implemented workflow was run against the paths and endpoint above. A clean three-article run followed by resumed ten- and twenty-article runs produced:

- 33 articles read, 33 exact source memories saved, 2 conservative semantic edges saved, and 16 proposed edges rejected;
- 7 interleaved probes with no retrieval or effective-grounding regressions and no inference errors;
- final probe: 3/3 exact subjects resolved and 3/3 effectively grounded;
- final probe: 0/3 model-grounded and 3 deterministic exact-reference fallbacks.

This proves streaming, Unicode-safe persistence, byte-offset resume, retention across 30 later writes, and honest fallback accounting on a bounded slice. It does not claim that the full 22.08 GiB dump has been ingested or that SmolLM2 independently answers the learned facts reliably.

## Regression tests

```powershell
node --test unit-tests-js/local-wikipedia-dataset.test.js `
  unit-tests-js/cheetah-wikipedia-runner.test.js `
  unit-tests-js/cheetah-wikipedia-soak.test.js `
  unit-tests-js/cheetah-knowledge-client.test.js `
  unit-tests-js/cheetah-learner.test.js `
  unit-tests-js/cheetah-learn-command.test.js
```

These tests cover split UTF-8 and JSON chunk boundaries, sidecar skipping, byte-offset resume, oversized records, bounded no-progress/error stops, fixed-subject probes, non-mutating evaluation, Unicode episode writes through the official binder, source grounding, and deterministic reference fallback.
