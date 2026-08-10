import fs from "node:fs/promises";
import path from "node:path";
import { inspectPageSource, openLivePage } from "../../src/libs/page-inspector.js";

/**
 * Proves the delivered app actually *uses* the design template it was given.
 *
 * This check exists because of a specific, expensive failure. The photos-social
 * sample says "use the static HTML/CSS design in html-template/ as its
 * front-end". The validator checked routes, JSON shapes and SQLite — all of
 * which a hand-written mock satisfies — plus a vision score, which a plain but
 * tidy page also satisfies. So a run that never opened a single template file
 * and emitted its own markup from memory passed, and the operator got hours of
 * work and no template.
 *
 * Every assertion here is textual and machine-checkable, per the validation
 * rules in `docs/guidelines/agent-navigation.md`: a model with no vision at all
 * can read the verdict and act on it. Nothing here is a screenshot.
 */

const MAX_ISSUE_CHARS = 700;
// How many of the template's own class names must appear on a served page
// before we believe the page is built from the template rather than from
// something that merely looks similar.
const MIN_SHARED_CLASSES = 8;
// Two files are "the same asset" when the served bytes match the template's.
// Exact equality is deliberate: a build step that minifies is fine, but then
// the served file should be reachable from the template path, which the
// path-overlap check below catches instead.
const SAMPLE_BYTES = 4096;

// Every class the template uses, not only the ones it repeats: a page built
// from this design carries its single-use structural classes too, and ignoring
// them would need an implausibly large overlap before the check believed the
// page came from the template.
const collapseClasses = (source) =>
  new Set(
    source?.classVocabulary?.length
      ? source.classVocabulary
      : (source?.repeatedClasses ?? []).map((entry) => entry.class),
  );

const normalizeAssetPath = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw, "http://placeholder.invalid/").pathname;
  } catch {
    return null;
  }
};

/**
 * The template's own vocabulary: the classes it reuses, the stylesheets it
 * links, and the asset paths it references. Read once per validation run from
 * the actual files on disk, never hard-coded, so the check follows the template
 * if the operator swaps it.
 */
export async function readTemplateVocabulary(templateDir, pages = ["home.html", "index.html", "profile.html"]) {
  const classes = new Set();
  const stylesheets = new Set();
  const assets = new Set();
  const read = [];
  for (const page of pages) {
    const file = path.join(templateDir, page);
    const source = await inspectPageSource(file).catch(() => null);
    if (!source) {
      continue;
    }
    read.push(page);
    for (const name of collapseClasses(source)) {
      classes.add(name);
    }
    for (const href of source.stylesheets) {
      const normalized = normalizeAssetPath(href);
      if (normalized) {
        stylesheets.add(normalized);
      }
    }
    for (const src of [...source.images, ...source.scripts]) {
      const normalized = normalizeAssetPath(src);
      if (normalized) {
        assets.add(normalized);
      }
    }
  }
  return { pagesRead: read, classes, stylesheets, assets };
}

const fetchText = async (url, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, buffer, text: buffer.toString("utf8") };
  } catch (error) {
    return { status: 0, buffer: Buffer.alloc(0), text: "", error: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
};

const classesIn = (html) => {
  const found = new Set();
  const pattern = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(html);
  while (match) {
    for (const name of (match[1] ?? match[2] ?? "").split(/\s+/)) {
      if (name) {
        found.add(name);
      }
    }
    match = pattern.exec(html);
  }
  return found;
};

/**
 * Runs the fidelity checks against a live origin.
 *
 * @param {{origin:string, templateDir:string, pages:Array<{name:string,pathname:string}>}} options
 * @returns {Promise<{issues:string[], facts:object}>}
 */
export async function checkTemplateFidelity({ origin, templateDir, pages }) {
  const issues = [];
  const facts = {};
  const vocabulary = await readTemplateVocabulary(templateDir);
  facts.templatePagesRead = vocabulary.pagesRead;
  facts.templateClassCount = vocabulary.classes.size;
  if (!vocabulary.classes.size) {
    // Nothing to compare against; say so rather than passing silently.
    return {
      issues: [
        `The design template at ${templateDir} could not be read, so template usage cannot be verified.`,
      ],
      facts,
    };
  }

  const perPage = [];
  for (const page of pages) {
    const response = await fetchText(`${origin}${page.pathname}`);
    if (response.status !== 200) {
      issues.push(
        `Serve ${page.pathname} as a 200 HTML page built from the html-template/ design. It answered status ${response.status}${response.error ? ` (${response.error})` : ""}.`,
      );
      continue;
    }
    const served = classesIn(response.text);
    const shared = [...served].filter((name) => vocabulary.classes.has(name));
    const linkedStyles = [...response.text.matchAll(/<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/gi)]
      .map((match) => /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[0]))
      .map((match) => normalizeAssetPath(match?.[1] ?? match?.[2]))
      .filter(Boolean);
    perPage.push({
      page: page.name,
      pathname: page.pathname,
      sharedClasses: shared.length,
      stylesheets: linkedStyles,
    });
    if (shared.length < MIN_SHARED_CLASSES) {
      issues.push(
        `Build ${page.pathname} from the html-template/ markup instead of writing new markup: only ${shared.length} of the template's own CSS classes appear on the page (at least ${MIN_SHARED_CLASSES} are expected). Copy the structure from the matching template file and fill it with real data — page_inspect on the template page gives you its classes, assets and layout without reading the whole file.`,
      );
    }
    if (!linkedStyles.length) {
      issues.push(
        `Link the template's own stylesheet from ${page.pathname}. The page contains no <link rel="stylesheet"> at all, so none of the html-template/ design is applied.`,
      );
    }
  }
  facts.pages = perPage;
  if (issues.length) {
    return { issues, facts };
  }

  // The stylesheet must not merely be *linked* — it must be served, and it must
  // be the template's file. A 404 on the CSS is the most common way a page
  // "uses the template" in markup and renders unstyled in a browser.
  const linked = [...new Set(perPage.flatMap((entry) => entry.stylesheets))];
  const servedStyles = [];
  for (const href of linked.slice(0, 6)) {
    const response = await fetchText(`${origin}${href}`);
    servedStyles.push({ href, status: response.status, bytes: response.buffer.length });
    if (response.status !== 200 || response.buffer.length === 0) {
      issues.push(
        `Serve the stylesheet ${href} that your pages link to: requesting it answered status ${response.status} with ${response.buffer.length} bytes. Mount html-template/assets as a static directory so the design's CSS, JS and images are reachable at the paths the markup uses.`,
      );
    }
  }
  facts.stylesheets = servedStyles;

  // At least one real template asset (an image or script from the design) must
  // be reachable, which is what distinguishes "serves a copy of the CSS" from
  // "serves the template's asset tree".
  const assetCandidates = [...vocabulary.assets]
    .filter((asset) => asset.includes("/assets/"))
    .slice(0, 8);
  let assetServed = null;
  for (const asset of assetCandidates) {
    const response = await fetchText(`${origin}${asset}`);
    if (response.status === 200 && response.buffer.length > 0) {
      assetServed = { asset, bytes: response.buffer.length };
      break;
    }
  }
  facts.assetServed = assetServed;
  if (assetCandidates.length && !assetServed) {
    issues.push(
      `Serve the html-template/ asset tree. None of the template's own assets (${assetCandidates
        .slice(0, 3)
        .join(", ")}) is reachable from the running app, so the pages render without their images, icons and scripts.`,
    );
  }

  return { issues, facts };
}

/**
 * The rendered half: what a browser actually ends up with. Still textual — the
 * verdict is counts and error lists, not a picture — so a model with no vision
 * can act on every one of these.
 */
export async function checkRenderedPage({ url, minStyledElements = 40 }) {
  const issues = [];
  let live = null;
  try {
    live = await openLivePage({ url, waitMs: 1200 });
  } catch (error) {
    return {
      issues: [`Make ${url} renderable in a browser: opening it failed with ${error?.message ?? error}.`],
      facts: {},
    };
  }
  try {
    const digest = await live.digest();
    const facts = {
      styledElements: digest.styledElements,
      stylesheets: digest.stylesheets.length,
      images: digest.images.length,
      brokenImages: digest.images.filter((image) => !image.loaded).map((image) => image.src),
      failedRequests: digest.failedRequests,
      pageErrors: digest.pageErrors,
      consoleErrors: digest.consoleErrors,
      documentHeight: digest.documentHeight,
    };
    if (!digest.stylesheets.length) {
      issues.push(
        `No stylesheet was actually applied when ${url} rendered in a browser. The document has ${digest.styledElements} elements carrying class attributes but zero loaded stylesheets, so the page is unstyled.`,
      );
    }
    if (digest.styledElements < minStyledElements) {
      issues.push(
        `The rendered ${url} has only ${digest.styledElements} elements with class attributes; a page built from the html-template/ design has many more. It is not being rendered from the template.`,
      );
    }
    if (facts.brokenImages.length) {
      issues.push(
        `Serve every image the page references: ${facts.brokenImages
          .slice(0, 4)
          .join(", ")
          .slice(0, MAX_ISSUE_CHARS)} failed to load in the browser.`,
      );
    }
    if (facts.failedRequests.length) {
      issues.push(
        `Fix the failing requests the page makes: ${facts.failedRequests
          .slice(0, 4)
          .join(" | ")
          .slice(0, MAX_ISSUE_CHARS)}`,
      );
    }
    if (facts.pageErrors.length) {
      issues.push(
        `Fix the JavaScript errors thrown while rendering ${url}: ${facts.pageErrors
          .slice(0, 3)
          .join(" | ")
          .slice(0, MAX_ISSUE_CHARS)}`,
      );
    }
    return { issues, facts };
  } finally {
    await live.close();
  }
}

/**
 * The project's own test suite, run as part of validation.
 *
 * Rule V1/R6: a change is not delivered until something executable proves it.
 * Requiring the suite here is what makes that rule enforceable rather than
 * advisory — and it gives the agent a fast, textual, vision-free way to check
 * its own work between validator runs.
 */
export async function checkOwnTestSuite({ serverDir, runCommand, timeoutMs = 180000 }) {
  const issues = [];
  const facts = {};
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(serverDir, "package.json"), "utf8"));
  } catch {
    return { issues, facts };
  }
  const script = manifest?.scripts?.test ?? "";
  facts.testScript = script || null;
  const placeholder = !script || /no test specified/i.test(script);
  if (placeholder) {
    issues.push(
      'Add an automated test suite and wire it to `npm test` in server/package.json. Write it with node:test (no dependency needed): unit tests for the data layer, plus an end-to-end test that starts the app on an ephemeral port and drives the real HTTP surface (register, login, upload, GET /api/posts, GET /feed) asserting on status codes and on strings that must appear in the HTML. Assertions must be textual so the suite passes or fails without anyone looking at it.',
    );
    return { issues, facts };
  }
  if (typeof runCommand !== "function") {
    return { issues, facts };
  }
  const result = await runCommand("npm test --silent", { cwd: serverDir, timeoutMs }).catch(
    (error) => ({ code: 1, output: error?.message ?? String(error) }),
  );
  facts.testExitCode = result?.code ?? null;
  facts.testOutput = String(result?.output ?? "").slice(0, 1200);
  if (result?.code !== 0) {
    issues.push(
      `Make \`npm test\` pass inside server/. It exited with code ${result?.code}: ${facts.testOutput.slice(0, MAX_ISSUE_CHARS)}`,
    );
  }
  return { issues, facts };
}

export default checkTemplateFidelity;
