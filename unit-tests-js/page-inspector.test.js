import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectPageSource,
  normalizeLocalUrl,
  parseHtmlStructure,
} from "../src/libs/page-inspector.js";

const PAGE = `<!doctype html>
<html>
<head>
  <title>Photos — Home</title>
  <link rel="stylesheet" href="assets/css/tailwind.css">
  <link rel="stylesheet" href="assets/css/style.css">
  <script src="assets/js/uikit.min.js"></script>
</head>
<body class="bg-gray-100">
  <header id="topbar" class="header shadow-sm">
    <nav class="nav-menu"><a href="home.html">Home</a><a href="explore.html">Explore</a></nav>
  </header>
  <main class="feed-wrapper">
    <div class="card post-card">
      <img src="assets/images/post/post-1.jpg" alt="post">
      <div class="card-body"><p>A caption</p></div>
    </div>
    <div class="card post-card">
      <img src="assets/images/post/post-2.jpg" alt="post">
      <div class="card-body"><p>Another caption</p></div>
    </div>
  </main>
  <form action="/login" method="post">
    <input type="text" name="username" placeholder="Username">
    <input type="password" name="password">
    <button type="submit">Sign in</button>
  </form>
  <script>
    // A closing tag inside a script must not confuse the parser: </div>
    const x = 1;
  </script>
</body>
</html>`;

test("the tolerant parser keeps script text from closing real elements", () => {
  const root = parseHtmlStructure(PAGE);
  const findAll = (node, tag, found = []) => {
    if (node.tag === tag) {
      found.push(node);
    }
    for (const child of node.children) {
      findAll(child, tag, found);
    }
    return found;
  };
  // Two real cards, and the `</div>` written inside the script closes nothing.
  assert.equal(findAll(root, "main").length, 1);
  assert.equal(findAll(root, "img").length, 2);
  assert.equal(findAll(root, "form").length, 1);
});

test("a template page is summarized by what a model needs to reuse it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-page-"));
  const file = path.join(dir, "home.html");
  await fs.writeFile(file, PAGE, "utf8");

  const source = await inspectPageSource(file);
  assert.equal(source.kind, "source");
  assert.equal(source.title, "Photos — Home");
  assert.deepEqual(source.stylesheets, ["assets/css/tailwind.css", "assets/css/style.css"]);
  assert.deepEqual(source.scripts, ["assets/js/uikit.min.js"]);
  assert.equal(source.images.length, 2);

  // The classes the design *reuses* are the ones an implementation must copy.
  const repeated = source.repeatedClasses.map((entry) => entry.class);
  assert.ok(repeated.includes("card"));
  assert.ok(repeated.includes("post-card"));
  assert.ok(repeated.includes("card-body"));

  // Forms come back with their real field names, which is what a server has to
  // accept — the single most common thing a re-implementation gets wrong.
  assert.equal(source.forms.length, 1);
  assert.equal(source.forms[0].action, "/login");
  assert.equal(source.forms[0].method, "post");
  assert.deepEqual(
    source.forms[0].fields.filter((field) => field.name).map((field) => field.name),
    ["username", "password"],
  );

  const outlineSelectors = source.outline.map((entry) => entry.selector);
  assert.ok(outlineSelectors.some((selector) => selector.startsWith("header#topbar")));
  assert.ok(outlineSelectors.some((selector) => selector.startsWith("main.feed-wrapper")));
  assert.ok(source.navLinks.some((link) => link.href === "explore.html"));
});

test("only loopback http(s) targets are accepted as live pages", () => {
  assert.equal(normalizeLocalUrl("http://127.0.0.1:3117/feed"), "http://127.0.0.1:3117/feed");
  assert.equal(normalizeLocalUrl("http://localhost:3000/"), "http://localhost:3000/");
  assert.equal(normalizeLocalUrl("https://example.com/"), null);
  assert.equal(normalizeLocalUrl("file:///etc/passwd"), null);
  assert.equal(normalizeLocalUrl(""), null);
});

test("the real photos-social template is readable and reports its own vocabulary", async () => {
  const template = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "samples",
    "photos-social",
    "html-template",
    "home.html",
  );
  const exists = await fs
    .access(template)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return; // the sample template is optional in a trimmed checkout
  }
  const source = await inspectPageSource(template);
  assert.ok(source.stylesheets.length > 0, "the design links at least one stylesheet");
  assert.ok(
    source.repeatedClasses.length >= 8,
    "the design reuses enough classes to check a served page against",
  );
});

test("a guessed template filename is answered with the names that exist", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-guess-"));
  await fs.mkdir(path.join(dir, "html-template"), { recursive: true });
  for (const name of ["form-login.html", "form-register.html", "home.html"]) {
    await fs.writeFile(path.join(dir, "html-template", name), "<html></html>", "utf8");
  }
  const { createPageInspectAction } = await import("../src/libs/page-inspector.js");
  const inspect = createPageInspectAction({ workspaceRoot: dir });

  // The exact mistake seen live: `login.html` instead of `form-login.html`.
  const result = await inspect({ relativePath: "html-template/login.html", mode: "source" });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not exist/);
  assert.match(result.error, /form-login\.html/);
  assert.match(result.error, /form-register\.html/);

  const good = await inspect({ relativePath: "html-template/form-login.html", mode: "source" });
  assert.equal(good.ok, true);
});
