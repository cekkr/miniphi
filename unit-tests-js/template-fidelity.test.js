import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  checkOwnTestSuite,
  checkTemplateFidelity,
  readTemplateVocabulary,
} from "../scripts/photos-social/template-fidelity.js";

const TEMPLATE = `<!doctype html>
<html><head><title>Home</title>
<link rel="stylesheet" href="assets/css/style.css">
</head><body>
<header class="header header-fixed"><nav class="nav nav-primary"><a class="nav-link" href="#">Home</a></nav></header>
<main class="feed feed-main">
  <article class="card post-card"><img class="post-image" src="assets/images/post/post-1.jpg"><div class="card-body post-body"><p class="caption">One</p></div></article>
  <article class="card post-card"><img class="post-image" src="assets/images/post/post-2.jpg"><div class="card-body post-body"><p class="caption">Two</p></div></article>
</main>
</body></html>`;

const withServer = async (handler, run) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const makeTemplateDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-template-"));
  await fs.writeFile(path.join(dir, "home.html"), TEMPLATE, "utf8");
  return dir;
};

test("the template's own vocabulary is read from the files, never hard-coded", async () => {
  const dir = await makeTemplateDir();
  const vocabulary = await readTemplateVocabulary(dir, ["home.html"]);
  assert.deepEqual(vocabulary.pagesRead, ["home.html"]);
  assert.ok(vocabulary.classes.has("post-card"));
  assert.ok(vocabulary.classes.has("card-body"));
  assert.ok(vocabulary.stylesheets.has("/assets/css/style.css"));
  assert.ok([...vocabulary.assets].some((asset) => asset.includes("/assets/images/post/")));
});

test("a page that invents its own markup is rejected, however well it works", async () => {
  const dir = await makeTemplateDir();
  const mock = `<html><head></head><body><h1>Feed</h1><div><img src="/uploads/a.jpg"><p>A caption</p></div></body></html>`;
  const result = await withServer(
    (request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(mock);
    },
    (origin) =>
      checkTemplateFidelity({
        origin,
        templateDir: dir,
        pages: [{ name: "feed", pathname: "/feed" }],
      }),
  );
  assert.ok(result.issues.length >= 1);
  assert.match(result.issues[0], /Build \/feed from the html-template\/ markup/);
  assert.match(result.issues[0], /only 0 of the template's own CSS classes/);
  // And it names the tool that makes the fix cheap, rather than only complaining.
  assert.match(result.issues[0], /page_inspect/);
});

test("a page built from the template, with its assets served, passes", async () => {
  const dir = await makeTemplateDir();
  const served = TEMPLATE.replace("One", "MiniPhi validation post").replace(
    'href="assets/css/style.css"',
    'href="/assets/css/style.css"',
  );
  const result = await withServer(
    (request, response) => {
      if (request.url === "/assets/css/style.css") {
        response.writeHead(200, { "content-type": "text/css" });
        response.end(".card{}");
        return;
      }
      if (request.url.startsWith("/assets/images/")) {
        response.writeHead(200, { "content-type": "image/jpeg" });
        response.end(Buffer.from([0xff, 0xd8, 0xff]));
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(served);
    },
    (origin) =>
      checkTemplateFidelity({
        origin,
        templateDir: dir,
        pages: [{ name: "feed", pathname: "/feed" }],
      }),
  );
  assert.deepEqual(result.issues, []);
  assert.ok(result.facts.pages[0].sharedClasses >= 8);
  assert.ok(result.facts.assetServed);
});

test("a linked stylesheet that 404s is reported, because the page renders unstyled", async () => {
  const dir = await makeTemplateDir();
  const result = await withServer(
    (request, response) => {
      if (request.url.startsWith("/assets/")) {
        response.writeHead(404);
        response.end("");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(TEMPLATE.replace('href="assets/', 'href="/assets/'));
    },
    (origin) =>
      checkTemplateFidelity({
        origin,
        templateDir: dir,
        pages: [{ name: "feed", pathname: "/feed" }],
      }),
  );
  assert.ok(result.issues.some((issue) => /Serve the stylesheet \/assets\/css\/style\.css/.test(issue)));
});

test("an app with no real test script is told exactly what suite to write", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-app-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    "utf8",
  );
  const result = await checkOwnTestSuite({ serverDir: dir });
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /node:test/);
  assert.match(result.issues[0], /end-to-end test/);
  assert.match(result.issues[0], /textual/);
});

test("a failing suite is reported with its own output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-app-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
    "utf8",
  );
  const result = await checkOwnTestSuite({
    serverDir: dir,
    runCommand: async () => ({ code: 1, output: "1 test failed: feed renders captions" }),
  });
  assert.match(result.issues[0], /Make `npm test` pass inside server\//);
  assert.match(result.issues[0], /feed renders captions/);
});

test("a passing suite adds no issues", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-app-"));
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
    "utf8",
  );
  const result = await checkOwnTestSuite({
    serverDir: dir,
    runCommand: async () => ({ code: 0, output: "pass 12" }),
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.facts.testExitCode, 0);
});
