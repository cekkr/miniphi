import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listWikipediaJsonFiles,
  streamWikipediaArticles,
  streamWikipediaShard,
} from "../src/libs/local-wikipedia-dataset.js";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("local Wikipedia reader skips AppleDouble files and streams split UTF-8/string boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-wikipedia-reader-"));
  try {
    const articles = [
      { id: "1", title: "Braces {inside}", text: "A quoted \\\"brace }\\\" and café." },
      { id: "2", title: "Second", text: "Second article." },
    ];
    await fs.writeFile(path.join(root, "b.json"), JSON.stringify(articles), "utf8");
    await fs.writeFile(path.join(root, "a.json"), JSON.stringify([{ id: "0", title: "First", text: "First." }]), "utf8");
    await fs.writeFile(path.join(root, "._a.json"), "not dataset json", "utf8");

    const inventory = await listWikipediaJsonFiles(root);
    assert.deepEqual(inventory.files, ["a.json", "b.json"]);
    const rows = await collect(streamWikipediaArticles(root, { highWaterMark: 7 }));
    assert.deepEqual(rows.map((row) => row.article?.title), ["First", "Braces {inside}", "Second"]);
    assert.equal(rows[1].article.text, articles[0].text);
    assert.equal(rows.every((row) => row.error === null), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("local Wikipedia shard offsets resume at the next article without replay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-wikipedia-resume-"));
  try {
    const file = path.join(root, "articles.json");
    await fs.writeFile(
      file,
      JSON.stringify([
        { id: "1", title: "One", text: "One." },
        { id: "2", title: "Two", text: "Two." },
        { id: "3", title: "Three", text: "Three." },
      ]),
      "utf8",
    );
    const initial = await collect(streamWikipediaShard(file, { highWaterMark: 9 }));
    const resumed = await collect(
      streamWikipediaShard(file, {
        startByteOffset: initial[0].nextByteOffset,
        startArticleOrdinal: initial[0].articleOrdinal + 1,
        highWaterMark: 5,
      }),
    );
    assert.deepEqual(resumed.map((row) => row.article.title), ["Two", "Three"]);
    assert.deepEqual(resumed.map((row) => row.articleOrdinal), [1, 2]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("local Wikipedia reader reports oversized articles and advances its resume offset", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-wikipedia-large-"));
  try {
    const file = path.join(root, "articles.json");
    await fs.writeFile(
      file,
      JSON.stringify([
        { id: "1", title: "Large", text: "x".repeat(300) },
        { id: "2", title: "Small", text: "ok" },
      ]),
      "utf8",
    );
    const rows = await collect(streamWikipediaShard(file, { maxArticleBytes: 100, highWaterMark: 11 }));
    assert.match(rows[0].error, /^article-too-large:/);
    assert.equal(rows[0].article, null);
    assert.equal(rows[1].article.title, "Small");
    assert.ok(rows[1].nextByteOffset > rows[0].nextByteOffset);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
