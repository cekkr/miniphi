import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import PageUnderstanding from "../src/libs/page-understanding.js";

const analyser = () =>
  new PageUnderstanding({
    client: {},
    schemaRegistry: new PromptSchemaRegistry(),
    model: "vlm",
  });

const digest = {
  viewport: { width: 1000, height: 800 },
  regions: [
    { selector: "header.header", box: { x: 0, y: 0, width: 1000, height: 80 }, images: 1, links: 6, inputs: 1, buttons: 0, text: "Photos" },
    { selector: "main.feed", box: { x: 200, y: 100, width: 600, height: 600 }, images: 4, links: 12, inputs: 0, buttons: 4, text: "posts" },
    { selector: "aside.suggestions", box: { x: 820, y: 100, width: 180, height: 400 }, images: 3, links: 5, inputs: 0, buttons: 3, text: "Suggested" },
  ],
};

test("a model region is cropped from the DOM element it overlaps, not from its estimate", () => {
  const selected = analyser()._selectRegions(
    [
      {
        name: "post feed",
        purpose: "the stream of photo posts",
        importance: "primary",
        // Deliberately a rough box — a vision model's estimate never matches
        // the DOM exactly, which is the whole reason for the IoU match.
        box: { x: 0.21, y: 0.14, width: 0.58, height: 0.72 },
      },
    ],
    digest,
    digest.viewport,
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].dom.selector, "main.feed");
  assert.deepEqual(selected[0].pixelBox, { x: 200, y: 100, width: 600, height: 600 });
});

test("a region the DOM does not express as one element keeps the model's own box", () => {
  const selected = analyser()._selectRegions(
    [
      {
        name: "floating composer",
        purpose: "a new-post button overlaying the feed",
        importance: "primary",
        box: { x: 0.9, y: 0.9, width: 0.06, height: 0.06 },
      },
    ],
    digest,
    digest.viewport,
  );
  assert.equal(selected[0].dom, null);
  assert.deepEqual(selected[0].pixelBox, { x: 900, y: 720, width: 60, height: 48 });
});

test("two regions never claim the same DOM element", () => {
  const selected = analyser()._selectRegions(
    [
      { name: "feed", purpose: "posts", importance: "primary", box: { x: 0.2, y: 0.12, width: 0.6, height: 0.75 } },
      { name: "feed again", purpose: "posts", importance: "primary", box: { x: 0.2, y: 0.13, width: 0.6, height: 0.74 } },
    ],
    digest,
    digest.viewport,
  );
  assert.equal(selected[0].dom.selector, "main.feed");
  assert.notEqual(selected[1].dom?.selector, "main.feed");
});

test("primary regions are analysed before decoration", () => {
  const selected = analyser()._selectRegions(
    [
      { name: "logo", purpose: "branding", importance: "decorative", box: { x: 0, y: 0, width: 0.1, height: 0.05 } },
      { name: "feed", purpose: "posts", importance: "primary", box: { x: 0.2, y: 0.12, width: 0.6, height: 0.75 } },
      { name: "sidebar", purpose: "suggestions", importance: "secondary", box: { x: 0.82, y: 0.12, width: 0.18, height: 0.5 } },
    ],
    digest,
    digest.viewport,
  );
  assert.deepEqual(
    selected.map((region) => region.name),
    ["feed", "sidebar", "logo"],
  );
});

test("the region schemas are published and strict", () => {
  const registry = new PromptSchemaRegistry();
  for (const id of ["page-regions", "page-region-detail"]) {
    const schema = registry.getSchema(id);
    assert.ok(schema, `${id} schema must exist`);
    assert.equal(schema.definition.additionalProperties, false);
    assert.ok(schema.definition.required.includes("needs_more_context"));
    assert.ok(schema.definition.required.includes("missing_snippets"));
  }
});

/**
 * The two-level flow against a *real* browser with a stubbed vision model.
 *
 * The interesting part is not the JSON — it is that each region crop is taken
 * from live geometry with `page.screenshot({clip})`. A survey call whose crops
 * are empty or wrong is worse than no second level at all, because the detail
 * answers then describe the wrong part of the page.
 */
test("each primary region is cropped from the live page and analysed on its own", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-understand-"));
  const page = path.join(dir, "page.html");
  await fs.writeFile(
    page,
    `<!doctype html><html><head><style>
      body{margin:0;font-family:sans-serif}
      #rail{position:fixed;left:0;top:0;width:200px;height:900px;background:#123}
      #feed{margin-left:220px;width:500px}
      .card{height:400px;background:#eee;margin:12px 0}
     </style></head><body>
     <div id="rail">nav</div>
     <div id="feed"><div class="card">one</div><div class="card">two</div><div class="card">three</div></div>
     </body></html>`,
    "utf8",
  );

  const requests = [];
  const client = {
    async createChatCompletion(request) {
      requests.push(request);
      const survey = JSON.stringify(request.response_format).includes("page-regions");
      const content = survey
        ? JSON.stringify({
            schema_version: "page-regions@v1",
            page_purpose: "A feed with a navigation rail",
            layout: "fixed rail on the left, a single feed column",
            regions: [
              { name: "rail", purpose: "navigation", box: { x: 0, y: 0, width: 0.16, height: 1 }, importance: "primary" },
              { name: "feed", purpose: "the posts", box: { x: 0.18, y: 0, width: 0.39, height: 0.9 }, importance: "primary" },
            ],
            notes: [],
            needs_more_context: false,
            missing_snippets: [],
          })
        : JSON.stringify({
            schema_version: "page-region-detail@v1",
            region: "r",
            description: "cards",
            elements: [{ kind: "card", label: "a post card" }],
            dynamic_data: ["caption"],
            interactions: [],
            implementation_notes: [],
            issues: [],
            needs_more_context: false,
            missing_snippets: [],
          });
      return { choices: [{ message: { content }, finish_reason: "stop" }] };
    },
  };

  const artifactsDir = path.join(dir, "artifacts");
  const analyser = new PageUnderstanding({
    client,
    schemaRegistry: new PromptSchemaRegistry(),
    model: "fake-vlm",
    artifactsDir,
    maxDetailRegions: 2,
  });
  const result = await analyser.understand({ absolutePath: page });

  assert.equal(result.ok, true);
  assert.equal(result.response.page_purpose, "A feed with a navigation rail");
  assert.equal(requests.length, 3, "one survey call plus one call per primary region");
  assert.equal(result.response.regions.length, 2);

  // Every detail call carries an image, and it is a *different* image from the
  // full screenshot — that is what makes the second level worth its cost.
  const images = requests.map(
    (request) => request.messages[1].content.find((part) => part.type === "image_url").image_url.url,
  );
  assert.equal(new Set(images).size, 3);

  for (const region of result.response.regions) {
    assert.ok(region.crop, `${region.region} was cropped`);
    const bytes = await fs.readFile(region.crop);
    assert.ok(bytes.length > 100);
    assert.ok(region.box.width >= 8 && region.box.height >= 8);
  }
  // The rail is a real DOM element, so its crop uses that element's geometry.
  const rail = result.response.regions.find((region) => region.region === "rail");
  assert.match(rail.selector ?? "", /#rail/);
  assert.equal(rail.box.width, 200);

  // The "as written" half rides along, because a screenshot cannot show a class
  // name and the implementation needs both.
  assert.ok(result.response.source);
  assert.ok(result.response.source.classVocabulary.includes("card"));
  // And the rendered half reports what the browser actually did.
  assert.equal(result.response.rendered.pageErrors.length, 0);
  assert.ok(await fs.readFile(result.response.screenshot).then((buffer) => buffer.length > 100));
});
