import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import LocalContextMemory, {
  createLocalContextMemory,
  lightStem,
  LOCAL_MEMORY_SCHEMA_VERSION,
  resolveLocalMemoryConfig,
} from "../src/libs/local-context-memory.js";

const makeBase = async () =>
  fs.promises.mkdtemp(path.join(os.tmpdir(), "miniphi-local-memory-"));

const write = async (filePath, content) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf8");
};

test("local memory configuration is on by default and honours env opt-out", () => {
  assert.equal(resolveLocalMemoryConfig({}, {}).enabled, true);
  assert.equal(resolveLocalMemoryConfig({}, { MINIPHI_LOCAL_MEMORY: "0" }).enabled, false);
  assert.equal(
    resolveLocalMemoryConfig({ context: { localMemory: { enabled: false } } }, {}).enabled,
    false,
  );
  assert.equal(
    resolveLocalMemoryConfig({ context: { localMemory: { maxCandidates: 3 } } }, {}).maxCandidates,
    3,
  );
});

test("the light stemmer maps the inflections a real agent seed mixes", () => {
  // Each pair is a query wording against the wording a stored sentence used.
  for (const [left, right] of [
    ["change", "changed"],
    ["file", "files"],
    ["serve", "server"],
    ["image", "images"],
    ["apply", "applied"],
    ["render", "rendering"],
  ]) {
    assert.equal(lightStem(left), lightStem(right), `${left} != ${right}`);
  }
  // Distinct concepts must not collapse into one another.
  assert.notEqual(lightStem("photo"), lightStem("post"));
  assert.notEqual(lightStem("upload"), lightStem("update"));
});

test("remembered facts survive a fresh store and are recalled by content", async () => {
  const base = await makeBase();
  const memory = new LocalContextMemory({ baseDir: base, sessionId: "s1" });
  await memory.prepare();
  const record = await memory.remember({
    kind: "decision",
    title: "storage choice",
    text: "The photo service stores uploads in SQLite through better-sqlite3 rather than Postgres.",
    tags: ["sqlite", "storage"],
  });
  assert.ok(record);
  assert.equal(record.schemaVersion, LOCAL_MEMORY_SCHEMA_VERSION);

  // A second process only sees what reached disk.
  const reopened = new LocalContextMemory({ baseDir: base, sessionId: "s2" });
  await reopened.prepare();
  const hit = reopened.recall({ text: "which sqlite driver did we pick for uploads?" });
  assert.equal(hit.ok, true);
  assert.ok(hit.referenceCandidates.length > 0);
  assert.match(hit.referenceCandidates[0].text, /better-sqlite3/);

  const miss = reopened.recall({ text: "kubernetes ingress certificate rotation" });
  assert.equal(miss.referenceCandidates.length, 0);
});

test("local candidates never name a graph node and are prefixed for the mirror to skip", async () => {
  const base = await makeBase();
  const memory = new LocalContextMemory({ baseDir: base });
  await memory.prepare();
  await memory.remember({
    title: "puppeteer",
    text: "Puppeteer screenshots are taken after networkidle0 so the feed images are loaded.",
  });
  const [candidate] = memory.recall({ text: "puppeteer screenshot feed" }).referenceCandidates;
  assert.ok(candidate);
  assert.match(candidate.id, /^local:lm_[a-f0-9]{20}:/);
  assert.equal(candidate.sourceNodeId, null);
  assert.equal(candidate.origin, "local");
});

test("repeating the same fact updates it instead of multiplying records", async () => {
  const base = await makeBase();
  const memory = new LocalContextMemory({ baseDir: base });
  await memory.prepare();
  const first = await memory.remember({
    title: "port",
    text: "The generated server listens on port 3000.",
    importance: 0.4,
  });
  const second = await memory.remember({
    title: "port",
    text: "The generated server listens on port 3000.",
    importance: 0.9,
    tags: ["server"],
  });
  assert.equal(first.id, second.id);
  assert.equal(memory.stats().records, 1);
  assert.equal(second.importance, 0.9);
  assert.deepEqual(second.tags, ["server"]);
});

test("markdown notes are harvested per section and re-harvested when edited", async () => {
  const base = await makeBase();
  const notePath = path.join(base, "memory", "notes", "stack.md");
  await write(
    notePath,
    [
      "---",
      "title: Stack decisions",
      "tags: stack, nodejs",
      "kind: decision",
      "---",
      "",
      "## Web framework",
      "Express 4 serves the templated pages and the JSON API.",
      "",
      "## Image handling",
      "Sharp resizes uploads to a 1080px long edge before they are stored.",
      "",
    ].join("\n"),
  );
  const memory = new LocalContextMemory({ baseDir: base });
  await memory.prepare();
  const refreshed = await memory.refresh();
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.harvested, 2);

  const express = memory.recall({ text: "which web framework serves the JSON API?" });
  assert.match(express.referenceCandidates[0].text, /Express 4/);

  // Editing the note replaces its records rather than leaving the old wording.
  await write(
    notePath,
    ["## Web framework", "Fastify serves the templated pages and the JSON API.", ""].join("\n"),
  );
  await memory.refresh();
  const after = memory.recall({ text: "which web framework serves the JSON API?" });
  assert.match(after.referenceCandidates[0].text, /Fastify/);
  assert.equal(
    after.referenceCandidates.some((candidate) => /Express 4/.test(candidate.text)),
    false,
  );
  assert.equal(
    memory.recall({ text: "sharp resize uploads long edge" }).referenceCandidates.length,
    0,
  );
});

test("hard-wrapped prose is rejoined before it becomes reference sentences", async () => {
  const base = await makeBase();
  await write(
    path.join(base, "memory", "notes", "wrapped.md"),
    [
      "## Session cookie",
      // Exactly the shape a markdown note is written in: one sentence, wrapped.
      "The compatible route honours the reasoning_effort parameter and silently",
      "ignores the reasoning parameter, which is the native spelling.",
      "",
      "## Fenced code stays line-wise",
      "```",
      "const port = 3000;",
      "server.listen(port);",
      "```",
      "",
    ].join("\n"),
  );
  const memory = new LocalContextMemory({ baseDir: base });
  await memory.prepare();
  await memory.refresh();

  const [candidate] = memory.recall({
    text: "which parameter does the compatible route honour?",
  }).referenceCandidates;
  assert.ok(candidate, "the wrapped sentence must be recallable");
  assert.match(candidate.text, /reasoning_effort parameter and silently ignores/);
  assert.doesNotMatch(
    candidate.text,
    /silently$/,
    "a sentence must not be stored truncated at the wrap point",
  );

  // Code lines mean something individually and must not be glued together.
  const code = memory.recall({ text: "server listen port 3000" }).referenceCandidates;
  assert.equal(
    code.some((entry) => /const port = 3000; server\.listen/.test(entry.text)),
    false,
    "code lines must keep their line-wise treatment",
  );
});

test("a previous session's graph and result are harvested without touching Cheetah", async () => {
  const base = await makeBase();
  const sessionDir = path.join(base, "agent-sessions", "agent-1700000000000");
  await write(
    path.join(sessionDir, "context-graph.json"),
    JSON.stringify({
      nodes: [
        {
          id: "c1",
          layer: "mission",
          kind: "mission",
          label: "task",
          state: "live",
          importance: 1,
          text: "Implement the photos-social template as a working Node.js application.",
        },
        {
          id: "c2",
          layer: "plan",
          kind: "model-note",
          label: "decision",
          state: "live",
          importance: 0.8,
          text: "Session decided to keep the template markup and only replace its data with server-rendered values.",
        },
        {
          id: "c3",
          layer: "evidence",
          kind: "action",
          label: "read",
          state: "live",
          importance: 0.5,
          text: "Reading assets/js/script.js returned 400 lines of unrelated UIkit glue that must not enter memory.",
        },
      ],
    }),
  );
  await write(
    path.join(sessionDir, "result.json"),
    JSON.stringify({
      task: "Build the photo social network",
      summary: "Created the Express server and the SQLite schema.",
      stopReason: "completed",
      appliedEdits: [{ path: "server/app.js" }, { path: "server/db.js" }],
    }),
  );

  const memory = new LocalContextMemory({ baseDir: base });
  await memory.prepare();
  await memory.refresh();

  assert.match(
    memory.recall({ text: "what did the previous session decide about the template markup?" })
      .referenceCandidates[0].text,
    /template markup/,
  );
  // The previous run's mission is the *current* run's mission verbatim; keeping
  // it is a long, highly topical duplicate that outranks real conclusions.
  assert.equal(
    memory
      .recall({ text: "implement the photos-social template as a working application" })
      .referenceCandidates.some((candidate) => /Implement the photos-social template/.test(candidate.text)),
    false,
    "a previous session's mission must not become durable memory",
  );
  assert.match(
    memory.recall({ text: "which files did the earlier session change?" }).referenceCandidates[0]
      .text,
    /server\/app\.js/,
  );
  // Evidence-layer tool output is this-run working state, never durable memory.
  assert.equal(
    memory.recall({ text: "UIkit glue script.js lines" }).referenceCandidates.length,
    0,
  );
});

test("the live session's own records are excluded so the prompt never duplicates them", async () => {
  const base = await makeBase();
  const memory = new LocalContextMemory({ baseDir: base, sessionId: "live" });
  await memory.prepare();
  await memory.remember({
    title: "live note",
    text: "The reels page needs an infinite scroll endpoint.",
    sessionId: "live",
  });
  await memory.remember({
    title: "old note",
    text: "The explore page needs a masonry grid endpoint.",
    sessionId: "previous",
  });
  const all = memory.recall({ text: "which page needs an endpoint?" });
  assert.equal(all.referenceCandidates.length, 2);
  const filtered = memory.recall({
    text: "which page needs an endpoint?",
    excludeSessionId: "live",
  });
  assert.equal(filtered.referenceCandidates.length, 1);
  assert.match(filtered.referenceCandidates[0].text, /explore/);
});

test("a deleted derived index costs a rescan, never a fact", async () => {
  const base = await makeBase();
  const memory = new LocalContextMemory({ baseDir: base });
  await memory.prepare();
  await memory.remember({ title: "kept", text: "The upload limit is eight megabytes per photo." });
  await write(
    path.join(base, "memory", "notes", "limits.md"),
    "## Rate limit\nThe API allows sixty uploads per hour per account.\n",
  );
  await memory.refresh();
  await fs.promises.rm(path.join(base, "memory", "index.json"));

  const reopened = new LocalContextMemory({ baseDir: base });
  await reopened.prepare();
  assert.match(
    reopened.recall({ text: "upload limit megabytes" }).referenceCandidates[0].text,
    /eight megabytes/,
  );
  await reopened.refresh();
  assert.match(
    reopened.recall({ text: "how many uploads per hour" }).referenceCandidates[0].text,
    /sixty uploads/,
  );
  assert.equal(reopened.stats().records, 2);
});

test("the factory returns null when disabled and a prepared store otherwise", async () => {
  const base = await makeBase();
  assert.equal(
    await createLocalContextMemory({ baseDir: base, env: { MINIPHI_LOCAL_MEMORY: "0" } }),
    null,
  );
  const memory = await createLocalContextMemory({ baseDir: base, env: {}, sessionId: "s" });
  assert.ok(memory instanceof LocalContextMemory);
  assert.equal(memory.stats().engine, "local");
  assert.ok(fs.existsSync(path.join(base, "memory", "notes")));
});
test("a stale per-turn validation snapshot is never stored as durable memory", async () => {
  const base = await makeBase();
  const sessionDir = path.join(base, "agent-sessions", "agent-1700000000001");
  await write(
    path.join(sessionDir, "context-graph.json"),
    JSON.stringify({
      nodes: [
        {
          id: "c1",
          layer: "plan",
          kind: "validation",
          label: "validation issues (turn 0)",
          state: "live",
          importance: 1,
          text: "Create the Node.js application inside server/. Nothing exists there yet.",
        },
        {
          id: "c2",
          layer: "plan",
          kind: "model-note",
          label: "decision",
          state: "live",
          importance: 0.8,
          text: "The session chose Express and the built-in node:sqlite driver for storage.",
        },
      ],
    }),
  );
  const memory = new LocalContextMemory({ baseDir: base });
  await memory.prepare();
  await memory.refresh();

  // The decision survives; the turn-0 snapshot, which was stale the moment the
  // next edit landed, does not.
  assert.match(
    memory.recall({ text: "which driver was chosen for storage?" }).referenceCandidates[0].text,
    /node:sqlite/,
  );
  assert.equal(
    memory.recall({ text: "nothing exists there yet in server" }).referenceCandidates.length,
    0,
  );
});
